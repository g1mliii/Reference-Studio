import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createPartFromUri,
  createPartFromText,
  createUserContent,
  GoogleGenAI,
} from '@google/genai';

import { DEFAULT_IMAGE_CONFIG, DEFAULT_MODEL } from '../../shared/constants.js';

const MIME_TYPES_BY_EXTENSION = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
});

export function mimeTypeForFile(filePath) {
  return MIME_TYPES_BY_EXTENSION[path.extname(filePath).toLowerCase()] || null;
}

function extractNumericStatus(error) {
  const candidates = [
    error?.status,
    error?.code,
    error?.cause?.status,
    error?.cause?.code,
    error?.response?.status,
  ];

  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

function headersRetryAfter(headers) {
  if (!headers) {
    return null;
  }

  const rawValue =
    headers?.get?.('retry-after') ??
    headers?.['retry-after'] ??
    headers?.retryAfter ??
    null;

  if (!rawValue) {
    return null;
  }

  const seconds = Number(rawValue);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const dateMs = Date.parse(rawValue);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function parseDurationToMs(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s)?$/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }

  return match[2]?.toLowerCase() === 'ms'
    ? Math.round(amount)
    : Math.round(amount * 1000);
}

function retryDelayFromDetails(error) {
  const details = Array.isArray(error?.details) ? error.details : [];
  for (const detail of details) {
    const delay =
      detail?.retryDelay ??
      detail?.retry_delay ??
      detail?.metadata?.retryDelay ??
      detail?.metadata?.retry_delay ??
      null;
    const parsed = parseDurationToMs(delay);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function retryDelayFromMessage(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  const retryDelayMatch =
    message.match(/retry(?:\s+after|\s+in)?\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)/i) ||
    message.match(/retryDelay["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)(ms|s)/i);

  if (!retryDelayMatch) {
    return null;
  }

  const amount = Number(retryDelayMatch[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }

  return retryDelayMatch[2].toLowerCase().startsWith('ms')
    ? Math.round(amount)
    : Math.round(amount * 1000);
}

export function isRateLimitError(error) {
  if (error?.rateLimit) {
    return true;
  }

  const numericStatus = extractNumericStatus(error);
  if (numericStatus === 429) {
    return true;
  }

  const haystack = [
    error?.status,
    error?.code,
    error?.name,
    error instanceof Error ? error.message : String(error || ''),
  ]
    .filter(Boolean)
    .join(' ');

  return /(rate\s*limit|resource[_\s-]*exhausted|too many requests|quota exceeded|429)/i.test(
    haystack,
  );
}

export function retryDelayMsFromError(
  error,
  attempt,
  { baseDelayMs = 4000, maxDelayMs = 60000 } = {},
) {
  const explicitDelay =
    headersRetryAfter(error?.headers) ||
    headersRetryAfter(error?.response?.headers) ||
    retryDelayFromDetails(error) ||
    retryDelayFromMessage(error);

  if (explicitDelay !== null) {
    return Math.min(maxDelayMs, Math.max(baseDelayMs, explicitDelay));
  }

  const backoff = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxDelayMs, backoff);
}

function createSearchTool(searchEnabled) {
  if (!searchEnabled) {
    return undefined;
  }

  return [
    {
      googleSearch: {
        searchTypes: {
          webSearch: {},
        },
      },
    },
  ];
}

function buildConfig(searchEnabled) {
  return {
    responseModalities: ['IMAGE'],
    imageConfig: DEFAULT_IMAGE_CONFIG,
    tools: createSearchTool(searchEnabled),
  };
}

export function extractFirstInlineImage(response) {
  for (const candidate of response?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (part.inlineData?.data && part.inlineData?.mimeType) {
        return {
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType,
        };
      }
    }
  }

  if (response?.data) {
    return {
      data: response.data,
      mimeType: 'image/png',
    };
  }

  return null;
}

export class GeminiService {
  constructor({ apiKey, model = DEFAULT_MODEL }) {
    this.model = model;
    this.ai = new GoogleGenAI({ apiKey });
  }

  async uploadFile(filePath) {
    const mimeType = mimeTypeForFile(filePath);
    if (!mimeType) {
      throw new Error(
        `Unsupported image file type for upload: ${path.basename(filePath)}`,
      );
    }

    const buffer = await fs.readFile(filePath);
    const blob = new Blob([buffer], { type: mimeType });

    return this.ai.files.upload({
      file: blob,
      config: {
        mimeType,
      },
    });
  }

  async uploadJsonlFile({ text, displayName = 'batch-requests.jsonl' }) {
    const blob = new Blob([text], { type: 'application/jsonl' });

    return this.ai.files.upload({
      file: blob,
      config: {
        mimeType: 'jsonl',
        displayName,
      },
    });
  }

  buildRequest({ prompt, referenceUpload, carUpload, metadata, searchEnabled }) {
    return {
      contents: createUserContent([
        createPartFromText(prompt),
        createPartFromUri(referenceUpload.uri, referenceUpload.mimeType),
        createPartFromUri(carUpload.uri, carUpload.mimeType),
      ]),
      metadata,
      config: buildConfig(searchEnabled),
    };
  }

  buildBatchFileRecord({ prompt, referenceUpload, carUpload, metadata, searchEnabled }) {
    const inlinedRequest = this.buildRequest({
      prompt,
      referenceUpload,
      carUpload,
      metadata,
      searchEnabled,
    });
    const config = inlinedRequest.config || {};

    return {
      request: {
        contents: Array.isArray(inlinedRequest.contents)
          ? inlinedRequest.contents
          : [inlinedRequest.contents],
        ...(config.tools ? { tools: config.tools } : {}),
        generationConfig: {
          ...(config.responseModalities
            ? { responseModalities: config.responseModalities }
            : {}),
          ...(config.imageConfig ? { imageConfig: config.imageConfig } : {}),
        },
      },
      ...(metadata ? { metadata } : {}),
    };
  }

  async generateImage({ prompt, referenceUpload, carUpload, searchEnabled }) {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: createUserContent([
        createPartFromText(prompt),
        createPartFromUri(referenceUpload.uri, referenceUpload.mimeType),
        createPartFromUri(carUpload.uri, carUpload.mimeType),
      ]),
      config: buildConfig(searchEnabled),
    });

    const image = extractFirstInlineImage(response);
    if (!image) {
      throw new Error('Gemini returned no image data.');
    }

    return {
      buffer: Buffer.from(image.data, 'base64'),
      mimeType: image.mimeType,
      response,
    };
  }

  async createBatch({ requests, inputFileName, displayName }) {
    return this.ai.batches.create({
      model: this.model,
      src: inputFileName
        ? inputFileName
        : {
            inlinedRequests: requests,
          },
      config: {
        displayName,
      },
    });
  }

  async getBatch(name) {
    return this.ai.batches.get({ name });
  }

  async cancelBatch(name) {
    return this.ai.batches.cancel({ name });
  }

  async downloadFile({ fileName, downloadPath }) {
    await this.ai.files.download({
      file: fileName,
      downloadPath,
    });
  }

  async saveGeneratedFile({ buffer, outputFile }) {
    await fs.writeFile(outputFile, buffer);
  }
}
