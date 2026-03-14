import fs from 'node:fs/promises';
import path from 'node:path';

import log from 'electron-log/main.js';

import {
  GeminiService,
  extractFirstInlineImage,
  isRateLimitError,
  retryDelayMsFromError,
} from './gemini-service.js';
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

const MOCK_FAILURE_TOKEN = 'mock-fail';
const MOCK_OUTPUT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAY0lEQVR4nO3PQQ3AIADAQMDwBOAVLTOxhmS5U9BH5z7P4Jt1O+BPzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzAq+oGAB4tQ6pQAAAABJRU5ErkJggg==',
  'base64',
);
const BATCH_POLLABLE_STATES = new Set([
  JOB_STATES.SUBMITTED,
  JOB_STATES.PROCESSING,
]);
const REMOTE_TERMINAL_STATES = new Set([
  'JOB_STATE_SUCCEEDED',
  'JOB_STATE_FAILED',
  'JOB_STATE_CANCELLED',
  'JOB_STATE_EXPIRED',
]);
const DEFAULT_RATE_LIMIT_RETRY_OPTIONS = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 4000,
  maxDelayMs: 60000,
  sleepSliceMs: 250,
});

class RunCancelledError extends Error {
  constructor(message = 'Run cancelled by user.') {
    super(message);
    this.name = 'RunCancelledError';
  }
}

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
    throw new Error('No supported source images were found in the selected Source folder.');
  }

  const duplicates = findDuplicateStems(carFiles);
  if (duplicates.length) {
    throw new Error(
      `Duplicate source filenames were found. Each input image needs a unique filename stem: ${duplicates.join(', ')}`,
    );
  }
}

export class RunManager {
  constructor({ settingsStore, jobStore, userDataPath, rateLimitRetryOptions = {} }) {
    this.settingsStore = settingsStore;
    this.jobStore = jobStore;
    this.batchCacheDir = path.join(userDataPath, 'batch-cache');
    this.activeJobId = null;
    this.pausedJobs = new Set();
    this.cancelRequestedJobs = new Set();
    this.rateLimitRetryOptions = {
      ...DEFAULT_RATE_LIMIT_RETRY_OPTIONS,
      ...rateLimitRetryOptions,
    };
  }

  async startRun({ mode, carsDir, outputDir, window }) {
    if (this.activeJobId) {
      throw new Error('A run is already active. Wait for it to finish before starting another one.');
    }

    const settings = await this.settingsStore.load();
    const apiKey = await this.settingsStore.getApiKey();

    if (!settings.localTestMode && !apiKey) {
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
      localTestMode: Boolean(settings.localTestMode),
      prompt: settings.prompt,
      remoteJobName: null,
      remoteState: null,
      mockBatchPollCount: 0,
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

      if (settings.localTestMode) {
        if (mode === 'sync') {
          return await this.#runSyncMock(job, { window });
        }

        return await this.#submitBatchMock(job, { window });
      }

      if (mode === 'sync') {
        return await this.#runSync(job, { apiKey, settings, window });
      }

      return await this.#submitBatch(job, { apiKey, settings, window });
    } catch (error) {
      if (error instanceof RunCancelledError) {
        const cancelledJob = await this.jobStore.patch(job.id, {
          state: JOB_STATES.CANCELLED,
          pausedFromState: null,
        });

        sendRunEvent(window, {
          kind: 'job-updated',
          job: cancelledJob,
        });

        return cancelledJob;
      }

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
      this.cancelRequestedJobs.delete(job.id);
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

  async cancelJob({ jobId, window }) {
    const job = await this.jobStore.get(jobId);
    if (!job) {
      throw new Error('The selected job could not be found.');
    }

    if (
      job.mode === 'batch' &&
      job.remoteJobName &&
      BATCH_POLLABLE_STATES.has(job.state) &&
      !REMOTE_TERMINAL_STATES.has(job.remoteState)
    ) {
      if (job.localTestMode) {
        this.cancelRequestedJobs.add(jobId);
        this.pausedJobs.delete(jobId);
        const cancelledJob = await this.jobStore.patch(jobId, {
          state: JOB_STATES.CANCELLED,
          remoteState: 'JOB_STATE_CANCELLED',
          pausedFromState: null,
        });
        sendRunEvent(window, {
          kind: 'job-updated',
          job: cancelledJob,
        });
        return cancelledJob;
      }

      const apiKey = await this.settingsStore.getApiKey();
      if (!apiKey) {
        throw new Error('Save a Gemini API key in Settings before cancelling a batch job.');
      }

      const gemini = new GeminiService({
        apiKey,
        model: job.model,
      });

      await gemini.cancelBatch(job.remoteJobName);
      const cancelledJob = await this.jobStore.patch(jobId, {
        state: JOB_STATES.CANCELLED,
        remoteState: 'JOB_STATE_CANCELLED',
        pausedFromState: null,
      });
      sendRunEvent(window, {
        kind: 'job-updated',
        job: cancelledJob,
      });
      return cancelledJob;
    }

    if (this.activeJobId !== jobId) {
      throw new Error('Only an active local job or submitted batch job can be cancelled.');
    }

    this.cancelRequestedJobs.add(jobId);
    this.pausedJobs.delete(jobId);
    const cancelledJob = await this.jobStore.patch(jobId, {
      state: JOB_STATES.CANCELLED,
      pausedFromState: null,
    });
    sendRunEvent(window, {
      kind: 'job-updated',
      job: cancelledJob,
    });
    return cancelledJob;
  }

  async refreshBatch({ jobId, window, silent = false }) {
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

    if (job.localTestMode) {
      return this.#refreshMockBatch(job, { window, silent });
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

    if (!silent) {
      sendRunEvent(window, {
        kind: 'job-log',
        jobId,
        message: 'Refreshing Gemini batch status...',
      });
    }
    let processingStarted = false;
    try {
      const remoteBatch = await this.#callGeminiWithRateLimitRetry({
        geminiCall: () => gemini.getBatch(job.remoteJobName),
        jobId,
        window,
        jobState: job.state,
        operationLabel: 'Refreshing batch status',
      });
      const remoteState = remoteBatch.state || 'UNKNOWN';
      const failedRemoteState =
        remoteState === 'JOB_STATE_FAILED' ||
        remoteState === 'JOB_STATE_CANCELLED' ||
        remoteState === 'JOB_STATE_EXPIRED';

      let nextJob = await this.jobStore.patch(job.id, {
        remoteState,
        lastPolledAt: now(),
        remoteResultFileName: remoteBatch.dest?.fileName || job.remoteResultFileName || null,
        state:
          remoteState === 'JOB_STATE_SUCCEEDED'
            ? JOB_STATES.PROCESSING
            : remoteState === 'JOB_STATE_CANCELLED'
              ? JOB_STATES.CANCELLED
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
          state:
            remoteState === 'JOB_STATE_CANCELLED' ? JOB_STATES.CANCELLED : JOB_STATES.FAILED,
          summary: summarizeRequests(nextJob.requests),
          remoteResultFileName: remoteBatch.dest?.fileName || job.remoteResultFileName || null,
          lastPolledAt: now(),
          activityMessage: null,
          retryAttempt: null,
          retryScheduledAt: null,
          lastRateLimitError: null,
          pausedFromState: null,
        });
      }

      if (remoteState !== 'JOB_STATE_SUCCEEDED') {
        return nextJob;
      }

      processingStarted = true;
      const requests = await this.#processBatchResults({
        gemini,
        job: nextJob,
        window,
        remoteBatch,
      });

      const failedCount = requests.filter((item) => item.status === 'failed').length;
      nextJob = await this.jobStore.patch(job.id, {
        requests,
        summary: summarizeRequests(requests),
        state: failedCount ? JOB_STATES.PARTIAL : JOB_STATES.COMPLETED,
        remoteState: remoteBatch.state,
        remoteResultFileName: remoteBatch.dest?.fileName || job.remoteResultFileName || null,
        lastPolledAt: now(),
        activityMessage: null,
        retryAttempt: null,
        retryScheduledAt: null,
        lastRateLimitError: null,
        pausedFromState: null,
      });

      sendRunEvent(window, {
        kind: 'job-updated',
        job: nextJob,
      });

      return nextJob;
    } catch (error) {
      if (error instanceof RunCancelledError) {
        const cancelledJob = await this.jobStore.patch(job.id, {
          state: JOB_STATES.CANCELLED,
          activityMessage: null,
          retryAttempt: null,
          retryScheduledAt: null,
          lastRateLimitError: null,
          pausedFromState: null,
        });
        sendRunEvent(window, {
          kind: 'job-updated',
          job: cancelledJob,
        });
        return cancelledJob;
      }
      if (processingStarted) {
        const failedJob = await this.jobStore.patch(job.id, {
          state: JOB_STATES.FAILED,
          activityMessage: null,
          retryAttempt: null,
          retryScheduledAt: null,
          lastRateLimitError: null,
          pausedFromState: null,
        });
        sendRunEvent(window, {
          kind: 'job-updated',
          job: failedJob,
        });
      }
      throw error;
    } finally {
      this.cancelRequestedJobs.delete(jobId);
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
      activityMessage: null,
      retryAttempt: null,
      retryScheduledAt: null,
      lastRateLimitError: null,
    });

    sendRunEvent(window, {
      kind: 'job-updated',
      job: runningJob,
    });

    let completed = 0;

    for (const request of requests) {
      await this.#waitIfPaused(job.id);
      this.#throwIfCancelled(job.id);

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
        await this.#checkpointRequests(job.id, requests, {
          state: JOB_STATES.RUNNING,
          pausedFromState: null,
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

        const result = await this.#callGeminiWithRateLimitRetry({
          geminiCall: () =>
            gemini.generateImage({
              prompt,
              referenceUpload: uploadedReference,
              carUpload: uploadedCar,
              searchEnabled: settings.searchEnabled,
            }),
          jobId: job.id,
          window,
          jobState: JOB_STATES.RUNNING,
          operationLabel: `Generating ${fileName(request.outputFile)}`,
        });
        this.#throwIfCancelled(job.id);

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
        await this.#checkpointRequests(job.id, requests, {
          state: JOB_STATES.RUNNING,
          pausedFromState: null,
        });
      } catch (error) {
        if (error instanceof RunCancelledError) {
          throw error;
        }
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
        await this.#checkpointRequests(job.id, requests, {
          state: JOB_STATES.RUNNING,
          activityMessage: null,
          retryAttempt: null,
          retryScheduledAt: null,
          pausedFromState: null,
        });
      }
    }

    const failedCount = requests.filter((request) => request.status === 'failed').length;
    const nextJob = await this.jobStore.patch(job.id, {
      requests,
      summary: summarizeRequests(requests),
      state: failedCount ? JOB_STATES.PARTIAL : JOB_STATES.COMPLETED,
      activityMessage: null,
      retryAttempt: null,
      retryScheduledAt: null,
      lastRateLimitError: null,
      pausedFromState: null,
    });

    sendRunEvent(window, {
      kind: 'job-updated',
      job: nextJob,
    });

    return nextJob;
  }

  async #runSyncMock(job, { window }) {
    let requests = [...job.requests];
    let completed = 0;

    const runningJob = await this.jobStore.patch(job.id, {
      state: JOB_STATES.RUNNING,
      activityMessage: null,
      retryAttempt: null,
      retryScheduledAt: null,
      lastRateLimitError: null,
    });

    sendRunEvent(window, {
      kind: 'job-updated',
      job: runningJob,
    });

    for (const request of requests) {
      await this.#waitIfPaused(job.id);
      this.#throwIfCancelled(job.id);

      if (await pathExists(request.outputFile)) {
        requests = patchRequest(requests, request.key, {
          status: 'skipped',
        });
        completed += 1;
        sendRunEvent(window, {
          kind: 'job-progress',
          jobId: job.id,
          completed,
          total: requests.length,
          message: `Skipped existing ${fileName(request.outputFile)} in Local Test Mode`,
        });
        await this.#checkpointRequests(job.id, requests, {
          state: JOB_STATES.RUNNING,
          pausedFromState: null,
        });
        continue;
      }

      if (this.#shouldMockFail(request)) {
        const message = this.#mockFailureMessage();
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
          message: `Failed ${fileName(request.outputFile)} in Local Test Mode: ${message}`,
        });
        await this.#checkpointRequests(job.id, requests, {
          state: JOB_STATES.RUNNING,
          pausedFromState: null,
        });
        continue;
      }

      await this.#writeMockOutput(request.outputFile);
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
        message: `Saved ${fileName(request.outputFile)} in Local Test Mode`,
      });
      await this.#checkpointRequests(job.id, requests, {
        state: JOB_STATES.RUNNING,
        pausedFromState: null,
      });
    }

    const failedCount = requests.filter((request) => request.status === 'failed').length;
    const nextJob = await this.jobStore.patch(job.id, {
      requests,
      summary: summarizeRequests(requests),
      state: failedCount ? JOB_STATES.PARTIAL : JOB_STATES.COMPLETED,
      activityMessage: null,
      retryAttempt: null,
      retryScheduledAt: null,
      lastRateLimitError: null,
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
      activityMessage: null,
      retryAttempt: null,
      retryScheduledAt: null,
      lastRateLimitError: null,
    });

    sendRunEvent(window, {
      kind: 'job-updated',
      job: runningJob,
    });

    const referenceUploads = new Map();
    const referenceUploadErrors = new Map();
    const carUploads = new Map();
    const carUploadErrors = new Map();
    const batchFileRecords = [];
    let requests = [...job.requests];
    let completed = 0;

    for (const request of requests) {
      await this.#waitIfPaused(job.id);
      this.#throwIfCancelled(job.id);

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

        batchFileRecords.push(
          gemini.buildBatchFileRecord({
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
        if (error instanceof RunCancelledError) {
          throw error;
        }
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
        await this.#checkpointRequests(job.id, requests, {
          state: JOB_STATES.RUNNING,
          activityMessage: null,
          retryAttempt: null,
          retryScheduledAt: null,
          pausedFromState: null,
        });
      }
    }

    if (!batchFileRecords.length) {
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

    sendRunEvent(window, {
      kind: 'job-log',
      jobId: job.id,
      message: 'Uploading batch request file...',
    });

    const uploadedBatchFile = await this.#callGeminiWithRateLimitRetry({
      geminiCall: () =>
        gemini.uploadJsonlFile({
          text: `${batchFileRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
          displayName: `${job.id}.jsonl`,
        }),
      jobId: job.id,
      window,
      jobState: JOB_STATES.RUNNING,
      operationLabel: 'Uploading batch request file',
    });

    const remoteJob = await this.#callGeminiWithRateLimitRetry({
      geminiCall: () =>
        gemini.createBatch({
          inputFileName: uploadedBatchFile.name,
          displayName: job.id,
        }),
      jobId: job.id,
      window,
      jobState: JOB_STATES.RUNNING,
      operationLabel: 'Submitting Gemini batch',
    });

    const nextJob = await this.jobStore.patch(job.id, {
      requests,
      summary: summarizeRequests(requests),
      state: JOB_STATES.SUBMITTED,
      remoteJobName: remoteJob.name,
      remoteState: remoteJob.state || 'JOB_STATE_PENDING',
      remoteInputFileName: uploadedBatchFile.name,
      batchFormat: 'file',
      activityMessage: null,
      retryAttempt: null,
      retryScheduledAt: null,
      lastRateLimitError: null,
      pausedFromState: null,
    });

    sendRunEvent(window, {
      kind: 'job-updated',
      job: nextJob,
    });

    return nextJob;
  }

  async #submitBatchMock(job, { window }) {
    let requests = [...job.requests];
    let completed = 0;

    const runningJob = await this.jobStore.patch(job.id, {
      state: JOB_STATES.RUNNING,
      activityMessage: null,
      retryAttempt: null,
      retryScheduledAt: null,
      lastRateLimitError: null,
    });

    sendRunEvent(window, {
      kind: 'job-updated',
      job: runningJob,
    });

    for (const request of requests) {
      await this.#waitIfPaused(job.id);
      this.#throwIfCancelled(job.id);

      if (await pathExists(request.outputFile)) {
        requests = patchRequest(requests, request.key, {
          status: 'skipped',
        });
        completed += 1;
        continue;
      }

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
        message: `Queued ${fileName(request.outputFile)} for Local Test Mode batch`,
      });
    }

    const nextJob = await this.jobStore.patch(job.id, {
      requests,
      summary: summarizeRequests(requests),
      state: JOB_STATES.SUBMITTED,
      remoteJobName: `mock-batch/${job.id}`,
      remoteState: 'JOB_STATE_PENDING',
      mockBatchPollCount: 0,
      activityMessage: null,
      retryAttempt: null,
      retryScheduledAt: null,
      lastRateLimitError: null,
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
      const uploadedFile = await this.#callGeminiWithRateLimitRetry({
        geminiCall: () => gemini.uploadFile(filePath),
        jobId,
        window,
        jobState: this.activeJobId === jobId ? JOB_STATES.RUNNING : JOB_STATES.SUBMITTED,
        operationLabel: `Uploading ${fileRole} ${fileName(filePath)}`,
      });
      cache.set(filePath, uploadedFile);
      return uploadedFile;
    } catch (error) {
      const message = `${this.#formatFileRole(fileRole)} upload failed for ${fileName(filePath)}: ${serializeError(error)}`;
      if (!(error?.rateLimit || isRateLimitError(error))) {
        errorCache.set(filePath, message);
      }
      throw new Error(message);
    }
  }

  #formatFileRole(fileRole) {
    return fileRole.charAt(0).toUpperCase() + fileRole.slice(1);
  }

  async #processBatchResults({ gemini, job, window, remoteBatch }) {
    log.info('processBatchResults: remoteBatch.dest =', JSON.stringify(remoteBatch.dest));

    const inlinedResponses =
      remoteBatch.dest?.inlinedResponses ||
      remoteBatch.dest?.inlined_responses ||
      [];

    let responseItems = inlinedResponses;
    if (!responseItems.length && remoteBatch.dest?.fileName) {
      responseItems = await this.#downloadBatchResultFile({
        gemini,
        job,
        fileName: remoteBatch.dest.fileName,
      });
    }

    log.info('processBatchResults: responseItems.length =', responseItems.length);
    if (!responseItems.length) {
      throw new Error(
        `The batch finished but no results were returned. remoteBatch.dest = ${JSON.stringify(remoteBatch.dest)}`,
      );
    }

    let requests = [...job.requests];
    let completed = 0;

    for (const responseItem of responseItems) {
      await this.#waitIfPaused(job.id);
      this.#throwIfCancelled(job.id);

      const key =
        responseItem.metadata?.requestKey ||
        responseItem.key ||
        responseItem.metadata?.key ||
        null;
      if (!key) {
        log.warn('processBatchResults: responseItem has no key, skipping. keys present:', Object.keys(responseItem));
        continue;
      }

      const request = requests.find((item) => item.key === key);
      if (!request) {
        log.warn('processBatchResults: no matching request for key', key);
        continue;
      }

      if (await pathExists(request.outputFile)) {
        requests = patchRequest(requests, key, {
          status: 'skipped',
        });
        completed += 1;
        await this.#checkpointRequests(job.id, requests, {
          state: JOB_STATES.PROCESSING,
          remoteState: remoteBatch.state,
          activityMessage: null,
          retryAttempt: null,
          retryScheduledAt: null,
          lastRateLimitError: null,
          pausedFromState: null,
        });
        continue;
      }

      if (responseItem.error) {
        requests = patchRequest(requests, key, {
          status: 'failed',
          error:
            responseItem.error.message ||
            serializeError(responseItem.error) ||
            'Unknown Gemini batch error.',
        });
        completed += 1;
        await this.#checkpointRequests(job.id, requests, {
          state: JOB_STATES.PROCESSING,
          remoteState: remoteBatch.state,
          activityMessage: null,
          retryAttempt: null,
          retryScheduledAt: null,
          lastRateLimitError: null,
          pausedFromState: null,
        });
        continue;
      }

      const image = extractFirstInlineImage(responseItem.response);
      if (!image) {
        requests = patchRequest(requests, key, {
          status: 'failed',
          error: 'Gemini batch response returned no image data.',
        });
        completed += 1;
        await this.#checkpointRequests(job.id, requests, {
          state: JOB_STATES.PROCESSING,
          remoteState: remoteBatch.state,
          activityMessage: null,
          retryAttempt: null,
          retryScheduledAt: null,
          lastRateLimitError: null,
          pausedFromState: null,
        });
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
        jobId: job.id,
        completed,
        total: responseItems.length,
        message: `Saved ${fileName(request.outputFile)}`,
      });
      await this.#checkpointRequests(job.id, requests, {
        state: JOB_STATES.PROCESSING,
        remoteState: remoteBatch.state,
        activityMessage: null,
        retryAttempt: null,
        retryScheduledAt: null,
        lastRateLimitError: null,
        pausedFromState: null,
      });
    }

    return requests;
  }

  async #downloadBatchResultFile({ gemini, job, fileName }) {
    await ensureDirectory(this.batchCacheDir);
    const downloadPath = path.join(this.batchCacheDir, `${job.id}-results.jsonl`);
    await this.#callGeminiWithRateLimitRetry({
      geminiCall: () =>
        gemini.downloadFile({
          fileName,
          downloadPath,
        }),
      jobId: job.id,
      window: null,
      jobState: JOB_STATES.PROCESSING,
      operationLabel: 'Downloading batch results',
    });
    const content = await fs.readFile(downloadPath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async #refreshMockBatch(job, { window, silent = false }) {
    if (this.activeJobId && this.activeJobId !== job.id) {
      throw new Error('Another local job is active. Finish or pause that job first.');
    }
    this.activeJobId = job.id;

    if (!silent) {
      sendRunEvent(window, {
        kind: 'job-log',
        jobId: job.id,
        message: 'Refreshing Local Test Mode batch status...',
      });
    }

    try {
      const pollCount = Number(job.mockBatchPollCount || 0);

      if (pollCount < 1) {
        const processingJob = await this.jobStore.patch(job.id, {
          state: JOB_STATES.PROCESSING,
          remoteState: 'JOB_STATE_RUNNING',
          mockBatchPollCount: pollCount + 1,
          activityMessage: null,
          retryAttempt: null,
          retryScheduledAt: null,
          lastRateLimitError: null,
          pausedFromState: null,
        });

        sendRunEvent(window, {
          kind: 'job-updated',
          job: processingJob,
        });

        return processingJob;
      }

      let requests = [...job.requests];
      let completed = 0;

      for (const request of requests) {
        await this.#waitIfPaused(job.id);
        this.#throwIfCancelled(job.id);

        if (['completed', 'skipped', 'failed'].includes(request.status)) {
          completed += 1;
          continue;
        }

        if (await pathExists(request.outputFile)) {
          requests = patchRequest(requests, request.key, {
            status: 'skipped',
          });
          completed += 1;
          await this.#checkpointRequests(job.id, requests, {
            state: JOB_STATES.PROCESSING,
            remoteState: 'JOB_STATE_RUNNING',
            pausedFromState: null,
          });
          continue;
        }

        if (this.#shouldMockFail(request)) {
          const message = this.#mockFailureMessage();
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
            message: `Failed ${fileName(request.outputFile)} in Local Test Mode batch: ${message}`,
          });
          await this.#checkpointRequests(job.id, requests, {
            state: JOB_STATES.PROCESSING,
            remoteState: 'JOB_STATE_RUNNING',
            pausedFromState: null,
          });
          continue;
        }

        await this.#writeMockOutput(request.outputFile);
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
          message: `Saved ${fileName(request.outputFile)} in Local Test Mode batch`,
        });
        await this.#checkpointRequests(job.id, requests, {
          state: JOB_STATES.PROCESSING,
          remoteState: 'JOB_STATE_RUNNING',
          pausedFromState: null,
        });
      }

      const failedCount = requests.filter((request) => request.status === 'failed').length;
      const nextJob = await this.jobStore.patch(job.id, {
        requests,
        summary: summarizeRequests(requests),
        state: failedCount ? JOB_STATES.PARTIAL : JOB_STATES.COMPLETED,
        remoteState: 'JOB_STATE_SUCCEEDED',
        mockBatchPollCount: pollCount + 1,
        activityMessage: null,
        retryAttempt: null,
        retryScheduledAt: null,
        lastRateLimitError: null,
        pausedFromState: null,
      });

      sendRunEvent(window, {
        kind: 'job-updated',
        job: nextJob,
      });

      return nextJob;
    } catch (error) {
      if (error instanceof RunCancelledError) {
        const cancelledJob = await this.jobStore.patch(job.id, {
          state: JOB_STATES.CANCELLED,
          remoteState: 'JOB_STATE_CANCELLED',
          activityMessage: null,
          retryAttempt: null,
          retryScheduledAt: null,
          lastRateLimitError: null,
          pausedFromState: null,
        });
        sendRunEvent(window, {
          kind: 'job-updated',
          job: cancelledJob,
        });
        return cancelledJob;
      }
      throw error;
    } finally {
      this.cancelRequestedJobs.delete(job.id);
      this.pausedJobs.delete(job.id);
      this.activeJobId = null;
    }
  }

  #shouldMockFail(request) {
    return [request.carFile, request.referenceFile, request.outputFile, request.key]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(MOCK_FAILURE_TOKEN));
  }

  #mockFailureMessage() {
    return `Local Test Mode simulated a failure because a filename contains "${MOCK_FAILURE_TOKEN}".`;
  }

  async #writeMockOutput(outputFile) {
    await ensureDirectory(path.dirname(outputFile));
    await fs.writeFile(outputFile, MOCK_OUTPUT_PNG);
  }

  async #checkpointRequests(jobId, requests, patch = {}) {
    return this.jobStore.patch(jobId, {
      requests,
      summary: summarizeRequests(requests),
      ...patch,
    });
  }

  async #callGeminiWithRateLimitRetry({
    geminiCall,
    jobId,
    window,
    jobState,
    operationLabel,
  }) {
    let attempt = 0;

    while (true) {
      await this.#waitIfPaused(jobId);
      this.#throwIfCancelled(jobId);

      try {
        const result = await geminiCall();
        this.#throwIfCancelled(jobId);
        if (attempt > 0) {
          await this.#updateJobActivity(jobId, {
            state: jobState,
            activityMessage: null,
            retryAttempt: null,
            retryScheduledAt: null,
            lastRateLimitError: null,
            pausedFromState: null,
          }, window);
        }
        return result;
      } catch (error) {
        if (!isRateLimitError(error)) {
          throw error;
        }

        attempt += 1;
        if (attempt > this.rateLimitRetryOptions.maxAttempts) {
          const message = `${operationLabel} hit Gemini rate limits too many times and stopped. ${serializeError(error)}`;
          const rateLimitError = new Error(message);
          rateLimitError.rateLimit = true;
          rateLimitError.cause = error;
          throw rateLimitError;
        }

        const delayMs = retryDelayMsFromError(error, attempt, this.rateLimitRetryOptions);
        const retryScheduledAt = new Date(Date.now() + delayMs).toISOString();
        const message = `${operationLabel} hit a Gemini rate limit. Retry ${attempt} of ${this.rateLimitRetryOptions.maxAttempts} in ${this.#formatDelay(delayMs)}.`;

        await this.#updateJobActivity(
          jobId,
          {
            state: jobState,
            activityMessage: message,
            retryAttempt: attempt,
            retryScheduledAt,
            lastRateLimitError: serializeError(error),
            pausedFromState: null,
          },
          window,
        );
        sendRunEvent(window, {
          kind: 'job-log',
          jobId,
          message,
        });
        await this.#sleepWithPauseAndCancel(jobId, delayMs);
      }
    }
  }

  async #updateJobActivity(jobId, patch, window) {
    const job = await this.jobStore.patch(jobId, patch);
    sendRunEvent(window, {
      kind: 'job-updated',
      job,
    });
    return job;
  }

  #throwIfCancelled(jobId) {
    if (this.cancelRequestedJobs.has(jobId)) {
      throw new RunCancelledError();
    }
  }

  async #sleepWithPauseAndCancel(jobId, delayMs) {
    let remainingMs = delayMs;
    while (remainingMs > 0) {
      await this.#waitIfPaused(jobId);
      this.#throwIfCancelled(jobId);
      const sliceMs = Math.min(this.rateLimitRetryOptions.sleepSliceMs, remainingMs);
      await new Promise((resolve) => setTimeout(resolve, sliceMs));
      remainingMs -= sliceMs;
    }
  }

  #formatDelay(delayMs) {
    if (delayMs < 1000) {
      return `${delayMs}ms`;
    }

    const seconds = delayMs / 1000;
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  }

  async #waitIfPaused(jobId) {
    while (this.pausedJobs.has(jobId)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
