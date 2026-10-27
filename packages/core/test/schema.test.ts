import { describe, expect, it } from 'vitest';
import { activity, parseCourse, runChecks } from '../src/index.ts';
import { rawCourse } from './fixtures.ts';

const mutate = (f: (c: any) => void) => {
  const c = rawCourse() as any;
  f(c);
  return parseCourse(c);
};

describe('CourseSchema', () => {
  it('accepts the example course', () => {
    const r = parseCourse(rawCourse());
    expect(r.ok, r.ok ? '' : r.errors.join('\n')).toBe(true);
  });

  it('rejects a branch that targets an unknown lesson', () => {
    const r = mutate((c) => (c.lessons['what-is-json'].checkpoint.branches[0].to = 'nowhere'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/unknown lesson "nowhere"/);
  });

  it('rejects duplicate branch ids and a checkpoint with no passing branch', () => {
    expect(mutate((c) => (c.lessons['what-is-json'].checkpoint.branches[1].id = 'ready')).ok).toBe(false);
    expect(mutate((c) => c.lessons['what-is-json'].checkpoint.branches.forEach((b: any) => (b.success = false))).ok).toBe(false);
  });

  it('requires code checkpoints to have a file, checks and a failing branch', () => {
    expect(mutate((c) => delete c.lessons['fix-the-config'].checkpoint.checks).ok).toBe(false);
    expect(
      mutate((c) => {
        const cp = c.lessons['fix-the-config'].checkpoint;
        cp.branches = cp.branches.filter((b: any) => b.success);
      }).ok,
    ).toBe(false);
  });

  it('rejects unknown properties, mismatched ids and a non-https activity base', () => {
    expect(mutate((c) => (c.extra = 1)).ok).toBe(false);
    expect(mutate((c) => (c.lessons['what-is-json'].id = 'other')).ok).toBe(false);
    expect(mutate((c) => (c.activityBase = 'http://example.org/x')).ok).toBe(false);
    expect(mutate((c) => (c.activityBase = 'https://example.org/x/')).ok).toBe(false);
  });

  it('rejects a path lesson from another path and duplicate beat ids', () => {
    expect(mutate((c) => (c.lessons['fix-the-config'].pathId = 'other')).ok).toBe(false);
    expect(mutate((c) => (c.lessons['what-is-json'].beats[1].id = 'text-format')).ok).toBe(false);
  });

  it('accepts nested file names, which run checks and encode into activity IRIs', () => {
    const r = mutate((c) => {
      const l = c.lessons['fix-the-config'];
      l.starterFiles = { 'templates/index.html': '<!-- wp:site-title /-->', 'parts/header.html': '' };
      l.checkpoint.file = 'templates/index.html';
      for (const ch of l.checkpoint.checks) ch.file = 'templates/index.html';
    });
    expect(r.ok, r.ok ? '' : r.errors.join('\n')).toBe(true);
    if (!r.ok) return;
    const res = runChecks([{ type: 'contains', file: 'templates/index.html', value: 'wp:site-title', message: 'Add the site title.' }], {
      'templates/index.html': '<!-- wp:site-title /-->',
    });
    expect(res.passed).toBe(true);
    expect(activity.file(r.course, 'fix-the-config', 'templates/index.html')).toContain('templates%2Findex.html');
  });

  it('rejects unsafe file names', () => {
    for (const bad of ['../x', '/x', 'a//b', 'a\\b', './x', 'x/', 'a/../b', ' x', '']) {
      const r = mutate((c) => (c.lessons['fix-the-config'].starterFiles = { [bad]: '' }));
      expect(r.ok, bad).toBe(false);
    }
  });
});
