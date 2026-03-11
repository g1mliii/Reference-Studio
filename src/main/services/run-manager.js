import fs from 'node:fs/promises';
import path from 'node:path';

import log from 'electron-log/main.js';

import { GeminiService, extractFirstInlineImage } from './gemini-service.js';
import { buildPrompt } from '../../shared/prompt.js';
import {
  ensureDirectory,
  fileName,
  fileStem,
  findDuplicateStems,
  listImageFiles,
  pathExists,
} from '../../shared/files.js';
import {
  createJobId,
  createRunRequests,
  patchRequest,
  summarizeRequests,
} from '../../shared/jobs.js';
import { JOB_STATES, RUN_EVENT_CHANNEL } from '../../shared/constants.js';

function now() {
  return new Date().toISOString();
}

function sendRunEvent(window, payload) {
  window?.webContents?.send(RUN_EVENT_CHANNEL, {
    ...payload,
    timestamp: now(),
  });
}

function serializeError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function validateReferenceFiles(referenceFiles) {
  if (referenceFiles.length === 0) {
    throw new Error('Save at least 1 reference image in Settings before running a job.');
  }

  for (const referenceFile of referenceFiles) {
    if (!(await pathExists(referenceFile))) {
      throw new Error(`Reference image no longer exists: ${referenceFile}`);
    }
  }

  const duplicates = findDuplicateStems(referenceFiles);
  if (duplicates.length) {
    throw new Error(
      `Duplicate reference filenames were found. Each reference image needs a unique filename stem: ${duplicates.join(', ')}`,
    );
  }
}

async function validateCarFiles(carFiles) {
  if (carFiles.length === 0) {
    throw new Error('No supported car images were found in the selected Cars folder.');
  }

  const duplicates = findDuplicateStems(carFiles);
  if (duplicates.length) {
    throw new Error(
      `Duplicate car filenames were found. Each car image needs a unique filename stem: ${duplicates.join(', ')}`,
    );
  }
}

export class RunManager {
  constructor({ settingsStore, jobStore }) {
    this.settingsStore = settingsStore;
    this.jobStore = jobStore;
    this.activeJobId = null;
    this.pausedJobs = new Set();
  }

  async startRun({ mode, carsDir, outputDir, window }) {
    if (this.activeJobId) {
      throw new Error('A run is already active. Wait for it to finish before starting another one.');
    }

    const settings = await this.settingsStore.load();
    const apiKey = await this.settingsStore.getApiKey();

    if (!apiKey) {
      throw new Error('Save a Gemini API key in Settings before running a job.');
    }

    await validateReferenceFiles(settings.referenceFiles);
    const carFiles = await listImageFiles(carsDir);
    await validateCarFiles(carFiles);
    await ensureDirectory(outputDir);

    const requests = createRunRequests({
      carFiles,
      referenceFiles: settings.referenceFiles,
      outputDir,
    });

    const job = {
      id: createJobId(),
      mode,
      state: JOB_STATES.READY,
      pausedFromState: null,
      createdAt: now(),
      updatedAt: now(),
      carsDir,
      outputDir,
      model: settings.model,
      searchEnabled: settings.searchEnabled,
      prompt: settings.prompt,
      remoteJobName: null,
      remoteState: null,
      requests,
      summary: summarizeRequests(requests),
    };

    await this.jobStore.upsert(job);
    this.activeJobId = job.id;

    try {
      sendRunEvent(window, {
        kind: 'job-started',
        job,
      });

      if (mode === 'sync') {
        return await this.#runSync(job, { apiKey, settings, window });
      }

      return await this.#submitBatch(job, { apiKey, settings, window });
    } catch (error) {
      this.pausedJobs.delete(job.id);
      const failedJob = await this.jobStore.patch(job.id, {
        state: JOB_STATES.FAILED,
        pausedFromState: null,
      });

      sendRunEvent(window, {
        kind: 'job-updated',
        job: failedJob,
      });

      throw error;
    } finally {
      this.pausedJobs.delete(job.id);
      this.activeJobId = null;
    }
  }

  async pauseJob({ jobId, window }) {
    const job = await this.jobStore.get(jobId);
    if (!job) {
      throw new Error('The selected job could not be found.');
    }
    if (this.activeJobId !== jobId) {
      throw new Error('Only the active local job can be paused.');
    }
    if (![JOB_STATES.RUNNING, JOB_STATES.PROCESSING].includes(job.state)) {
      return job;
    }

    this.pausedJobs.add(jobId);
    const nextJob = await this.jobStore.patch(jobId, {
      pausedFromState: job.state,
      state: JOB_STATES.PAUSED,
    });

    sendRunEvent(window, {
      kind: 'job-updated',
      job: nextJob,
    });

    return nextJob;
  }

  async resumeJob({ jobId, window }) {
    const job = await this.jobStore.get(jobId);
    if (!job) {
      throw new Error('The selected job could not be found.');
    }
    if (this.activeJobId !== jobId) {
      throw new Error('Only the active local job can be resumed.');
    }
    if (job.state !== JOB_STATES.PAUSED) {
      return job;
    }

    this.pausedJobs.delete(jobId);
    const nextJob = await this.jobStore.patch(jobId, {
      state: job.pausedFromState || JOB_STATES.RUNNING,
      pausedFromState: null,
    });

    sendRunEvent(window, {
      kind: 'job-updated',
      job: nextJob,
    });

    return nextJob;
  }

  async refreshBatch({ jobId, window }) {
    const job = await this.jobStore.get(jobId);
    if (!job) {
      throw new Error('The selected batch job could not be found.');
    }
    if (job.mode !== 'batch') {
      throw new Error('Only batch jobs can be refreshed.');
    }
    if (!job.remoteJobName) {
      throw new Error('This batch job has no remote Gemini batch id.');
    }

    const apiKey = await this.settingsStore.getApiKey();
    if (!apiKey) {
      throw new Error('Save a Gemini API key in Settings before refreshing a batch job.');
    }

    const gemini = new GeminiService({
      apiKey,
      model: job.model,
    });

    if (this.activeJobId && this.activeJobId !== jobId) {
      throw new Error('Another local job is active. Finish or pause that job first.');
    }
    this.activeJobId = jobId;

    sendRunEvent(window, {
      kind: 'job-log',
      jobId,
      message: 'Refreshing Gemini batch status...',
    });
    try {
      const remoteBatch = await gemini.getBatch(job.remoteJobName);
      const remoteState = remoteBatch.state || 'UNKNOWN';
      const failedRemoteState =
        remoteState === 'JOB_STATE_FAILED' || remoteState === 'JOB_STATE_CANCELLED';

      let nextJob = await this.jobStore.patch(job.id, {
        remoteState,
        state:
          remoteState === 'JOB_STATE_SUCCEEDED'
            ? JOB_STATES.PROCESSING
            : failedRemoteState
              ? JOB_STATES.FAILED
              : JOB_STATES.SUBMITTED,
        pausedFromState: null,
      });

      sendRunEvent(window, {
        kind: 'job-updated',
        job: nextJob,
      });

      if (failedRemoteState) {
        return this.jobStore.patch(job.id, {
          state: JOB_STATES.FAILED,
          summary: summarizeRequests(nextJob.requests),
          pausedFromState: null,
        });
      }

      if (remoteState !== 'JOB_STATE_SUCCEEDED') {
        return nextJob;
      }

      const inlinedResponses =
        remoteBatch.dest?.inlinedResponses ||
        remoteBatch.dest?.inlined_responses ||
        [];

      if (!inlinedResponses.length) {
        throw new Error('The batch finished but no inline responses were returned.');
      }

      let requests = [...nextJob.requests];
      let completed = 0;

      for (const responseItem of inlinedResponses) {
        await this.#waitIfPaused(jobId);

        const key = responseItem.metadata?.requestKey;
        if (!key) {
          continue;
        }

        const request = requests.find((item) => item.key === key);
        if (!request) {
          continue;
        }

        if (await pathExists(request.outputFile)) {
          requests = patchRequest(requests, key, {
            status: 'skipped',
          });
          completed += 1;
          continue;
        }

        if (responseItem.error) {
          requests = patchRequest(requests, key, {
            status: 'failed',
            error: responseItem.error.message || 'Unknown Gemini batch error.',
          });
          completed += 1;
          continue;
        }

        const image = extractFirstInlineImage(responseItem.response);
        if (!image) {
          requests = patchRequest(requests, key, {
            status: 'failed',
            error: 'Gemini batch response returned no image data.',
          });
          completed += 1;
          continue;
        }

        await ensureDirectory(path.dirname(request.outputFile));
        await fs.writeFile(request.outputFile, Buffer.from(image.data, 'base64'));
        requests = patchRequest(requests, key, {
          status: 'completed',
          error: null,
        });
        completed += 1;

        sendRunEvent(window, {
          kind: 'job-progress',
          jobId,
          completed,
          total: inlinedResponses.length,
          message: `Saved ${fileName(request.outputFile)}`,
        });
      }

      const failedCount = requests.filter((item) => item.status === 'failed').length;
      nextJob = await this.jobStore.patch(job.id, {
        requests,
        summary: summarizeRequests(requests),
        state: failedCount ? JOB_STATES.PARTIAL : JOB_STATES.COMPLETED,
        remoteState: remoteBatch.state,
        pausedFromState: null,
      });

      sendRunEvent(window, {
        kind: 'job-updated',
        job: nextJob,
      });

      return nextJob;
    } finally {
      this.pausedJobs.delete(jobId);
      this.activeJobId = null;
    }
  }

  async #runSync(job, { apiKey, settings, window }) {
    const gemini = new GeminiService({
      apiKey,
      model: settings.model,
    });

    const referenceUploads = new Map();
    const referenceUploadErrors = new Map();
    const carUploads = new Map();
    const carUploadErrors = new Map();
    let requests = [...job.requests];

    const runningJob = await this.jobStore.patch(job.id, {
      state: JOB_STATES.RUNNING,
    });

    sendRunEvent(window, {
      kind: 'job-updated',
      job: runningJob,
    });

    let completed = 0;

    for (const request of requests) {
      await this.#waitIfPaused(job.id);

      const outputExists = await pathExists(request.outputFile);
      if (outputExists) {
        requests = patchRequest(requests, request.key, {
          status: 'skipped',
        });
        completed += 1;
        sendRunEvent(window, {
          kind: 'job-progress',
          jobId: job.id,
          completed,
          total: requests.length,
          message: `Skipped existing ${fileName(request.outputFile)} (${fileName(request.carFile)} x ${fileName(request.referenceFile)})`,
        });
        continue;
      }

      try {
        const uploadedReference = await this.#getUpload({
          gemini,
          filePath: request.referenceFile,
          fileRole: 'reference',
          jobId: job.id,
          window,
          cache: referenceUploads,
          errorCache: referenceUploadErrors,
        });
        const uploadedCar = await this.#getUpload({
          gemini,
          filePath: request.carFile,
          fileRole: 'car',
          jobId: job.id,
          window,
          cache: carUploads,
          errorCache: carUploadErrors,
        });

        const prompt = buildPrompt({
          basePrompt: settings.prompt,
          carIdentity: fileStem(request.carFile),
        });

        const result = await gemini.generateImage({
          prompt,
          referenceUpload: uploadedReference,
          carUpload: uploadedCar,
          searchEnabled: settings.searchEnabled,
        });

        await ensureDirectory(path.dirname(request.outputFile));
        await gemini.saveGeneratedFile({
          buffer: result.buffer,
          outputFile: request.outputFile,
        });

        requests = patchRequest(requests, request.key, {
          status: 'completed',
          error: null,
        });
        completed += 1;
        sendRunEvent(window, {
          kind: 'job-progress',
          jobId: job.id,
          completed,
          total: requests.length,
          message: `Saved ${fileName(request.outputFile)} from ${fileName(request.carFile)} with ${fileName(request.referenceFile)}`,
        });
      } catch (error) {
        const message = serializeError(error);
        log.error('Sync request failed', request.key, message);
        requests = patchRequest(requests, request.key, {
          status: 'failed',
          error: message,
        });
        completed += 1;
        sendRunEvent(window, {
          kind: 'job-progress',
          jobId: job.id,
          completed,
          total: requests.length,
          message: `Failed ${fileName(request.outputFile)} from ${fileName(request.carFile)} with ${fileName(request.referenceFile)}: ${message}`,
        });
      }
    }

    const failedCount = requests.filter((request) => request.status === 'failed').length;
    const nextJob = await this.jobStore.patch(job.id, {
      requests,
      summary: summarizeRequests(requests),
      state: failedCount ? JOB_STATES.PARTIAL : JOB_STATES.COMPLETED,
      pausedFromState: null,
    });

    sendRunEvent(window, {
      kind: 'job-updated',
      job: nextJob,
    });

    return nextJob;
  }

  async #submitBatch(job, { apiKey, settings, window }) {
    const gemini = new GeminiService({
      apiKey,
      model: settings.model,
    });

    const runningJob = await this.jobStore.patch(job.id, {
      state: JOB_STATES.RUNNING,
    });

    sendRunEvent(window, {
      kind: 'job-updated',
      job: runningJob,
    });

    const referenceUploads = new Map();
    const referenceUploadErrors = new Map();
    const carUploads = new Map();
    const carUploadErrors = new Map();
    const batchRequests = [];
    let requests = [...job.requests];
    let completed = 0;

    for (const request of requests) {
      await this.#waitIfPaused(job.id);

      if (await pathExists(request.outputFile)) {
        requests = patchRequest(requests, request.key, {
          status: 'skipped',
        });
        completed += 1;
        continue;
      }

      try {
        const referenceUpload = await this.#getUpload({
          gemini,
          filePath: request.referenceFile,
          fileRole: 'reference',
          jobId: job.id,
          window,
          cache: referenceUploads,
          errorCache: referenceUploadErrors,
        });
        const carUpload = await this.#getUpload({
          gemini,
          filePath: request.carFile,
          fileRole: 'car',
          jobId: job.id,
          window,
          cache: carUploads,
          errorCache: carUploadErrors,
        });

        const prompt = buildPrompt({
          basePrompt: settings.prompt,
          carIdentity: fileStem(request.carFile),
        });

        batchRequests.push(
          gemini.buildRequest({
            prompt,
            referenceUpload,
            carUpload,
            metadata: {
              requestKey: request.key,
            },
            searchEnabled: settings.searchEnabled,
          }),
        );

        requests = patchRequest(requests, request.key, {
          status: 'submitted',
          error: null,
        });
        completed += 1;

        sendRunEvent(window, {
          kind: 'job-progress',
          jobId: job.id,
          completed,
          total: job.requests.length,
          message: `Prepared ${fileName(request.outputFile)} from ${fileName(request.carFile)} with ${fileName(request.referenceFile)}`,
        });
      } catch (error) {
        const message = serializeError(error);
        log.error('Batch request preparation failed', request.key, message);
        requests = patchRequest(requests, request.key, {
          status: 'failed',
          error: message,
        });
        completed += 1;

        sendRunEvent(window, {
          kind: 'job-progress',
          jobId: job.id,
          completed,
          total: job.requests.length,
          message: `Failed ${fileName(request.outputFile)} from ${fileName(request.carFile)} with ${fileName(request.referenceFile)}: ${message}`,
        });
      }
    }

    if (!batchRequests.length) {
      const failedCount = requests.filter((request) => request.status === 'failed').length;
      const skippedCount = requests.filter((request) => request.status === 'skipped').length;
      const nextJob = await this.jobStore.patch(job.id, {
        requests,
        summary: summarizeRequests(requests),
        state:
          failedCount === 0
            ? JOB_STATES.COMPLETED
            : skippedCount > 0
              ? JOB_STATES.PARTIAL
              : JOB_STATES.FAILED,
        pausedFromState: null,
      });
      sendRunEvent(window, {
        kind: 'job-updated',
        job: nextJob,
      });
      return nextJob;
    }

    const remoteJob = await gemini.createBatch({
      requests: batchRequests,
      displayName: job.id,
    });

    const nextJob = await this.jobStore.patch(job.id, {
      requests,
      summary: summarizeRequests(requests),
      state: JOB_STATES.SUBMITTED,
      remoteJobName: remoteJob.name,
      remoteState: remoteJob.state || 'JOB_STATE_PENDING',
      pausedFromState: null,
    });

    sendRunEvent(window, {
      kind: 'job-updated',
      job: nextJob,
    });

    return nextJob;
  }

  async #getUpload({
    gemini,
    filePath,
    fileRole,
    jobId,
    window,
    cache,
    errorCache,
  }) {
    if (cache.has(filePath)) {
      return cache.get(filePath);
    }

    if (errorCache.has(filePath)) {
      throw new Error(errorCache.get(filePath));
    }

    sendRunEvent(window, {
      kind: 'job-log',
      jobId,
      message: `Uploading ${fileRole} ${fileName(filePath)}...`,
    });

    try {
      const uploadedFile = await gemini.uploadFile(filePath);
      cache.set(filePath, uploadedFile);
      return uploadedFile;
    } catch (error) {
      const message = `${this.#formatFileRole(fileRole)} upload failed for ${fileName(filePath)}: ${serializeError(error)}`;
      errorCache.set(filePath, message);
      throw new Error(message);
    }
  }

  #formatFileRole(fileRole) {
    return fileRole.charAt(0).toUpperCase() + fileRole.slice(1);
  }

  async #waitIfPaused(jobId) {
    while (this.pausedJobs.has(jobId)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
