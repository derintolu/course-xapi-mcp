import { describe, expect, it } from 'vitest';
import { allowedBranches, nextLessonId, validatePlacement } from '../src/index.ts';
import { loadCourse } from './fixtures.ts';

const course = loadCourse();
const ok = { pathId: 'json', startLessonId: 'fix-the-config', skip: ['what-is-json'], reason: 'Edits JSON daily.' };

describe('validatePlacement', () => {
  it('accepts an authored placement', () => {
    expect(validatePlacement(course, ok)).toEqual({ ok: true, placement: ok });
  });

  it.each([
    [{ ...ok, pathId: 'invented' }, /unknown path/],
    [{ ...ok, pathId: '__proto__' }, /unknown path/],
    [{ ...ok, startLessonId: 'invented' }, /not in the path/],
    [{ ...ok, skip: ['fix-the-config'] }, /before the start lesson/],
    [{ ...ok, reason: '' }, /reason/],
    [{ ...ok, reason: 'x'.repeat(301) }, /reason/],
    [null, /object/],
  ])('rejects %j', (raw, msg) => {
    const r = validatePlacement(course, raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
});

describe('allowedBranches', () => {
  const cp = course.lessons['fix-the-config'].checkpoint!;
  it('allows every branch when checks passed or there are none', () => {
    expect(allowedBranches(cp, true).map((b) => b.id)).toEqual(['done', 'explain-again', 'retry']);
    expect(allowedBranches(course.lessons['what-is-json'].checkpoint!, null).map((b) => b.id)).toEqual(['ready', 'review']);
  });
  it('allows only failing branches when a deterministic check failed', () => {
    expect(allowedBranches(cp, false).map((b) => b.id)).toEqual(['explain-again', 'retry']);
  });
});

describe('nextLessonId', () => {
  it('walks the path and honours skips', () => {
    expect(nextLessonId(course, 'json', null, [])).toBe('what-is-json');
    expect(nextLessonId(course, 'json', null, ['what-is-json'])).toBe('fix-the-config');
    expect(nextLessonId(course, 'json', 'fix-the-config', [])).toBeNull();
    expect(nextLessonId(course, 'json', 'not-in-path', [])).toBeNull();
  });
});
