import path from 'node:path';
import { fileURLToPath } from 'node:url';

import log from 'electron-log/main.js';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
} from 'electron';

import { SettingsStore } from './services/settings-store.js';
import { JobStore } from './services/job-store.js';
import { RunManager } from './services/run-manager.js';
import { listImagePathsPage } from '../shared/files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let settingsStore;
let jobStore;
let runManager;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 1160,
    minHeight: 760,
    backgroundColor: '#f4ede1',
    title: 'Car Replacement Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.webContents.on('context-menu', (event, params) => {
    if (!params.isEditable && !params.selectionText) {
      return;
    }

    const menu = Menu.buildFromTemplate([
      ...(params.isEditable
        ? [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ]
        : [
            { role: 'copy' },
            { role: 'selectAll' },
          ]),
    ]);

    menu.popup({ window: mainWindow });
  });
}

async function chooseDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  return result.filePaths[0];
}

async function chooseReferences() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Images',
        extensions: ['jpg', 'jpeg', 'png', 'webp'],
      },
    ],
  });

  if (result.canceled || !result.filePaths.length) {
    return [];
  }

  return result.filePaths.sort((left, right) => left.localeCompare(right));
}

app.whenReady().then(async () => {
  log.initialize();

  settingsStore = new SettingsStore({
    userDataPath: app.getPath('userData'),
    safeStorage,
  });
  jobStore = new JobStore({
    userDataPath: app.getPath('userData'),
  });
  runManager = new RunManager({
    settingsStore,
    jobStore,
  });

  ipcMain.handle('settings:load', () => settingsStore.load());
  ipcMain.handle('settings:save', (_event, payload) => settingsStore.save(payload));
  ipcMain.handle('settings:clear-api-key', () => settingsStore.clearApiKey());
  ipcMain.handle('jobs:list', () => jobStore.list());
  ipcMain.handle('dialog:choose-directory', () => chooseDirectory());
  ipcMain.handle('dialog:choose-references', () => chooseReferences());
  ipcMain.handle('files:list-images-page', (_event, payload) =>
    listImagePathsPage(payload.directoryPath, payload.page, payload.pageSize),
  );
  ipcMain.handle('runs:start', (_event, payload) =>
    runManager.startRun({
      ...payload,
      window: mainWindow,
    }),
  );
  ipcMain.handle('runs:refresh-batch', (_event, payload) =>
    runManager.refreshBatch({
      ...payload,
      window: mainWindow,
    }),
  );
  ipcMain.handle('runs:pause-job', (_event, payload) =>
    runManager.pauseJob({
      ...payload,
      window: mainWindow,
    }),
  );
  ipcMain.handle('runs:resume-job', (_event, payload) =>
    runManager.resumeJob({
      ...payload,
      window: mainWindow,
    }),
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
