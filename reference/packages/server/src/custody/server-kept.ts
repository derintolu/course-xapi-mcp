// SPDX-License-Identifier: Apache-2.0
// Option 3, server-kept: the course server is the official record holder, in its own store.
// The learner views, exports and deletes the record on this server's record pages.
import type { Custody, LearnerRef, RecordView } from '@course-xapi-mcp/core';
import type { ServerStore } from './stores.ts';

export function createServerKeptCustody(o: { store: ServerStore; publicUrl: string; courseTitle: string }): Custody {
  const { store } = o;
  const base = o.publicUrl;

  return {
    option: 'server-kept',
    official: true,

    async load(l: LearnerRef) {
      const got = await store.getState(l.subject);
      return got ? { state: got.state, etag: got.etag } : {};
    },

    save(l, state, etag) {
      return store.putState(l.subject, state, etag);
    },

    deliver(l, statements) {
      return store.append(l.subject, statements);
    },

    async record(l): Promise<RecordView> {
      const [statements, got] = await Promise.all([store.statements(l.subject), store.getState(l.subject)]);
      return {
        official: true,
        statements,
        complete: got?.state.satisfied.course ?? false,
        note: `This is your official record, kept by ${o.courseTitle} on this course server. View, export or delete it at ${base}/record.`,
      };
    },

    links() {
      return {
        holder: `${o.courseTitle} (this course server)`,
        view: base + '/record',
        export: base + '/record/export.json',
        delete: base + '/record',
        policy: base + '/record/policy',
      };
    },
  };
}
