// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../src/constants.ts';
import { REMOVED, checkCode, chooseBranch, endSession, expireSession, nextBeat, restartCourse, revealBug, submitCheckpoint } from '../../src/session/index.ts';
import { COURSE_ID, variant } from '../fixtures/course-model.ts';
import { Run, defined, expectClean, sessionOf, verbName, verbs } from './driver.ts';

describe('session engine: AU session lifecycle', () => {
  it('an idle session is terminated with timestamp lastActivity+1ms and the next call opens a new one', () => {
    const run = new Run();
    run.start();
    run.place();
    run.beat();
    const s = run.state!.session!;
    expect(run.expire().statements).toEqual([]); // not idle yet
    run.env.advance(DEFAULTS.sessionIdleMs);
    const r = run.expire();
    expect(verbs(r.statements)).toEqual(['terminated']);
    const t = r.statements[0]!;
    expect(sessionOf(t)).toBe(s.id);
    expect(Date.parse(t.timestamp)).toBe(Date.parse(s.lastActivityAt) + 1);
    expect(t.result!.duration).toBe(`PT${(Date.parse(s.lastActivityAt) - Date.parse(s.startedAt)) / 1000}S`);
    expect(t.object.id).toBe(`${COURSE_ID}/lessons/a/au`);
    expect(run.state!.session).toBeUndefined();

    const next = run.beat();
    expect(verbs(next.statements)).toEqual(['launched', 'initialized', 'experienced']);
    expect(run.state!.session!.id).not.toBe(s.id);
    expect(run.state!.cursor).toMatchObject({ lessonKey: 'a', beat: 2 });
    expectClean(run.statements);
  });

  it('every write call keeps the session alive', () => {
    const run = new Run();
    run.start();
    run.place();
    run.beat();
    run.env.advance(DEFAULTS.sessionIdleMs - 5000);
    run.beat();
    run.env.advance(DEFAULTS.sessionIdleMs - 5000);
    expect(run.expire().statements).toEqual([]);
    expect(run.state!.session).toBeDefined();
  });

  it('end_session terminates the open session with its duration', () => {
    const run = new Run();
    run.start();
    run.place();
    run.beat();
    const r = run.do((s) => endSession(run.course, s, run.env));
    expect(verbs(r.statements)).toEqual(['terminated']);
    expect(r.statements[0]!.result!.duration).toMatch(/^PT\d/);
    expect(r.data).toMatchObject({ ended: true });
    expect(run.do((s) => endSession(run.course, s, run.env)).statements).toEqual([]);
    expectClean(run.statements);
  });

  it('moving to another lesson terminates the session of the one being left', () => {
    const run = new Run();
    run.toCheckpointA();
    const a = run.state!.session!.id;
    const r = run.start(); // back to placement mid-lesson
    expect(verbs(r.statements)).toEqual(['terminated', 'launched', 'initialized']);
    expect(sessionOf(r.statements[0]!)).toBe(a);
    expectClean(run.statements);
  });

  it('restart_course mints a new registration and keeps earned awards', () => {
    const run = new Run();
    run.toCheckpointA();
    run.state = { ...run.state!, awards: [{ badgeId: 'badge-a', statementId: '00000000-0000-4000-8000-000000000099' }] };
    const old = run.state.registration;
    const r = run.do((s) => restartCourse(run.course, s, run.env));
    expect(verbs(r.statements)).toEqual(['terminated']);
    expect(r.statements[0]!.context.registration).toBe(old);
    const st = run.state!;
    expect(st.registration).not.toBe(old);
    expect(st.awards).toEqual([{ badgeId: 'badge-a', statementId: '00000000-0000-4000-8000-000000000099' }]);
    expect(st.au).toEqual({});
    expect(st.cursor).toBeUndefined();
    expect(st.placement).toBeUndefined();
    expect(st.session).toBeUndefined();
    expect(st.satisfied).toEqual({ blocks: [], course: false });
    expect(JSON.stringify(r.data)).not.toContain(st.registration);

    const again = run.start();
    expect(again.statements.every((s) => s.context.registration === st.registration)).toBe(true);
    run.place();
    run.beat();
    run.beat();
    const done = run.beat('A string.');
    expect(defined(done.statements).map(verbName)).toEqual(['completed']); // a fresh registration sends completed again
    expectClean(run.statements);
  });

  it('a removed lesson after a course update gives the choose_placement error and closes the open session', () => {
    const run = new Run();
    run.toCheckpointA();
    run.submit('Ready.');
    run.branch('ready');
    run.beat(); // b's session is open
    const open = run.state!.session!;
    const updated = variant((c) => {
      delete c.lessons.b;
      c.paths.p!.lessons = ['a', 'c'];
      c.version = '1.1.0';
    });
    run.course = updated;
    const env = run.env;
    for (const call of [
      () => nextBeat(updated, run.state!, {}, env),
      () => checkCode(updated, run.state!, { file: 'config.json', content: '{}' }, env),
      () => revealBug(updated, run.state!, env),
      () => submitCheckpoint(updated, run.state!, { response: 'x' }, env),
      () => chooseBranch(updated, run.state!, { branch: 'fixed', rationale: 'x' }, env),
      () => endSession(updated, run.state!, env),
    ]) {
      expect(call()).toEqual({ ok: false, error: REMOVED });
    }
    expect(REMOVED).toBe('this lesson is no longer in the course (it was updated); call choose_placement to continue');

    const closed = run.do((s) => expireSession(updated, s, env));
    expect(verbs(closed.statements)).toEqual(['terminated']);
    expect(closed.statements[0]!.object.id).toBe(`${COURSE_ID}/lessons/b/au`);
    expect(sessionOf(closed.statements[0]!)).toBe(open.id);
    expect(run.state!.session).toBeUndefined();
    // nothing defined about b beyond what its session already had, and nothing after terminated
    expect(run.statements.filter((s) => s.object.id.includes('/lessons/b/') && verbName(s) !== 'launched' && verbName(s) !== 'initialized' && verbName(s) !== 'experienced').map(verbName)).toEqual(['terminated']);

    run.start();
    const placed = run.place('p', 'c', [], 'Continue after the update.');
    expect(placed.data).toMatchObject({ start_lesson: { key: 'c' } });
    run.beat();
    run.beat();
    expectClean(run.statements);
  });
});
