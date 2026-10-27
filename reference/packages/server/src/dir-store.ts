// SPDX-License-Identifier: Apache-2.0
// A RecordStore that keeps each record as a JSON file in a folder (Node only).
// File names are a hash of the handle, so listing the folder does not reveal handles.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseRecord, type LearningRecord, type RecordStore } from '@course-xapi-mcp/core';

export class DirectoryStore implements RecordStore {
  private dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private file(handle: string) {
    return join(this.dir, `${createHash('sha256').update(handle).digest('hex')}.json`);
  }
  async get(handle: string): Promise<LearningRecord | undefined> {
    try {
      const p = parseRecord(JSON.parse(await readFile(this.file(handle), 'utf8')));
      return p.ok ? p.record : undefined;
    } catch {
      return undefined;
    }
  }
  async put(handle: string, record: LearningRecord) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(handle), JSON.stringify(record, null, 2));
  }
  async delete(handle: string) {
    try {
      await rm(this.file(handle));
      return true;
    } catch {
      return false;
    }
  }
}
