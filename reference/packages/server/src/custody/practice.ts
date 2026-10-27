// SPDX-License-Identifier: Apache-2.0
// Option 4, practice: nobody holds an official record. The working state and the statements of a practice run
// are kept together as one practice copy under the practice handle (the relay), and returned to the learner.
import { PRACTICE_LABEL, StoreError, type Custody, type LearnerRef, type LearnerState, type RecordView, type XapiStatement } from '@course-xapi-mcp/core';
import { PRACTICE_FORMAT, PRACTICE_VERSION, isPracticeHandle, type PracticeActor, type PracticeRecord } from '@course-xapi-mcp/core/practice';
import { MemoryPracticeStore, type PracticeStore } from './stores.ts';

export type PracticeCustody = Custody & {
  /** True when a copy was there. */
  deletePractice(handle: string): Promise<boolean>;
  /** Stores a copy `parsePracticeRecord` accepted under a new handle, to continue it as practice. */
  importCopy(handle: string, rec: PracticeRecord): Promise<void>;
};

function handleOf(l: LearnerRef): string {
  if (!isPracticeHandle(l.handle)) throw new StoreError('a practice run needs its practice handle');
  return l.handle;
}

const gone = () => new StoreError('this practice copy no longer exists; practice copies are kept for 30 days');

export function createPracticeCustody(o: { store?: PracticeStore; courseId: string }): PracticeCustody {
  const store = o.store ?? new MemoryPracticeStore();

  return {
    option: 'practice',
    official: false,

    async load(l) {
      const got = await store.get(handleOf(l));
      return got ? { state: got.record.state, etag: got.etag } : {};
    },

    async save(l, state: LearnerState, etag?: string) {
      const handle = handleOf(l);
      const got = await store.get(handle);
      // The copy the caller loaded has expired (or was deleted) since: say so rather than report a conflict.
      if (!got && etag !== undefined) throw gone();
      const record: PracticeRecord = got
        ? { ...got.record, state, updatedAt: state.updatedAt }
        : {
            format: PRACTICE_FORMAT,
            version: PRACTICE_VERSION,
            official: false,
            label: PRACTICE_LABEL,
            courseId: o.courseId,
            actor: structuredClone(l.actor) as PracticeActor,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
            state,
            statements: [],
          };
      // The etag the caller read decides, not the one just fetched: a save since then conflicts.
      return store.put(handle, record, etag);
    },

    async deliver(l, statements: XapiStatement[]) {
      const handle = handleOf(l);
      const got = await store.get(handle);
      if (!got) throw gone();
      const ids = new Set(got.record.statements.map((s) => s.id));
      const fresh = statements.filter((s) => !ids.has(s.id) && ids.add(s.id));
      if (!fresh.length) return;
      await store.put(handle, { ...got.record, statements: [...got.record.statements, ...fresh] }, got.etag);
    },

    async record(l): Promise<RecordView> {
      const got = await store.get(handleOf(l));
      return {
        official: false,
        statements: got?.record.statements ?? [],
        complete: got?.record.state.satisfied.course ?? false,
        note: PRACTICE_LABEL,
      };
    },

    links() {
      return { holder: 'nobody: practice run' };
    },

    deletePractice(handle) {
      return store.delete(handle);
    },

    async importCopy(handle, rec) {
      await store.put(handle, rec);
    },
  };
}
