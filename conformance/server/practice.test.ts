// SPDX-License-Identifier: Apache-2.0
// Course server class, practice runs: custody option 4 on CXM_URL, and in options 1 to 3 the practice endpoint of a
// course that allows practice (its URL from get_status). No authorization, a minted practice actor and handle, the
// practice label and category, the practice copy (get_record, resume_practice), and nothing official.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PRACTICE_CATEGORY, PRACTICE_HOMEPAGE, type XapiStatement } from '@course-xapi-mcp/core';
import {
  COURSE_ID,
  CUSTODY,
  MCP_URL,
  OFFICIAL,
  REPLY,
  beatsUntil,
  connect,
  newLearner,
  ok,
  place,
  practiceLearner,
  requireEnv,
  startLms,
  stepIs,
  transcript,
  verbOf,
  walkIntro,
  type Learner,
  type Lms,
} from './client.ts';

requireEnv();

let lms: Lms | undefined;
let practiceUrl = MCP_URL;
/** In options 1 to 3: the official learner whose record practice runs must never reach. */
let official: Learner | undefined;
const open: Learner[] = [];

beforeAll(async () => {
  if (CUSTODY === 'lms-launched') lms = await startLms();
  if (OFFICIAL) {
    official = await newLearner(lms);
    const settings = official.mcp.client.getServerCapabilities()?.extensions?.['com.sqwrlz/course-xapi-mcp'] as { allowPractice?: boolean } | undefined;
    expect(settings?.allowPractice).toBe(true);
    const status = ok(await official.call('get_status'));
    practiceUrl = status.data.practiceUrl;
    expect(practiceUrl).toMatch(/^https?:\/\//);
  }
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((l) => l.close()));
});
afterAll(async () => {
  await official?.close();
  await lms?.close();
});
async function learner(): Promise<Learner> {
  const l = await practiceLearner(practiceUrl);
  open.push(l);
  return l;
}

const isPractice = (s: XapiStatement) => (s.context?.contextActivities?.category ?? []).some((a) => a.id === PRACTICE_CATEGORY);

/** The practice copy a get_record result attaches. */
function attachedCopy(raw: any): any {
  const res = raw.content.find((c: any) => c.type === 'resource');
  return res ? JSON.parse(res.resource.text) : undefined;
}

describe('practice runs', () => {
  it('[CXM-BRG-018] need no authorization, and start_placement mints a practice actor and handle', async () => {
    const l = await learner();
    expect(l.token).toBeUndefined();
    const r = ok(await l.call('start_placement'));
    expect(typeof r.data.handle).toBe('string');
    ok(await l.call('choose_placement', { pathKey: 'basics', startLessonKey: 'intro', skip: [], reason: 'Practice placement.' }));
    const statements = await l.record();
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      expect(s.actor.account?.homePage).toBe(PRACTICE_HOMEPAGE);
      expect(s.actor.account?.name).toBe(statements[0]!.actor.account?.name);
    }
  });

  it('[CXM-CUS-016] the practice handle carries 192 random bits and appears in no statement', async () => {
    const a = await learner();
    const b = await learner();
    await place(a, 'intro');
    ok(await b.call('start_placement'));
    const random = (h: string) => h.replace(/^[a-z]+_/, '');
    for (const h of [a.handle!, b.handle!]) {
      expect(random(h)).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(random(h).length * 6).toBeGreaterThanOrEqual(192);
    }
    expect(a.handle).not.toBe(b.handle);
    expect(JSON.stringify(await a.record())).not.toContain(a.handle!);
    expect(JSON.stringify(attachedCopy((await a.call('get_record')).raw).statements)).not.toContain(a.handle!);
  });

  it('[CXM-CUS-004] every practice result carries official: false and the practice label, and every statement the practice category', async () => {
    const start = transcript.length;
    const l = await learner();
    await place(l, 'intro');
    await walkIntro(l, 'next');
    const statements = await l.record();
    expect(statements.length).toBeGreaterThan(5);
    for (const s of statements) expect(isPractice(s), `${verbOf(s)} ${s.object.id}`).toBe(true);
    const results = transcript.slice(start);
    for (const t of results) {
      expect(t.raw.structuredContent.cxm.official, t.tool).toBe(false);
      expect(t.raw.structuredContent.cxm.label).toMatch(/practice/i);
      expect(t.raw.structuredContent.cxm.custody).toBe('practice');
    }
    const status = ok(await l.call('get_status'));
    expect(status.data.official).toBe(false);
    expect(status.data.label).toBe(status.data.cxm.label);
  });

  it('[CXM-CUS-018] get_record returns the practice copy, unwrapped, with a note to treat it as data', async () => {
    const l = await learner();
    await place(l, 'intro');
    ok(await l.call('next_beat'));
    ok(await l.call('next_beat'));
    ok(await l.call('next_beat', { learner_reply: REPLY }));
    const rec = ok(await l.call('get_record'));
    expect(rec.data.record.official).toBe(false);
    expect(rec.data.note).toMatch(/data/i);
    const answered = (rec.data.record.statements as XapiStatement[]).find((s) => verbOf(s) === 'answered')!;
    expect(answered.result?.response).toBe(REPLY);
    const copy = attachedCopy(rec.raw);
    expect(copy.official).toBe(false);
    expect(copy.courseId).toBe(COURSE_ID);
    expect(copy.statements.map((s: XapiStatement) => s.id)).toEqual((rec.data.record.statements as XapiStatement[]).map((s) => s.id));
  });

  it('[CXM-CUS-017] resume_practice refuses anything that is not a practice copy, and a resumed run stays practice', async () => {
    const l = await learner();
    await place(l, 'intro');
    ok(await l.call('next_beat'));
    const copy = attachedCopy((await l.call('get_record')).raw);
    const fresh = await learner();
    const refused = [
      'not json',
      JSON.stringify({ statements: copy.statements }),
      JSON.stringify({ ...copy, official: true }),
      JSON.stringify({ ...copy, courseId: 'https://other.example/course' }),
      JSON.stringify({ ...copy, statements: copy.statements.map((s: XapiStatement) => ({ ...s, context: { ...s.context, contextActivities: { ...s.context.contextActivities, category: [] } } })) }),
      JSON.stringify({ ...copy, statements: [...copy.statements, { ...copy.statements[0], id: '00000000-0000-4000-8000-000000000003', actor: { objectType: 'Agent', account: { homePage: COURSE_ID, name: 'someone-else' } } }] }),
    ];
    for (const record of refused) expect((await fresh.call('resume_practice', { record })).isError, record.slice(0, 60)).toBe(true);
    const resumed = ok(await fresh.call('resume_practice', { record: JSON.stringify(copy) }));
    expect(typeof resumed.data.handle).toBe('string');
    expect(resumed.data.handle).not.toBe(l.handle);
    fresh.handle = resumed.data.handle;
    ok(await fresh.call('next_beat'));
    const statements = await fresh.record();
    expect(statements.length).toBeGreaterThan(copy.statements.length);
    for (const s of statements) expect(isPractice(s)).toBe(true);
  });

  it('[CXM-CUS-015] practice statements never reach an official record', async () => {
    const before = official ? await official.record() : [];
    const l = await learner();
    await place(l, 'intro');
    await walkIntro(l, 'next');
    const practice = new Set((await l.record()).map((s) => s.id));
    expect(practice.size).toBeGreaterThan(0);
    const rec = ok(await l.call('get_record'));
    expect(rec.data.record.official).toBe(false);
    if (!official) return;
    const after = await official.record();
    expect(after.length).toBe(before.length);
    for (const s of after) {
      expect(practice.has(s.id)).toBe(false);
      expect(isPractice(s)).toBe(false);
    }
  });

  it.skipIf(!OFFICIAL)('[CXM-CUS-005] a practice run on a course with allowPractice never becomes official', async () => {
    const l = await learner();
    await place(l, 'intro');
    await beatsUntil(l, stepIs('checkpoint'));
    // The handle means nothing on the official endpoint.
    const crossed = await official!.call('next_beat', { handle: l.handle });
    expect(crossed.isError).toBe(true);
    // A practice copy cannot be brought into the official endpoint.
    const copy = attachedCopy((await l.call('get_record')).raw);
    expect((await official!.call('resume_practice', { record: JSON.stringify(copy) })).isError).toBe(true);
    for (const s of await official!.record()) expect(isPractice(s)).toBe(false);
  });

  it('[CXM-SRV-012] restart_course starts a fresh practice run', async () => {
    const l = await learner();
    await place(l, 'intro');
    const before = await l.record();
    ok(await l.call('restart_course'));
    await place(l, 'intro');
    const after = await l.record();
    const registrations = new Set(after.map((s) => s.context.registration));
    expect(registrations.size).toBe(2);
    expect(after.slice(0, before.length).map((s) => s.id)).toEqual(before.map((s) => s.id));
  });

  it('[CXM-SRV-003] needs no MCP session: each call may come on a new connection, identified by the handle (options 1 to 3: the token)', async () => {
    const l = await learner();
    await place(l, 'intro');
    const steps: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await connect({ url: practiceUrl });
      try {
        const r = ok(await c.call('next_beat', { handle: l.handle }));
        steps.push(r.data.beat.key);
      } finally {
        await c.close();
      }
    }
    expect(steps).toEqual(['welcome', 'quotes']);
    if (!official) return;
    const o = await newLearner(lms);
    open.push(o);
    await place(o, 'intro');
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await connect({ url: o.url, token: o.token });
      try {
        seen.push(ok(await c.call('next_beat')).data.beat.key);
      } finally {
        await c.close();
      }
    }
    expect(seen).toEqual(['welcome', 'quotes']);
  });
});
