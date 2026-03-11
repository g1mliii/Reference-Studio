function now() {
  return new Date().toISOString();
}

function trim(value) {
  return String(value || '').trim();
}

function baseStatus(app) {
  return {
    currentVersion: app.getVersion(),
    repoOwner: '',
    repoName: '',
    autoCheck: true,
    isPackaged: app.isPackaged,
    configured: false,
    canInstall: false,
    state: app.isPackaged ? 'disabled' : 'unsupported',
    latestVersion: '',
    progressPercent: 0,
    lastCheckedAt: null,
    error: null,
    message: app.isPackaged
      ? 'Add a GitHub owner and repo to enable app updates.'
      : 'Update checks only run from the packaged app build.',
  };
}

function versionFromInfo(info) {
  return info?.version || info?.tag || '';
}

export class UpdateService {
  constructor({ app, updater, windowProvider, logger }) {
    this.app = app;
    this.updater = updater;
    this.windowProvider = windowProvider;
    this.logger = logger;
    this.status = baseStatus(app);
    this.feedKey = '';
    this.launchCheckStarted = false;

    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.allowPrerelease = false;

    this.#bindEvents();
  }

  getStatus() {
    return { ...this.status };
  }

  async configure(settings) {
    const repoOwner = trim(settings.updateRepoOwner);
    const repoName = trim(settings.updateRepoName);
    const autoCheck =
      typeof settings.updateAutoCheck === 'boolean' ? settings.updateAutoCheck : true;

    const nextStatus = {
      ...this.status,
      currentVersion: this.app.getVersion(),
      repoOwner,
      repoName,
      autoCheck,
      isPackaged: this.app.isPackaged,
      latestVersion: '',
      progressPercent: 0,
      canInstall: false,
      error: null,
      lastCheckedAt: null,
    };

    if (!this.app.isPackaged) {
      this.status = {
        ...nextStatus,
        configured: false,
        state: 'unsupported',
        message: 'Update checks only run from the packaged app build.',
      };
      this.#emitStatus();
      return this.getStatus();
    }

    if (!repoOwner || !repoName) {
      this.feedKey = '';
      this.launchCheckStarted = false;
      this.status = {
        ...nextStatus,
        configured: false,
        state: 'disabled',
        message: 'Add a GitHub owner and repo to enable app updates.',
      };
      this.#emitStatus();
      return this.getStatus();
    }

    const feedConfig = {
      provider: 'github',
      owner: repoOwner,
      repo: repoName,
      private: false,
    };
    const feedKey = JSON.stringify(feedConfig);
    const sameFeed = feedKey === this.feedKey;
    if (feedKey !== this.feedKey) {
      this.updater.setFeedURL(feedConfig);
      this.feedKey = feedKey;
      this.launchCheckStarted = false;
    }

    this.status =
      sameFeed && this.status.configured
        ? {
            ...this.status,
            currentVersion: nextStatus.currentVersion,
            repoOwner,
            repoName,
            autoCheck,
            isPackaged: nextStatus.isPackaged,
          }
        : {
            ...nextStatus,
            configured: true,
            state: 'configured',
            message: `Ready to check ${repoOwner}/${repoName} on GitHub Releases.`,
          };
    this.#emitStatus();
    return this.getStatus();
  }

  async checkOnLaunch() {
    if (this.launchCheckStarted || !this.status.configured || !this.status.autoCheck) {
      return this.getStatus();
    }

    this.launchCheckStarted = true;
    setTimeout(() => {
      this.checkForUpdates().catch((error) => {
        this.logger?.error?.('Automatic update check failed', error);
      });
    }, 1200);

    return this.getStatus();
  }

  async checkForUpdates() {
    if (!this.app.isPackaged) {
      this.status = {
        ...this.status,
        state: 'unsupported',
        message: 'Update checks only run from the packaged app build.',
      };
      this.#emitStatus();
      return this.getStatus();
    }

    if (!this.status.configured) {
      this.status = {
        ...this.status,
        state: 'disabled',
        message: 'Save a GitHub owner and repo first.',
      };
      this.#emitStatus();
      return this.getStatus();
    }

    if (['checking', 'downloading', 'installing'].includes(this.status.state)) {
      return this.getStatus();
    }

    try {
      await this.updater.checkForUpdates();
      return this.getStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Update check failed', message);
      this.status = {
        ...this.status,
        state: 'error',
        error: message,
        lastCheckedAt: now(),
        message: `Update check failed: ${message}`,
        canInstall: false,
      };
      this.#emitStatus();
      return this.getStatus();
    }
  }

  installUpdateAndRestart() {
    if (!this.status.canInstall) {
      throw new Error('No downloaded update is ready to install yet.');
    }

    this.status = {
      ...this.status,
      state: 'installing',
      message: `Installing ${this.status.latestVersion || 'the downloaded update'} and restarting...`,
    };
    this.#emitStatus();
    this.updater.quitAndInstall();
  }

  #bindEvents() {
    this.updater.on('checking-for-update', () => {
      this.status = {
        ...this.status,
        state: 'checking',
        progressPercent: 0,
        error: null,
        canInstall: false,
        latestVersion: '',
        message: `Checking ${this.status.repoOwner}/${this.status.repoName} for updates...`,
      };
      this.#emitStatus();
    });

    this.updater.on('update-available', (info) => {
      const latestVersion = versionFromInfo(info);
      this.status = {
        ...this.status,
        state: 'available',
        latestVersion,
        error: null,
        canInstall: false,
        lastCheckedAt: now(),
        message: latestVersion
          ? `Update ${latestVersion} found. Downloading now...`
          : 'Update found. Downloading now...',
      };
      this.#emitStatus();
    });

    this.updater.on('download-progress', (progress) => {
      const latestVersion = this.status.latestVersion;
      const progressPercent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
      this.status = {
        ...this.status,
        state: 'downloading',
        progressPercent,
        message: latestVersion
          ? `Downloading ${latestVersion}... ${progressPercent}%`
          : `Downloading update... ${progressPercent}%`,
      };
      this.#emitStatus();
    });

    this.updater.on('update-not-available', () => {
      this.status = {
        ...this.status,
        state: 'not-available',
        latestVersion: '',
        progressPercent: 0,
        error: null,
        canInstall: false,
        lastCheckedAt: now(),
        message: `No newer version was found for ${this.status.currentVersion}.`,
      };
      this.#emitStatus();
    });

    this.updater.on('update-downloaded', (info) => {
      const latestVersion = versionFromInfo(info);
      this.status = {
        ...this.status,
        state: 'downloaded',
        latestVersion,
        progressPercent: 100,
        error: null,
        canInstall: true,
        lastCheckedAt: now(),
        message: latestVersion
          ? `Update ${latestVersion} is downloaded and ready to install.`
          : 'Downloaded update is ready to install.',
      };
      this.#emitStatus();
    });

    this.updater.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Updater error', message);
      this.status = {
        ...this.status,
        state: 'error',
        error: message,
        canInstall: false,
        progressPercent: 0,
        lastCheckedAt: now(),
        message: `Update error: ${message}`,
      };
      this.#emitStatus();
    });
  }

  #emitStatus() {
    this.windowProvider()?.webContents?.send('update:event', this.getStatus());
  }
}
