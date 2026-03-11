#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');
const packageJson = JSON.parse(
  await fs.readFile(path.join(projectDir, 'package.json'), 'utf8'),
);
const productName = packageJson.build?.productName || packageJson.productName || packageJson.name;
const version = packageJson.version;
const arch = 'arm64';
const distDir = path.join(projectDir, 'dist');
const appPath = path.join(distDir, `mac-${arch}`, `${productName}.app`);
const dmgPath = path.join(distDir, `${productName}-${version}-${arch}.dmg`);

function run(commandName, commandArgs, { allowFailure = false } = {}) {
  const result = spawnSync(commandName, commandArgs, {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  const output = [stdout, stderr].filter(Boolean).join('\n');

  if (!allowFailure && result.status !== 0) {
    throw new Error(output || `${commandName} exited with code ${result.status}`);
  }

  return {
    code: result.status ?? 0,
    output,
  };
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseEntitlements(xml) {
  return {
    allowJit: xml.includes('com.apple.security.cs.allow-jit'),
    allowUnsignedExecutableMemory: xml.includes(
      'com.apple.security.cs.allow-unsigned-executable-memory',
    ),
    disableLibraryValidation: xml.includes('com.apple.security.cs.disable-library-validation'),
    hasGetTaskAllow: xml.includes('com.apple.security.get-task-allow'),
  };
}

function findLine(text, prefix) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith(prefix));
}

function printSection(title) {
  process.stdout.write(`\n${title}\n`);
}

function printStatus(label, value) {
  process.stdout.write(`${label}: ${value}\n`);
}

async function main() {
  if (!(await exists(appPath))) {
    process.stderr.write(`Missing app bundle: ${appPath}\n`);
    process.exit(1);
  }

  const appFiles = Number.parseInt(run('/usr/bin/find', [appPath, '-type', 'f']).output.split('\n').length, 10);
  const macosFilesRaw = run('/usr/bin/find', [path.join(appPath, 'Contents', 'MacOS'), '-maxdepth', '1', '-type', 'f']).output;
  const macosFiles = macosFilesRaw ? macosFilesRaw.split('\n').filter(Boolean) : [];
  const hasAsar = await exists(path.join(appPath, 'Contents', 'Resources', 'app.asar'));

  printSection('Bundle');
  printStatus('App', appPath);
  printStatus('File count', String(appFiles));
  printStatus('Contents/MacOS files', String(macosFiles.length));
  printStatus('Resources/app.asar', hasAsar ? 'present' : 'missing');

  const codeSignInfo = run('/usr/bin/codesign', ['-dvvv', appPath], { allowFailure: true });
  const codeVerify = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    allowFailure: true,
  });
  const entitlements = run('/usr/bin/codesign', ['-d', '--entitlements', ':-', appPath], {
    allowFailure: true,
  });
  const entitlementsInfo = parseEntitlements(entitlements.output);

  printSection('Signing');
  printStatus('Authority', findLine(codeSignInfo.output, 'Authority=') || 'missing');
  printStatus('Timestamp', findLine(codeSignInfo.output, 'Timestamp=') || 'missing');
  printStatus('Runtime', findLine(codeSignInfo.output, 'Runtime Version=') || 'missing');
  printStatus('codesign verify', codeVerify.code === 0 ? 'ok' : `failed (${codeVerify.code})`);
  printStatus('allow-jit', entitlementsInfo.allowJit ? 'yes' : 'no');
  printStatus(
    'allow-unsigned-executable-memory',
    entitlementsInfo.allowUnsignedExecutableMemory ? 'yes' : 'no',
  );
  printStatus(
    'disable-library-validation',
    entitlementsInfo.disableLibraryValidation ? 'yes' : 'no',
  );
  printStatus('get-task-allow', entitlementsInfo.hasGetTaskAllow ? 'present' : 'absent');

  const gatekeeperApp = run('/usr/sbin/spctl', ['-a', '-vv', '-t', 'exec', appPath], {
    allowFailure: true,
  });

  printSection('Gatekeeper');
  printStatus('App', gatekeeperApp.output || `spctl exit ${gatekeeperApp.code}`);

  if (await exists(dmgPath)) {
    const dmgCodesign = run('/usr/bin/codesign', ['-dv', dmgPath], { allowFailure: true });
    const gatekeeperDmg = run('/usr/sbin/spctl', ['-a', '-vv', '-t', 'open', dmgPath], {
      allowFailure: true,
    });
    const staplerDmg = run('/usr/bin/xcrun', ['stapler', 'validate', dmgPath], {
      allowFailure: true,
    });

    printSection('DMG');
    printStatus('DMG', dmgPath);
    printStatus('codesign', dmgCodesign.code === 0 ? 'signed' : `not signed (${dmgCodesign.code})`);
    printStatus('Gatekeeper', gatekeeperDmg.output || `spctl exit ${gatekeeperDmg.code}`);
    printStatus('Stapler', staplerDmg.output || `stapler exit ${staplerDmg.code}`);
  } else {
    printSection('DMG');
    printStatus('DMG', 'not built yet');
  }
}

await main();
