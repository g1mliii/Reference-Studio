import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { JobStore } from '../src/main/services/job-store.js';
import { GeminiService } from '../src/main/services/gemini-service.js';
import { RunManager } from '../src/main/services/run-manager.js';
import { JOB_STATES } from '../src/shared/constants.js';

const temporaryDirectories = [];

afterEach(async () => {
  vi.restoreAllMocks();

  while (temporaryDirectories.length) {
    const directoryPath = temporaryDirectories.pop();
    await fs.rm(directoryPath, { recursive: true, force: true });
  }
});

async function makeTempWorkspace() {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'run-manager-'));
  temporaryDirectories.push(rootDirectory);
  await fs.mkdir(path.join(rootDirectory, 'cars'), { recursive: true });
  await fs.mkdir(path.join(rootDirectory, 'refs'), { recursive: true });
  await fs.mkdir(path.join(rootDirectory, 'out'), { recursive: true });
  return rootDirectory;
}

describe('RunManager batch preparation', () => {
  it('keeps the batch run alive when one car upload fails', async () => {
    const rootDirectory = await makeTempWorkspace();
    const carsDir = path.join(rootDirectory, 'cars');
    const refsDir = path.join(rootDirectory, 'refs');
    const outputDir = path.join(rootDirectory, 'out');

    const goodCarPath = path.join(carsDir, 'blue,911-gt3-rs.png');
    const badCarPath = path.join(carsDir, 'bad（widebody）.png');
    const referencePath = path.join(refsDir, 'studio-front.png');

    await fs.writeFile(goodCarPath, Buffer.from('good-car'));
    await fs.writeFile(badCarPath, Buffer.from('bad-car'));
    await fs.writeFile(referencePath, Buffer.from('ref'));

    const settingsStore = {
      load: vi.fn().mockResolvedValue({
        referenceFiles: [referencePath],
        model: 'gemini-3-pro-image-preview',
        searchEnabled: true,
        prompt: 'prompt',
      }),
      getApiKey: vi.fn().mockResolvedValue('test-key'),
    };
    const jobStore = new JobStore({ userDataPath: rootDirectory });
    const runManager = new RunManager({
      settingsStore,
      jobStore,
    });

    vi.spyOn(GeminiService.prototype, 'uploadFile').mockImplementation(async (filePath) => {
      if (filePath === badCarPath) {
        throw new Error('invalid image payload');
      }

      return {
        uri: `mock://${path.basename(filePath)}`,
        mimeType: 'image/png',
      };
    });
    const buildRequestSpy = vi
      .spyOn(GeminiService.prototype, 'buildRequest')
      .mockImplementation(({ metadata }) => ({ metadata }));
    const createBatchSpy = vi
      .spyOn(GeminiService.prototype, 'createBatch')
      .mockResolvedValue({
        name: 'batches/mock-job',
        state: 'JOB_STATE_PENDING',
      });

    const job = await runManager.startRun({
      mode: 'batch',
      carsDir,
      outputDir,
      window: null,
    });

    expect(createBatchSpy).toHaveBeenCalledTimes(1);
    expect(buildRequestSpy).toHaveBeenCalledTimes(1);
    expect(job.state).toBe(JOB_STATES.SUBMITTED);
    expect(job.summary.submitted).toBe(1);
    expect(job.summary.failed).toBe(1);

    const failedRequest = job.requests.find((request) => request.carFile === badCarPath);
    const submittedRequest = job.requests.find((request) => request.carFile === goodCarPath);

    expect(failedRequest.status).toBe('failed');
    expect(failedRequest.error).toContain('Car upload failed');
    expect(submittedRequest.status).toBe('submitted');
    expect(submittedRequest.error).toBeNull();
  });
});

describe('RunManager local test mode', () => {
  it('runs sync jobs without an api key and writes placeholder outputs', async () => {
    const rootDirectory = await makeTempWorkspace();
    const carsDir = path.join(rootDirectory, 'cars');
    const refsDir = path.join(rootDirectory, 'refs');
    const outputDir = path.join(rootDirectory, 'out');

    const carPath = path.join(carsDir, 'blue,911-gt3-rs.png');
    const referencePath = path.join(refsDir, 'studio-front.png');

    await fs.writeFile(carPath, Buffer.from('good-car'));
    await fs.writeFile(referencePath, Buffer.from('ref'));

    const settingsStore = {
      load: vi.fn().mockResolvedValue({
        referenceFiles: [referencePath],
        model: 'gemini-3-pro-image-preview',
        searchEnabled: true,
        localTestMode: true,
        prompt: 'prompt',
      }),
      getApiKey: vi.fn().mockResolvedValue(''),
    };
    const jobStore = new JobStore({ userDataPath: rootDirectory });
    const runManager = new RunManager({
      settingsStore,
      jobStore,
    });

    const job = await runManager.startRun({
      mode: 'sync',
      carsDir,
      outputDir,
      window: null,
    });

    expect(job.state).toBe(JOB_STATES.COMPLETED);
    expect(job.summary.completed).toBe(1);
    expect(await fs.readFile(job.requests[0].outputFile)).not.toHaveLength(0);
  });

  it('simulates batch progress and per-file failures in local test mode', async () => {
    const rootDirectory = await makeTempWorkspace();
    const carsDir = path.join(rootDirectory, 'cars');
    const refsDir = path.join(rootDirectory, 'refs');
    const outputDir = path.join(rootDirectory, 'out');

    const goodCarPath = path.join(carsDir, 'blue,911-gt3-rs.png');
    const badCarPath = path.join(carsDir, 'mock-fail,911-gt3-rs.png');
    const referencePath = path.join(refsDir, 'studio-front.png');

    await fs.writeFile(goodCarPath, Buffer.from('good-car'));
    await fs.writeFile(badCarPath, Buffer.from('bad-car'));
    await fs.writeFile(referencePath, Buffer.from('ref'));

    const settingsStore = {
      load: vi.fn().mockResolvedValue({
        referenceFiles: [referencePath],
        model: 'gemini-3-pro-image-preview',
        searchEnabled: true,
        localTestMode: true,
        prompt: 'prompt',
      }),
      getApiKey: vi.fn().mockResolvedValue(''),
    };
    const jobStore = new JobStore({ userDataPath: rootDirectory });
    const runManager = new RunManager({
      settingsStore,
      jobStore,
    });

    const submittedJob = await runManager.startRun({
      mode: 'batch',
      carsDir,
      outputDir,
      window: null,
    });

    expect(submittedJob.state).toBe(JOB_STATES.SUBMITTED);
    expect(submittedJob.remoteJobName).toContain('mock-batch/');

    const processingJob = await runManager.refreshBatch({
      jobId: submittedJob.id,
      window: null,
    });
    expect(processingJob.state).toBe(JOB_STATES.PROCESSING);

    const completedJob = await runManager.refreshBatch({
      jobId: submittedJob.id,
      window: null,
    });
    expect(completedJob.state).toBe(JOB_STATES.PARTIAL);
    expect(completedJob.summary.completed).toBe(1);
    expect(completedJob.summary.failed).toBe(1);
  });
});
