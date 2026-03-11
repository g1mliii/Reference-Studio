import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRunRequests, summarizeRequests } from '../src/shared/jobs.js';

describe('shared/jobs', () => {
  it('creates three requests for one car and three references', () => {
    const requests = createRunRequests({
      carFiles: ['/cars/blue,911-gt3-rs.png'],
      referenceFiles: [
        '/refs/front.png',
        '/refs/side.png',
        '/refs/rear.png',
      ],
      outputDir: '/out',
    });

    expect(requests).toHaveLength(3);
    expect(requests[0].outputFile).toBe(path.join('/out', 'blue,911-gt3-rs,front.png'));
  });

  it('summarizes request status counts', () => {
    expect(
      summarizeRequests([
        { status: 'completed' },
        { status: 'completed' },
        { status: 'failed' },
      ]),
    ).toEqual({
      completed: 2,
      failed: 1,
    });
  });
});
