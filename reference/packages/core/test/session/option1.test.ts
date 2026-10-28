// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { CMI5, CXM_EXT } from '../../src/constants.ts';
import { expireSession, nextBeat, restartCourse, type LaunchBinding } from '../../src/session/index.ts';
import { buildDefined, type XapiAgent, type XapiStatement } from '../../src/xapi/index.ts';
import { COURSE_ID, course } from '../fixtures/course-model.ts';
import { GOOD_FILE, Run, expectClean, makeEnv, sessionOf, verbs } from './driver.ts';

const LMS_ACTOR: XapiAgent = { objectType: 'Agent', account: { homePage: 'https://lms.example.org', name: 'lms-user-7' } };
const REG = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
let sessions = 0;

function launch(auKey: string, launchMode: LaunchBinding['launchMode'] = 'Normal'): LaunchBinding {
  const sessionId = `aaaaaaaa-0000-4000-8000-${String(++sessions).padStart(12, '0')}`;
  const auId = auKey === 'placement' ? course.placement.auId : course.lessons[auKey]!.auId;
  return {
    auKey,
    activityId: `https://lms.example.org/activities/${auKey}-1234`,
    registration: REG,
    sessionId,
    contextTemplate: { contextActivities: { grouping: [{ objectType: 'Activity', id: auId }] }, extensions: { [CMI5.extSessionId]: sessionId } },
    launchMode,
    returnURL: 'https://lms.example.org/course/return',
  };
}

/** A learner in option 1; `relaunch` stands in for the bridge, which sends `initialized` itself. */
function lmsRun() {
  const env = makeEnv({ custody: 'lms-launched', actor: LMS_ACTOR, launch: launch('placement') });
  const run = new Run(course, env);
  const bridge: XapiStatement[] = [];
  const relaunch = (auKey: string, mode?: LaunchBinding['launchMode']) => {
    env.launch = launch(auKey, mode);
    const l = env.launch;
    const auId = auKey === 'placement' ? course.placement.auId : course.lessons[auKey]!.auId;
    bridge.push(
      buildDefined(
        { actor: LMS_ACTOR, registration: REG, sessionId: l.sessionId, courseId: COURSE_ID, language: 'en', rulesVersion: '0.2', custody: 'lms-launched', practice: false, contextTemplate: l.contextTemplate },
        'initialized',
        { au: { publisherId: auId, activityId: l.activityId } },
        { id: `bbbbbbbb-0000-4000-8000-${String(bridge.length + 1).padStart(12, '0')}`, timestamp: new Date(env.t).toISOString() },
      ),
    );
    env.advance(1000);
  };
  relaunch('placement');
  return { run, env, relaunch, all: () => [...bridge, ...run.statements] };
}

describe('session engine: option 1 (lms-launched)', () => {
  it('option 1 records waive-recommended instead of waived and returns return-to-lms for the next AU', () => {
    const { run, env, relaunch, all } = lmsRun();
    const started = run.start();
    expect(started.statements).toEqual([]);
    expect(run.state!.registration).toBe(REG);
    expect(run.state!.session!.id).toBe(env.launch!.sessionId);

    const placed = run.place('p', 'b', ['a'], 'Already knows A.');
    expect(verbs(placed.statements)).toEqual(['placed', 'terminated']);
    expect(placed.statements[0]!.result!.extensions![CXM_EXT['waive-recommended']]).toEqual([`${COURSE_ID}/lessons/a`]);
    expect(placed.statements[1]!.object.id).toBe('https://lms.example.org/activities/placement-1234');
    expect(placed.next).toEqual({ type: 'return-to-lms', lessonKey: 'b', returnURL: 'https://lms.example.org/course/return' });
    expect(placed.data).toMatchObject({ waive_recommended: ['a'] });
    expect(run.state!.au.a).toBeUndefined();

    // still bound to the placement launch: b is not opened here
    const stay = run.do((s) => nextBeat(course, s, {}, env));
    expect(stay.statements).toEqual([]);
    expect(stay.next).toEqual({ type: 'return-to-lms', lessonKey: 'b', returnURL: 'https://lms.example.org/course/return' });
    expect(run.state!.session).toBeUndefined();

    relaunch('b');
    const first = run.beat();
    expect(verbs(first.statements)).toEqual(['experienced']);
    expect(sessionOf(first.statements[0]!)).toBe(env.launch!.sessionId);
    expect(first.statements[0]!.context.contextActivities!.parent).toEqual([{ objectType: 'Activity', id: 'https://lms.example.org/activities/b-1234' }]);
    run.beat();
    run.code('{"port":8080}');
    const completed = run.beat();
    expect(verbs(completed.statements)).toEqual(['completed']);
    expect(completed.statements[0]!.object.id).toBe('https://lms.example.org/activities/b-1234');
    run.submit('timeout is compared with elapsed time.', { 'config.json': GOOD_FILE });
    const passed = run.branch('fixed');
    expect(verbs(passed.statements)).toEqual(['passed', 'branched', 'passed', 'terminated']);
    expect(passed.next).toEqual({ type: 'return-to-lms', lessonKey: 'c', returnURL: 'https://lms.example.org/course/return' });
    expect(passed.events).toEqual([{ type: 'au', lessonKey: 'b', statementId: passed.statements[2]!.id, waived: false, carriedOver: false }]);

    relaunch('c');
    run.beat();
    const end = run.beat();
    expect(verbs(end.statements)).toEqual(['completed', 'terminated']);
    expect(end.next).toEqual({ type: 'done' });
    expect(run.state!.satisfied).toEqual({ blocks: [], course: false });
    expectClean(all(), { lmsActor: true });
  });

  it.each(['Browse', 'Review'] as const)('a %s launch sends no completed, passed or failed on the AU (cmi5 10.2.2)', (mode) => {
    const { run, relaunch, all } = lmsRun();
    run.start();
    run.place('p', 'b', ['a'], 'Already knows A.');
    relaunch('b', mode);
    run.beat();
    run.beat();
    run.code('{"port":8080}');
    const done = run.beat();
    expect(verbs(done.statements)).not.toContain('completed');
    run.submit('timeout is compared with elapsed time.', { 'config.json': GOOD_FILE });
    const r = run.branch('fixed');
    // The allowed passed on the checkpoint stays; the AU gets no defined passed, and the session still ends.
    expect(verbs(r.statements)).toEqual(['passed', 'branched', 'terminated']);
    expect(r.events).toEqual([]);
    expect(run.state!.au.b?.passed).not.toBe(true);
    expectClean(all(), { lmsActor: true });
  });

  it('a forward success branch recommends waivers on branched', () => {
    const { run, relaunch, all } = lmsRun();
    run.start();
    run.place();
    relaunch('a');
    run.beat();
    run.beat();
    run.beat('A string.');
    run.submit('I know B already.');
    const r = run.branch('skip');
    const branched = r.statements.find((s) => s.verb.id.endsWith('/branched'))!;
    expect(branched.result!.extensions![CXM_EXT['waive-recommended']]).toEqual([`${COURSE_ID}/lessons/b`]);
    expect(verbs(r.statements)).toEqual(['passed', 'branched', 'passed', 'terminated']);
    expect(r.data).toMatchObject({ waive_recommended: ['b'] });
    expectClean(all(), { lmsActor: true });
  });

  it('option 1 never emits launched, initialized, waived or satisfied', () => {
    const { run, relaunch } = lmsRun();
    run.start();
    run.place('p', 'c', ['a', 'b'], 'Knows A and B.');
    relaunch('c');
    run.beat();
    run.beat();
    run.start(); // the old launch is for c: placement is not opened here
    for (const v of ['launched', 'initialized', 'waived', 'satisfied']) expect(verbs(run.statements)).not.toContain(v);
    expect(run.statements.length).toBeGreaterThan(0);
  });

  it('an ended launch sends the learner back to the LMS; an idle session is left to the bridge sweeper', () => {
    const { run, env, relaunch } = lmsRun();
    run.start();
    run.place();
    relaunch('a');
    run.beat();
    env.advance(31 * 60_000);
    const expired = run.expire();
    expect(expired.statements).toEqual([]);
    expect(run.state!.session).toBeUndefined();
    env.launch = { ...env.launch!, ended: true };
    const r = run.beat();
    expect(r.statements).toEqual([]);
    expect(r.next).toMatchObject({ type: 'return-to-lms', lessonKey: 'a' });
    expect(run.try((s) => restartCourse(course, s, env))).toEqual({ ok: false, error: 'your LMS owns the registrations for this course; ask it to start the course again' });
    expect(expireSession(course, run.state!, env)).toMatchObject({ ok: true, statements: [] });
  });
});
