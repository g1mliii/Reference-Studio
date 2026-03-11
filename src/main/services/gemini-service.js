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

  async createBatch({ requests, displayName }) {
    return this.ai.batches.create({
      model: this.model,
      src: {
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

  async saveGeneratedFile({ buffer, outputFile }) {
    await fs.writeFile(outputFile, buffer);
  }
}
