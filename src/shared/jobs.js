import path from 'node:path';

import { buildOutputFileName, buildRequestKey } from './files.js';

export function createJobId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `job-${stamp}`;
}

export function createRunRequests({ carFiles, referenceFiles, outputDir }) {
  return carFiles.flatMap((carFile) =>
    referenceFiles.map((referenceFile) => ({
      key: buildRequestKey(carFile, referenceFile),
      carFile,
      referenceFile,
      outputFile: path.join(outputDir, buildOutputFileName(carFile, referenceFile)),
      status: 'pending',
      error: null,
    })),
  );
}

export function summarizeRequests(requests) {
  return requests.reduce(
    (summary, request) => {
      summary[request.status] = (summary[request.status] || 0) + 1;
      return summary;
    },
    {},
  );
}

export function patchRequest(requests, key, patch) {
  return requests.map((request) =>
    request.key === key ? { ...request, ...patch } : request,
  );
}
