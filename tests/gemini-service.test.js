import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createPartFromUri } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractFirstInlineImage,
  GeminiService,
  isRateLimitError,
  mimeTypeForFile,
  retryDelayMsFromError,
} from '../src/main/services/gemini-service.js';

const temporaryDirectories = [];

afterEach(async () => {
  vi.restoreAllMocks();

  while (temporaryDirectories.length) {
    const directoryPath = temporaryDirectories.pop();
    await fs.rm(directoryPath, { recursive: true, force: true });
  }
});

describe('GeminiService helpers', () => {
  it('extracts the first inline image payload from a response', () => {
    const image = extractFirstInlineImage({
      candidates: [
        {
          content: {
            parts: [
              {
                text: 'ignored',
              },
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: Buffer.from('hello').toString('base64'),
                },
              },
            ],
          },
        },
      ],
    });

    expect(image).toEqual({
      mimeType: 'image/png',
      data: Buffer.from('hello').toString('base64'),
    });
  });

  it('infers supported image mime types from the file extension', () => {
    expect(mimeTypeForFile('/tmp/car.jpg')).toBe('image/jpeg');
    expect(mimeTypeForFile('/tmp/car.jpeg')).toBe('image/jpeg');
    expect(mimeTypeForFile('/tmp/car.png')).toBe('image/png');
    expect(mimeTypeForFile('/tmp/car.webp')).toBe('image/webp');
    expect(mimeTypeForFile('/tmp/car.gif')).toBeNull();
  });

  it('uploads image bytes as a blob so unicode file paths do not break uploads', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-service-'));
    temporaryDirectories.push(tempDirectory);

    const imagePath = path.join(tempDirectory, 'blue（widebody）.png');
    await fs.writeFile(imagePath, Buffer.from('image-data'));

    const service = new GeminiService({ apiKey: 'test-key' });
    const upload = vi.fn().mockResolvedValue({
      uri: 'mock://file',
      mimeType: 'image/png',
    });

    service.ai = {
      files: {
        upload,
      },
    };

    await service.uploadFile(imagePath);

    expect(upload).toHaveBeenCalledTimes(1);
    const [payload] = upload.mock.calls[0];
    expect(payload.config).toEqual({
      mimeType: 'image/png',
    });
    expect(payload.file).toBeInstanceOf(Blob);
    expect(payload.file.type).toBe('image/png');
    expect(Buffer.from(await payload.file.arrayBuffer())).toEqual(Buffer.from('image-data'));
  });

  it('builds file-batch records in Gemini request format', () => {
    const service = new GeminiService({ apiKey: 'test-key' });

    const record = service.buildBatchFileRecord({
      prompt: 'test prompt',
      referenceUpload: { uri: 'files/ref', mimeType: 'image/png' },
      carUpload: { uri: 'files/car', mimeType: 'image/png' },
      metadata: { requestKey: 'req-1' },
      searchEnabled: true,
    });

    expect(record.metadata).toEqual({ requestKey: 'req-1' });
    expect(record.request.contents).toHaveLength(1);
    expect(record.request.contents[0].parts[0]).toEqual({ text: 'test prompt' });
    expect(record.request.contents[0].parts[1]).toEqual(
      createPartFromUri('files/ref', 'image/png'),
    );
    expect(record.request.contents[0].parts[2]).toEqual(
      createPartFromUri('files/car', 'image/png'),
    );
    expect(record.request.generationConfig).toEqual({
      responseModalities: ['IMAGE'],
      imageConfig: {
        aspectRatio: '1:1',
        imageSize: '1K',
      },
    });
    expect(record.request.tools).toBeTruthy();
  });

  it('detects rate-limit style Gemini errors and derives retry delays', () => {
    const rateLimitError = Object.assign(new Error('429 RESOURCE_EXHAUSTED: retry after 7s'), {
      status: 429,
    });

    expect(isRateLimitError(rateLimitError)).toBe(true);
    expect(retryDelayMsFromError(rateLimitError, 1, { baseDelayMs: 1000, maxDelayMs: 10000 })).toBe(
      7000,
    );

    const retryInfoError = Object.assign(new Error('too many requests'), {
      details: [{ retryDelay: '12s' }],
    });
    expect(retryDelayMsFromError(retryInfoError, 2, { baseDelayMs: 1000, maxDelayMs: 15000 })).toBe(
      12000,
    );

    const genericRateLimitError = new Error('Rate limit exceeded');
    expect(isRateLimitError(genericRateLimitError)).toBe(true);
    expect(
      retryDelayMsFromError(genericRateLimitError, 3, {
        baseDelayMs: 500,
        maxDelayMs: 5000,
      }),
    ).toBe(2000);
  });
});
