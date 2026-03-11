import fs from 'node:fs/promises';
import path from 'node:path';

import { SUPPORTED_IMAGE_EXTENSIONS } from './constants.js';

export function isSupportedImageFile(filePath) {
  return SUPPORTED_IMAGE_EXTENSIONS.has(
    path.extname(filePath).toLowerCase(),
  );
}

export async function listImageFiles(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directoryPath, entry.name))
    .filter((filePath) => isSupportedImageFile(filePath))
    .sort((left, right) => left.localeCompare(right));
}

export function fileStem(filePath) {
  return path.parse(filePath).name;
}

export function fileName(filePath) {
  return path.basename(filePath);
}

export function sanitizeFileFragment(value) {
  return value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildOutputFileName(carPath, referencePath) {
  const carStem = sanitizeFileFragment(fileStem(carPath));
  const referenceStem = sanitizeFileFragment(fileStem(referencePath));
  return `${carStem},${referenceStem}.png`;
}

export function buildRequestKey(carPath, referencePath) {
  return `${fileStem(carPath)}::${fileStem(referencePath)}`;
}

export async function ensureDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function findDuplicateStems(filePaths) {
  const counts = new Map();
  for (const filePath of filePaths) {
    const stem = fileStem(filePath);
    counts.set(stem, (counts.get(stem) || 0) + 1);
  }

  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([stem]) => stem);
}

export async function describeImageFiles(directoryPath) {
  const files = await listImageFiles(directoryPath);
  return files.map((filePath) => ({
    path: filePath,
    name: fileName(filePath),
    stem: fileStem(filePath),
  }));
}

export async function listImagePathsPage(directoryPath, page = 1, pageSize = 50) {
  const files = await listImageFiles(directoryPath);
  const normalizedPage = Math.max(1, Number(page) || 1);
  const normalizedPageSize = Math.max(1, Number(pageSize) || 50);
  const total = files.length;
  const totalPages = Math.max(1, Math.ceil(total / normalizedPageSize));
  const safePage = Math.min(normalizedPage, totalPages);
  const startIndex = (safePage - 1) * normalizedPageSize;
  const items = files.slice(startIndex, startIndex + normalizedPageSize);

  return {
    directoryPath,
    items,
    page: safePage,
    pageSize: normalizedPageSize,
    total,
    totalPages,
  };
}
