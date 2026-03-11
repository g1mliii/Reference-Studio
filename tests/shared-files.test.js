import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildOutputFileName,
  findDuplicateStems,
  listImagePathsPage,
  listImageFiles,
} from '../src/shared/files.js';

const tempDirectories = [];

async function makeTempDir() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'car-studio-files-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('shared/files', () => {
  it('lists only supported image files in sorted order', async () => {
    const directory = await makeTempDir();
    await fs.writeFile(path.join(directory, 'b.webp'), '');
    await fs.writeFile(path.join(directory, 'a.png'), '');
    await fs.writeFile(path.join(directory, 'notes.txt'), '');

    const files = await listImageFiles(directory);

    expect(files.map((filePath) => path.basename(filePath))).toEqual([
      'a.png',
      'b.webp',
    ]);
  });

  it('creates loose output names using car and reference stems', () => {
    expect(
      buildOutputFileName(
        '/tmp/blue,911-gt3-rs.png',
        '/tmp/studio-front.jpg',
      ),
    ).toBe('blue,911-gt3-rs,studio-front.png');
  });

  it('finds duplicate car stems', () => {
    expect(
      findDuplicateStems([
        '/tmp/red,car.png',
        '/tmp/red,car.jpg',
        '/tmp/blue,car.webp',
      ]),
    ).toEqual(['red,car']);
  });

  it('returns a paged list of image paths', async () => {
    const directory = await makeTempDir();
    await fs.writeFile(path.join(directory, 'blue,911-gt3-rs.png'), '');
    await fs.writeFile(path.join(directory, 'green,m3.png'), '');

    const page = await listImagePathsPage(directory, 2, 1);

    expect(page.items).toEqual([path.join(directory, 'green,m3.png')]);
    expect(page.total).toBe(2);
    expect(page.totalPages).toBe(2);
    expect(page.page).toBe(2);
  });
});
