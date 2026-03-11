import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_MODEL,
  DEFAULT_PROMPT,
  DEFAULT_SEARCH_ENABLED,
  SETTINGS_FILE_NAME,
} from '../../shared/constants.js';
import { normalizePrompt } from '../../shared/prompt.js';

function createSafeStorageAdapter(safeStorage) {
  return {
    canEncrypt() {
      return Boolean(safeStorage?.isEncryptionAvailable?.());
    },
    encrypt(plainText) {
      return safeStorage.encryptString(plainText).toString('base64');
    },
    decrypt(cipherText) {
      return safeStorage.decryptString(Buffer.from(cipherText, 'base64'));
    },
  };
}

function defaultSettingsData() {
  return {
    prompt: DEFAULT_PROMPT,
    referenceFiles: [],
    model: DEFAULT_MODEL,
    searchEnabled: DEFAULT_SEARCH_ENABLED,
    localTestMode: false,
    updateAutoCheck: true,
    encryptedApiKey: null,
    plainApiKey: null,
    apiKeyUpdatedAt: null,
    updatedAt: null,
  };
}

export class SettingsStore {
  constructor({ userDataPath, safeStorage }) {
    this.settingsPath = path.join(userDataPath, SETTINGS_FILE_NAME);
    this.safeAdapter = createSafeStorageAdapter(safeStorage);
  }

  async load() {
    const raw = await this.#read();
    return this.#present(raw);
  }

  async getApiKey() {
    const raw = await this.#read();
    return this.#decryptApiKey(raw);
  }

  async save(partialSettings) {
    const timestamp = new Date().toISOString();
    const current = await this.#read();
    const next = {
      ...current,
      prompt: normalizePrompt(partialSettings.prompt ?? current.prompt),
      referenceFiles: Array.isArray(partialSettings.referenceFiles)
        ? partialSettings.referenceFiles
        : current.referenceFiles,
      model: (partialSettings.model || current.model || DEFAULT_MODEL).trim(),
      searchEnabled:
        typeof partialSettings.searchEnabled === 'boolean'
          ? partialSettings.searchEnabled
          : current.searchEnabled,
      localTestMode:
        typeof partialSettings.localTestMode === 'boolean'
          ? partialSettings.localTestMode
          : current.localTestMode,
      updateAutoCheck:
        typeof partialSettings.updateAutoCheck === 'boolean'
          ? partialSettings.updateAutoCheck
          : current.updateAutoCheck,
      updatedAt: timestamp,
    };

    if (Object.hasOwn(partialSettings, 'apiKey')) {
      const apiKey = (partialSettings.apiKey || '').trim();
      if (apiKey) {
        if (this.safeAdapter.canEncrypt()) {
          next.encryptedApiKey = this.safeAdapter.encrypt(apiKey);
          // Keep a plain-text fallback for local persistence across signing/build changes.
          next.plainApiKey = apiKey;
        } else {
          next.encryptedApiKey = null;
          next.plainApiKey = apiKey;
        }
        next.apiKeyUpdatedAt = timestamp;
      }
    }

    await this.#write(next);
    return this.#present(next);
  }

  async clearApiKey() {
    const timestamp = new Date().toISOString();
    const current = await this.#read();
    const next = {
      ...current,
      encryptedApiKey: null,
      plainApiKey: null,
      apiKeyUpdatedAt: null,
      updatedAt: timestamp,
    };
    await this.#write(next);
    return this.#present(next);
  }

  async #read() {
    try {
      const content = await fs.readFile(this.settingsPath, 'utf8');
      const parsed = JSON.parse(content);
      return {
        ...defaultSettingsData(),
        ...parsed,
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return defaultSettingsData();
      }
      throw error;
    }
  }

  async #write(data) {
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    await fs.writeFile(this.settingsPath, JSON.stringify(data, null, 2));
  }

  #decryptApiKey(raw) {
    if (raw.encryptedApiKey) {
      try {
        return this.safeAdapter.decrypt(raw.encryptedApiKey);
      } catch {
        return raw.plainApiKey || '';
      }
    }
    return raw.plainApiKey || '';
  }

  #present(raw) {
    const apiKey = this.#decryptApiKey(raw);
    return {
      prompt: normalizePrompt(raw.prompt),
      referenceFiles: raw.referenceFiles || [],
      model: raw.model || DEFAULT_MODEL,
      searchEnabled:
        typeof raw.searchEnabled === 'boolean'
          ? raw.searchEnabled
          : DEFAULT_SEARCH_ENABLED,
      localTestMode:
        typeof raw.localTestMode === 'boolean' ? raw.localTestMode : false,
      updateAutoCheck:
        typeof raw.updateAutoCheck === 'boolean' ? raw.updateAutoCheck : true,
      hasApiKey: Boolean(apiKey),
      apiKeyPreview: apiKey ? `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}` : '',
      apiKeyUpdatedAt: raw.apiKeyUpdatedAt,
      updatedAt: raw.updatedAt,
    };
  }
}
