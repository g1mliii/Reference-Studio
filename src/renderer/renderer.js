const state = {
  currentTab: 'run',
  settings: null,
  jobs: [],
  carsDir: '',
  outputDir: '',
  apiKeyDraft: '',
  carFilesPage: {
    items: [],
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
  },
  logs: [],
};

const els = {
  navTabs: Array.from(document.querySelectorAll('.nav-tab')),
  tabPanels: Array.from(document.querySelectorAll('.tab-panel')),
  carsDirInput: document.querySelector('#cars-dir-input'),
  outputDirInput: document.querySelector('#output-dir-input'),
  runStatus: document.querySelector('#run-status'),
  chooseCarsDirButton: document.querySelector('#choose-cars-dir-button'),
  chooseOutputDirButton: document.querySelector('#choose-output-dir-button'),
  startRunButton: document.querySelector('#start-run-button'),
  refreshJobsButton: document.querySelector('#refresh-jobs-button'),
  statusApiKey: document.querySelector('#status-api-key'),
  statusReferences: document.querySelector('#status-references'),
  statusOutputs: document.querySelector('#status-outputs'),
  statusModel: document.querySelector('#status-model'),
  statusSearch: document.querySelector('#status-search'),
  carsCountPill: document.querySelector('#cars-count-pill'),
  referencesCountPill: document.querySelector('#references-count-pill'),
  carsList: document.querySelector('#cars-list'),
  carsPrevButton: document.querySelector('#cars-prev-button'),
  carsNextButton: document.querySelector('#cars-next-button'),
  carsPageLabel: document.querySelector('#cars-page-label'),
  runReferenceList: document.querySelector('#run-reference-list'),
  logOutput: document.querySelector('#log-output'),
  jobsList: document.querySelector('#jobs-list'),
  apiKeyInput: document.querySelector('#api-key-input'),
  apiKeyIndicator: document.querySelector('#api-key-indicator'),
  apiKeySavedLabel: document.querySelector('#api-key-saved-label'),
  saveApiKeyButton: document.querySelector('#save-api-key-button'),
  chooseReferencesButton: document.querySelector('#choose-references-button'),
  referenceList: document.querySelector('#reference-list'),
  modelInput: document.querySelector('#model-input'),
  searchEnabledInput: document.querySelector('#search-enabled-input'),
  promptInput: document.querySelector('#prompt-input'),
  saveSettingsButton: document.querySelector('#save-settings-button'),
  clearApiKeyButton: document.querySelector('#clear-api-key-button'),
  settingsStatus: document.querySelector('#settings-status'),
};

function addLog(message) {
  state.logs.unshift({
    message,
    timestamp: new Date().toISOString(),
  });
  state.logs = state.logs.slice(0, 80);
  renderLogs();
}

function formatTimestamp(value) {
  return new Date(value).toLocaleString();
}

function renderTabs() {
  els.navTabs.forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === state.currentTab);
  });
  els.tabPanels.forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${state.currentTab}`);
  });
}

function renderSettingsSummary() {
  const settings = state.settings;
  const referenceCount = settings?.referenceFiles?.length || 0;
  const projectedOutputs = referenceCount * (state.carFilesPage?.total || 0);
  els.statusApiKey.textContent = settings?.hasApiKey
    ? `Saved (${settings.apiKeyPreview})`
    : 'Not saved';
  els.statusReferences.textContent = `${referenceCount} saved`;
  els.statusOutputs.textContent = String(projectedOutputs);
  els.statusModel.textContent = settings?.model || 'gemini-3-pro-image-preview';
  els.statusSearch.textContent = settings?.searchEnabled ? 'Enabled' : 'Disabled';
}

function renderLogs() {
  if (!state.logs.length) {
    els.logOutput.innerHTML = '<div class="empty-state">Run events will appear here.</div>';
    return;
  }

  els.logOutput.innerHTML = state.logs
    .map(
      (entry) => `
        <article class="log-entry">
          <time>${formatTimestamp(entry.timestamp)}</time>
          <p>${escapeHtml(entry.message)}</p>
        </article>
      `,
    )
    .join('');
}

function renderJobs() {
  if (!state.jobs.length) {
    els.jobsList.innerHTML = '<div class="empty-state">No jobs have been run yet.</div>';
    return;
  }

  els.jobsList.innerHTML = state.jobs
    .map((job) => {
      const summary = job.summary || {};
      const total =
        (summary.pending || 0) +
        (summary.submitted || 0) +
        (summary.completed || 0) +
        (summary.skipped || 0) +
        (summary.failed || 0);
      const canRefresh =
        job.mode === 'batch' &&
        job.remoteJobName &&
        ['submitted', 'processing', 'running'].includes(job.state);
      const canPause = ['running', 'processing'].includes(job.state);
      const canResume = job.state === 'paused';
      const stateClass =
        job.state === 'partial' || job.state === 'failed'
          ? 'partial'
          : job.state === 'paused'
            ? 'paused'
            : '';

      return `
        <article class="job-card">
          <header>
            <strong>${escapeHtml(job.id)}</strong>
            <span class="job-state ${stateClass}">
              ${escapeHtml(job.state)}
            </span>
          </header>
          <div class="job-meta">
            <span>${escapeHtml(job.mode.toUpperCase())}</span>
            <span>${escapeHtml(job.model)}</span>
          </div>
          <p>Output folder: ${escapeHtml(nameFromPath(job.outputDir))}</p>
          <p>
            ${summary.completed || 0} completed, ${summary.skipped || 0} skipped,
            ${summary.failed || 0} failed, ${total} total
          </p>
          <div class="job-actions">
            <small>${job.updatedAt ? formatTimestamp(job.updatedAt) : 'Just now'}</small>
            <div class="inline-actions">
              ${
                canPause
                  ? `<button class="ghost-button pause-job-button" data-job-id="${escapeHtml(job.id)}">Pause</button>`
                  : ''
              }
              ${
                canResume
                  ? `<button class="ghost-button resume-job-button" data-job-id="${escapeHtml(job.id)}">Resume</button>`
                  : ''
              }
              ${
                canRefresh
                  ? `<button class="ghost-button refresh-job-button" data-job-id="${escapeHtml(job.id)}">Refresh Batch</button>`
                  : ''
              }
            </div>
          </div>
        </article>
      `;
    })
    .join('');

  Array.from(document.querySelectorAll('.pause-job-button')).forEach((button) => {
    button.addEventListener('click', async () => {
      await pauseJob(button.dataset.jobId);
    });
  });

  Array.from(document.querySelectorAll('.resume-job-button')).forEach((button) => {
    button.addEventListener('click', async () => {
      await resumeJob(button.dataset.jobId);
    });
  });

  Array.from(document.querySelectorAll('.refresh-job-button')).forEach((button) => {
    button.addEventListener('click', async () => {
      await refreshBatch(button.dataset.jobId);
    });
  });
}

function renderReferenceList() {
  const references = state.settings?.referenceFiles || [];
  if (!references.length) {
    els.referenceList.innerHTML =
      '<li class="empty-state">No reference images saved yet.</li>';
    els.runReferenceList.innerHTML =
      '<div class="empty-state">Saved reference image names will show here.</div>';
    els.referencesCountPill.textContent = '0 refs';
    return;
  }

  els.referenceList.innerHTML = references
    .map(
      (referencePath) => `
        <li>
          <strong>${escapeHtml(nameFromPath(referencePath))}</strong>
        </li>
      `,
    )
    .join('');

  els.runReferenceList.innerHTML = references
    .map(
      (referencePath) => `
        <div class="file-row">
          <strong>${escapeHtml(nameFromPath(referencePath))}</strong>
        </div>
      `,
    )
    .join('');
  els.referencesCountPill.textContent = `${references.length} ${references.length === 1 ? 'ref' : 'refs'}`;
}

function renderCarsList() {
  const page = state.carFilesPage || {
    items: [],
    page: 1,
    totalPages: 1,
    total: 0,
  };
  const carFiles = page.items || [];
  if (!page.total) {
    els.carsList.innerHTML =
      '<div class="empty-state">Choose a cars folder to see each car filename here.</div>';
    els.carsCountPill.textContent = '0 cars';
    els.carsPageLabel.textContent = 'Page 1 of 1';
    els.carsPrevButton.disabled = true;
    els.carsNextButton.disabled = true;
    return;
  }

  els.carsList.innerHTML = carFiles
    .map(
      (carPath) => `
        <div class="file-row">
          <strong>${escapeHtml(nameFromPath(carPath))}</strong>
        </div>
      `,
    )
    .join('');
  els.carsCountPill.textContent = `${page.total} ${page.total === 1 ? 'car' : 'cars'}`;
  els.carsPageLabel.textContent = `Page ${page.page} of ${page.totalPages}`;
  els.carsPrevButton.disabled = page.page <= 1;
  els.carsNextButton.disabled = page.page >= page.totalPages;
}

function populateSettingsForm() {
  const settings = state.settings;
  els.apiKeyInput.value = state.apiKeyDraft;
  if (settings?.hasApiKey) {
    els.apiKeyIndicator.textContent = 'Saved';
    els.apiKeyIndicator.classList.add('saved');
    els.apiKeySavedLabel.textContent = settings?.apiKeyUpdatedAt
      ? `Saved key ${settings.apiKeyPreview} on this Mac at ${formatTimestamp(settings.apiKeyUpdatedAt)}.`
      : `Saved key: ${settings.apiKeyPreview}`;
  } else {
    els.apiKeyIndicator.textContent = 'Not Saved';
    els.apiKeyIndicator.classList.remove('saved');
    els.apiKeySavedLabel.textContent = 'No Gemini API key has been saved yet.';
  }
  els.modelInput.value = settings?.model || '';
  els.searchEnabledInput.checked = Boolean(settings?.searchEnabled);
  els.promptInput.value = settings?.prompt || '';
  els.clearApiKeyButton.disabled = !settings?.hasApiKey;
}

function renderAll() {
  renderTabs();
  renderSettingsSummary();
  renderLogs();
  renderJobs();
  renderReferenceList();
  renderCarsList();
  populateSettingsForm();
  els.carsDirInput.value = state.carsDir;
  els.outputDirInput.value = state.outputDir;
}

function nameFromPath(filePath) {
  return filePath.split('/').pop() || filePath;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function reloadSettings() {
  state.settings = await window.carStudioAPI.loadSettings();
  renderAll();
}

async function reloadJobs() {
  state.jobs = await window.carStudioAPI.listJobs();
  renderJobs();
}

async function saveSettings() {
  try {
    els.settingsStatus.textContent = 'Saving...';
    state.settings = await window.carStudioAPI.saveSettings({
      referenceFiles: state.settings?.referenceFiles || [],
      model: els.modelInput.value.trim(),
      searchEnabled: els.searchEnabledInput.checked,
      prompt: els.promptInput.value,
    });
    els.settingsStatus.textContent = state.apiKeyDraft.trim()
      ? 'Advanced settings saved. Click Save API Key to persist the pasted key.'
      : 'Saved locally on this Mac.';
    addLog('Settings saved.');
    renderAll();
  } catch (error) {
    els.settingsStatus.textContent = error.message;
    addLog(`Settings save failed: ${error.message}`);
  }
}

async function saveApiKey() {
  const apiKey = state.apiKeyDraft.trim();
  if (!apiKey) {
    els.settingsStatus.textContent = 'Paste a Gemini API key first.';
    return;
  }

  try {
    els.settingsStatus.textContent = 'Saving API key...';
    state.settings = await window.carStudioAPI.saveSettings({
      apiKey,
    });
    state.apiKeyDraft = '';
    els.settingsStatus.textContent = 'Gemini API key saved on this Mac.';
    addLog('Gemini API key saved.');
    renderAll();
  } catch (error) {
    els.settingsStatus.textContent = error.message;
    addLog(`API key save failed: ${error.message}`);
  }
}

async function chooseDirectory(target) {
  const selected = await window.carStudioAPI.chooseDirectory();
  if (!selected) {
    return;
  }

  if (target === 'cars') {
    state.carsDir = selected;
    try {
      await loadCarsPage(1);
    } catch (error) {
      addLog(`Failed to scan cars folder: ${error.message}`);
      state.carFilesPage = {
        items: [],
        page: 1,
        pageSize: 50,
        total: 0,
        totalPages: 1,
      };
    }
  } else {
    state.outputDir = selected;
  }
  renderAll();
}

async function loadCarsPage(page) {
  if (!state.carsDir) {
    state.carFilesPage = {
      items: [],
      page: 1,
      pageSize: 50,
      total: 0,
      totalPages: 1,
    };
    return;
  }

  state.carFilesPage = await window.carStudioAPI.listImagesPage({
    directoryPath: state.carsDir,
    page,
    pageSize: state.carFilesPage?.pageSize || 50,
  });
}

async function chooseReferences() {
  try {
    const referenceFiles = await window.carStudioAPI.chooseReferences();
    if (!referenceFiles.length) {
      return;
    }
    state.settings = await window.carStudioAPI.saveSettings({
      referenceFiles,
      model: els.modelInput.value.trim(),
      searchEnabled: els.searchEnabledInput.checked,
      prompt: els.promptInput.value,
    });
    els.settingsStatus.textContent = `Saved ${referenceFiles.length} reference image${referenceFiles.length === 1 ? '' : 's'}.`;
    addLog('Reference images updated.');
    renderAll();
  } catch (error) {
    els.settingsStatus.textContent = error.message;
    addLog(`Reference image selection failed: ${error.message}`);
  }
}

async function clearApiKey() {
  if (!window.confirm('Remove the saved Gemini API key from this Mac?')) {
    return;
  }

  try {
    state.settings = await window.carStudioAPI.clearApiKey();
    state.apiKeyDraft = '';
    els.settingsStatus.textContent = 'Saved API key cleared.';
    addLog('Saved Gemini API key cleared.');
    renderAll();
  } catch (error) {
    els.settingsStatus.textContent = error.message;
    addLog(`Failed to clear API key: ${error.message}`);
  }
}

function selectedRunMode() {
  return document.querySelector('input[name="run-mode"]:checked').value;
}

async function startRun() {
  if (!state.carsDir || !state.outputDir) {
    els.runStatus.textContent = 'Choose both a Cars folder and an Output folder first.';
    return;
  }

  try {
    els.startRunButton.disabled = true;
    els.runStatus.textContent = 'Starting run...';
    const job = await window.carStudioAPI.startRun({
      mode: selectedRunMode(),
      carsDir: state.carsDir,
      outputDir: state.outputDir,
    });
    els.runStatus.textContent =
      job.mode === 'batch'
        ? `Batch submitted: ${job.remoteJobName || job.id}`
        : `Run finished: ${job.state}`;
    await reloadJobs();
  } catch (error) {
    els.runStatus.textContent = error.message;
    addLog(`Run failed to start: ${error.message}`);
  } finally {
    els.startRunButton.disabled = false;
  }
}

async function refreshBatch(jobId) {
  try {
    els.runStatus.textContent = `Refreshing batch ${jobId}...`;
    const job = await window.carStudioAPI.refreshBatch({ jobId });
    els.runStatus.textContent = `Batch ${job.id}: ${job.state}`;
    await reloadJobs();
  } catch (error) {
    els.runStatus.textContent = error.message;
    addLog(`Batch refresh failed: ${error.message}`);
  }
}

async function pauseJob(jobId) {
  try {
    els.runStatus.textContent = `Pausing job ${jobId}...`;
    const job = await window.carStudioAPI.pauseJob({ jobId });
    els.runStatus.textContent = `Job ${job.id}: ${job.state}`;
    await reloadJobs();
  } catch (error) {
    els.runStatus.textContent = error.message;
    addLog(`Pause failed: ${error.message}`);
  }
}

async function resumeJob(jobId) {
  try {
    els.runStatus.textContent = `Resuming job ${jobId}...`;
    const job = await window.carStudioAPI.resumeJob({ jobId });
    els.runStatus.textContent = `Job ${job.id}: ${job.state}`;
    await reloadJobs();
  } catch (error) {
    els.runStatus.textContent = error.message;
    addLog(`Resume failed: ${error.message}`);
  }
}

function bindEvents() {
  els.navTabs.forEach((button) => {
    button.addEventListener('click', () => {
      state.currentTab = button.dataset.tab;
      renderTabs();
    });
  });

  els.chooseCarsDirButton.addEventListener('click', () => chooseDirectory('cars'));
  els.chooseOutputDirButton.addEventListener('click', () => chooseDirectory('output'));
  els.apiKeyInput.addEventListener('input', (event) => {
    state.apiKeyDraft = event.target.value;
  });
  els.saveApiKeyButton.addEventListener('click', saveApiKey);
  els.carsPrevButton.addEventListener('click', async () => {
    await loadCarsPage((state.carFilesPage?.page || 1) - 1);
    renderAll();
  });
  els.carsNextButton.addEventListener('click', async () => {
    await loadCarsPage((state.carFilesPage?.page || 1) + 1);
    renderAll();
  });
  els.startRunButton.addEventListener('click', startRun);
  els.refreshJobsButton.addEventListener('click', reloadJobs);
  els.chooseReferencesButton.addEventListener('click', chooseReferences);
  els.saveSettingsButton.addEventListener('click', saveSettings);
  els.clearApiKeyButton.addEventListener('click', clearApiKey);

  window.carStudioAPI.onRunEvent((payload) => {
    if (payload.kind === 'job-progress' || payload.kind === 'job-log') {
      addLog(payload.message);
    }
    if (payload.kind === 'job-updated') {
      addLog(`Job ${payload.job.id} is now ${payload.job.state}.`);
      reloadJobs();
    }
    if (payload.kind === 'job-started') {
      addLog(`Started ${payload.job.mode} job ${payload.job.id}.`);
      reloadJobs();
    }
  });
}

async function bootstrap() {
  bindEvents();
  await reloadSettings();
  await reloadJobs();
  renderCarsList();
  renderLogs();
}

bootstrap().catch((error) => {
  addLog(`App failed to load: ${error.message}`);
});
