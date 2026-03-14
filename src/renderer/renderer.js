const state = {
  currentTab: 'run',
  settings: null,
  jobs: [],
  carsDir: '',
  outputDir: '',
  apiKeyDraft: '',
  updateStatus: null,
  carFilesPage: {
    items: [],
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
  },
  logs: [],
};
const BATCH_POLL_INTERVAL_MS = 10000;
const TERMINAL_JOB_STATES = new Set(['completed', 'partial', 'failed', 'cancelled']);
let batchPollTimer = null;
let batchPollInFlight = false;

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
  activeJobPill: document.querySelector('#active-job-pill'),
  activeJobPanel: document.querySelector('#active-job-panel'),
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
  localTestModeInput: document.querySelector('#local-test-mode-input'),
  promptInput: document.querySelector('#prompt-input'),
  saveSettingsButton: document.querySelector('#save-settings-button'),
  clearApiKeyButton: document.querySelector('#clear-api-key-button'),
  settingsStatus: document.querySelector('#settings-status'),
  updateAutoCheckInput: document.querySelector('#update-auto-check-input'),
  updateStatusBadge: document.querySelector('#update-status-badge'),
  updateCurrentVersion: document.querySelector('#update-current-version'),
  updateFeedStatus: document.querySelector('#update-feed-status'),
  updateStatusCopy: document.querySelector('#update-status-copy'),
  checkUpdatesButton: document.querySelector('#check-updates-button'),
  installUpdateButton: document.querySelector('#install-update-button'),
  recoverBatchesButton: document.querySelector('#recover-batches-button'),
  recoverBatchesStatus: document.querySelector('#recover-batches-status'),
};

function defaultUpdateStatus() {
  return {
    currentVersion: '0.1.4',
    repoOwner: 'g1mliii',
    repoName: 'Reference-Studio',
    autoCheck: true,
    isPackaged: false,
    configured: false,
    canInstall: false,
    state: 'unsupported',
    latestVersion: '',
    progressPercent: 0,
    lastCheckedAt: null,
    error: null,
    message: 'Update checks only run from the packaged app build.',
  };
}

function addLog(message) {
  state.logs.unshift({
    message,
    timestamp: new Date().toISOString(),
  });
  state.logs = state.logs.slice(0, 80);
  renderLogs();
}

function sortJobs(jobs) {
  return [...jobs].sort((left, right) =>
    (right.updatedAt || '').localeCompare(left.updatedAt || ''),
  );
}

function upsertJob(job) {
  state.jobs = sortJobs([...state.jobs.filter((item) => item.id !== job.id), job]);
}

function findJob(jobId) {
  return state.jobs.find((job) => job.id === jobId) || null;
}

function isActiveJob(job) {
  return !TERMINAL_JOB_STATES.has(job.state);
}

function primaryActiveJob() {
  return state.jobs.find(isActiveJob) || null;
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
    ? settings?.localTestMode
      ? `Saved (${settings.apiKeyPreview}) but not used in Local Test Mode`
      : `Saved (${settings.apiKeyPreview})`
    : settings?.localTestMode
      ? 'Not required in Local Test Mode'
      : 'Not saved';
  els.statusReferences.textContent = `${referenceCount} saved`;
  els.statusOutputs.textContent = String(projectedOutputs);
  els.statusModel.textContent = settings?.model || 'gemini-3-pro-image-preview';
  els.statusSearch.textContent = settings?.localTestMode
    ? 'Off in Local Test Mode'
    : settings?.searchEnabled
      ? 'Enabled'
      : 'Disabled';
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
          <p class="log-message">${escapeHtml(entry.message)}</p>
        </article>
      `,
    )
    .join('');
}

function totalForJob(job) {
  const summary = job.summary || {};
  return (
    (summary.pending || 0) +
    (summary.submitted || 0) +
    (summary.completed || 0) +
    (summary.skipped || 0) +
    (summary.failed || 0)
  );
}

function canRefreshJob(job) {
  if (job.mode !== 'batch' || !job.remoteJobName) return false;
  if (['submitted', 'processing'].includes(job.state)) return true;
  // Allow retry on failed batch jobs that have a result file ready to download
  if (job.state === 'failed' && job.remoteResultFileName) return true;
  return false;
}

function canPauseJob(job) {
  return ['running', 'processing'].includes(job.state);
}

function canResumeJob(job) {
  return job.state === 'paused';
}

function canCancelJob(job) {
  return ['running', 'processing', 'submitted', 'paused'].includes(job.state);
}

function jobStateClass(job) {
  return job.state === 'partial' || job.state === 'failed'
    ? 'partial'
    : job.state === 'paused' || job.state === 'cancelled'
      ? 'paused'
      : '';
}

function renderJobActionButtons(job) {
  return `
    ${
      canPauseJob(job)
        ? `<button class="ghost-button pause-job-button" data-job-id="${escapeHtml(job.id)}">Pause</button>`
        : ''
    }
    ${
      canResumeJob(job)
        ? `<button class="ghost-button resume-job-button" data-job-id="${escapeHtml(job.id)}">Resume</button>`
        : ''
    }
    ${
      canCancelJob(job)
        ? `<button class="ghost-button cancel-job-button" data-job-id="${escapeHtml(job.id)}">Cancel</button>`
        : ''
    }
    ${
      canRefreshJob(job)
        ? `<button class="ghost-button refresh-job-button" data-job-id="${escapeHtml(job.id)}">Refresh Batch</button>`
        : ''
    }
  `;
}

function renderJobDetails(job) {
  const summary = job.summary || {};
  const total = totalForJob(job);
  const activityMarkup = job.activityMessage
    ? `<p class="job-note important">${escapeHtml(job.activityMessage)}</p>`
    : '';
  const retryMarkup = job.retryScheduledAt
    ? `<p class="job-note">Next retry around ${formatTimestamp(job.retryScheduledAt)}.</p>`
    : '';
  const remoteIdMarkup =
    job.mode === 'batch' && job.remoteJobName
      ? `<p class="job-remote-id">Gemini batch id: ${escapeHtml(job.remoteJobName)}</p>`
      : '';
  const remoteStateMarkup =
    job.mode === 'batch'
      ? `<p>Remote state: ${escapeHtml(job.remoteState || 'pending')}</p>`
      : '';
  const pollingMarkup =
    job.mode === 'batch' && ['submitted', 'processing'].includes(job.state)
      ? '<p>Auto-polling every 10 seconds while this app is open.</p>'
      : '';

  return `
    <div class="job-meta">
      <span>${escapeHtml(job.mode.toUpperCase())}</span>
      <span>${escapeHtml(job.model)}</span>
    </div>
    ${activityMarkup}
    ${retryMarkup}
    ${remoteIdMarkup}
    ${remoteStateMarkup}
    <p>Output folder: ${escapeHtml(nameFromPath(job.outputDir))}</p>
    <p>
      ${summary.completed || 0} completed, ${summary.skipped || 0} skipped,
      ${summary.failed || 0} failed, ${total} total
    </p>
    ${pollingMarkup}
  `;
}

function bindJobActionButtons() {
  Array.from(document.querySelectorAll('.pause-job-button')).forEach((button) => {
    if (button.dataset.bound === '1') {
      return;
    }
    button.dataset.bound = '1';
    button.addEventListener('click', async () => {
      await pauseJob(button.dataset.jobId);
    });
  });

  Array.from(document.querySelectorAll('.resume-job-button')).forEach((button) => {
    if (button.dataset.bound === '1') {
      return;
    }
    button.dataset.bound = '1';
    button.addEventListener('click', async () => {
      await resumeJob(button.dataset.jobId);
    });
  });

  Array.from(document.querySelectorAll('.cancel-job-button')).forEach((button) => {
    if (button.dataset.bound === '1') {
      return;
    }
    button.dataset.bound = '1';
    button.addEventListener('click', async () => {
      await cancelJob(button.dataset.jobId);
    });
  });

  Array.from(document.querySelectorAll('.refresh-job-button')).forEach((button) => {
    if (button.dataset.bound === '1') {
      return;
    }
    button.dataset.bound = '1';
    button.addEventListener('click', async () => {
      await refreshBatch(button.dataset.jobId);
    });
  });
}

function renderActiveJob() {
  const job = primaryActiveJob();
  els.activeJobPill.textContent = job ? job.state : 'Idle';

  if (!job) {
    els.activeJobPanel.innerHTML =
      '<div class="empty-state">No active sync or batch job right now.</div>';
    bindJobActionButtons();
    return;
  }

  els.activeJobPanel.innerHTML = `
    <div class="active-job-meta">
      <strong>${escapeHtml(job.id)}</strong>
      <span class="job-state ${jobStateClass(job)}">${escapeHtml(job.state)}</span>
    </div>
    ${renderJobDetails(job)}
    <div class="inline-actions">
      ${renderJobActionButtons(job)}
    </div>
  `;
  bindJobActionButtons();
}

function updateBadgeCopy(status) {
  switch (status.state) {
    case 'configured':
      return 'Ready';
    case 'checking':
      return 'Checking';
    case 'available':
    case 'downloading':
      return 'Downloading';
    case 'downloaded':
      return 'Ready To Install';
    case 'not-available':
      return 'Up To Date';
    case 'installing':
      return 'Installing';
    case 'error':
      return 'Update Error';
    case 'unsupported':
      return 'Packaged Only';
    case 'disabled':
      return 'Unavailable';
    default:
      return 'Built In';
  }
}

function updateBadgeClass(status) {
  switch (status.state) {
    case 'configured':
    case 'checking':
    case 'available':
    case 'downloading':
    case 'installing':
      return 'active';
    case 'downloaded':
    case 'not-available':
      return 'saved';
    case 'error':
    case 'unsupported':
      return 'warning';
    default:
      return '';
  }
}

function renderUpdatePanel() {
  const status = state.updateStatus || defaultUpdateStatus();
  const badgeClass = updateBadgeClass(status);

  els.updateStatusBadge.textContent = updateBadgeCopy(status);
  els.updateStatusBadge.className = `status-badge${badgeClass ? ` ${badgeClass}` : ''}`;
  els.updateCurrentVersion.textContent = status.currentVersion || '0.1.4';
  els.updateFeedStatus.textContent = `${status.repoOwner}/${status.repoName}`;

  let statusCopy = status.message || 'Automatic updates are built into this app.';
  if (status.latestVersion && !statusCopy.includes(status.latestVersion)) {
    statusCopy += ` Latest version: ${status.latestVersion}.`;
  }
  if (status.lastCheckedAt) {
    statusCopy += ` Last checked ${formatTimestamp(status.lastCheckedAt)}.`;
  }
  els.updateStatusCopy.textContent = statusCopy;

  els.checkUpdatesButton.disabled =
    !status.isPackaged ||
    !status.configured ||
    ['checking', 'downloading', 'installing'].includes(status.state);
  els.installUpdateButton.disabled = !status.canInstall;
}

function renderJobs() {
  if (!state.jobs.length) {
    els.jobsList.innerHTML = '<div class="empty-state">No jobs have been run yet.</div>';
    bindJobActionButtons();
    return;
  }

  els.jobsList.innerHTML = state.jobs
    .map((job) => {
      return `
        <article class="job-card">
          <header>
            <strong>${escapeHtml(job.id)}</strong>
            <span class="job-state ${jobStateClass(job)}">
              ${escapeHtml(job.state)}
            </span>
          </header>
          ${renderJobDetails(job)}
          <div class="job-actions">
            <small>${job.updatedAt ? formatTimestamp(job.updatedAt) : 'Just now'}</small>
            <div class="inline-actions">${renderJobActionButtons(job)}</div>
          </div>
        </article>
      `;
    })
    .join('');

  bindJobActionButtons();
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
      '<div class="empty-state">Choose a source folder to see each input filename here.</div>';
    els.carsCountPill.textContent = '0 images';
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
  els.carsCountPill.textContent = `${page.total} ${page.total === 1 ? 'image' : 'images'}`;
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
  els.localTestModeInput.checked = Boolean(settings?.localTestMode);
  els.promptInput.value = settings?.prompt || '';
  els.updateAutoCheckInput.checked =
    typeof settings?.updateAutoCheck === 'boolean' ? settings.updateAutoCheck : true;
  els.clearApiKeyButton.disabled = !settings?.hasApiKey;
}

function renderAll() {
  renderTabs();
  renderSettingsSummary();
  renderLogs();
  renderJobs();
  renderActiveJob();
  renderReferenceList();
  renderCarsList();
  renderUpdatePanel();
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
  state.jobs = sortJobs(await window.carStudioAPI.listJobs());
  renderJobs();
  renderActiveJob();
  ensureBatchPolling();
}

async function reloadUpdateStatus() {
  state.updateStatus = await window.carStudioAPI.loadUpdateStatus();
  renderUpdatePanel();
}

async function saveSettings() {
  try {
    els.settingsStatus.textContent = 'Saving...';
    state.settings = await window.carStudioAPI.saveSettings({
      referenceFiles: state.settings?.referenceFiles || [],
      model: els.modelInput.value.trim(),
      searchEnabled: els.searchEnabledInput.checked,
      localTestMode: els.localTestModeInput.checked,
      prompt: els.promptInput.value,
      updateAutoCheck: els.updateAutoCheckInput.checked,
    });
    await reloadUpdateStatus();
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
      addLog(`Failed to scan source folder: ${error.message}`);
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
      localTestMode: els.localTestModeInput.checked,
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

async function checkForUpdates() {
  try {
    els.settingsStatus.textContent = 'Checking for updates...';
    state.updateStatus = await window.carStudioAPI.checkForUpdates();
    renderUpdatePanel();
    els.settingsStatus.textContent = state.updateStatus.message;
  } catch (error) {
    els.settingsStatus.textContent = error.message;
    addLog(`Update check failed: ${error.message}`);
  }
}

async function installUpdate() {
  try {
    els.settingsStatus.textContent = 'Installing downloaded update...';
    await window.carStudioAPI.installUpdate();
  } catch (error) {
    els.settingsStatus.textContent = error.message;
    addLog(`Update install failed: ${error.message}`);
  }
}

function selectedRunMode() {
  return document.querySelector('input[name="run-mode"]:checked').value;
}

async function startRun() {
  if (!state.carsDir || !state.outputDir) {
    els.runStatus.textContent = 'Choose both a Source folder and an Output folder first.';
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

async function refreshBatch(jobId, { silent = false } = {}) {
  try {
    if (!silent) {
      els.runStatus.textContent = `Refreshing batch ${jobId}...`;
    }
    const job = await window.carStudioAPI.refreshBatch({ jobId, silent });
    if (!silent) {
      els.runStatus.textContent = `Batch ${job.id}: ${job.state}`;
    }
    await reloadJobs();
  } catch (error) {
    if (!silent) {
      els.runStatus.textContent = error.message;
      addLog(`Batch refresh failed: ${error.message}`);
    }
  }
}

async function recoverFailedBatches() {
  const eligible = state.jobs.filter(
    (job) => job.mode === 'batch' && job.state === 'failed' && job.remoteResultFileName,
  );
  if (!eligible.length) {
    els.recoverBatchesStatus.textContent = 'No failed batch jobs with available results found.';
    return;
  }
  els.recoverBatchesButton.disabled = true;
  els.recoverBatchesStatus.textContent = `Recovering ${eligible.length} job(s)...`;
  let recovered = 0;
  let failed = 0;
  for (const job of eligible) {
    try {
      await refreshBatch(job.id, { silent: false });
      recovered++;
    } catch {
      failed++;
    }
  }
  els.recoverBatchesButton.disabled = false;
  els.recoverBatchesStatus.textContent = failed
    ? `Done. Recovered: ${recovered}, failed: ${failed}. Check logs for details.`
    : `Done. Recovered ${recovered} job(s).`;
  await reloadJobs();
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

async function cancelJob(jobId) {
  if (!window.confirm(`Cancel job ${jobId}?`)) {
    return;
  }

  try {
    els.runStatus.textContent = `Cancelling job ${jobId}...`;
    const job = await window.carStudioAPI.cancelJob({ jobId });
    els.runStatus.textContent = `Job ${job.id}: ${job.state}`;
    await reloadJobs();
  } catch (error) {
    els.runStatus.textContent = error.message;
    addLog(`Cancel failed: ${error.message}`);
  }
}

function shouldPollJob(job) {
  return (
    job.mode === 'batch' &&
    job.remoteJobName &&
    ['submitted', 'processing'].includes(job.state)
  );
}

async function pollActiveBatches() {
  if (batchPollInFlight) {
    return;
  }

  const jobsToPoll = state.jobs.filter(shouldPollJob);
  if (!jobsToPoll.length) {
    return;
  }

  batchPollInFlight = true;
  try {
    for (const job of jobsToPoll) {
      await refreshBatch(job.id, { silent: true });
    }
  } finally {
    batchPollInFlight = false;
  }
}

function ensureBatchPolling() {
  if (batchPollTimer) {
    return;
  }

  batchPollTimer = window.setInterval(() => {
    pollActiveBatches().catch((error) => {
      addLog(`Batch polling failed: ${error.message}`);
    });
  }, BATCH_POLL_INTERVAL_MS);
}

function shouldLogProgress(payload) {
  const job = findJob(payload.jobId);
  if (!job) {
    return true;
  }

  if (job.mode !== 'batch' || payload.kind !== 'job-progress') {
    return true;
  }

  if (/^Failed\b/.test(payload.message || '')) {
    return true;
  }

  return (
    payload.completed === 1 ||
    payload.completed === payload.total ||
    payload.completed % 25 === 0
  );
}

function handleJobLifecycleEvent(job, { started = false } = {}) {
  const previousJob = findJob(job.id);
  const previousState = previousJob?.state;
  upsertJob(job);
  renderJobs();
  renderActiveJob();
  ensureBatchPolling();

  if (job.activityMessage) {
    els.runStatus.textContent = job.activityMessage;
  } else if (started) {
    els.runStatus.textContent = `Started ${job.mode} job ${job.id}.`;
  } else if (!TERMINAL_JOB_STATES.has(job.state)) {
    els.runStatus.textContent = `Job ${job.id}: ${job.state}`;
  } else {
    els.runStatus.textContent = `Job ${job.id}: ${job.state}`;
  }

  if (started) {
    addLog(`Started ${job.mode} job ${job.id}.`);
    return;
  }

  if (previousState && previousState !== job.state) {
    addLog(`Job ${job.id} is now ${job.state}.`);
  }
}

async function resumeSavedBatchesOnLaunch() {
  const resumableJobs = state.jobs.filter(shouldPollJob);
  if (!resumableJobs.length) {
    return;
  }

  addLog(
    `Resuming ${resumableJobs.length} saved batch job${resumableJobs.length === 1 ? '' : 's'} from the previous session...`,
  );
  await pollActiveBatches();
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
  els.checkUpdatesButton.addEventListener('click', checkForUpdates);
  els.installUpdateButton.addEventListener('click', installUpdate);
  els.recoverBatchesButton.addEventListener('click', recoverFailedBatches);

  window.carStudioAPI.onRunEvent((payload) => {
    if ((payload.kind === 'job-progress' && shouldLogProgress(payload)) || payload.kind === 'job-log') {
      addLog(payload.message);
    }
    if (payload.kind === 'job-updated') {
      handleJobLifecycleEvent(payload.job);
    }
    if (payload.kind === 'job-started') {
      handleJobLifecycleEvent(payload.job, { started: true });
    }
  });

  window.carStudioAPI.onUpdateEvent((payload) => {
    const previousState = state.updateStatus?.state;
    state.updateStatus = payload;
    renderUpdatePanel();

    if (
      payload.state !== previousState &&
      ['checking', 'downloaded', 'not-available', 'error', 'installing'].includes(payload.state)
    ) {
      addLog(`Updater: ${payload.message}`);
    }
  });
}

async function bootstrap() {
  bindEvents();
  await reloadSettings();
  await reloadUpdateStatus();
  await reloadJobs();
  await resumeSavedBatchesOnLaunch();
  ensureBatchPolling();
  renderCarsList();
  renderLogs();
}

bootstrap().catch((error) => {
  addLog(`App failed to load: ${error.message}`);
});
