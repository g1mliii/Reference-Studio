import { access, readFile } from 'node:fs/promises';

const LOCKFILE_PATH = new URL('../package-lock.json', import.meta.url);
const PACKAGE_JSON_PATH = new URL('../package.json', import.meta.url);

const BLOCKED_PACKAGES = new Map([
  [
    'axios',
    {
      versions: new Set(['1.14.1', '0.30.4']),
      reason: 'reported malicious publish on npm on 2026-03-31',
    },
  ],
  [
    'plain-crypto-js',
    {
      versions: new Set(['4.2.1']),
      reason: 'reported malicious publish on npm on 2026-03-31',
    },
  ],
]);

const BLOCKED_HOSTS = new Set(['sfrclak.com', '142.11.206.73']);
const ALLOWED_TARBALL_HOSTS = new Set(
  (process.env.ALLOWED_NPM_HOSTS ?? 'registry.npmjs.org').split(',').map((host) => host.trim()).filter(Boolean),
);

async function readJson(fileUrl, label) {
  try {
    return JSON.parse(await readFile(fileUrl, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${error.message}`);
  }
}

function inspectPackage(name, meta, issues) {
  const blocked = BLOCKED_PACKAGES.get(name);
  if (!blocked) {
    return;
  }

  if (blocked.versions.has(meta?.version)) {
    issues.push(`Blocked package ${name}@${meta.version}: ${blocked.reason}`);
  }
}

function inspectResolved(name, meta, issues) {
  const resolved = meta?.resolved;
  if (!resolved || resolved.startsWith('file:')) {
    return;
  }

  let url;
  try {
    url = new URL(resolved);
  } catch {
    issues.push(`Package ${name} has an invalid resolved URL: ${resolved}`);
    return;
  }

  if (BLOCKED_HOSTS.has(url.hostname)) {
    issues.push(`Package ${name} resolves through blocked host ${url.hostname}`);
  }

  if (url.protocol !== 'https:') {
    issues.push(`Package ${name} resolves over ${url.protocol} instead of https`);
  }

  if (!ALLOWED_TARBALL_HOSTS.has(url.hostname)) {
    issues.push(
      `Package ${name} resolves through unexpected host ${url.hostname}. ` +
        `Set ALLOWED_NPM_HOSTS to permit additional registries if this is intentional.`,
    );
  }
}

async function main() {
  const packageJson = await readJson(PACKAGE_JSON_PATH, 'package.json');
  if (!packageJson.packageManager) {
    console.warn('Warning: package.json does not declare packageManager; use npm ci against the committed lockfile.');
  }

  try {
    await access(LOCKFILE_PATH);
  } catch {
    console.warn('Skipping dependency compromise check because package-lock.json is missing.');
    return;
  }

  const lockfile = await readJson(LOCKFILE_PATH, 'package-lock.json');
  const packages = lockfile?.packages ?? {};
  const issues = [];

  for (const [packagePath, meta] of Object.entries(packages)) {
    if (packagePath === '') {
      continue;
    }

    const name = meta?.name ?? packagePath.split('node_modules/').pop();
    inspectPackage(name, meta, issues);
    inspectResolved(name, meta, issues);
  }

  if (issues.length > 0) {
    console.error('Dependency security check failed:');
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Dependency security check passed. Scanned ${Object.keys(packages).length - 1} lockfile entries against blocked versions and registry host policy.`,
  );
}

await main();
