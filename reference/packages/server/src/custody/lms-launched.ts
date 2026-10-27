// SPDX-License-Identifier: Apache-2.0
// Option 1: the LMS launched the lesson; statements and working state go to the LMS's LRS with the launch's token.
import {
  actorKey,
  ADL_VERBS,
  CMI5,
  STATE_IDS,
  StoreConflictError,
  StoreError,
  type CourseModel,
  type Custody,
  type LaunchContext,
  type LaunchStore,
  type LearnerRef,
  type LearnerState,
  type RecordView,
  type XapiStatement,
} from '@course-xapi-mcp/core';
import { createLrsClient, type LrsClient } from '@course-xapi-mcp/lrs-client';

type Receipt = NonNullable<RecordView['receipt']>;

const RELAUNCHED = 'this lesson was relaunched elsewhere; continue in the newest window or launch it again from your LMS';
const ENDED = 'this lesson session has ended; launch it again from your LMS';
const NOT_LAUNCHED = 'this lesson was not launched from your LMS; launch it from your LMS';
const NOTE = 'Your LMS holds the official record; ask it for a full export.';
/** State document holding a receipt of every statement this server delivered for the registration. */
const RECEIPT_STATE_ID = 'cxm-receipt';
const RECEIPT_TRIES = 3;

export function createLmsLaunchedCustody(o: {
  course: CourseModel;
  launches: LaunchStore;
  fetch?: typeof fetch;
}): Custody & { launchFor(l: LearnerRef, auKey?: string): Promise<LaunchContext | { error: string }> } {
  const courseId = o.course.id;
  const clients = new Map<string, LrsClient>();

  function clientFor(c: LaunchContext): LrsClient {
    const key = c.endpoint + ' ' + c.authToken;
    let client = clients.get(key);
    if (!client) {
      client = createLrsClient({ endpoint: c.endpoint, auth: { type: 'token', value: c.authToken }, fetch: o.fetch });
      clients.set(key, client);
    }
    return client;
  }

  async function bound(l: LearnerRef): Promise<LaunchContext> {
    const c = l.launchId === undefined ? undefined : await o.launches.get(l.launchId);
    if (!c) throw new StoreError(NOT_LAUNCHED);
    return c;
  }

  /** True when a newer launch of the same AU exists for this endpoint, actor and registration. */
  async function stale(c: LaunchContext): Promise<boolean> {
    if (c.supersededAt !== undefined) return true;
    const newest = await o.launches.latestFor(c.endpoint, actorKey(c.actor), c.registration, c.auKey);
    return newest !== undefined && newest.launchId !== c.launchId;
  }

  async function live(l: LearnerRef): Promise<LaunchContext> {
    const c = await bound(l);
    if (await stale(c)) throw new StoreError(RELAUNCHED);
    return c;
  }

  const docKey = (c: LaunchContext, stateId: string) => ({ activityId: courseId, agent: c.actor, registration: c.registration, stateId });

  async function readReceipt(c: LaunchContext): Promise<{ receipt: Receipt; etag?: string }> {
    const got = await clientFor(c).getState(docKey(c, RECEIPT_STATE_ID));
    const receipt = Array.isArray(got?.body) ? (got.body as Receipt) : [];
    return { receipt, etag: got?.etag };
  }

  async function addToReceipt(c: LaunchContext, statements: XapiStatement[]): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const { receipt, etag } = await readReceipt(c);
      const fresh = statements.filter((s) => !receipt.some((r) => r.id === s.id));
      if (fresh.length === 0) return;
      const next = [
        ...receipt,
        ...fresh.map((s) => ({ id: s.id, verb: s.verb.display['en-US'] ?? Object.values(s.verb.display)[0] ?? s.verb.id, object: s.object.id, timestamp: s.timestamp })),
      ];
      try {
        await clientFor(c).putState(docKey(c, RECEIPT_STATE_ID), next, etag !== undefined ? { ifMatch: etag } : { ifNoneMatch: '*' });
        return;
      } catch (e) {
        // Another call delivered at the same time: merge again on top of its receipt.
        if (!(e instanceof StoreConflictError) || attempt >= RECEIPT_TRIES) throw e;
      }
    }
  }

  return {
    option: 'lms-launched',
    official: true,

    async launchFor(l, auKey) {
      const c = l.launchId === undefined ? undefined : await o.launches.get(l.launchId);
      if (!c) return { error: NOT_LAUNCHED };
      if (await stale(c)) return { error: RELAUNCHED };
      const newest = await o.launches.latestFor(c.endpoint, actorKey(c.actor), c.registration, auKey);
      return newest ?? { error: NOT_LAUNCHED };
    },

    async load(l) {
      const c = await bound(l);
      const got = await clientFor(c).getState(docKey(c, STATE_IDS.learner));
      if (!got) return {};
      const state = got.body as LearnerState;
      return got.etag === undefined ? { state } : { state, etag: got.etag };
    },

    async save(l, state, etag) {
      // Saving stays allowed after terminated, so the engine can clear its outbox; a stale launch may not write.
      const c = await live(l);
      const key = docKey(c, STATE_IDS.learner);
      const client = clientFor(c);
      const put = await client.putState(key, state, etag !== undefined ? { ifMatch: etag } : { ifNoneMatch: '*' });
      const next = put.etag ?? (await client.getState(key))?.etag;
      if (next === undefined) throw new StoreError('the record holder did not return a version for the saved state');
      return { etag: next };
    },

    async deliver(l, statements) {
      const c = await live(l);
      if (c.terminatedAt !== undefined) {
        // A redelivered outbox the LMS already accepted is fine; anything new is refused.
        const { receipt } = await readReceipt(c);
        if (statements.some((s) => !receipt.some((r) => r.id === s.id))) throw new StoreError(ENDED);
        return;
      }
      await clientFor(c).postStatements(statements);
      await addToReceipt(c, statements);
      const terminated = statements.find((s) => s.verb.id === ADL_VERBS.terminated && s.context?.extensions?.[CMI5.extSessionId] === c.sessionId);
      const patch: Partial<LaunchContext> = { lastActivityAt: new Date().toISOString() };
      if (terminated) patch.terminatedAt = terminated.timestamp;
      await o.launches.update(c.launchId, patch);
    },

    async record(l) {
      const c = await bound(l);
      const client = clientFor(c);
      let statements: XapiStatement[] = [];
      let complete = true;
      try {
        statements = await client.getStatements({ agent: c.actor, registration: c.registration });
      } catch {
        complete = false;
      }
      let receipt: Receipt = [];
      try {
        receipt = (await readReceipt(c)).receipt;
      } catch {
        complete = false;
      }
      return { official: true, statements, receipt, complete, note: NOTE };
    },

    links() {
      return { holder: 'your LMS' };
    },
  };
}
