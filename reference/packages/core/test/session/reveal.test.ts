// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { CXM_EXT } from '../../src/constants.ts';
import { getLesson, listPaths, revealBug, status } from '../../src/session/index.ts';
import { BUG_EXPLANATION, COURSE_ID, FIX_VALUE, variant } from '../fixtures/course-model.ts';
import { GOOD_FILE, Run, defined, expectClean, makeEnv, verbName, verbs } from './driver.ts';

const WRONG = '{"port":"8081"}';

/** Lesson b's bug step, after `fails` failed fix attempts. */
function atBug(fails: number, run = new Run()) {
  run.toCheckpointA();
  run.submit('Ready.');
  run.branch('ready');
  run.beat();
  run.beat();
  for (let i = 0; i < fails; i++) run.code(WRONG);
  return run;
}

describe('session engine: reveal_bug', () => {
  it('reveal_bug is refused before 3 failed fixes, allowed after, emits revealed, and the lesson can still pass', () => {
    const run = atBug(2);
    const early = run.reveal();
    expect(early).toEqual({ ok: false, error: 'reveal_bug is allowed after 3 failed fix attempts; the learner has made 2. Keep helping with hints.' });
    const third = run.code(WRONG);
    expect(third.data).toMatchObject({ passed: false, fix_attempts: 3, can_reveal: true, hint: 'Look at the types.' });
    const r = run.reveal();
    if (!r.ok) throw new Error(r.error);
    expect(verbs(r.statements)).toEqual(['revealed']);
    expect(r.statements[0]!.object.id).toBe(`${COURSE_ID}/lessons/b/bugs/port`);
    expect(r.data).toMatchObject({ revealed: true, explanation: BUG_EXPLANATION });
    expect(run.state!.au.b!.bug).toBe('revealed');
    expect(verbs(run.statements)).not.toContain('caught');

    const completed = run.beat();
    expect(verbs(completed.statements)).toEqual(['completed']);
    run.submit('timeout is compared with elapsed time.', { 'config.json': GOOD_FILE });
    const pass = run.branch('fixed');
    expect(defined(pass.statements).map(verbName)).toEqual(['passed', 'terminated']);
    expectClean(run.statements);
  });

  it('reveal_bug is refused when revealAfter is null', () => {
    const course = variant((c) => {
      c.lessons.b!.bug!.revealAfter = null;
    });
    const run = atBug(5, new Run(course));
    expect(run.reveal()).toEqual({ ok: false, error: 'the author turned reveal_bug off for this lesson; keep helping the learner find the bug with hints' });
    expect(run.last!.data).toMatchObject({ can_reveal: false });
  });

  it('reveal_bug follows an authored revealAfter and is refused outside the bug step', () => {
    const course = variant((c) => {
      c.lessons.b!.bug!.revealAfter = 1;
    });
    const run = atBug(1, new Run(course));
    expect(run.reveal().ok).toBe(true);
    expect(run.try((s) => revealBug(course, s, run.env)).ok).toBe(false);
  });

  it('no result before caught or revealed contains the explanation or a fix-check value', () => {
    const run = new Run();
    const env = makeEnv();
    const seen: unknown[] = [listPaths(run.course), getLesson(run.course, 'b'), status(run.course, undefined, env)];
    const original = run.try.bind(run);
    run.try = (fn) => {
      const r = original(fn);
      seen.push(r, run.state && status(run.course, run.state, env));
      return r;
    };
    atBug(3, run);
    run.reveal(); // every result up to here is scanned; the reveal itself carries the explanation
    seen.pop();
    const revealed = JSON.stringify(seen.pop());
    expect(revealed).toContain(BUG_EXPLANATION);
    const text = JSON.stringify(seen);
    const inJson = (v: string) => JSON.stringify(v).slice(1, -1);
    expect(text).toContain(inJson('{"port":"8081"}')); // the scan sees escaped file contents
    expect(text).not.toContain(BUG_EXPLANATION);
    expect(text).not.toContain(inJson(FIX_VALUE));
    expect(text).not.toContain('port is a number');
    // fix attempts record empty check lists, so the record does not point at the bug either
    const fixes = run.statements.filter((s) => s.object.id.endsWith('/files/config.json'));
    expect(fixes.length).toBe(3);
    for (const s of fixes) expect(s.result!.extensions![CXM_EXT.checks]).toEqual([]);
  });
});
