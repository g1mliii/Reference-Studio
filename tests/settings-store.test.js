import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SettingsStore } from '../src/main/services/settings-store.js';

const tempDirectories = [];

async function makeTempDir() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'car-studio-settings-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

function fakeSafeStorage() {
  return {
    isEncryptionAvailable() {
      return true;
    },
    encryptString(value) {
      return Buffer.from(`enc:${value}`);
    },
    decryptString(value) {
      return value.toString().replace(/^enc:/, '');
    },
  };
}

function fakeBrokenSafeStorage() {
  return {
    isEncryptionAvailable() {
      return true;
    },
    encryptString(value) {
      return Buffer.from(`enc:${value}`);
    },
    decryptString() {
      throw new Error('decrypt failed');
    },
  };
}

describe('SettingsStore', () => {
  it('returns defaults before anything is saved', async () => {
    const store = new SettingsStore({
      userDataPath: await makeTempDir(),
      safeStorage: fakeSafeStorage(),
    });

    const settings = await store.load();

    expect(settings.hasApiKey).toBe(false);
    expect(settings.referenceFiles).toEqual([]);
    expect(settings.updateRepoOwner).toBe('');
    expect(settings.updateRepoName).toBe('');
    expect(settings.updateAutoCheck).toBe(true);
  });

  it('saves and decrypts the api key', async () => {
    const store = new SettingsStore({
      userDataPath: await makeTempDir(),
      safeStorage: fakeSafeStorage(),
    });

    await store.save({
      apiKey: 'abc123456789',
      referenceFiles: ['/refs/a.png', '/refs/b.png', '/refs/c.png'],
      prompt: 'Prompt',
      model: 'gemini-3-pro-image-preview',
      searchEnabled: true,
      updateRepoOwner: 'subaigsuri',
      updateRepoName: 'reference-studio',
      updateAutoCheck: false,
    });

    expect(await store.getApiKey()).toBe('abc123456789');
    const settings = await store.load();
    expect(settings.apiKeyPreview).toBe('abc1••••6789');
    expect(settings.updateRepoOwner).toBe('subaigsuri');
    expect(settings.updateRepoName).toBe('reference-studio');
    expect(settings.updateAutoCheck).toBe(false);
  });

  it('falls back to the plain-text copy if secure decrypt fails later', async () => {
    const directory = await makeTempDir();
    const writerStore = new SettingsStore({
      userDataPath: directory,
      safeStorage: fakeSafeStorage(),
    });

    await writerStore.save({
      apiKey: 'persist-me',
    });

    const readerStore = new SettingsStore({
      userDataPath: directory,
      safeStorage: fakeBrokenSafeStorage(),
    });

    expect(await readerStore.getApiKey()).toBe('persist-me');
    expect((await readerStore.load()).hasApiKey).toBe(true);
  });
});
