// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  PRACTICE_HOMEPAGE,
  PRACTICE_LABEL,
  StoreConflictError,
  StoreError,
  type LearnerRef,
  type LearnerState,
  type XapiStatement,
} from '@course-xapi-mcp/core';
import { PRACTICE_FORMAT, PRACTICE_VERSION, newPracticeHandle, parsePracticeRecord, type PracticeRecord } from '@course-xapi-mcp/core/practice';
import { createPracticeCustody } from '../src/custody/practice.ts';
import { createServerKeptCustody } from '../src/custody/server-kept.ts';
import { DirectoryPracticeStore, DirectoryServerStore, MemoryPracticeStore, MemoryServerStore, type PracticeStore, type ServerStore } from '../src/custody/stores.ts';
import { withLearnerLock } from '../src/custody/mutex.ts';

const COURSE = 'https://course-xapi-mcp.sqwrlz.com/examples/json-basics';
const AU = COURSE + '/lessons/what-is-json';
const REG = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const SUBJECT = 'learner-subject-7f3e';

function state(over: Partial<LearnerState> = {}): LearnerState {
  return {
    v: 1,
    courseVersion: '1.0.0',
    registration: REG,
    createdAt: '2026-10-27T12:00:00.000Z',
    updatedAt: '2026-10-27T12:00:00.000Z',
    au: {},
    satisfied: { blocks: [], course: false },
    files: {},
    outbox: [],
    awards: [],
    ...over,
  };
}

let n = 0;
/** A practice-shaped allowed statement; enough for the stores, which do not check the profile. */
function stmt(actor: LearnerRef['actor'], id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`): XapiStatement {
  return {
    id,
    actor,
    verb: { id: 'http://adlnet.gov/expapi/verbs/experienced', display: { en: 'experienced' } },
    object: { objectType: 'Activity', id: AU + '/beats/intro', definition: { type: 'https://course-xapi-mcp.sqwrlz.com/xapi/activity-types/beat', name: { en: 'Intro' } } },
    context: {
      registration: REG,
      language: 'en',
      contextActivities: {
        parent: [{ objectType: 'Activity', id: AU + '/au' }],
        grouping: [{ objectType: 'Activity', id: AU }, { objectType: 'Activity', id: COURSE }],
        category: [{ objectType: 'Activity', id: 'https://course-xapi-mcp.sqwrlz.com/xapi/v0.2' }, { objectType: 'Activity', id: 'https://course-xapi-mcp.sqwrlz.com/xapi/practice' }],
      },
      extensions: {
        'https://w3id.org/xapi/cmi5/context/extensions/sessionid': 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        'https://course-xapi-mcp.sqwrlz.com/xapi/extensions/rules-version': '0.2',
        'https://course-xapi-mcp.sqwrlz.com/xapi/extensions/custody': 'practice',
      },
    },
    timestamp: '2026-10-27T12:00:00.000Z',
  };
}

const dirs: string[] = [];
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), 'cxm-custody-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Every file and folder name under `dir`, recursively. */
async function names(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    out.push(e.name);
    if (e.isDirectory()) out.push(...(await names(join(dir, e.name))));
  }
  return out;
}

const practiceActor = { objectType: 'Agent' as const, account: { homePage: PRACTICE_HOMEPAGE, name: 'p-0001' } };
const officialActor = { objectType: 'Agent' as const, account: { homePage: COURSE, name: SUBJECT } };

function practiceRef(handle = newPracticeHandle()): LearnerRef {
  return { kind: 'practice', subject: handle, actor: practiceActor, handle };
}
const officialRef: LearnerRef = { kind: 'official', subject: SUBJECT, actor: officialActor };

describe('withLearnerLock', () => {
  it('runs two concurrent calls for one subject one after the other', async () => {
    const log: string[] = [];
    const slow = (name: string) =>
      withLearnerLock(SUBJECT, async () => {
        log.push(name + ' start');
        await new Promise((r) => setTimeout(r, 20));
        log.push(name + ' end');
        return name;
      });
    const results = await Promise.all([slow('a'), slow('b')]);
    expect(results).toEqual(['a', 'b']);
    expect(log).toEqual(['a start', 'a end', 'b start', 'b end']);
  });

  it('does not hold up another subject, and releases after a failure', async () => {
    const log: string[] = [];
    let release!: () => void;
    const held = withLearnerLock('one', () => new Promise<void>((r) => (release = r)));
    await withLearnerLock('two', async () => log.push('two ran'));
    expect(log).toEqual(['two ran']);
    release();
    await held;

    await expect(withLearnerLock('one', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await withLearnerLock('one', async () => 'after')).toBe('after');
  });
});

describe('MemoryPracticeStore', () => {
  it('expires a copy 30 days after it was last saved (injected clock)', async () => {
    let now = Date.parse('2026-10-27T12:00:00.000Z');
    const store = new MemoryPracticeStore(undefined, () => now);
    const h = newPracticeHandle();
    const rec = practiceRecord();
    await store.put(h, rec);
    now += DEFAULTS.practiceTtlMs - 1;
    expect((await store.get(h))?.record).toEqual(rec);
    now += 1;
    expect(await store.get(h)).toBeUndefined();
  });

  it('drops an expired copy nobody reads when another copy is saved', async () => {
    let now = Date.parse('2026-10-27T12:00:00.000Z');
    const store = new MemoryPracticeStore(undefined, () => now);
    const abandoned = newPracticeHandle();
    await store.put(abandoned, practiceRecord());
    now += DEFAULTS.practiceTtlMs;
    await store.put(newPracticeHandle(), practiceRecord());
    // Lift the clock back: only a sweep on that put can have removed the abandoned copy.
    now -= DEFAULTS.practiceTtlMs;
    expect(await store.get(abandoned)).toBeUndefined();
  });
});

function practiceRecord(over: Partial<PracticeRecord> = {}): PracticeRecord {
  return {
    format: PRACTICE_FORMAT,
    version: PRACTICE_VERSION,
    official: false,
    label: PRACTICE_LABEL,
    courseId: COURSE,
    actor: practiceActor,
    createdAt: '2026-10-27T12:00:00.000Z',
    updatedAt: '2026-10-27T12:00:00.000Z',
    state: state(),
    statements: [],
    ...over,
  };
}

const practiceStores: [string, () => Promise<PracticeStore>][] = [
  ['MemoryPracticeStore', async () => new MemoryPracticeStore()],
  ['DirectoryPracticeStore', async () => new DirectoryPracticeStore(await tempDir())],
];

describe.each(practiceStores)('%s', (_name, make) => {
  it('gets, puts with an etag, and deletes', async () => {
    const store = await make();
    const h = newPracticeHandle();
    expect(await store.get(h)).toBeUndefined();
    const { etag } = await store.put(h, practiceRecord());
    const got = await store.get(h);
    expect(got).toEqual({ record: practiceRecord(), etag });
    const next = await store.put(h, practiceRecord({ updatedAt: '2026-10-27T12:05:00.000Z' }), etag);
    expect(next.etag).not.toBe(etag);
    expect(await store.delete(h)).toBe(true);
    expect(await store.get(h)).toBeUndefined();
    expect(await store.delete(h)).toBe(false);
  });

  it('throws StoreConflictError on a stale etag, and when creating over an existing copy', async () => {
    const store = await make();
    const h = newPracticeHandle();
    const { etag } = await store.put(h, practiceRecord());
    await store.put(h, practiceRecord({ updatedAt: '2026-10-27T12:01:00.000Z' }), etag);
    await expect(store.put(h, practiceRecord(), etag)).rejects.toBeInstanceOf(StoreConflictError);
    await expect(store.put(h, practiceRecord())).rejects.toBeInstanceOf(StoreConflictError);
    await expect(store.put(newPracticeHandle(), practiceRecord(), etag)).rejects.toBeInstanceOf(StoreConflictError);
  });
});

describe('DirectoryPracticeStore', () => {
  it('never writes the handle in a file name', async () => {
    const dir = await tempDir();
    const store = new DirectoryPracticeStore(dir);
    const h = newPracticeHandle();
    await store.put(h, practiceRecord());
    const all = await names(dir);
    expect(all.length).toBeGreaterThan(0);
    for (const name of all) {
      expect(name).not.toContain(h);
      expect(name).not.toContain(h.slice(4));
    }
  });

  it('expires a copy after the TTL', async () => {
    let now = Date.parse('2026-10-27T12:00:00.000Z');
    const store = new DirectoryPracticeStore(await tempDir(), undefined, () => now);
    const h = newPracticeHandle();
    await store.put(h, practiceRecord());
    now += DEFAULTS.practiceTtlMs;
    expect(await store.get(h)).toBeUndefined();
  });

  it('removes an expired file nobody reads on a later put, at most once an hour', async () => {
    let now = Date.parse('2026-10-27T12:00:00.000Z');
    const dir = await tempDir();
    const store = new DirectoryPracticeStore(dir, undefined, () => now);
    await store.put(newPracticeHandle(), practiceRecord());
    now += DEFAULTS.practiceTtlMs - 1000;
    await store.put(newPracticeHandle(), practiceRecord());
    now += 1000;
    await store.put(newPracticeHandle(), practiceRecord());
    expect(await readdir(dir)).toHaveLength(3);
    now += 3_600_000;
    await store.put(newPracticeHandle(), practiceRecord());
    expect(await readdir(dir)).toHaveLength(3);
  });
});

const serverStores: [string, () => Promise<ServerStore>][] = [
  ['MemoryServerStore', async () => new MemoryServerStore()],
  ['DirectoryServerStore', async () => new DirectoryServerStore(await tempDir())],
];

describe.each(serverStores)('%s', (_name, make) => {
  it('keeps state with an etag and refuses a stale one', async () => {
    const store = await make();
    expect(await store.getState(SUBJECT)).toBeUndefined();
    const { etag } = await store.putState(SUBJECT, state());
    expect(await store.getState(SUBJECT)).toEqual({ state: state(), etag });
    const second = await store.putState(SUBJECT, state({ updatedAt: '2026-10-27T12:01:00.000Z' }), etag);
    await expect(store.putState(SUBJECT, state(), etag)).rejects.toBeInstanceOf(StoreConflictError);
    await expect(store.putState(SUBJECT, state())).rejects.toBeInstanceOf(StoreConflictError);
    expect((await store.getState(SUBJECT))?.etag).toBe(second.etag);
  });

  it('appends idempotently by statement id', async () => {
    const store = await make();
    const a = stmt(officialActor);
    const b = stmt(officialActor);
    await store.append(SUBJECT, [a, b]);
    await store.append(SUBJECT, [a, b]);
    await store.append(SUBJECT, [b]);
    expect(await store.statements(SUBJECT)).toEqual([a, b]);
    expect(await store.statements('someone-else')).toEqual([]);
  });

  it('deleteLearner removes state and statements', async () => {
    const store = await make();
    await store.putState(SUBJECT, state());
    await store.append(SUBJECT, [stmt(officialActor)]);
    await store.putState('other', state());
    await store.deleteLearner(SUBJECT);
    expect(await store.getState(SUBJECT)).toBeUndefined();
    expect(await store.statements(SUBJECT)).toEqual([]);
    expect(await store.getState('other')).toBeDefined();
    await store.deleteLearner(SUBJECT);
  });

  it('one of two concurrent saves from the same etag wins; the other gets StoreConflictError', async () => {
    const store = await make();
    const { etag } = await store.putState(SUBJECT, state());
    const results = await Promise.allSettled([
      store.putState(SUBJECT, state({ updatedAt: '2026-10-27T12:01:00.000Z' }), etag),
      store.putState(SUBJECT, state({ updatedAt: '2026-10-27T12:02:00.000Z' }), etag),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(StoreConflictError);
  });
});

describe('DirectoryServerStore', () => {
  it('never writes the subject in a file name', async () => {
    const dir = await tempDir();
    const store = new DirectoryServerStore(dir);
    await store.putState(SUBJECT, state());
    await store.append(SUBJECT, [stmt(officialActor)]);
    const all = await names(dir);
    expect(all.length).toBeGreaterThan(0);
    for (const name of all) expect(name).not.toContain(SUBJECT);
  });

  it('survives a new instance over the same folder', async () => {
    const dir = await tempDir();
    const a = stmt(officialActor);
    const first = new DirectoryServerStore(dir);
    const { etag } = await first.putState(SUBJECT, state());
    await first.append(SUBJECT, [a]);
    const second = new DirectoryServerStore(dir);
    expect(await second.getState(SUBJECT)).toEqual({ state: state(), etag });
    expect(await second.statements(SUBJECT)).toEqual([a]);
  });
});

describe('server-kept custody', () => {
  const make = () =>
    createServerKeptCustody({ store: new MemoryServerStore(), publicUrl: 'https://course.example', courseTitle: 'JSON basics' });

  it('is the official server-kept option', () => {
    const c = make();
    expect(c.option).toBe('server-kept');
    expect(c.official).toBe(true);
  });

  it('loads nothing for a new learner, then saves and loads with an etag', async () => {
    const c = make();
    expect(await c.load(officialRef)).toEqual({});
    const { etag } = await c.save(officialRef, state());
    expect(await c.load(officialRef)).toEqual({ state: state(), etag });
  });

  it('save with a stale etag throws StoreConflictError', async () => {
    const c = make();
    const { etag } = await c.save(officialRef, state());
    await c.save(officialRef, state({ updatedAt: '2026-10-27T12:01:00.000Z' }), etag);
    await expect(c.save(officialRef, state(), etag)).rejects.toBeInstanceOf(StoreConflictError);
  });

  it('delivers statements idempotently and shows them in the record', async () => {
    const c = make();
    const s = stmt(officialActor);
    await c.save(officialRef, state({ satisfied: { blocks: [], course: true } }));
    await c.deliver(officialRef, [s]);
    await c.deliver(officialRef, [s]);
    const view = await c.record(officialRef);
    expect(view.official).toBe(true);
    expect(view.statements).toEqual([s]);
    expect(view.complete).toBe(true);
  });

  it('links to the record pages on this server', () => {
    expect(make().links(officialRef)).toEqual({
      holder: 'JSON basics (this course server)',
      view: 'https://course.example/record',
      export: 'https://course.example/record/export.json',
      delete: 'https://course.example/record',
      policy: 'https://course.example/record/policy',
    });
  });
});

describe('practice custody', () => {
  it('is the unofficial practice option with no record holder', () => {
    const c = createPracticeCustody({ courseId: COURSE });
    expect(c.option).toBe('practice');
    expect(c.official).toBe(false);
    expect(c.links(practiceRef())).toEqual({ holder: 'nobody: practice run' });
  });

  it('keeps state and statements in one practice copy under the handle', async () => {
    const store = new MemoryPracticeStore();
    const c = createPracticeCustody({ store, courseId: COURSE });
    const l = practiceRef();
    expect(await c.load(l)).toEqual({});
    const { etag } = await c.save(l, state());
    expect(await c.load(l)).toEqual({ state: state(), etag });
    const s = stmt(practiceActor);
    await c.deliver(l, [s]);
    await c.deliver(l, [s]);

    const kept = (await store.get(l.handle!))!.record;
    expect(kept).toMatchObject({ format: PRACTICE_FORMAT, official: false, label: PRACTICE_LABEL, courseId: COURSE, actor: practiceActor });
    expect(kept.statements).toEqual([s]);
    expect(parsePracticeRecord(JSON.parse(JSON.stringify(kept)), COURSE).ok).toBe(true);

    const view = await c.record(l);
    expect(view).toMatchObject({ official: false, statements: [s], complete: false, note: PRACTICE_LABEL });
  });

  it('save with a stale etag throws StoreConflictError', async () => {
    const c = createPracticeCustody({ courseId: COURSE });
    const l = practiceRef();
    const { etag } = await c.save(l, state());
    await c.save(l, state({ updatedAt: '2026-10-27T12:01:00.000Z' }), etag);
    await expect(c.save(l, state(), etag)).rejects.toBeInstanceOf(StoreConflictError);
  });

  it('a save after the loaded copy expired says the copy is gone, not a conflict', async () => {
    let now = Date.parse('2026-10-27T12:00:00.000Z');
    const c = createPracticeCustody({ store: new MemoryPracticeStore(undefined, () => now), courseId: COURSE });
    const l = practiceRef();
    const { etag } = await c.save(l, state());
    now += DEFAULTS.practiceTtlMs;
    const err = await c.save(l, state(), etag).catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).not.toBeInstanceOf(StoreConflictError);
    expect(err.message).toContain('no longer exists');
  });

  it('refuses a learner without a practice handle', async () => {
    const c = createPracticeCustody({ courseId: COURSE });
    await expect(c.load(officialRef)).rejects.toBeInstanceOf(StoreError);
  });

  it('deliver to a copy that no longer exists throws StoreError', async () => {
    const c = createPracticeCustody({ courseId: COURSE });
    await expect(c.deliver(practiceRef(), [stmt(practiceActor)])).rejects.toBeInstanceOf(StoreError);
  });

  it('importCopy continues an exported copy under a new handle; deletePractice removes it', async () => {
    const c = createPracticeCustody({ courseId: COURSE });
    const s = stmt(practiceActor);
    const h = newPracticeHandle();
    await c.importCopy(h, practiceRecord({ statements: [s] }));
    const l = practiceRef(h);
    expect((await c.load(l)).state).toEqual(state());
    expect((await c.record(l)).statements).toEqual([s]);
    expect(await c.deletePractice(h)).toBe(true);
    expect(await c.load(l)).toEqual({});
    expect(await c.deletePractice(h)).toBe(false);
  });

  it('keeps the copy in a directory store whose files do not name the handle', async () => {
    const dir = await tempDir();
    const c = createPracticeCustody({ store: new DirectoryPracticeStore(dir), courseId: COURSE });
    const l = practiceRef();
    await c.save(l, state());
    const [file] = await readdir(dir);
    expect(file).not.toContain(l.handle!.slice(4));
    expect(await readFile(join(dir, file!), 'utf8')).not.toContain(l.handle!);
  });
});
