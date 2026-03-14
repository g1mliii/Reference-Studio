#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(projectDir, 'package.json');
const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
const productName = packageJson.build?.productName || packageJson.productName || packageJson.name;
const artifactProductName = productName.replace(/\s+/g, '-');
const version = packageJson.version;
const arch = 'arm64';
const distDir = path.join(projectDir, 'dist');
const appDir = path.join(distDir, `mac-${arch}`);
const appPath = path.join(appDir, `${productName}.app`);
const appResourcesDir = path.join(appPath, 'Contents', 'Resources');
const appUpdateConfigPath = path.join(appResourcesDir, 'app-update.yml');
const notarizationDir = path.join(distDir, 'notarization');
const notaryArchivePath = path.join(notarizationDir, `${productName}-${version}-${arch}-notary.zip`);
const statePath = path.join(distDir, 'macos-release-state.json');
const builderBin = path.join(projectDir, 'node_modules', '.bin', 'electron-builder');
const defaultPublishConfig = packageJson.build?.publish || {};
const macEntitlementsPath = path.join(projectDir, packageJson.build?.mac?.entitlements || '');

const args = process.argv.slice(2);
const command = args[0] || 'help';
const flags = new Set(args.slice(1));

function now() {
  return new Date().toISOString();
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function ensureEnv(name, fallback) {
  const value = (process.env[name] || fallback || '').trim();
  if (!value) {
    fail(`Missing ${name}.`);
  }
  return value;
}

function artifactBaseName(ext) {
  return `${artifactProductName}-${version}-${arch}.${ext}`;
}

function artifactPath(ext) {
  return path.join(distDir, artifactBaseName(ext));
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function loadState() {
  if (!(await exists(statePath))) {
    fail(`No release state found at ${statePath}. Run "npm run dist" or "npm run release:github" first.`);
  }

  return JSON.parse(await fs.readFile(statePath, 'utf8'));
}

async function saveState(nextState) {
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
}

function run(commandName, commandArgs, { capture = false, cwd = projectDir, env } = {}) {
  const result = spawnSync(commandName, commandArgs, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (result.status !== 0) {
    const detail = capture ? `${result.stdout || ''}${result.stderr || ''}`.trim() : '';
    throw new Error(detail || `${commandName} exited with code ${result.status}`);
  }

  return capture ? (result.stdout || '').trim() : '';
}

async function removeIfExists(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function cleanupPrepareOutputs() {
  await removeIfExists(appDir);
  await removeIfExists(notarizationDir);
  await removeIfExists(statePath);
}

async function cleanupArtifactOutputs() {
  const files = [
    artifactPath('dmg'),
    `${artifactPath('dmg')}.blockmap`,
    artifactPath('zip'),
    `${artifactPath('zip')}.blockmap`,
    path.join(distDir, 'latest-mac.yml'),
  ];

  for (const targetPath of files) {
    await removeIfExists(targetPath);
  }
}

async function restoreSubmittedAppArchive(state) {
  if (!(await exists(state.notaryArchivePath))) {
    fail(`Accepted notary archive is missing at ${state.notaryArchivePath}.`);
  }

  await removeIfExists(appPath);
  await fs.mkdir(appDir, { recursive: true });
  run('/usr/bin/ditto', ['-x', '-k', state.notaryArchivePath, appDir]);

  if (!(await exists(appPath))) {
    fail(`Restored app bundle not found at ${appPath} after extracting ${state.notaryArchivePath}.`);
  }
}

function notaryInfoArgs(submissionId, keychainProfile) {
  return [
    'notarytool',
    'info',
    submissionId,
    '--keychain-profile',
    keychainProfile,
    '--output-format',
    'json',
  ];
}

function submitNotaryArgs(filePath, keychainProfile, { wait = false } = {}) {
  return [
    'notarytool',
    'submit',
    filePath,
    '--keychain-profile',
    keychainProfile,
    '--output-format',
    'json',
    ...(wait ? ['--wait'] : []),
  ];
}

function trimTagPlaceholder(uploadUrl) {
  return uploadUrl.replace(/\{.*$/, '');
}

function releaseRepoFromState(state, publishRequested) {
  const repoOwner = (
    process.env.UPDATE_REPO_OWNER ||
    state.repoOwner ||
    defaultPublishConfig.owner ||
    ''
  ).trim();
  const repoName = (
    process.env.UPDATE_REPO_NAME ||
    state.repoName ||
    defaultPublishConfig.repo ||
    ''
  ).trim();

  if (publishRequested && (!repoOwner || !repoName)) {
    fail('Publishing requires UPDATE_REPO_OWNER and UPDATE_REPO_NAME.');
  }

  return { repoOwner, repoName };
}

function updaterCacheDirName() {
  return `${String(packageJson.name || productName)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .toLowerCase()}-updater`;
}

function buildAppUpdateYaml({ repoOwner, repoName }) {
  return [
    'provider: github',
    `owner: ${repoOwner}`,
    `repo: ${repoName}`,
    'private: false',
    `updaterCacheDirName: ${updaterCacheDirName()}`,
    '',
  ].join('\n');
}

async function writeEmbeddedAppUpdateConfig({ repoOwner, repoName }) {
  if (!repoOwner || !repoName) {
    return;
  }

  await fs.mkdir(appResourcesDir, { recursive: true });
  await fs.writeFile(appUpdateConfigPath, buildAppUpdateYaml({ repoOwner, repoName }), 'utf8');
}

function detectSigningIdentity() {
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = `${result.stdout || ''}${result.stderr || ''}`.trim();
    fail(detail || `codesign exited with code ${result.status}`);
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const match = output.match(/^Authority=(Developer ID Application:[^\n]+)$/m);
  if (!match) {
    fail(`Could not determine the current Developer ID signing identity from ${appPath}.`);
  }

  return match[1];
}

function resignAppBundle() {
  if (!macEntitlementsPath) {
    fail('No mac entitlements file is configured for re-signing.');
  }

  const identity = detectSigningIdentity();
  run('/usr/bin/codesign', [
    '--force',
    '--sign',
    identity,
    '--timestamp',
    '--options',
    'runtime',
    '--entitlements',
    macEntitlementsPath,
    appPath,
  ]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
}

async function prepare() {
  const keychainProfile = ensureEnv('APPLE_KEYCHAIN_PROFILE');
  const repoOwner = (process.env.UPDATE_REPO_OWNER || defaultPublishConfig.owner || '').trim();
  const repoName = (process.env.UPDATE_REPO_NAME || defaultPublishConfig.repo || '').trim();
  if (flags.has('--github') && (!repoOwner || !repoName)) {
    fail('release:github requires UPDATE_REPO_OWNER and UPDATE_REPO_NAME.');
  }

  await cleanupPrepareOutputs();
  await cleanupArtifactOutputs();
  await fs.mkdir(notarizationDir, { recursive: true });

  log('Building signed macOS app bundle...');
  run(builderBin, ['--mac', 'dir', '--arm64']);

  if (!(await exists(appPath))) {
    fail(`Signed app bundle not found at ${appPath}.`);
  }

  await writeEmbeddedAppUpdateConfig({ repoOwner, repoName });
  resignAppBundle();

  log('Creating notarization archive...');
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, notaryArchivePath]);

  log('Submitting archive to Apple notarization...');
  const submitOutput = run(
    '/usr/bin/xcrun',
    [
      'notarytool',
      'submit',
      notaryArchivePath,
      '--keychain-profile',
      keychainProfile,
      '--output-format',
      'json',
    ],
    { capture: true },
  );
  const submitResult = JSON.parse(submitOutput);
  const submissionId = submitResult.id || submitResult.submissionId;

  if (!submissionId) {
    fail(`Apple did not return a submission id.\n${submitOutput}`);
  }

  const state = {
    productName,
    version,
    arch,
    appPath,
    notaryArchivePath,
    keychainProfile,
    submissionId,
    submissionStatus: 'In Progress',
    submittedAt: now(),
    repoOwner,
    repoName,
    releaseTag: `v${version}`,
    phase: 'submitted',
    artifacts: [],
  };

  await saveState(state);

  log('');
  log(`Notarization submitted: ${submissionId}`);
  log(`Saved state: ${statePath}`);
  log('Next steps:');
  log('  npm run dist:status');
  log('  npm run dist:finalize');
  if (repoOwner && repoName) {
    log('  npm run release:github:finalize');
  }
}

async function fetchNotaryInfo(state) {
  const keychainProfile = ensureEnv('APPLE_KEYCHAIN_PROFILE', state.keychainProfile);
  const output = run('/usr/bin/xcrun', notaryInfoArgs(state.submissionId, keychainProfile), {
    capture: true,
  });
  return JSON.parse(output);
}

function submitForNotarization(filePath, keychainProfile, { wait = false } = {}) {
  const output = run('/usr/bin/xcrun', submitNotaryArgs(filePath, keychainProfile, { wait }), {
    capture: true,
  });
  return JSON.parse(output);
}

async function updateStateFromNotary(state) {
  const info = await fetchNotaryInfo(state);
  const nextState = {
    ...state,
    keychainProfile: ensureEnv('APPLE_KEYCHAIN_PROFILE', state.keychainProfile),
    submissionStatus: info.status || state.submissionStatus,
    lastCheckedAt: now(),
    acceptedAt: info.status === 'Accepted' ? now() : state.acceptedAt,
  };
  await saveState(nextState);
  return { state: nextState, info };
}

async function status() {
  const currentState = await loadState();
  const { state, info } = await updateStateFromNotary(currentState);

  log(`Submission: ${state.submissionId}`);
  log(`Status: ${info.status}`);
  if (info.createdDate) {
    log(`Created: ${info.createdDate}`);
  }
  if (info.name) {
    log(`Archive: ${info.name}`);
  }

  if (info.status === 'Accepted') {
    log('Ready to finalize: npm run dist:finalize');
    if (state.repoOwner && state.repoName) {
      log('Or publish now: npm run release:github:finalize');
    }
  } else if (info.status === 'Invalid') {
    log(`Fetch Apple log: xcrun notarytool log ${state.submissionId} --keychain-profile ${state.keychainProfile}`);
    process.exitCode = 1;
  }
}

function packagingArgs({ repoOwner, repoName }) {
  const args = [
    '--prepackaged',
    appPath,
    '--mac',
    'dmg',
    'zip',
    '--arm64',
    '--publish',
    'never',
  ];

  if (repoOwner && repoName) {
    args.push(
      '-c.publish.provider=github',
      `-c.publish.owner=${repoOwner}`,
      `-c.publish.repo=${repoName}`,
    );
  }

  return args;
}

function mimeTypeFor(filePath) {
  if (filePath.endsWith('.dmg')) {
    return 'application/x-apple-diskimage';
  }
  if (filePath.endsWith('.zip')) {
    return 'application/zip';
  }
  if (filePath.endsWith('.yml')) {
    return 'text/yaml';
  }
  return 'application/octet-stream';
}

async function githubRequest(url, { token, method = 'GET', body, contentType } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body,
  });

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${url} failed: ${response.status} ${text}`);
  }

  return json;
}

async function getOrCreateRelease({ token, repoOwner, repoName, tagName }) {
  const releaseUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/tags/${tagName}`;

  try {
    return await githubRequest(releaseUrl, { token });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('404')) {
      throw error;
    }
  }

  return githubRequest(`https://api.github.com/repos/${repoOwner}/${repoName}/releases`, {
    token,
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({
      tag_name: tagName,
      name: `${productName} ${version}`,
      draft: false,
      prerelease: false,
      generate_release_notes: false,
    }),
  });
}

async function uploadReleaseAssets({ token, release, files }) {
  const uploadUrl = trimTagPlaceholder(release.upload_url);

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const buffer = await fs.readFile(filePath);
    const targetUrl = `${uploadUrl}?name=${encodeURIComponent(fileName)}`;
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': mimeTypeFor(filePath),
        'Content-Length': String(buffer.byteLength),
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: buffer,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub asset upload failed for ${fileName}: ${response.status} ${text}`);
    }

    log(`Uploaded ${fileName}`);
  }
}

async function deleteExistingAssets({ token, repoOwner, repoName, release, files }) {
  const names = new Set(files.map((filePath) => path.basename(filePath)));
  for (const asset of release.assets || []) {
    if (!names.has(asset.name)) {
      continue;
    }
    await githubRequest(
      `https://api.github.com/repos/${repoOwner}/${repoName}/releases/assets/${asset.id}`,
      { token, method: 'DELETE' },
    );
  }
}

async function publishGitHubRelease(state, files) {
  const token = ensureEnv('GH_TOKEN');
  const { repoOwner, repoName } = releaseRepoFromState(state, true);
  const release = await getOrCreateRelease({
    token,
    repoOwner,
    repoName,
    tagName: state.releaseTag,
  });

  await deleteExistingAssets({ token, repoOwner, repoName, release, files });
  const refreshedRelease = await githubRequest(
    `https://api.github.com/repos/${repoOwner}/${repoName}/releases/tags/${state.releaseTag}`,
    { token },
  );
  await uploadReleaseAssets({ token, release: refreshedRelease, files });
}

async function finalize() {
  const currentState = await loadState();
  const publishRequested = flags.has('--publish');
  const { state, info } = await updateStateFromNotary(currentState);
  const keychainProfile = ensureEnv('APPLE_KEYCHAIN_PROFILE', state.keychainProfile);

  if (info.status !== 'Accepted') {
    fail(`Cannot finalize while submission status is ${info.status}. Run "npm run dist:status" again later.`);
  }

  log('Restoring the exact accepted app bundle from the notarized archive...');
  await restoreSubmittedAppArchive(state);

  log('Stapling notarization ticket to the app...');
  run('/usr/bin/xcrun', ['stapler', 'staple', appPath]);

  const { repoOwner, repoName } = releaseRepoFromState(state, publishRequested || flags.has('--github'));

  log('Packaging DMG and ZIP from the stapled app...');
  await cleanupArtifactOutputs();
  run(builderBin, packagingArgs({ repoOwner, repoName }));

  const dmgPath = artifactPath('dmg');
  let dmgStapled = false;
  if (await exists(dmgPath)) {
    log('Submitting packaged DMG for notarization and waiting for Apple...');
    const dmgSubmission = submitForNotarization(dmgPath, keychainProfile, { wait: true });
    if ((dmgSubmission.status || '').toLowerCase() !== 'accepted') {
      fail(`DMG notarization failed: ${JSON.stringify(dmgSubmission)}`);
    }

    log('Stapling notarization ticket to the DMG...');
    run('/usr/bin/xcrun', ['stapler', 'staple', dmgPath]);
    dmgStapled = true;
  }

  const artifacts = [
    dmgPath,
    `${dmgPath}.blockmap`,
    artifactPath('zip'),
    `${artifactPath('zip')}.blockmap`,
  ];
  const latestMacPath = path.join(distDir, 'latest-mac.yml');
  if (repoOwner && repoName && (await exists(latestMacPath))) {
    artifacts.push(latestMacPath);
  }

  const existingArtifacts = [];
  for (const filePath of artifacts) {
    if (await exists(filePath)) {
      existingArtifacts.push(filePath);
    }
  }

  const nextState = {
    ...state,
    repoOwner,
    repoName,
    artifacts: existingArtifacts,
    dmgStapled,
    dmgNotarizedAt: dmgStapled ? now() : null,
    phase: publishRequested ? 'publishing' : 'packaged',
    finalizedAt: now(),
  };
  await saveState(nextState);

  if (publishRequested) {
    log('Publishing release assets to GitHub...');
    await publishGitHubRelease(nextState, existingArtifacts);
    await saveState({
      ...nextState,
      phase: 'published',
      publishedAt: now(),
    });
    log(`Published ${nextState.releaseTag} to ${repoOwner}/${repoName}`);
    return;
  }

  log('Artifacts are ready in dist/.');
  if (repoOwner && repoName) {
    log('To publish them to GitHub, run: npm run release:github:finalize');
  }
}

function printHelp() {
  log('Usage: node scripts/macos-release.mjs <prepare|status|finalize> [--github] [--publish]');
}

switch (command) {
  case 'prepare':
    await prepare();
    break;
  case 'status':
    await status();
    break;
  case 'finalize':
    await finalize();
    break;
  default:
    printHelp();
    process.exitCode = command === 'help' ? 0 : 1;
}
