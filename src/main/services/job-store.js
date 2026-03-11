import fs from 'node:fs/promises';
import path from 'node:path';

import { JOBS_FILE_NAME } from '../../shared/constants.js';

function sortJobs(jobs) {
  return [...jobs].sort((left, right) =>
    (right.updatedAt || '').localeCompare(left.updatedAt || ''),
  );
}

export class JobStore {
  constructor({ userDataPath }) {
    this.jobsPath = path.join(userDataPath, JOBS_FILE_NAME);
  }

  async list() {
    const jobs = await this.#read();
    return sortJobs(jobs);
  }

  async get(jobId) {
    const jobs = await this.#read();
    return jobs.find((job) => job.id === jobId) || null;
  }

  async upsert(job) {
    const jobs = await this.#read();
    const nextJobs = jobs.filter((existing) => existing.id !== job.id);
    nextJobs.push({
      ...job,
      updatedAt: new Date().toISOString(),
    });
    await this.#write(nextJobs);
    return job;
  }

  async patch(jobId, patch) {
    const jobs = await this.#read();
    const target = jobs.find((job) => job.id === jobId);
    if (!target) {
      throw new Error(`Unknown job: ${jobId}`);
    }

    const next = {
      ...target,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    await this.#write([
      ...jobs.filter((job) => job.id !== jobId),
      next,
    ]);

    return next;
  }

  async #read() {
    try {
      const content = await fs.readFile(this.jobsPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async #write(jobs) {
    await fs.mkdir(path.dirname(this.jobsPath), { recursive: true });
    await fs.writeFile(this.jobsPath, JSON.stringify(sortJobs(jobs), null, 2));
  }
}
