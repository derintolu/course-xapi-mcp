// SPDX-License-Identifier: Apache-2.0
// Course server class, every custody option: three runs through the conformance course, then every statement the
// record holder took is checked (xAPI 1.0.3 and 2.0, the cxm profile, cmi5 order, sessions, outcomes, waivers and
// satisfaction), and every result the agent saw is checked (structured content, rules and cxm, no credentials).
//   A, the whole path: intro (with a failed answer and a restart), types, fix (a failed check, a review of intro).
//   B, placed at fix with intro and types skipped; the checkpoint fails until maxAttempts runs out, then passes.
//   C, intro, then a success branch that jumps over types; the session at fix is ended with end_session.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CMI5, CXM_EXT, type XapiStatement } from '@course-xapi-mcp/core';
import { checkCmi5Order, checkProfile, validateStatement } from '@course-xapi-mcp/core/xapi';
import {
  AU_IDS,
  BLOCK_ID,
  COURSE_ID,
  CUSTODY,
  FILES,
  LMS_ACTOR,
  OFFICIAL,
  REPLY,
  agentVisible,
  beatsUntil,
  finishFix,
  isDefined,
  newLearner,
  newSince,
  ok,
  place,
  requireEnv,
  sessionOf,
  startLms,
  stepIs,
  transcript,
  verbOf,
  walkFixToCheckpoint,
  walkIntro,
  walkTypes,
  type LessonKey,
  type Learner,
  type Lms,
} from './client.ts';

requireEnv();

const OPTION1 = CUSTODY === 'lms-launched';
const RATIONALE_A = 'Run A: the answer names number versus string.';
const ANSWER = 'The first is a number and the second is a string.';
const PLACEMENT_REASON = 'Placement chosen by the conformance client.';

let lms: Lms | undefined;
const learners: Learner[] = [];
const runs: Record<'A' | 'B' | 'C', XapiStatement[]> = { A: [], B: [], C: [] };

async function run(name: keyof typeof runs, body: (l: Learner) => Promise<void>) {
  const l = await newLearner(lms);
  learners.push(l);
  // Option 1: a new learner is a new registration, whose launch already sent initialized.
  const before = l.lms ? [] : await l.record();
  await body(l);
  runs[name] = await newSince(l, before);
}

beforeAll(async () => {
  if (OPTION1) lms = await startLms();
  const first = await newLearner(lms);
  learners.push(first);
  ok(await first.call('get_status'));

  await run('A', async (l) => {
    await place(l, 'intro');
    await beatsUntil(l, stepIs('checkpoint'));
    ok(await l.call('submit_checkpoint', { response: 'I do not know.' }));
    ok(await l.call('choose_branch', { branch: 'again', rationale: 'Run A: the answer misses the difference.' }));
    await beatsUntil(l, stepIs('checkpoint'));
    ok(await l.call('submit_checkpoint', { response: ANSWER }));
    ok(await l.call('choose_branch', { branch: 'next', rationale: RATIONALE_A }));
    await walkTypes(l);
    await walkFixToCheckpoint(l, 1);
    ok(await l.call('submit_checkpoint', { response: 'Not sure what a string is.', files: { 'config.json': FILES.configTimeoutString } }));
    ok(await l.call('choose_branch', { branch: 'back-to-intro', rationale: 'Run A: the learner is unsure about strings.' }));
    await beatsUntil(l, stepIs('checkpoint'));
    await finishFix(l);
    ok(await l.call('get_record'));
  });

  await run('B', async (l) => {
    await place(l, 'fix', ['intro', 'types']);
    await walkFixToCheckpoint(l);
    for (let i = 0; i < 2; i++) {
      await finishFix(l, FILES.configTimeoutString, 'retry');
      // retry restarts the beats; the bug is already caught, so they lead back to the checkpoint.
      await beatsUntil(l, stepIs('checkpoint'));
    }
    await finishFix(l);
  });

  await run('C', async (l) => {
    await place(l, 'intro');
    await walkIntro(l, 'ahead');
    ok(await l.call('next_beat'));
    const ended = ok(await l.call('end_session'));
    expect(ended.data.ended).toBe(true);
  });
});

afterAll(async () => {
  await Promise.all(learners.map((l) => l.close()));
  await lms?.close();
});

const all = () => [...runs.A, ...runs.B, ...runs.C];
/** Statements the LMS itself sent (option 1: `launched`); the rest are the course server's. */
const fromLms = (s: XapiStatement) => OPTION1 && isDefined(s) && verbOf(s) === 'launched';
const server = (list: XapiStatement[]) => list.filter((s) => !fromLms(s));
const auActivity = (key: LessonKey | 'placement') => AU_IDS[key] + '/au';
const definedOn = (list: XapiStatement[], verb: string, key: LessonKey | 'placement') => list.filter((s) => isDefined(s) && verbOf(s) === verb && s.object.id === auActivity(key));
const parents = (s: XapiStatement) => (s.context?.contextActivities?.parent ?? []).map((a) => a.id);
const sessions = (list: XapiStatement[]) => {
  const m = new Map<string, XapiStatement[]>();
  for (const s of server(list)) {
    const id = sessionOf(s);
    if (!id || (isDefined(s) && (verbOf(s) === 'waived' || verbOf(s) === 'satisfied'))) continue;
    m.set(id, [...(m.get(id) ?? []), s]);
  }
  return m;
};
const ordered = (list: XapiStatement[]) => [...list].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

describe('every statement', () => {
  it('the runs wrote statements', () => {
    for (const r of Object.values(runs)) expect(server(r).length).toBeGreaterThan(5);
  });

  it('[CXM-SRV-024] every statement is built by the server: valid under xAPI 1.0.3 and 2.0, on the cxm profile, in cmi5 order, with no version, contextAgents or contextGroups', () => {
    for (const s of all()) {
      expect(validateStatement(s), s.id).toEqual([]);
      expect(s).not.toHaveProperty('version');
      expect(s.context).not.toHaveProperty('contextAgents');
      expect(s.context).not.toHaveProperty('contextGroups');
      if (fromLms(s)) continue;
      expect(checkProfile(s, { lmsActor: OPTION1 }), `${verbOf(s)} ${s.object.id}`).toEqual([]);
      const actor = s.actor as Record<string, unknown>;
      if (OPTION1) expect(s.actor).toEqual(LMS_ACTOR);
      else for (const k of ['mbox', 'mbox_sha1sum', 'openid', 'name']) expect(actor).not.toHaveProperty(k);
    }
    expect(checkCmi5Order(all())).toEqual([]);
  });

  it('[CXM-BRG-004] no defined failed follows a defined passed in a registration', () => {
    for (const list of Object.values(runs)) {
      const passed = new Set<string>();
      for (const s of ordered(list).filter(isDefined)) {
        if (verbOf(s) === 'passed') passed.add(s.object.id);
        if (verbOf(s) === 'failed') expect(passed.has(s.object.id), s.object.id).toBe(false);
      }
    }
  });

  it('[CXM-BRG-005] completed only after the last beat and the planted bug, passed only on a success branch, each at most once per registration', () => {
    for (const list of Object.values(runs)) {
      const o = ordered(list);
      for (const key of ['intro', 'types', 'fix'] as const) {
        const completed = definedOn(o, 'completed', key);
        const passed = definedOn(o, 'passed', key);
        expect(completed.length, `completed ${key}`).toBeLessThanOrEqual(1);
        expect(passed.length, `passed ${key}`).toBeLessThanOrEqual(1);
        for (const c of completed) {
          const before = o.slice(0, o.indexOf(c));
          const lastBeat = AU_IDS[key] + '/beats/';
          expect(before.some((s) => s.object.id.startsWith(lastBeat)), `beats before completed ${key}`).toBe(true);
          if (key !== 'intro') expect(before.some((s) => ['caught', 'revealed'].includes(verbOf(s)) && s.object.id.startsWith(AU_IDS[key] + '/bugs/')), `bug before completed ${key}`).toBe(true);
        }
        for (const p of passed) {
          const before = o.slice(0, o.indexOf(p));
          const branch = before.filter((s) => verbOf(s) === 'branched' && s.object.id.startsWith(AU_IDS[key] + '/checkpoints/')).at(-1);
          expect(branch, `a branch before passed ${key}`).toBeDefined();
          expect(['next', 'ahead', 'done']).toContain(branch!.result?.extensions?.[CXM_EXT.branch]);
        }
      }
    }
    // Run A passes and completes all three lessons once; types (moveOn Completed) has no checkpoint and no passed.
    expect(definedOn(runs.A, 'completed', 'types')).toHaveLength(1);
    expect(definedOn(runs.A, 'passed', 'types')).toHaveLength(0);
    expect(definedOn(runs.A, 'passed', 'fix')).toHaveLength(1);
  });

  it('[CXM-BRG-001] one AU session per lesson visit, from initialized (the first statement of the session) to terminated (the last)', () => {
    for (const list of Object.values(runs)) {
      for (const [id, s] of sessions(list)) {
        const o = ordered(s);
        const verbs = o.map(verbOf);
        const start = verbs[0] === 'launched' ? 1 : 0;
        expect(verbs[start], `session ${id}`).toBe('initialized');
        expect(verbs.at(-1), `session ${id}: ${verbs.join(' ')}`).toBe('terminated');
        expect(verbs.filter((v) => v === 'terminated')).toHaveLength(1);
      }
    }
    // Run A: placement, intro (one visit despite the restart), types, fix (the review stays inside it).
    expect(sessions(runs.A).size).toBe(4);
  });

  it('[CXM-BRG-015] the server generates the session ids and sends launched (launchMode Normal) before initialized; reviews get no launched', () => {
    const launchedOf = (o: XapiStatement[]) => o.filter((s) => verbOf(s) === 'launched');
    for (const list of Object.values(runs)) {
      for (const s of sessions(list).values()) {
        const o = ordered(s);
        if (OPTION1) {
          expect(launchedOf(o)).toEqual([]);
          continue;
        }
        expect(verbOf(o[0]!)).toBe('launched');
        expect(o[0]!.context.extensions?.['https://w3id.org/xapi/cmi5/context/extensions/launchmode']).toBe('Normal');
        expect(verbOf(o[1]!)).toBe('initialized');
      }
    }
    // The review of intro in run A runs in fix's session: intro has one launched (option 1: the LMS's) in run A.
    expect(all().filter((s) => isDefined(s) && verbOf(s) === 'launched' && s.object.id === auActivity('intro') && runs.A.includes(s))).toHaveLength(1);
  });

  it('[CXM-BRG-014] the AU activityId is {au@id}/au', () => {
    for (const s of server(all()).filter(isDefined)) {
      if (s.object.id === BLOCK_ID || s.object.id === COURSE_ID) continue;
      expect(Object.values(AU_IDS).map((id) => id + '/au')).toContain(s.object.id);
    }
  });

  it('[CXM-BRG-016] waived and satisfied are sent in the LMS role (options 2 to 4), never in option 1', () => {
    const lmsRole = server(all()).filter((s) => isDefined(s) && ['waived', 'satisfied'].includes(verbOf(s)));
    if (OPTION1) return void expect(lmsRole).toEqual([]);
    const satisfiedA = runs.A.filter((s) => isDefined(s) && verbOf(s) === 'satisfied').map((s) => s.object.id);
    expect(satisfiedA.sort()).toEqual([BLOCK_ID, COURSE_ID].sort());
    for (const s of lmsRole) {
      expect(s.context.contextActivities?.category?.map((a) => a.id)).toContain(CMI5.categoryCmi5);
      expect(sessionOf(s)).toBeTruthy();
    }
    // B ends satisfied too: two waived lessons and a passed fix.
    expect(runs.B.filter((s) => verbOf(s) === 'satisfied').map((s) => s.object.id).sort()).toEqual([BLOCK_ID, COURSE_ID].sort());
  });

  it('[CXM-BRG-008] in options 2 and 3 a lesson skipped by placement or jumped over by a success branch is waived Tested Out', () => {
    const waived = (list: XapiStatement[]) => list.filter((s) => isDefined(s) && verbOf(s) === 'waived');
    if (OPTION1) return void expect(waived(all())).toEqual([]);
    const reasons = (list: XapiStatement[]) => waived(list).map((s) => [s.object.id, s.result?.extensions?.[CMI5.extReason]]);
    expect(reasons(runs.B).sort()).toEqual([
      [auActivity('intro'), 'Tested Out'],
      [auActivity('types'), 'Tested Out'],
    ]);
    expect(reasons(runs.C)).toEqual([[auActivity('types'), 'Tested Out']]);
    expect(waived(runs.A)).toEqual([]);
  });

  it.skipIf(!OPTION1)('[CXM-BRG-009] option 1 never waives; placed and branched carry waive-recommended with the AU ids', () => {
    expect(all().filter((s) => verbOf(s) === 'waived')).toEqual([]);
    const placed = runs.B.find((s) => verbOf(s) === 'placed')!;
    expect([...(placed.result?.extensions?.[CXM_EXT['waive-recommended']] as string[])].sort()).toEqual([AU_IDS.intro, AU_IDS.types].sort());
    const jump = runs.C.find((s) => verbOf(s) === 'branched')!;
    expect(jump.result?.extensions?.[CXM_EXT['waive-recommended']]).toEqual([AU_IDS.types]);
  });

  it('[CXM-BRG-006] a branch to a satisfied lesson runs a review inside the current session: beats only, with the reviewed lesson as parent', () => {
    const o = ordered(server(runs.A));
    const back = o.find((s) => verbOf(s) === 'branched' && s.result?.extensions?.[CXM_EXT.branch] === 'back-to-intro')!;
    expect(back).toBeDefined();
    const after = o.slice(o.indexOf(back) + 1);
    const resumed = after.findIndex((s) => s.object.id.startsWith(AU_IDS.fix + '/checkpoints/'));
    const review = after.slice(0, resumed);
    expect(review.length).toBeGreaterThanOrEqual(2);
    for (const s of review) {
      expect(isDefined(s), verbOf(s)).toBe(false);
      expect(['experienced', 'answered']).toContain(verbOf(s));
      expect(s.object.id.startsWith(AU_IDS.intro + '/beats/')).toBe(true);
      expect(parents(s)).toContain(auActivity('intro'));
      expect(sessionOf(s)).toBe(sessionOf(back));
    }
  });

  it('[CXM-BRG-007] a branch to the same unpassed lesson restarts its beats in the same session', () => {
    const o = ordered(server(runs.A));
    const again = o.find((s) => verbOf(s) === 'branched' && s.result?.extensions?.[CXM_EXT.branch] === 'again')!;
    const first = AU_IDS.intro + '/beats/welcome';
    const welcome = o.filter((s) => s.object.id === first && verbOf(s) === 'experienced');
    expect(welcome).toHaveLength(3); // the visit, the restart and the review
    expect(sessionOf(welcome[1]!)).toBe(sessionOf(again));
    expect(sessionOf(welcome[0]!)).toBe(sessionOf(again));
  });

  it('[CXM-BRG-002] a success: false branch records the allowed failed on the checkpoint and leaves the session open', () => {
    const o = ordered(server(runs.A));
    const failed = o.find((s) => !isDefined(s) && verbOf(s) === 'failed' && s.object.id === AU_IDS.intro + '/checkpoints/explain')!;
    expect(failed).toBeDefined();
    expect(failed.result?.success).toBe(false);
    const session = o.filter((s) => sessionOf(s) === sessionOf(failed));
    const terminated = session.find((s) => verbOf(s) === 'terminated')!;
    expect(o.indexOf(terminated)).toBeGreaterThan(o.indexOf(failed) + 2);
    expect(definedOn(runs.A, 'failed', 'intro')).toEqual([]);
  });

  it('[CXM-BRG-003] a defined failed only when maxAttempts ran out, and the session then ends with terminated', () => {
    const o = ordered(server(runs.B));
    const failed = definedOn(o, 'failed', 'fix');
    expect(failed).toHaveLength(1);
    const session = o.filter((s) => sessionOf(s) === sessionOf(failed[0]!));
    expect(session.map(verbOf).slice(-2)).toEqual(['failed', 'terminated']);
    expect(session.filter((s) => verbOf(s) === 'branched')).toHaveLength(2);
    // Run A's one failure branch at fix, under maxAttempts, sends no defined failed.
    expect(definedOn(runs.A, 'failed', 'fix')).toEqual([]);
  });

  it('[CXM-SRV-011] end_session terminates the current AU session with its duration', () => {
    const o = ordered(server(runs.C));
    const last = o.filter((s) => sessionOf(s) === sessionOf(o.at(-1)!));
    const terminated = last.at(-1)!;
    expect(verbOf(terminated)).toBe('terminated');
    expect(terminated.object.id).toBe(auActivity('fix'));
    expect(terminated.result?.duration).toMatch(/^P/);
  });

  it('[CXM-SRV-022] records the agent rationale of every branch choice', () => {
    const branched = server(runs.A).filter((s) => verbOf(s) === 'branched');
    expect(branched.map((s) => s.result?.extensions?.[CXM_EXT.rationale])).toContain(RATIONALE_A);
    for (const s of branched) expect(typeof s.result?.extensions?.[CXM_EXT.rationale]).toBe('string');
  });

  it('[CXM-SEC-005] the record keeps agent-written text apart from learner-written text', () => {
    const learnerText = [REPLY, ANSWER, 'I do not know.'];
    for (const s of server(all())) {
      const response = s.result?.response;
      if (verbOf(s) === 'placed') expect(response).toBe(PLACEMENT_REASON);
      if (verbOf(s) === 'branched') {
        expect(response).toBeUndefined();
        expect(learnerText).not.toContain(s.result?.extensions?.[CXM_EXT.rationale]);
      }
      if (response !== undefined && learnerText.includes(response)) expect(verbOf(s)).toBe('answered');
      if (verbOf(s) === 'answered') expect(response).not.toBe(PLACEMENT_REASON);
    }
  });

  it('[CXM-SEC-007] fix-attempt statements carry an empty checks list', () => {
    const o = ordered(server(runs.A));
    for (const key of ['types', 'fix'] as const) {
      const found = o.findIndex((s) => ['caught', 'revealed'].includes(verbOf(s)) && s.object.id.startsWith(AU_IDS[key] + '/bugs/'));
      const attempts = o.slice(0, found).filter((s) => s.object.id.startsWith(AU_IDS[key] + '/files/'));
      expect(attempts.length, key).toBeGreaterThanOrEqual(2);
      for (const s of attempts) expect(s.result?.extensions?.[CXM_EXT.checks]).toEqual([]);
    }
    const checkpointFile = o.slice(o.findIndex((s) => verbOf(s) === 'caught' && s.object.id.startsWith(AU_IDS.fix))).find((s) => s.object.id.startsWith(AU_IDS.fix + '/files/'));
    expect((checkpointFile?.result?.extensions?.[CXM_EXT.checks] as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('every result', () => {
  it('[CXM-SRV-005] every tool returns structuredContent matching its output schema, and the same content as text', () => {
    const calls = transcript.filter((t) => !t.tool.startsWith('resource:'));
    expect(calls.length).toBeGreaterThan(40);
    for (const t of calls) {
      expect(t.raw.structuredContent, t.tool).toBeTypeOf('object');
      const text = t.raw.content.find((c: any) => c.type === 'text');
      expect(JSON.parse(text.text), t.tool).toEqual(t.raw.structuredContent);
    }
  });

  it('[CXM-SRV-006] every result carries rules and cxm (custody, official, the practice label, the lesson and step)', () => {
    for (const t of transcript.filter((x) => !x.tool.startsWith('resource:'))) {
      const d = t.raw.structuredContent;
      expect(d.rules, t.tool).toMatchObject({ version: '0.2', full: 'course-xapi-mcp://rules/agent' });
      expect(d.rules.digest.length).toBeGreaterThan(0);
      expect(d.cxm).toMatchObject({ custody: CUSTODY, official: OFFICIAL });
      if (!OFFICIAL) expect(typeof d.cxm.label).toBe('string');
    }
    const lessonCalls = transcript.filter((t) => ['next_beat', 'check_code', 'submit_checkpoint'].includes(t.tool) && !t.raw.isError);
    for (const t of lessonCalls) expect(t.raw.structuredContent.cxm, t.tool).toHaveProperty('lesson');
  });

  it('[CXM-CUS-001] reports the custody option before the first recorded step, in every result and through get_status', () => {
    const status = transcript.find((t) => t.tool === 'get_status')!;
    const firstWrite = transcript.findIndex((t) => t.tool === 'start_placement');
    expect(transcript.indexOf(status)).toBeLessThan(firstWrite);
    expect(status.raw.structuredContent.custody).toBe(CUSTODY);
    for (const t of transcript.filter((x) => !x.tool.startsWith('resource:'))) expect(t.raw.structuredContent.cxm.custody).toBe(CUSTODY);
  });

  it('[CXM-SEC-004] no credential, token, actor account name or registration appears in a result the agent sees, except in the export', () => {
    const secrets = new Set<string>();
    for (const s of all()) {
      if (s.context?.registration) secrets.add(s.context.registration);
      if (s.actor.account?.name) secrets.add(s.actor.account.name);
    }
    for (const l of lms?.launches ?? []) secrets.add(l.token);
    secrets.add(btoa('test:test'));
    const visible = agentVisible();
    expect(visible.length).toBeGreaterThan(40);
    for (const t of visible) for (const secret of secrets) expect(t.plain.includes(secret), `${t.tool} shows ${secret}`).toBe(false);
  });
});
