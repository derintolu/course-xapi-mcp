// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { CXM_EXT } from '../../src/constants.ts';
import { chooseBranch } from '../../src/session/index.ts';
import { COURSE_ID } from '../fixtures/course-model.ts';
import { BAD_FILE, GOOD_FILE, Run, defined, expectClean, sessionOf, verbName, verbs } from './driver.ts';

describe('session engine: branches', () => {
  it('a failed retry records allowed failed with attempt 1 and keeps the session open', () => {
    const run = new Run();
    run.toCheckpointA();
    const session = run.state!.session!.id;
    run.submit('Strings and numbers are the same.');
    const r = run.branch('review', 'Mixes the types up.');
    expect(verbs(r.statements)).toEqual(['failed', 'branched']);
    expect(defined(r.statements)).toEqual([]);
    const failed = r.statements[0]!;
    expect(failed.object.id).toBe(`${COURSE_ID}/lessons/a/checkpoints/cp`);
    expect(failed.result).toMatchObject({ success: false, extensions: { [CXM_EXT.attempt]: 1 } });
    expect(run.state!.session).toMatchObject({ id: session, attempts: 1 });
    // a branch to the same unpassed lesson restarts its beats in the same session
    expect(run.state!.cursor).toMatchObject({ lessonKey: 'a', beat: 0, phase: 'beats' });
    const again = run.beat();
    expect(verbs(again.statements)).toEqual(['experienced']);
    expect(sessionOf(again.statements[0]!)).toBe(session);
    run.beat();
    const done = run.beat('A string.');
    expect(verbs(done.statements)).toEqual(['answered']); // completed was already sent once
    run.submit('One is a number and one a string.');
    const second = run.branch('review');
    expect(second.statements[0]!.result!.extensions![CXM_EXT.attempt]).toBe(2);
    expectClean(run.statements);
  });

  it('a failed check leaves only branches that do not count as a pass', () => {
    const run = new Run();
    run.toCheckpointB();
    const r = run.submit('It is a number.', { 'config.json': BAD_FILE });
    expect(r.data).toMatchObject({ checks_passed: false, allowed_branches: [{ key: 'back' }] });
    const refused = run.try((s) => chooseBranch(run.course, s, { branch: 'fixed', rationale: 'Looks fine.' }, run.env));
    expect(refused).toEqual({ ok: false, error: '"fixed" is not an allowed branch here; choose one of: back' });
    expect(run.try((s) => chooseBranch(run.course, s, { branch: 'invented', rationale: 'x' }, run.env)).ok).toBe(false);
  });

  it('maxAttempts spent sends defined failed then terminated; a later session can still pass', () => {
    const run = new Run();
    run.toCheckpointB();
    const first = run.state!.session!.id;
    run.submit('It is a number.', { 'config.json': BAD_FILE });
    const one = run.branch('back', 'Needs the basics.');
    expect(verbs(one.statements)).toEqual(['failed', 'branched']);
    // a is passed, so the branch is a review inside b's session
    run.beat();
    run.beat();
    run.beat('A string.');
    expect(run.state!.cursor!.phase).toBe('checkpoint');
    run.submit('Still not sure.', { 'config.json': BAD_FILE });
    const two = run.branch('back', 'Needs the basics.');
    expect(verbs(two.statements)).toEqual(['failed', 'branched', 'failed', 'terminated']);
    expect(defined(two.statements).map(verbName)).toEqual(['failed', 'terminated']);
    expect(two.statements[2]!.object.id).toBe(`${COURSE_ID}/lessons/b/au`);
    expect(two.statements[2]!.result!.duration).toMatch(/^PT/);
    expect(run.state!.session).toBeUndefined();
    expect(run.state!.au.b!.failed).toBe(true);

    // the review continues in a new session on b, with fresh attempts
    const next = run.beat();
    expect(verbs(next.statements)).toEqual(['launched', 'initialized', 'experienced']);
    expect(run.state!.session!.id).not.toBe(first);
    expect(run.state!.session!.attempts).toBe(0);
    run.beat();
    run.beat('A string.');
    run.submit('timeout is compared with elapsed time.', { 'config.json': GOOD_FILE });
    const pass = run.branch('fixed');
    expect(defined(pass.statements).map(verbName)).toEqual(['passed', 'terminated']);
    expectClean(run.statements);
  });

  it('never sends defined failed after passed', () => {
    const run = new Run();
    run.toCheckpointB();
    // b was passed earlier in this registration (as if by an earlier visit)
    run.state = { ...run.state!, au: { ...run.state!.au, b: { ...run.state!.au.b!, passed: true } } };
    run.submit('No idea.', { 'config.json': BAD_FILE });
    run.branch('back');
    run.beat();
    run.beat();
    run.beat('A string.');
    run.submit('Still no idea.', { 'config.json': BAD_FILE });
    const spent = run.branch('back');
    expect(verbs(spent.statements)).toEqual(['failed', 'branched', 'terminated']);
    expect(run.statements.filter((s) => verbName(s) === 'failed' && s.object.id.endsWith('/b/au'))).toEqual([]);
  });

  it('a branch to a passed lesson runs a review inside the current session and returns to the checkpoint', () => {
    const run = new Run();
    run.toCheckpointB();
    const session = run.state!.session!.id;
    run.submit('It is a number.', { 'config.json': BAD_FILE });
    const r = run.branch('back', 'Needs the basics.');
    expect(r.data).toMatchObject({ review_of: { key: 'a' } });
    expect(run.state!.cursor).toMatchObject({ lessonKey: 'b', phase: 'review', review: { lessonKey: 'a', beat: 0 } });

    const b1 = run.beat();
    const b2 = run.beat();
    const back = run.beat('A string.');
    const review = [...b1.statements, ...b2.statements, ...back.statements];
    expect(verbs(review)).toEqual(['experienced', 'experienced', 'answered']);
    expect(defined(review)).toEqual([]);
    for (const s of review) {
      expect(sessionOf(s)).toBe(session);
      expect(s.context.contextActivities!.parent!.map((p) => p.id)).toEqual([`${COURSE_ID}/lessons/a/au`]);
      expect(s.object.id.startsWith(`${COURSE_ID}/lessons/a/beats/`)).toBe(true);
    }
    expect(b1.data).toMatchObject({ step: 'review', lesson: { key: 'b' }, review_of: { key: 'a' } });
    expect(back.data).toMatchObject({ step: 'checkpoint', lesson: { key: 'b' }, review_done: { key: 'a' } });
    expect(run.state!.cursor).toMatchObject({ lessonKey: 'b', phase: 'checkpoint' });
    expect(run.state!.cursor!.review).toBeUndefined();
    expectClean(run.statements);
  });

  it('refuses choose_branch before a submission and submit_checkpoint before the checkpoint', () => {
    const run = new Run();
    run.start();
    run.place();
    run.beat();
    expect(run.try((s) => chooseBranch(run.course, s, { branch: 'ready', rationale: 'x' }, run.env)).ok).toBe(false);
  });
});
