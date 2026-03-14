#!/usr/bin/env node
/**
 * Emergency batch result extractor.
 * Usage:
 *   GEMINI_API_KEY=your-key node scripts/extract-batch.mjs \
 *     --file files/batch-9b5kprz373qdbfjl2y83as7qipvlff8avxxh \
 *     --out ~/Desktop/batch-output
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') result.file = args[++i];
    if (args[i] === '--out') result.out = args[++i];
  }
  return result;
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Set GEMINI_API_KEY environment variable.');
    process.exit(1);
  }

  const { file: fileName, out: outDir } = parseArgs();
  if (!fileName || !outDir) {
    console.error('Usage: GEMINI_API_KEY=key node scripts/extract-batch.mjs --file files/batch-xxx --out /path/to/output');
    process.exit(1);
  }

  const expandedOut = outDir.replace(/^~/, process.env.HOME);
  await fs.mkdir(expandedOut, { recursive: true });

  console.log(`Downloading ${fileName}...`);
  const downloadUrl = `https://generativelanguage.googleapis.com/v1beta/${fileName}:download?alt=media&key=${apiKey}`;
  const { status, body } = await fetchUrl(downloadUrl);

  if (status !== 200) {
    console.error(`Download failed with status ${status}:`);
    console.error(body.toString('utf8').slice(0, 500));
    process.exit(1);
  }

  const content = body.toString('utf8');
  console.log(`Downloaded ${content.length} bytes. Parsing...`);

  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  console.log(`Found ${lines.length} result lines.`);

  let saved = 0;
  let failed = 0;
  let noImage = 0;

  for (let i = 0; i < lines.length; i++) {
    let item;
    try {
      item = JSON.parse(lines[i]);
    } catch (e) {
      console.warn(`Line ${i + 1}: failed to parse JSON, skipping.`);
      failed++;
      continue;
    }

    const key =
      item.metadata?.requestKey ||
      item.key ||
      item.metadata?.key ||
      `item-${i + 1}`;

    if (item.error) {
      console.warn(`Line ${i + 1} [${key}]: error — ${item.error.message || JSON.stringify(item.error)}`);
      failed++;
      continue;
    }

    // Find inline image
    let imageData = null;
    let mimeType = 'image/png';
    for (const candidate of item.response?.candidates || []) {
      for (const part of candidate?.content?.parts || []) {
        if (part.inlineData?.data) {
          imageData = part.inlineData.data;
          mimeType = part.inlineData.mimeType || 'image/png';
          break;
        }
      }
      if (imageData) break;
    }

    if (!imageData) {
      console.warn(`Line ${i + 1} [${key}]: no image data.`);
      noImage++;
      continue;
    }

    const ext = mimeType.includes('jpeg') ? '.jpg' : mimeType.includes('webp') ? '.webp' : '.png';
    const safeName = key.replace(/[^a-zA-Z0-9_,. -]/g, '_');
    const outFile = path.join(expandedOut, `${safeName}${ext}`);
    await fs.writeFile(outFile, Buffer.from(imageData, 'base64'));
    console.log(`Saved: ${path.basename(outFile)}`);
    saved++;
  }

  console.log(`\nDone. Saved: ${saved}  Failed: ${failed}  No image: ${noImage}`);
  console.log(`Output folder: ${expandedOut}`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
