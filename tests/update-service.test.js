import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { UpdateService } from '../src/main/services/update-service.js';
import {
  DEFAULT_UPDATE_REPO_NAME,
  DEFAULT_UPDATE_REPO_OWNER,
} from '../src/shared/constants.js';

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = false;
    this.autoInstallOnAppQuit = false;
    this.allowPrerelease = false;
    this.feedConfig = null;
    this.checkForUpdates = vi.fn().mockResolvedValue(null);
    this.quitAndInstall = vi.fn();
  }

  setFeedURL(config) {
    this.feedConfig = config;
  }
}

function makeWindow(events) {
  return {
    webContents: {
      send(channel, payload) {
        events.push({ channel, payload });
      },
    },
  };
}

describe('UpdateService', () => {
  it('stays launch-safe when no updater is available', async () => {
    const events = [];
    const service = new UpdateService({
      app: {
        getVersion: () => '0.1.0',
        isPackaged: true,
      },
      updater: null,
      windowProvider: () => makeWindow(events),
      logger: console,
    });

    const status = await service.configure({
      updateAutoCheck: true,
    });

    expect(status.state).toBe('disabled');
    expect(status.message).toBe('App updates are unavailable in this build.');
  });

  it('configures the built-in GitHub feed and checks for updates', async () => {
    const updater = new FakeUpdater();
    const events = [];
    const service = new UpdateService({
      app: {
        getVersion: () => '0.1.0',
        isPackaged: true,
      },
      updater,
      windowProvider: () => makeWindow(events),
      logger: console,
    });

    const status = await service.configure({
      updateAutoCheck: true,
    });

    expect(status.state).toBe('configured');
    expect(status.configured).toBe(true);
    expect(updater.feedConfig).toEqual({
      provider: 'github',
      owner: DEFAULT_UPDATE_REPO_OWNER,
      repo: DEFAULT_UPDATE_REPO_NAME,
      private: false,
    });
    expect(events.at(-1).channel).toBe('update:event');
    await service.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('marks a downloaded update as installable', async () => {
    const updater = new FakeUpdater();
    const service = new UpdateService({
      app: {
        getVersion: () => '0.1.0',
        isPackaged: true,
      },
      updater,
      windowProvider: () => null,
      logger: console,
    });

    await service.configure({
      updateAutoCheck: true,
    });
    updater.emit('update-downloaded', { version: '0.1.1' });

    expect(service.getStatus()).toMatchObject({
      state: 'downloaded',
      latestVersion: '0.1.1',
      canInstall: true,
    });

    service.installUpdateAndRestart();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
