// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { privateDir, writeFileAtomic } from '../src/private-files.ts';

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), 'cxm-files-'));
  dirs.push(d);
  return d;
}

describe('private files', () => {
  it('writeFileAtomic replaces a file with a 0600 one and leaves no temporary file', async () => {
    const dir = await tempDir();
    const file = join(dir, 'x.json');
    await writeFile(file, 'old', { mode: 0o644 });
    await writeFileAtomic(file, 'new');
    expect(await readFile(file, 'utf8')).toBe('new');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['x.json']);
  });

  it('a write whose rename fails leaves what was there and no temporary file', async () => {
    const dir = await tempDir();
    // The name is taken by a folder, so the rename fails after the temporary file was written and synced.
    await mkdir(join(dir, 'x.json'));
    await writeFile(join(dir, 'x.json', 'keep'), 'kept');
    await expect(writeFileAtomic(join(dir, 'x.json'), 'new')).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['x.json']);
    expect(await readFile(join(dir, 'x.json', 'keep'), 'utf8')).toBe('kept');
  });

  it('privateDir creates folders 0700 and narrows an existing one', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'wide'), { mode: 0o755 });
    await privateDir(join(dir, 'wide'));
    await privateDir(join(dir, 'a', 'b'));
    for (const d of ['wide', 'a', join('a', 'b')]) expect((await stat(join(dir, d))).mode & 0o777).toBe(0o700);
  });
});
