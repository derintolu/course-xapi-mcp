// SPDX-License-Identifier: Apache-2.0
// Option 2: the official record and the working state live in an LRS the course author names.
import { STATE_IDS, StoreConflictError, StoreError, type CourseModel, type Custody, type LearnerRef, type LearnerState, type XapiAgent, type XapiStatement } from '@course-xapi-mcp/core';
import { createLrsClient, type LrsClient, type XapiVersion } from '@course-xapi-mcp/lrs-client';

/**
 * The ETag this custody hands out names the registration it was read under as well as the LRS ETag
 * of that registration's state document, so a save under a new registration (restart_course) can
 * move the registration pointer only if it still points where the caller last read it.
 */
interface Tag {
  r: string;
  d: string;
}

/** Without a version (ETag) the next save could never be made conditional, so it would conflict for ever. */
const NO_VERSION = "the record holder did not return a version for the learner's state";

const encode = (t: Tag) => JSON.stringify(t);
function decode(etag: string | undefined): Tag | undefined {
  if (etag === undefined) return undefined;
  try {
    const t = JSON.parse(etag) as Partial<Tag>;
    if (typeof t.r === 'string' && typeof t.d === 'string') return { r: t.r, d: t.d };
  } catch {
    // fall through
  }
  throw new StoreConflictError();
}

const isForCourse = (s: XapiStatement, courseId: string) =>
  s.object.id === courseId || (s.context?.contextActivities?.grouping ?? []).some((a) => a.id === courseId);

export function createAuthorLrsCustody(o: {
  course: CourseModel;
  lrs: { endpoint: string; key: string; secret: string; version?: XapiVersion };
  publicUrl: string;
  assignActor?: (subject: string) => Promise<XapiAgent>;
  fetch?: typeof fetch;
}): Custody & {
  /** The actor this custody keeps the learner's state and reads their record under; statements must use it too. */
  actorFor(subject: string): Promise<XapiAgent>;
} {
  const client: LrsClient = createLrsClient({
    endpoint: o.lrs.endpoint,
    auth: { type: 'basic', key: o.lrs.key, secret: o.lrs.secret },
    version: o.lrs.version ?? 'auto',
    fetch: o.fetch,
  });
  const courseId = o.course.id;
  const base = o.publicUrl.replace(/\/+$/, '');

  const actorOf = (subject: string): Promise<XapiAgent> =>
    o.assignActor ? o.assignActor(subject) : Promise.resolve({ objectType: 'Agent', account: { homePage: courseId, name: subject } });
  const actorFor = (l: LearnerRef) => actorOf(l.subject);
  const pointerKey = (agent: XapiAgent) => ({ activityId: courseId, agent, stateId: STATE_IDS.registration });
  const stateKey = (agent: XapiAgent, registration: string) => ({ activityId: courseId, agent, registration, stateId: STATE_IDS.learner });

  async function readPointer(agent: XapiAgent): Promise<{ registration: string; etag?: string } | undefined> {
    const got = await client.getState(pointerKey(agent));
    const registration = (got?.body as { registration?: unknown } | undefined)?.registration;
    return got && typeof registration === 'string' ? { registration, etag: got.etag } : undefined;
  }

  async function etagAfterPut(put: { etag?: string }, key: ReturnType<typeof stateKey>): Promise<string> {
    const etag = put.etag ?? (await client.getState(key))?.etag;
    if (etag === undefined) throw new StoreError(NO_VERSION);
    return etag;
  }

  return {
    option: 'author-lrs',
    official: true,
    actorFor: actorOf,

    async load(l) {
      const agent = await actorFor(l);
      const pointer = await readPointer(agent);
      if (!pointer) return {};
      const got = await client.getState(stateKey(agent, pointer.registration));
      if (!got) return {};
      if (got.etag === undefined) throw new StoreError(NO_VERSION);
      return { state: got.body as LearnerState, etag: encode({ r: pointer.registration, d: got.etag }) };
    },

    async save(l, state, etag) {
      const agent = await actorFor(l);
      const key = stateKey(agent, state.registration);
      const tag = decode(etag);
      if (tag && tag.r === state.registration) {
        // A tab still on a registration that restart_course replaced must not keep writing to it.
        if ((await readPointer(agent))?.registration !== tag.r) throw new StoreConflictError();
        const put = await client.putState(key, state, { ifMatch: tag.d });
        return { etag: encode({ r: state.registration, d: await etagAfterPut(put, key) }) };
      }

      // First save, or a new registration: the registration's document must not exist yet, and the
      // pointer must still be where the caller read it (on a first save: absent, or left pointing at a
      // state the record holder has since erased).
      const pointer = await readPointer(agent);
      if (tag ? pointer?.registration !== tag.r : pointer !== undefined && (await client.getState(stateKey(agent, pointer.registration)))) {
        throw new StoreConflictError();
      }
      const put = await client.putState(key, state, { ifNoneMatch: '*' });
      const d = await etagAfterPut(put, key);
      await client.putState(pointerKey(agent), { registration: state.registration }, pointer?.etag !== undefined ? { ifMatch: pointer.etag } : { ifNoneMatch: '*' });
      return { etag: encode({ r: state.registration, d }) };
    },

    async deliver(_l, statements) {
      await client.postStatements(statements);
    },

    async record(l) {
      const agent = await actorFor(l);
      const statements = (await client.getStatements({ agent })).filter((s) => isForCourse(s, courseId));
      return { official: true, statements, complete: true, note: 'The course author\'s learning record store holds your official record.' };
    },

    links() {
      return {
        holder: `${o.course.title} (the course author's learning record store)`,
        view: base + '/record',
        export: base + '/record/export.json',
      };
    },
  };
}
