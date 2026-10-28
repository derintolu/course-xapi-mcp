// SPDX-License-Identifier: Apache-2.0
// Files only the server's own user can read: folders 0700, files 0600, each file written through a synced
// temporary file in the same folder and a rename, so a reader or a crash never leaves half a file.
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Makes a rename or delete that just happened in `dir` durable. Not every platform can sync a folder; there it is skipped. */
export async function syncDir(dir: string) {
  let fh;
  try {
    fh = await open(dir, 'r');
    await fh.sync();
  } catch {
    // The rename itself is atomic either way.
  } finally {
    await fh?.close();
  }
}

/** Writes `text` to `file` (mode 0600) through a synced temporary file and a rename; on failure no temporary file is left. */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  let fh;
  try {
    fh = await open(tmp, 'wx', 0o600);
    await fh.writeFile(text);
    await fh.sync();
    await fh.close();
    fh = undefined;
    await rename(tmp, file);
  } catch (e) {
    await fh?.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw e;
  }
  await syncDir(dirname(file));
}

/** Creates `dir` (and any missing parent) 0700 if needed, and makes `dir` 0700 whatever made it before. */
export async function privateDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}
