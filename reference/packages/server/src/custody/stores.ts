// SPDX-License-Identifier: Apache-2.0
// Where the practice relay (option 4) and the server-kept record (option 3) live between tool calls.
// Every write takes the etag the caller read; a mismatch throws StoreConflictError. Writing with no etag
// means "this is new" and conflicts when something is already there.
// Directory stores name files by the SHA-256 of the handle or subject, so a folder listing reveals neither.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULTS, StoreConflictError, type LearnerState, type XapiStatement } from '@course-xapi-mcp/core';
import type { PracticeRecord } from '@course-xapi-mcp/core/practice';
import { createKeyedMutex } from './mutex.ts';

export interface PracticeStore {
  get(handle: string): Promise<{ record: PracticeRecord; etag: string } | undefined>;
  /** Throws `StoreConflictError` when `etag` is not the stored one (or is absent while a copy exists). */
  put(handle: string, rec: PracticeRecord, etag?: string): Promise<{ etag: string }>;
  /** True when a copy was there. */
  delete(handle: string): Promise<boolean>;
}

export interface ServerStore {
  getState(subject: string): Promise<{ state: LearnerState; etag: string } | undefined>;
  /** Throws `StoreConflictError` when `etag` is not the stored one (or is absent while state exists). */
  putState(subject: string, state: LearnerState, etag?: string): Promise<{ etag: string }>;
  /** Idempotent by statement id: a statement whose id is already stored is skipped. */
  append(subject: string, statements: XapiStatement[]): Promise<void>;
  statements(subject: string): Promise<XapiStatement[]>;
  deleteLearner(subject: string): Promise<void>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function checkEtag(current: string | undefined, given: string | undefined) {
  if (current !== given) throw new StoreConflictError();
}

function appendNew(kept: XapiStatement[], more: XapiStatement[]): XapiStatement[] {
  const ids = new Set(kept.map((s) => s.id));
  const out = [...kept];
  for (const s of more) {
    if (ids.has(s.id)) continue;
    ids.add(s.id);
    out.push(structuredClone(s));
  }
  return out;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Writes through a temporary file and a rename, so a reader never sees half a file. */
async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

/** In-memory practice relay. A copy expires `ttlMs` after it was last saved (30 days by default). */
export class MemoryPracticeStore implements PracticeStore {
  readonly #items = new Map<string, { record: PracticeRecord; etag: string; savedAt: number }>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(ttlMs: number = DEFAULTS.practiceTtlMs, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  #live(handle: string) {
    const it = this.#items.get(handle);
    if (it && this.#now() - it.savedAt >= this.#ttlMs) {
      this.#items.delete(handle);
      return undefined;
    }
    return it;
  }

  async get(handle: string) {
    const it = this.#live(handle);
    return it && { record: structuredClone(it.record), etag: it.etag };
  }

  async put(handle: string, rec: PracticeRecord, etag?: string) {
    checkEtag(this.#live(handle)?.etag, etag);
    const next = randomUUID();
    this.#items.set(handle, { record: structuredClone(rec), etag: next, savedAt: this.#now() });
    return { etag: next };
  }

  async delete(handle: string) {
    const had = this.#live(handle) !== undefined;
    this.#items.delete(handle);
    return had;
  }
}

interface PracticeFile {
  etag: string;
  savedAt: number;
  record: PracticeRecord;
}

/** Practice relay in a folder (Node only), one file per copy, named by the SHA-256 of the handle. */
export class DirectoryPracticeStore implements PracticeStore {
  readonly #dir: string;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #lock = createKeyedMutex();

  constructor(dir: string, ttlMs: number = DEFAULTS.practiceTtlMs, now: () => number = Date.now) {
    this.#dir = dir;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  #file(handle: string) {
    return join(this.#dir, sha256(handle) + '.json');
  }

  async #read(file: string): Promise<PracticeFile | undefined> {
    const f = await readJson<PracticeFile>(file);
    if (f && this.#now() - f.savedAt >= this.#ttlMs) {
      await rm(file, { force: true });
      return undefined;
    }
    return f;
  }

  async get(handle: string) {
    const f = await this.#read(this.#file(handle));
    return f && { record: f.record, etag: f.etag };
  }

  async put(handle: string, rec: PracticeRecord, etag?: string) {
    const file = this.#file(handle);
    return this.#lock(file, async () => {
      checkEtag((await this.#read(file))?.etag, etag);
      await mkdir(this.#dir, { recursive: true });
      const next = randomUUID();
      await writeJson(file, { etag: next, savedAt: this.#now(), record: rec } satisfies PracticeFile);
      return { etag: next };
    });
  }

  async delete(handle: string) {
    const file = this.#file(handle);
    return this.#lock(file, async () => {
      const had = (await this.#read(file)) !== undefined;
      await rm(file, { force: true });
      return had;
    });
  }
}

/** In-memory server-kept record (option 3). Lost on restart; for tests and demos. */
export class MemoryServerStore implements ServerStore {
  readonly #state = new Map<string, { state: LearnerState; etag: string }>();
  readonly #statements = new Map<string, XapiStatement[]>();

  async getState(subject: string) {
    const it = this.#state.get(subject);
    return it && { state: structuredClone(it.state), etag: it.etag };
  }

  async putState(subject: string, state: LearnerState, etag?: string) {
    checkEtag(this.#state.get(subject)?.etag, etag);
    const next = randomUUID();
    this.#state.set(subject, { state: structuredClone(state), etag: next });
    return { etag: next };
  }

  async append(subject: string, statements: XapiStatement[]) {
    this.#statements.set(subject, appendNew(this.#statements.get(subject) ?? [], statements));
  }

  async statements(subject: string) {
    return structuredClone(this.#statements.get(subject) ?? []);
  }

  async deleteLearner(subject: string) {
    this.#state.delete(subject);
    this.#statements.delete(subject);
  }
}

/** Server-kept record in a folder (Node only): one subfolder per learner, named by the SHA-256 of the subject. */
export class DirectoryServerStore implements ServerStore {
  readonly #dir: string;
  readonly #lock = createKeyedMutex();

  constructor(dir: string) {
    this.#dir = dir;
  }

  #folder(subject: string) {
    return join(this.#dir, sha256(subject));
  }

  async getState(subject: string) {
    return readJson<{ state: LearnerState; etag: string }>(join(this.#folder(subject), 'state.json'));
  }

  async putState(subject: string, state: LearnerState, etag?: string) {
    const folder = this.#folder(subject);
    return this.#lock(folder, async () => {
      checkEtag((await this.getState(subject))?.etag, etag);
      await mkdir(folder, { recursive: true });
      const next = randomUUID();
      await writeJson(join(folder, 'state.json'), { state, etag: next });
      return { etag: next };
    });
  }

  async append(subject: string, statements: XapiStatement[]) {
    const folder = this.#folder(subject);
    await this.#lock(folder, async () => {
      await mkdir(folder, { recursive: true });
      await writeJson(join(folder, 'statements.json'), appendNew(await this.statements(subject), statements));
    });
  }

  async statements(subject: string) {
    return (await readJson<XapiStatement[]>(join(this.#folder(subject), 'statements.json'))) ?? [];
  }

  async deleteLearner(subject: string) {
    const folder = this.#folder(subject);
    await this.#lock(folder, () => rm(folder, { recursive: true, force: true }));
  }
}
