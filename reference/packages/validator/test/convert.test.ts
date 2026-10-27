// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadPackage, readDir } from '@course-xapi-mcp/core/package';
import { convertLegacyCourse } from '../src/convert.ts';

const legacyPath = new URL('./fixtures/json-basics.course.json', import.meta.url);
const exampleDir = new URL('../../../../examples/json-basics/', import.meta.url).pathname;
const legacy = (): any => JSON.parse(readFileSync(legacyPath, 'utf8'));
const OPTS = {
  courseIri: 'https://course-xapi-mcp.sqwrlz.com/examples/json-basics',
  mcpUrl: 'http://127.0.0.1:8787/mcp',
  launchBase: 'http://127.0.0.1:8787/cmi5/launch',
  custody: 'server-kept' as const,
  allowPractice: true,
};
const enc = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)]));

describe('convertLegacyCourse', () => {
  it('converts the legacy example into a package that loads with no errors', () => {
    const r = convertLegacyCourse(legacy(), OPTS);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(Object.keys(r.files).sort()).toEqual(['cmi5.xml', 'cxm/course.json', 'cxm/lessons/fix-the-config.json', 'cxm/lessons/what-is-json.json']);
    const loaded = loadPackage(enc(r.files));
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues, null, 2));
    expect(loaded.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const course = loaded.course;
    const old = legacy();
    for (const [key, l] of Object.entries<any>(old.lessons)) {
      const m = course.lessons[key]!;
      expect(m.auId).toBe(`${OPTS.courseIri}/lessons/${key}`);
      expect(m.url).toBe(`${OPTS.launchBase}?au=${key}`);
      expect(m.beats.length).toBe(l.beats.length);
      expect(Boolean(m.checkpoint)).toBe(Boolean(l.checkpoint));
      expect(m.moveOn).toBe(l.checkpoint ? 'CompletedAndPassed' : 'Completed');
      expect(m.checkpoint?.branches.length).toBe(l.checkpoint?.branches.length);
      expect(m.bug?.revealAfter).toBe(l.bug ? 3 : undefined);
      for (const b of l.checkpoint?.branches ?? []) {
        const t = m.checkpoint!.branches.find((x: any) => x.key === b.id)!.to;
        expect(t).toBe(b.to);
        if (t !== null) expect(course.lessons[t]).toBeDefined();
      }
    }
    expect(course.placement.auId).toBe(`${OPTS.courseIri}/placement`);
    expect(course.paths.json!.blockId).toBe(`${OPTS.courseIri}/paths/json`);
    expect(course.custody).toBe('server-kept');
    expect(course.allowPractice).toBe(true);
  });

  it('returns the error for an unknown branch target', () => {
    const raw = legacy();
    raw.lessons['what-is-json'].checkpoint.branches[0].to = 'nope';
    const r = convertLegacyCourse(raw, OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('unknown lesson "nope"');
  });
});

describe('examples/json-basics', () => {
  it('loads with no errors, server-kept, two badges, reference solution on fix-the-config', async () => {
    const loaded = loadPackage(await readDir(exampleDir));
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues, null, 2));
    expect(loaded.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const c = loaded.course;
    expect(c.custody).toBe('server-kept');
    expect(c.badges).toHaveLength(2);
    expect(c.badges.map((b) => [b.awardOn, b.for])).toEqual([['au-moveon', 'fix-the-config'], ['block-satisfied', 'json']]);
    expect(c.lessons['fix-the-config']!.referenceSolution?.bugFix).toBeTruthy();
    expect(c.lessons['what-is-json']!.referenceSolution).toBeUndefined();
  });
});
