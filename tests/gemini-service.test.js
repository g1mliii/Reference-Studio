import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractFirstInlineImage,
  GeminiService,
  mimeTypeForFile,
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
});
