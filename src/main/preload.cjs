const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('carStudioAPI', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  clearApiKey: () => ipcRenderer.invoke('settings:clear-api-key'),
  listJobs: () => ipcRenderer.invoke('jobs:list'),
  chooseDirectory: () => ipcRenderer.invoke('dialog:choose-directory'),
  chooseReferences: () => ipcRenderer.invoke('dialog:choose-references'),
  listImagesPage: (payload) => ipcRenderer.invoke('files:list-images-page', payload),
  startRun: (payload) => ipcRenderer.invoke('runs:start', payload),
  refreshBatch: (payload) => ipcRenderer.invoke('runs:refresh-batch', payload),
  pauseJob: (payload) => ipcRenderer.invoke('runs:pause-job', payload),
  resumeJob: (payload) => ipcRenderer.invoke('runs:resume-job', payload),
  onRunEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('run:event', listener);
    return () => ipcRenderer.removeListener('run:event', listener);
  },
});
