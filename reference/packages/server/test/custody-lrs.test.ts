// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ADL_VERBS,
  CMI5,
  MemoryLaunchStore,
  STATE_IDS,
  StoreConflictError,
  StoreError,
  type ContextTemplate,
  type CourseModel,
  type LaunchContext,
  type LearnerRef,
  type LearnerState,
  type XapiAgent,
  type XapiStatement,
} from '@course-xapi-mcp/core';
import { buildDefined, type Cmi5Context } from '@course-xapi-mcp/core/xapi';
import { createLmsSim, createTestLrs, type TestLrs } from '@course-xapi-mcp/conformance';
import { createLrsClient, fetchAuthToken, LrsError } from '@course-xapi-mcp/lrs-client';
import { createAuthorLrsCustody } from '../src/custody/author-lrs.ts';
import { createLmsLaunchedCustody } from '../src/custody/lms-launched.ts';

const LRS_URL = 'http://lrs.test/xapi';
const PUBLIC_URL = 'https://course.example';
const COURSE = { id: 'https://example.org/course', title: 'JSON basics' } as CourseModel;
const AU1 = 'https://example.org/course/au1';
const AU2 = 'https://example.org/course/au2';
const RELAUNCHED = 'this lesson was relaunched elsewhere; continue in the newest window or launch it again from your LMS';
const ENDED = 'this lesson session has ended; launch it again from your LMS';
const NO_VERSION = "the record holder did not return a version for the learner's state";

type Seen = { method: string; url: URL; headers: Headers };

/** A fetch that serves the test LRS in memory and records every request. */
function lrsFetch(lrs: TestLrs) {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ method: req.method, url: new URL(req.url), headers: req.headers });
    return lrs.fetch(req);
  }) as typeof fetch;
  return { f, seen };
}

/** The test LRS behind a fetch that drops the ETag from State GETs, as a non-conforming LRS might. */
function noStateEtag(lrs: TestLrs) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const res = await lrs.fetch(req);
    if (req.method !== 'GET' || !new URL(req.url).pathname.endsWith('/activities/state')) return res;
    const headers = new Headers(res.headers);
    headers.delete('etag');
    return new Response(res.body, { status: res.status, headers });
  }) as typeof fetch;
}

function learnerState(registration: string, beat = 0): LearnerState {
  return {
    v: 1,
    courseVersion: '1.0.0',
    registration,
    createdAt: '2026-10-27T10:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
    cursor: { pathKey: 'main', lessonKey: 'l1', beat, phase: 'beats' },
    au: {},
    satisfied: { blocks: [], course: false },
    files: {},
    outbox: [],
    awards: [],
  };
}

let clock = 0;
/** Wall-clock timestamps that never repeat, so they follow the simulator's own. */
const stamp = () => new Date((clock = Math.max(Date.now(), clock + 1))).toISOString();

function cmi5Context(actor: XapiAgent, registration: string, sessionId: string, custody: 'author-lrs' | 'lms-launched', contextTemplate?: ContextTemplate): Cmi5Context {
  return { actor, registration, sessionId, courseId: COURSE.id, language: 'en-US', rulesVersion: '0.2', custody, practice: false, contextTemplate };
}

function defined(c: Cmi5Context, auId: string, verbs: ('initialized' | 'completed' | 'terminated')[]): XapiStatement[] {
  return verbs.map((v) =>
    buildDefined(c, v, { au: { publisherId: auId, activityId: auId + '/au' } }, { id: randomUUID(), timestamp: stamp(), duration: v === 'initialized' ? undefined : 'PT1M' }),
  );
}

// Author LRS (option 2)

function authorSetup(o: { versions?: ('1.0.3' | '2.0.0')[]; version?: '1.0.3' | '2.0.0' } = {}) {
  const lrs = createTestLrs({ versions: o.versions, credentials: [{ key: 'author', secret: 'sekrit' }] });
  const { f, seen } = lrsFetch(lrs);
  const make = () => createAuthorLrsCustody({ course: COURSE, lrs: { endpoint: LRS_URL, key: 'author', secret: 'sekrit', version: o.version }, publicUrl: PUBLIC_URL, fetch: f });
  const subject = 'idp-subject-' + randomUUID();
  const actor: XapiAgent = { objectType: 'Agent', account: { homePage: COURSE.id, name: subject } };
  const learner: LearnerRef = { kind: 'official', subject, actor };
  return { lrs, seen, make, learner, actor };
}

const learnerPuts = (seen: Seen[]) => seen.filter((s) => s.method === 'PUT' && s.url.pathname.endsWith('/activities/state') && s.url.searchParams.get('stateId') === STATE_IDS.learner);

describe('author-LRS custody', () => {
  it('first save sends If-None-Match: *, the next save sends the ETag it got back', async () => {
    const { make, seen, learner } = authorSetup();
    const custody = make();
    expect(custody.option).toBe('author-lrs');
    expect(custody.official).toBe(true);
    expect(await custody.load(learner)).toEqual({});

    const reg = randomUUID();
    const first = await custody.save(learner, learnerState(reg), undefined);
    await custody.save(learner, learnerState(reg, 1), first.etag);

    const [p1, p2] = learnerPuts(seen);
    expect(p1.headers.get('if-none-match')).toBe('*');
    expect(p1.headers.get('if-match')).toBeNull();
    expect(p2.headers.get('if-none-match')).toBeNull();
    expect(p2.headers.get('if-match')).toMatch(/^"[0-9a-f]{40}"$/);
    expect(p1.url.searchParams.get('activityId')).toBe(COURSE.id);
    expect(p1.url.searchParams.get('registration')).toBe(reg);
    expect(JSON.parse(p1.url.searchParams.get('agent')!)).toEqual({ objectType: 'Agent', account: { homePage: COURSE.id, name: learner.subject } });

    const loaded = await custody.load(learner);
    expect(loaded.state?.cursor?.beat).toBe(1);
  });

  it('[Review Focus 2] a save on a stale ETag (another tab saved first) throws StoreConflictError', async () => {
    const { make, learner } = authorSetup();
    const custody = make();
    const reg = randomUUID();
    await custody.save(learner, learnerState(reg), undefined);
    const tab1 = await custody.load(learner);
    const tab2 = await custody.load(learner);
    await custody.save(learner, learnerState(reg, 1), tab1.etag);
    await expect(custody.save(learner, learnerState(reg, 2), tab2.etag)).rejects.toBeInstanceOf(StoreConflictError);
    expect((await custody.load(learner)).state?.cursor?.beat).toBe(1);
  });

  it('[Review Focus 2] two first saves for one learner: one wins, the other conflicts', async () => {
    const { make, learner } = authorSetup();
    const custody = make();
    await custody.save(learner, learnerState(randomUUID()), undefined);
    await expect(custody.save(learner, learnerState(randomUUID()), undefined)).rejects.toBeInstanceOf(StoreConflictError);
  });

  it('the registration pointer survives a new client instance, and a new registration moves it', async () => {
    const { make, learner } = authorSetup();
    const reg = randomUUID();
    const saved = await make().save(learner, learnerState(reg, 3), undefined);

    const again = make();
    const loaded = await again.load(learner);
    expect(loaded.state?.registration).toBe(reg);
    expect(loaded.state?.cursor?.beat).toBe(3);

    // restart_course: a new registration saved on the old ETag
    const reg2 = randomUUID();
    await again.save(learner, learnerState(reg2), loaded.etag);
    expect((await make().load(learner)).state?.registration).toBe(reg2);
    // the old registration's ETag no longer saves
    await expect(make().save(learner, learnerState(reg, 4), saved.etag)).rejects.toBeInstanceOf(StoreConflictError);
  });

  it('a first save works again after the record holder erased the working state but kept the pointer', async () => {
    const { lrs, make, learner, actor } = authorSetup();
    const custody = make();
    const reg = randomUUID();
    await custody.save(learner, learnerState(reg), undefined);
    const q = new URLSearchParams({ activityId: COURSE.id, agent: JSON.stringify(actor), registration: reg, stateId: STATE_IDS.learner });
    const del = await lrs.fetch(new Request(`${LRS_URL}/activities/state?${q}`, { method: 'DELETE', headers: { authorization: 'Basic ' + btoa('author:sekrit'), 'x-experience-api-version': '1.0.3' } }));
    expect(del.status).toBe(204);

    expect(await custody.load(learner)).toEqual({});
    const reg2 = randomUUID();
    await custody.save(learner, learnerState(reg2), undefined);
    expect((await custody.load(learner)).state?.registration).toBe(reg2);
  });

  it('deliver lands statements in the LRS; redelivering the same batch adds nothing', async () => {
    const { lrs, make, learner, actor } = authorSetup();
    const custody = make();
    const batch = defined(cmi5Context(actor, randomUUID(), randomUUID(), 'author-lrs'), AU1, ['initialized', 'completed']);
    await custody.deliver(learner, batch);
    expect(lrs.statements().map((s) => s.id)).toEqual(batch.map((s) => s.id));
    await custody.deliver(learner, batch);
    expect(lrs.statements()).toHaveLength(2);
  });

  it('[Review Focus 3] an LRS that answers 503 makes deliver throw LrsError; the retry delivers once', async () => {
    const { lrs, make, learner, actor } = authorSetup();
    const custody = make();
    await custody.load(learner); // version negotiated, so the failure hits the statements POST
    const batch = defined(cmi5Context(actor, randomUUID(), randomUUID(), 'author-lrs'), AU1, ['initialized', 'completed', 'terminated']);
    lrs.failNext(1, 503);
    const err = await custody.deliver(learner, batch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LrsError);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as LrsError).status).toBe(503);
    expect(lrs.statements()).toHaveLength(0);

    await custody.deliver(learner, batch);
    await custody.deliver(learner, batch);
    expect(lrs.statements().map((s) => s.id)).toEqual(batch.map((s) => s.id));
  });

  for (const version of ['1.0.3', '2.0.0'] as const) {
    // With the version configured; negotiation against a single-version LRS is tested below.
    it(`works against a ${version}-only LRS`, async () => {
      const { lrs, make, learner, actor, seen } = authorSetup({ versions: [version], version });
      const custody = make();
      const reg = randomUUID();
      const { etag } = await custody.save(learner, learnerState(reg), undefined);
      await custody.save(learner, learnerState(reg, 1), etag);
      await custody.deliver(learner, defined(cmi5Context(actor, reg, randomUUID(), 'author-lrs'), AU1, ['initialized']));
      expect(lrs.statements()).toHaveLength(1);
      expect((await custody.load(learner)).state?.cursor?.beat).toBe(1);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((s) => s.headers.get('x-experience-api-version') === version)).toBe(true);
    });
  }

  it('negotiates the version with a 2.0.0-only LRS when none is configured', async () => {
    const { lrs, make, learner, actor, seen } = authorSetup({ versions: ['2.0.0'] });
    const custody = make();
    const reg = randomUUID();
    const { etag } = await custody.save(learner, learnerState(reg), undefined);
    await custody.save(learner, learnerState(reg, 1), etag);
    await custody.deliver(learner, defined(cmi5Context(actor, reg, randomUUID(), 'author-lrs'), AU1, ['initialized']));
    expect(lrs.statements()).toHaveLength(1);
    expect(seen.filter((s) => s.url.pathname.endsWith('/about'))).toHaveLength(1);
    expect(seen.filter((s) => !s.url.pathname.endsWith('/about')).every((s) => s.headers.get('x-experience-api-version') === '2.0.0')).toBe(true);
  });

  it('load refuses a state the LRS returns without an ETag, instead of conflicting on every save', async () => {
    const lrs = createTestLrs({ credentials: [{ key: 'author', secret: 'sekrit' }] });
    const custody = createAuthorLrsCustody({ course: COURSE, lrs: { endpoint: LRS_URL, key: 'author', secret: 'sekrit' }, publicUrl: PUBLIC_URL, fetch: noStateEtag(lrs) });
    const learner: LearnerRef = { kind: 'official', subject: 's', actor: await custody.actorFor('s') };
    await custody.save(learner, learnerState(randomUUID()), undefined);
    const err = await custody.load(learner).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as Error).message).toBe(NO_VERSION);
  });

  it('actorFor gives the actor statements must use: minted from the subject, or assigned', async () => {
    const { make } = authorSetup();
    expect(await make().actorFor('sub-1')).toEqual({ objectType: 'Agent', account: { homePage: COURSE.id, name: 'sub-1' } });
    const assigned: XapiAgent = { objectType: 'Agent', account: { homePage: 'https://lrs.example/people', name: 'p-1' } };
    const lrs = createTestLrs();
    const custody = createAuthorLrsCustody({ course: COURSE, lrs: { endpoint: LRS_URL, key: 'test', secret: 'test' }, publicUrl: PUBLIC_URL, fetch: lrsFetch(lrs).f, assignActor: async () => assigned });
    expect(await custody.actorFor('sub-1')).toEqual(assigned);
  });

  it('record() returns the learner\'s statements for the course across registrations, and links point at /record', async () => {
    const { lrs, make, learner, actor } = authorSetup();
    const custody = make();
    const a = defined(cmi5Context(actor, randomUUID(), randomUUID(), 'author-lrs'), AU1, ['initialized']);
    const b = defined(cmi5Context(actor, randomUUID(), randomUUID(), 'author-lrs'), AU2, ['initialized']);
    const other = defined({ ...cmi5Context(actor, randomUUID(), randomUUID(), 'author-lrs'), courseId: 'https://example.org/other-course' }, AU1, ['initialized']);
    const someoneElse = defined(cmi5Context({ objectType: 'Agent', account: { homePage: COURSE.id, name: 'someone-else' } }, randomUUID(), randomUUID(), 'author-lrs'), AU1, ['initialized']);
    await custody.deliver(learner, [...a, ...b, ...other, ...someoneElse]);
    expect(lrs.statements()).toHaveLength(4);

    const view = await custody.record(learner);
    expect(view.official).toBe(true);
    expect(view.complete).toBe(true);
    expect(view.statements.map((s) => s.id).sort()).toEqual([...a, ...b].map((s) => s.id).sort());
    expect(custody.links(learner)).toEqual({
      holder: 'JSON basics (the course author\'s learning record store)',
      view: PUBLIC_URL + '/record',
      export: PUBLIC_URL + '/record/export.json',
    });
  });

  it('record() keeps the learner\'s voiding statements, which name no course, and the LRS leaves out what they void (badge revocation)', async () => {
    const { lrs, make, learner, actor } = authorSetup();
    const custody = make();
    const [mine] = defined(cmi5Context(actor, randomUUID(), randomUUID(), 'author-lrs'), AU1, ['initialized']);
    const [other] = defined({ ...cmi5Context(actor, randomUUID(), randomUUID(), 'author-lrs'), courseId: 'https://example.org/other-course' }, AU1, ['initialized']);
    await custody.deliver(learner, [mine!, other!]);
    // A minimal voiding statement: no context, so no course in it (cast, the core type wants a cmi5 context).
    const voids = (target: string): XapiStatement => ({
      id: randomUUID(),
      actor,
      verb: { id: 'http://adlnet.gov/expapi/verbs/voided', display: { 'en-US': 'voided' } },
      object: { objectType: 'StatementRef', id: target } as never,
      timestamp: stamp(),
    }) as unknown as XapiStatement;
    const ofMine = voids(mine!.id);
    await custody.deliver(learner, [ofMine]);
    expect(lrs.statements()).toHaveLength(3);
    // The other course's statement stays out; the voided one is hidden by the LRS; its void is in the record.
    expect((await custody.record(learner)).statements.map((s) => s.id)).toEqual([ofMine.id]);
  });

  it('links() gives the configured record holder URL as the deletion link, and none otherwise', () => {
    const { make, learner } = authorSetup();
    expect(make().links(learner).delete).toBeUndefined();
    const lrs = createTestLrs();
    const custody = createAuthorLrsCustody({ course: COURSE, lrs: { endpoint: LRS_URL, key: 'a', secret: 'b' }, publicUrl: PUBLIC_URL, fetch: lrsFetch(lrs).f, recordHolderUrl: 'https://lrs.example/account/delete' });
    expect(custody.links(learner)).toMatchObject({ holder: expect.any(String), view: PUBLIC_URL + '/record', delete: 'https://lrs.example/account/delete' });
  });

  it('assignActor replaces the minted actor', async () => {
    const lrs = createTestLrs({ credentials: [{ key: 'author', secret: 'sekrit' }] });
    const { f, seen } = lrsFetch(lrs);
    const assigned: XapiAgent = { objectType: 'Agent', account: { homePage: 'https://lrs.example/people', name: 'p-42' } };
    const custody = createAuthorLrsCustody({ course: COURSE, lrs: { endpoint: LRS_URL, key: 'author', secret: 'sekrit' }, publicUrl: PUBLIC_URL, fetch: f, assignActor: async () => assigned });
    const learner: LearnerRef = { kind: 'official', subject: 's', actor: assigned };
    await custody.save(learner, learnerState(randomUUID()), undefined);
    expect(JSON.parse(learnerPuts(seen)[0].url.searchParams.get('agent')!)).toEqual(assigned);
  });
});

// LMS-launched (option 1)

function lmsSetup(o: { recordHolderUrl?: string } = {}) {
  const lrs = createTestLrs();
  const { f, seen } = lrsFetch(lrs);
  const sim = createLmsSim({
    lrs,
    lrsUrl: LRS_URL,
    courseId: COURSE.id,
    aus: [
      { auId: AU1, url: 'https://au.example/au1', moveOn: 'Completed' },
      { auId: AU2, url: 'https://au.example/au2', moveOn: 'Completed' },
    ],
  });
  const launches = new MemoryLaunchStore();
  const custody = createLmsLaunchedCustody({ course: COURSE, launches, fetch: f, ...o });

  /** What the bridge does on a launch: fetch the token once, read LMS.LaunchData, keep the LaunchContext. */
  async function launch(auId: string, auKey: string, o: { registration?: string } = {}): Promise<LaunchContext> {
    const r = await sim.launch(auId, o);
    const u = new URL(r.launchUrl);
    const authToken = await fetchAuthToken(u.searchParams.get('fetch')!, f);
    const actor = JSON.parse(u.searchParams.get('actor')!) as XapiAgent;
    const client = createLrsClient({ endpoint: u.searchParams.get('endpoint')!, auth: { type: 'token', value: authToken }, fetch: f });
    const data = (await client.getState({ activityId: r.activityId, agent: actor, registration: r.registration, stateId: 'LMS.LaunchData' }))!.body as { contextTemplate: ContextTemplate };
    const c: LaunchContext = {
      launchId: randomUUID(),
      endpoint: u.searchParams.get('endpoint')!,
      authToken,
      tokenFetchedAt: stamp(),
      actor,
      registration: r.registration,
      activityId: r.activityId,
      auId,
      auKey,
      contextTemplate: data.contextTemplate,
      launchMode: 'Normal',
      moveOn: 'Completed',
      sessionId: r.sessionId,
      initializedAt: stamp(),
      pairingCode: 'ABCDEF',
      pairingExpiresAt: stamp(),
    };
    await launches.put(c);
    return c;
  }
  const learnerOf = (c: LaunchContext): LearnerRef => ({ kind: 'official', subject: 'paired-subject', actor: c.actor, launchId: c.launchId });
  const ctxOf = (c: LaunchContext) => cmi5Context(c.actor, c.registration, c.sessionId, 'lms-launched', c.contextTemplate);
  return { lrs, sim, seen, launches, custody, launch, learnerOf, ctxOf };
}

describe('LMS-launched custody', () => {
  it('statements land in the LMS\'s LRS under the LMS actor and registration, with the contextTemplate grouping, sent with the session token', async () => {
    const { lrs, seen, custody, launch, learnerOf, ctxOf } = lmsSetup();
    expect(custody.option).toBe('lms-launched');
    expect(custody.official).toBe(true);
    const c = await launch(AU1, 'l1');
    const batch = defined(ctxOf(c), AU1, ['initialized', 'completed']);
    await custody.deliver(learnerOf(c), batch);

    const landed = lrs.statements().filter((s) => batch.some((b) => b.id === s.id));
    expect(landed).toHaveLength(2);
    for (const s of landed) {
      expect(s.actor).toEqual(c.actor);
      expect(s.context.registration).toBe(c.registration);
      const grouping = s.context.contextActivities!.grouping!.map((a) => a.id);
      for (const g of c.contextTemplate.contextActivities!.grouping!) expect(grouping).toContain(g.id);
      expect(s.context.extensions![CMI5.extSessionId]).toBe(c.sessionId);
    }
    const posts = seen.filter((s) => s.method === 'POST' && s.url.pathname.endsWith('/statements'));
    expect(posts.at(-1)!.headers.get('authorization')).toBe('Basic ' + c.authToken);
  });

  it('keeps working state in the LMS\'s State API with If-None-Match then If-Match, and a stale save conflicts', async () => {
    const { seen, custody, launch, learnerOf } = lmsSetup();
    const c = await launch(AU1, 'l1');
    const l = learnerOf(c);
    expect(await custody.load(l)).toEqual({});
    const first = await custody.save(l, learnerState(c.registration), undefined);
    const loaded = await custody.load(l);
    expect(loaded.state?.registration).toBe(c.registration);
    await custody.save(l, learnerState(c.registration, 1), first.etag);
    await expect(custody.save(l, learnerState(c.registration, 2), first.etag)).rejects.toBeInstanceOf(StoreConflictError);

    const [p1, p2] = learnerPuts(seen);
    expect(p1.headers.get('if-none-match')).toBe('*');
    expect(p2.headers.get('if-match')).toBe(first.etag);
    expect(p1.headers.get('authorization')).toBe('Basic ' + c.authToken);
    expect(p1.url.searchParams.get('registration')).toBe(c.registration);
  });

  it('[Review Focus 5] a relaunch of the same AU makes the older launch answer the relaunched error', async () => {
    const { lrs, custody, launch, learnerOf, ctxOf } = lmsSetup();
    const old = await launch(AU1, 'l1');
    const fresh = await launch(AU1, 'l1', { registration: old.registration });

    expect(await custody.launchFor(learnerOf(old))).toEqual({ error: RELAUNCHED });
    expect(await custody.launchFor(learnerOf(old), 'l1')).toEqual({ error: RELAUNCHED });
    const live = await custody.launchFor(learnerOf(fresh));
    expect('error' in live ? live : live.launchId).toBe(fresh.launchId);

    const before = lrs.statements().length;
    await expect(custody.deliver(learnerOf(old), defined(ctxOf(old), AU1, ['completed']))).rejects.toThrow(RELAUNCHED);
    await expect(custody.save(learnerOf(old), learnerState(old.registration), undefined)).rejects.toThrow(RELAUNCHED);
    expect(lrs.statements()).toHaveLength(before);
  });

  it('[Review Focus 5] a launch the bridge marked superseded answers the relaunched error', async () => {
    const { launches, custody, launch, learnerOf } = lmsSetup();
    const c = await launch(AU1, 'l1');
    await launches.update(c.launchId, { supersededAt: stamp() });
    expect(await custody.launchFor(learnerOf(c))).toEqual({ error: RELAUNCHED });
  });

  it('a launch of another AU in the same registration does not make this one stale; launchFor finds the newest per AU', async () => {
    const { custody, launch, learnerOf } = lmsSetup();
    const a = await launch(AU1, 'l1');
    const b = await launch(AU2, 'l2', { registration: a.registration });
    const forA = await custody.launchFor(learnerOf(a), 'l1');
    expect('error' in forA ? forA : forA.launchId).toBe(a.launchId);
    const newest = await custody.launchFor(learnerOf(a));
    expect('error' in newest ? newest : newest.launchId).toBe(b.launchId);
    const forB = await custody.launchFor(learnerOf(a), 'l2');
    expect('error' in forB ? forB : forB.launchId).toBe(b.launchId);
  });

  it('a call with no launch, or an unknown one, gets an error', async () => {
    const { custody } = lmsSetup();
    const actor: XapiAgent = { objectType: 'Agent', account: { homePage: 'https://lms.example', name: 'x' } };
    expect(await custody.launchFor({ kind: 'official', subject: 's', actor })).toHaveProperty('error');
    expect(await custody.launchFor({ kind: 'official', subject: 's', actor, launchId: 'nope' })).toHaveProperty('error');
    await expect(custody.load({ kind: 'official', subject: 's', actor, launchId: 'nope' })).rejects.toBeInstanceOf(StoreError);
  });

  it('[Review Focus 5] delivering terminated sets terminatedAt and lastActivityAt; after that nothing is delivered', async () => {
    const { lrs, sim, launches, custody, launch, learnerOf, ctxOf } = lmsSetup();
    const c = await launch(AU1, 'l1');
    const l = learnerOf(c);
    const [init] = defined(ctxOf(c), AU1, ['initialized']);
    await custody.deliver(l, [init]);
    const afterInit = (await launches.get(c.launchId))!;
    expect(afterInit.lastActivityAt).toBeDefined();
    expect(afterInit.terminatedAt).toBeUndefined();

    const ending = defined(ctxOf(c), AU1, ['completed', 'terminated']);
    await custody.deliver(l, ending);
    const ended = (await launches.get(c.launchId))!;
    expect(ended.terminatedAt).toBe(ending[1].timestamp);

    const bound = await custody.launchFor(l);
    expect('error' in bound ? bound : bound.terminatedAt).toBe(ending[1].timestamp);

    const count = lrs.statements().length;
    const late = defined(ctxOf(c), AU1, ['completed']);
    const err = await custody.deliver(l, late).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as Error).message).toBe(ENDED);
    expect(lrs.statements()).toHaveLength(count);
    expect(sim.problems()).toEqual([]);
  });

  it('[Review Focus 3] after terminated, redelivering an outbox the LMS already accepted is a no-op', async () => {
    const { lrs, custody, launch, learnerOf, ctxOf } = lmsSetup();
    const c = await launch(AU1, 'l1');
    const batch = defined(ctxOf(c), AU1, ['initialized', 'completed', 'terminated']);
    await custody.deliver(learnerOf(c), batch);
    const count = lrs.statements().length;
    await custody.deliver(learnerOf(c), batch);
    expect(lrs.statements()).toHaveLength(count);
  });

  it('[Review Focus 3] an LMS LRS that answers 503 makes deliver throw; the retry delivers once and records one receipt entry each', async () => {
    const { lrs, custody, launch, learnerOf, ctxOf } = lmsSetup();
    const c = await launch(AU1, 'l1');
    await custody.load(learnerOf(c));
    const batch = defined(ctxOf(c), AU1, ['initialized', 'completed']);
    lrs.failNext(1, 503);
    await expect(custody.deliver(learnerOf(c), batch)).rejects.toBeInstanceOf(LrsError);
    await custody.deliver(learnerOf(c), batch);
    await custody.deliver(learnerOf(c), batch);
    expect(lrs.statements().filter((s) => batch.some((b) => b.id === s.id))).toHaveLength(2);
    expect((await custody.record(learnerOf(c))).receipt).toHaveLength(2);
  });

  it('record() returns what the token reads for the registration plus a receipt entry per delivered statement', async () => {
    const { custody, launch, learnerOf, ctxOf } = lmsSetup();
    const c = await launch(AU1, 'l1');
    const b = await launch(AU2, 'l2', { registration: c.registration });
    const first = defined(ctxOf(c), AU1, ['initialized', 'completed', 'terminated']);
    const second = defined(ctxOf(b), AU2, ['initialized']);
    await custody.deliver(learnerOf(c), first);
    await custody.deliver(learnerOf(b), second);

    const view = await custody.record(learnerOf(b));
    expect(view.official).toBe(true);
    expect(view.complete).toBe(true);
    expect(view.note).toBe('Your LMS holds the official record; ask it for a full export.');
    const ids = view.statements.map((s) => s.id);
    for (const s of [...first, ...second]) expect(ids).toContain(s.id);
    // the LMS's own launched statements are part of what the token reads
    expect(view.statements.some((s) => s.verb.id === ADL_VERBS.launched)).toBe(true);
    expect(view.receipt).toEqual([...first, ...second].map((s) => ({ id: s.id, verb: s.verb.display['en-US'], object: s.object.id, timestamp: s.timestamp })));
  });

  it('record() gives complete: false when the read fails, and keeps the receipt it could read', async () => {
    const { lrs, custody, launch, learnerOf, ctxOf } = lmsSetup();
    const c = await launch(AU1, 'l1');
    const batch = defined(ctxOf(c), AU1, ['initialized']);
    await custody.deliver(learnerOf(c), batch);
    lrs.failNext(1, 403);
    const view = await custody.record(learnerOf(c));
    expect(view.complete).toBe(false);
    expect(view.statements).toEqual([]);
    expect(view.receipt?.map((r) => r.id)).toEqual(batch.map((s) => s.id));
    expect(view.note).toBe('Your LMS holds the official record; ask it for a full export.');
  });

  it('load refuses a state the LMS returns without an ETag', async () => {
    const { lrs, launches, launch, learnerOf } = lmsSetup();
    const c = await launch(AU1, 'l1');
    const custody = createLmsLaunchedCustody({ course: COURSE, launches, fetch: noStateEtag(lrs) });
    await custody.save(learnerOf(c), learnerState(c.registration), undefined);
    await expect(custody.load(learnerOf(c))).rejects.toThrow(NO_VERSION);
  });

  it('keeps no client per launch: the version is learnt once per endpoint', async () => {
    const { seen, custody, launch, learnerOf, ctxOf } = lmsSetup();
    const a = await launch(AU1, 'l1');
    const b = await launch(AU2, 'l2', { registration: a.registration });
    const before = seen.filter((s) => s.url.pathname.endsWith('/about')).length;
    await custody.deliver(learnerOf(a), defined(ctxOf(a), AU1, ['initialized']));
    await custody.deliver(learnerOf(b), defined(ctxOf(b), AU2, ['initialized']));
    await custody.load(learnerOf(a));
    expect(seen.filter((s) => s.url.pathname.endsWith('/about')).length - before).toBe(1);
  });

  it('links() name the LMS and carry no token or registration', async () => {
    const { custody, launch, learnerOf } = lmsSetup();
    const c = await launch(AU1, 'l1');
    const links = custody.links(learnerOf(c));
    expect(links.holder).toBe('your LMS');
    expect(JSON.stringify(links)).not.toContain(c.authToken);
    expect(JSON.stringify(links)).not.toContain(c.registration);
  });

  it('links() give the launch returnURL as the LMS link and the fallback deletion link, once the custody has seen the launch', async () => {
    const { custody, launches, launch, learnerOf } = lmsSetup();
    const c = await launch(AU1, 'l1');
    await launches.update(c.launchId, { returnURL: 'https://lms.example/course/1' });
    // links() is synchronous: before any call has read the launch, there is nothing to give.
    expect(custody.links(learnerOf(c)).lms).toBeUndefined();
    await custody.load(learnerOf(c));
    expect(custody.links(learnerOf(c))).toEqual({ holder: 'your LMS', lms: 'https://lms.example/course/1', delete: 'https://lms.example/course/1' });
    // Another launch has its own returnURL.
    const d = await launch(AU2, 'l2', { registration: c.registration });
    await launches.update(d.launchId, { returnURL: 'https://lms.example/course/2' });
    await custody.record(learnerOf(d));
    expect(custody.links(learnerOf(d)).lms).toBe('https://lms.example/course/2');
    expect(custody.links(learnerOf(c)).lms).toBe('https://lms.example/course/1');
  });

  it('links() give no LMS link and no deletion link for a launch without a returnURL', async () => {
    const { custody, launch, learnerOf } = lmsSetup();
    const c = await launch(AU1, 'l1');
    await custody.load(learnerOf(c));
    expect(custody.links(learnerOf(c))).toEqual({ holder: 'your LMS' });
  });

  it('links() give the configured record holder URL as the deletion link ahead of the returnURL', async () => {
    const { custody, launches, launch, learnerOf } = lmsSetup({ recordHolderUrl: 'https://lms.example/privacy/delete' });
    const c = await launch(AU1, 'l1');
    await launches.update(c.launchId, { returnURL: 'https://lms.example/course/1' });
    expect(custody.links(learnerOf(c)).delete).toBe('https://lms.example/privacy/delete');
    await custody.load(learnerOf(c));
    expect(custody.links(learnerOf(c))).toMatchObject({ lms: 'https://lms.example/course/1', delete: 'https://lms.example/privacy/delete' });
  });

  it('recordSent puts statements the bridge sent into the receipt, once each, beside those the tools delivered', async () => {
    const { custody, launch, learnerOf, ctxOf } = lmsSetup();
    const c = await launch(AU1, 'l1');
    const [init] = defined(ctxOf(c), AU1, ['initialized']);
    await custody.recordSent(c, [init]);
    await custody.recordSent(c, [init]);
    const [done] = defined(ctxOf(c), AU1, ['completed']);
    await custody.deliver(learnerOf(c), [done]);
    const receipt = (await custody.record(learnerOf(c))).receipt!;
    expect(receipt.map((r) => r.id)).toEqual([init.id, done.id]);
    expect(receipt[0]).toMatchObject({ verb: 'initialized', object: init.object.id });
  });
});
