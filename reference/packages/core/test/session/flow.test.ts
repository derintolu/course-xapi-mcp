// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { CMI5, PRACTICE_CATEGORY, PRACTICE_HOMEPAGE } from '../../src/constants.ts';
import { nextBeat } from '../../src/session/index.ts';
import { COURSE_ID } from '../fixtures/course-model.ts';
import { GOOD_FILE, Run, defined, expectClean, makeEnv, sessionOf, strictlyIncreasing, verbName, verbs } from './driver.ts';

/** Path p from placement to the end, every checkpoint passed first time. */
function fullRun(run = new Run()) {
  const steps = [];
  steps.push(run.start());
  steps.push(run.place());
  steps.push(run.beat());
  steps.push(run.beat());
  steps.push(run.beat('No, it is a string.'));
  steps.push(run.submit('One is a number and one a string; a program compares numbers.'));
  steps.push(run.branch('ready'));
  steps.push(run.beat());
  steps.push(run.beat());
  steps.push(run.code('{"port":8080}'));
  steps.push(run.beat());
  steps.push(run.submit('timeout is compared with elapsed time, so it is a number.', { 'config.json': GOOD_FILE }));
  steps.push(run.branch('fixed'));
  steps.push(run.beat());
  steps.push(run.beat());
  return { run, steps };
}

describe('session engine: a full run', () => {
  it('a full run of path p emits launched, initialized, ..., completed, passed, terminated per lesson, then satisfied for p', () => {
    const { run } = fullRun();
    expect(verbs(run.statements)).toEqual([
      // placement AU
      'launched', 'initialized', 'placed', 'terminated',
      // a
      'launched', 'initialized', 'experienced', 'experienced', 'answered', 'completed', 'answered', 'passed', 'branched', 'passed', 'terminated',
      // b
      'launched', 'initialized', 'experienced', 'passed', 'caught', 'completed', 'answered', 'passed', 'passed', 'branched', 'passed', 'terminated',
      // c, then block p
      'launched', 'initialized', 'experienced', 'completed', 'terminated', 'satisfied',
    ]);
    expect(verbs(defined(run.statements))).toEqual([
      'launched', 'initialized', 'terminated',
      'launched', 'initialized', 'completed', 'passed', 'terminated',
      'launched', 'initialized', 'completed', 'passed', 'terminated',
      'launched', 'initialized', 'completed', 'terminated', 'satisfied',
    ]);
    expectClean(run.statements);
    const satisfied = run.statements.at(-1)!;
    expect(satisfied.object.id).toBe(`${COURSE_ID}/paths/p`);
    expect(run.state!.satisfied).toEqual({ blocks: ['p'], course: false });
    expect(run.state!.cursor!.phase).toBe('done');
    expect(run.last!.next).toEqual({ type: 'done' });
  });

  it('reports each met moveOn and the satisfied block as events', () => {
    const { run } = fullRun();
    expect(run.events.map((e) => (e.type === 'au' ? `au:${e.lessonKey}` : e.type === 'block' ? `block:${e.pathKey}` : 'course'))).toEqual(['au:a', 'au:b', 'au:c', 'block:p']);
    const byId = new Map(run.statements.map((s) => [s.id, s]));
    for (const e of run.events) expect(byId.has(e.statementId)).toBe(true);
    const a = run.events[0]!;
    expect(a.type === 'au' && a.waived).toBe(false);
    expect(byId.get(a.statementId)!.verb.id).toBe('http://adlnet.gov/expapi/verbs/passed');
  });

  it('timestamps strictly increase within one step', () => {
    const { steps, run } = fullRun();
    for (const step of steps) expect(strictlyIncreasing(step.statements.map((s) => s.timestamp))).toBe(true);
    expect(steps.some((s) => s.statements.length >= 4)).toBe(true);
    // and across steps
    expect(strictlyIncreasing(run.statements.map((s) => s.timestamp))).toBe(true);
  });

  it('keeps statements ordered even when the clock does not move between calls', () => {
    const run = new Run();
    run.env.advance = () => {};
    fullRun(run);
    expect(strictlyIncreasing(run.statements.map((s) => s.timestamp))).toBe(true);
    expectClean(run.statements);
  });

  it('opens one AU session per lesson visit, and launched carries launchMode Normal', () => {
    const { run } = fullRun();
    const launched = run.statements.filter((s) => verbName(s) === 'launched');
    expect(launched).toHaveLength(4);
    expect(new Set(launched.map(sessionOf)).size).toBe(4);
    expect(launched[1]!.context.extensions!['https://w3id.org/xapi/cmi5/context/extensions/launchmode']).toBe('Normal');
    expect(launched[1]!.context.extensions!['https://w3id.org/xapi/cmi5/context/extensions/moveon']).toBe('CompletedAndPassed');
    expect(launched[0]!.context.extensions!['https://w3id.org/xapi/cmi5/context/extensions/moveon']).toBe('NotApplicable');
    for (const s of run.statements.filter((x) => verbName(x) === 'experienced')) {
      expect(s.context.extensions![CMI5.extSessionId]).toBeTypeOf('string');
    }
  });

  it('never mutates its input state', () => {
    const run = new Run();
    run.toCheckpointA();
    const before = structuredClone(run.state);
    const frozen = run.state!;
    run.submit('An answer.');
    expect(frozen).toEqual(before);
  });

  it('requires the learner reply after a beat with a question, and records it as answered', () => {
    const run = new Run();
    run.start();
    run.place();
    run.beat();
    run.beat();
    expect(run.state!.cursor!.awaitingReply).toBe(true);
    const refused = run.try((s) => nextBeat(run.course, s, {}, run.env));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain('learner_reply');
    const ok = run.beat('No, it is a string.');
    const answered = ok.statements.find((s) => verbName(s) === 'answered')!;
    expect(answered.result!.response).toBe('No, it is a string.');
    expect(answered.object.id).toBe(`${COURSE_ID}/lessons/a/beats/a2`);
  });

  it('practice statements all carry the practice category', () => {
    const env = makeEnv({ custody: 'practice', practice: true, actor: { objectType: 'Agent', account: { homePage: PRACTICE_HOMEPAGE, name: 'p-1' } } });
    const { run } = fullRun(new Run(undefined, env));
    expect(run.statements.length).toBeGreaterThan(20);
    for (const s of run.statements) expect(s.context.contextActivities!.category!.map((a) => a.id)).toContain(PRACTICE_CATEGORY);
    expect(verbs(run.statements)).toContain('satisfied');
    expectClean(run.statements);
  });
});

