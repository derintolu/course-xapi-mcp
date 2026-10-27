// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { allowedBranches, getLesson, listPaths, nextLessonId, status, validatePlacement } from '../../src/session/index.ts';
import { BUG_EXPLANATION, course, variant } from '../fixtures/course-model.ts';
import { BAD_FILE, Run, makeEnv } from './driver.ts';

describe('session engine: status and read-only views', () => {
  it('status follows the learner and names the tools that fit next', () => {
    const env = makeEnv();
    expect(status(course, undefined, env)).toEqual({ position: {}, next: ['start_placement'] });
    const run = new Run();
    run.start();
    expect(status(course, run.state, env).next).toEqual(['choose_placement']);
    run.place();
    expect(status(course, run.state, env)).toEqual({ position: { pathKey: 'p', lessonKey: 'a', phase: 'beats' }, next: ['next_beat'] });
    run.beat();
    expect(status(course, run.state, env).next).toEqual(['next_beat', 'end_session']);
    run.beat();
    run.beat('A string.');
    expect(status(course, run.state, env).next).toEqual(['submit_checkpoint', 'end_session']);
    run.submit('Ready.');
    expect(status(course, run.state, env).next).toEqual(['choose_branch', 'end_session']);
    run.branch('ready');
    run.beat();
    run.beat();
    expect(status(course, run.state, env)).toMatchObject({ position: { lessonKey: 'b', phase: 'bug' }, next: ['check_code', 'end_session'] });
    for (let i = 0; i < 3; i++) run.code(BAD_FILE.replace('8080', '"8080"'));
    expect(status(course, run.state, env).next).toEqual(['check_code', 'reveal_bug', 'end_session']);
    run.code('{"port":8080}');
    run.beat();
    expect(status(course, run.state, env).next).toEqual(['check_code', 'submit_checkpoint', 'end_session']);

    const updated = variant((c) => {
      delete c.lessons.b;
      c.paths.p!.lessons = ['a', 'c'];
    });
    expect(status(updated, run.state, env)).toEqual({ position: {}, next: ['choose_placement'] });
  });

  it('listPaths and getLesson never return secrets', () => {
    const text = JSON.stringify([listPaths(course), getLesson(course, 'b')]);
    expect(text).not.toContain(BUG_EXPLANATION);
    expect(text).not.toContain('fixChecks');
    expect(text).not.toContain('rubric');
    expect(getLesson(course, 'b')).toMatchObject({ ok: true, data: { lesson: { key: 'b', pathKey: 'p' }, has_planted_bug: true, checkpoint: { kind: 'code' } } });
    expect(getLesson(course, 'nope')).toEqual({ ok: false, error: 'unknown lesson; lessons: a, b, c, q1' });
    expect(listPaths(course).paths.map((p) => [p.key, p.lessons.map((l) => l.key)])).toEqual([['p', ['a', 'b', 'c']], ['q', ['q1']]]);
  });

  it('the key-based engine ports validate placement, allowed branches and path order', () => {
    expect(validatePlacement(course, { pathKey: 'x', startLessonKey: 'a', skip: [], reason: 'r' })).toEqual({ ok: false, error: 'unknown path; choose one of: p, q' });
    expect(validatePlacement(course, { pathKey: 'p', startLessonKey: 'q1', skip: [], reason: 'r' })).toEqual({ ok: false, error: 'startLessonKey is not in the path; lessons in order: a, b, c' });
    expect(validatePlacement(course, { pathKey: 'p', startLessonKey: 'b', skip: ['a'], reason: 'x'.repeat(301) }).ok).toBe(false);
    expect(validatePlacement(course, { pathKey: 'p', startLessonKey: 'c', skip: ['a', 'a'], reason: 'r' })).toEqual({ ok: true, placement: { pathKey: 'p', startLessonKey: 'c', skip: ['a'], reason: 'r' } });
    const cp = course.lessons.b!.checkpoint!;
    expect(allowedBranches(cp, false).map((b) => b.key)).toEqual(['back']);
    expect(allowedBranches(cp, true).map((b) => b.key)).toEqual(['fixed', 'back']);
    expect(nextLessonId(course, 'p', null, [])).toBe('a');
    expect(nextLessonId(course, 'p', 'a', ['b'])).toBe('c');
    expect(nextLessonId(course, 'p', 'c', [])).toBeNull();
    expect(nextLessonId(course, 'zz', null, [])).toBeNull();
  });
});
