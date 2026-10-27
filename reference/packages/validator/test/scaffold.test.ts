// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPackage } from '@course-xapi-mcp/core/package';
import { scaffoldCourse, scaffoldLesson, validatePackage } from '../src/index.ts';

const BIN = fileURLToPath(new URL('../bin/cxm.mjs', import.meta.url));
const enc = new TextEncoder();
const bytes = (f: Record<string, string>) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const COURSE = { id: 'https://example.org/courses/regex', title: 'Regular expressions', language: 'en', custody: 'server-kept' as const };

function cxm(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'cxm-scaffold-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** What a new lesson leaves to fill in. */
const lessonTodo = (key: string) => [
  ['CXM-PKG-007', `cxm/lessons/${key}.json`, '/beats/0/content'],
  ['CXM-PKG-007', `cxm/lessons/${key}.json`, '/beats/0/goal'],
  ['CXM-PKG-007', `cxm/lessons/${key}.json`, '/minutes'],
];
const pathTodo = (key: string) => [
  ['CXM-PKG-006', 'cxm/course.json', `/paths/${key}/placementHints`],
  ['CXM-PKG-006', 'cxm/course.json', `/paths/${key}/tagline`],
];
const INTRO = ['CXM-PKG-006', 'cxm/course.json', '/placement/intro'];

describe('cxm init, add-lesson, validate', () => {
  it('leaves only the fill-this-in errors, each with a fix', async () => {
    const dir = join(tmp, 'course');
    const init = await cxm('init', dir, '--id', COURSE.id, '--title', COURSE.title);
    expect(init.stderr).toBe('');
    expect(init.code).toBe(0);
    const add = await cxm('add-lesson', dir, '--path', 'basics', '--key', 'literals', '--title', 'Literal characters');
    expect(add.stderr).toBe('');
    expect(add.code).toBe(0);

    const r = await cxm('validate', dir, '--json');
    expect(r.stderr).toBe('');
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.issues.map((i: any) => [i.code, i.file, i.pointer ?? i.xpath])).toEqual([...pathTodo('basics'), INTRO, ...lessonTodo('literals')]);
    for (const i of out.issues) {
      expect(i.severity).toBe('error');
      expect(i.fix.length).toBeGreaterThan(10);
    }
    expect(JSON.parse(readFileSync(join(dir, 'cxm/course.json'), 'utf8')).custody).toBe('server-kept');
  });

  it('a second lesson in the same path goes into the same block', async () => {
    const dir = join(tmp, 'two');
    await cxm('init', dir, '--id', COURSE.id, '--title', COURSE.title, '--custody', 'author-lrs');
    await cxm('add-lesson', dir, '--path', 'basics', '--key', 'one', '--title', 'One');
    expect((await cxm('add-lesson', dir, '--path', 'basics', '--key', 'two', '--title', 'Two')).code).toBe(0);
    const xml = readFileSync(join(dir, 'cmi5.xml'), 'utf8');
    expect(xml.match(/<block /g)).toHaveLength(1);
    expect(xml.indexOf('cxm:key="two"')).toBeLessThan(xml.indexOf('<cxm:path'));
    const r = JSON.parse((await cxm('validate', dir, '--json')).stdout);
    expect(r.issues.map((i: any) => [i.code, i.file, i.pointer ?? i.xpath])).toEqual([...pathTodo('basics'), INTRO, ...lessonTodo('one'), ...lessonTodo('two')]);
  });

  it('init refuses a folder that is not empty, and a custody that does not exist', async () => {
    const dir = join(tmp, 'full');
    mkdirSync(dir);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const r = await cxm('init', dir, '--id', COURSE.id, '--title', COURSE.title);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('not empty');
    expect((await cxm('init', join(tmp, 'c2'), '--id', COURSE.id, '--title', 'x', '--custody', 'nope')).code).toBe(2);
  });

  it('add-lesson refuses a key already in use', async () => {
    const dir = join(tmp, 'dup');
    await cxm('init', dir, '--id', COURSE.id, '--title', COURSE.title);
    const r = await cxm('add-lesson', dir, '--path', 'basics', '--key', 'placement', '--title', 'Again');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"placement" is already used');
  });
});

describe('scaffoldCourse and scaffoldLesson', () => {
  it('the course alone asks only for the placement intro', async () => {
    const r = await validatePackage(bytes(scaffoldCourse(COURSE)));
    expect(r.issues.map((i) => [i.code, i.file, i.pointer])).toEqual([INTRO]);
  });

  it('a filled-in scaffold is a valid package', async () => {
    let f = scaffoldLesson(scaffoldCourse(COURSE), { pathKey: 'basics', key: 'literals', title: 'Literal characters' });
    const course = JSON.parse(f['cxm/course.json']!);
    course.placement.intro = 'Ask whether the learner has written a regex before.';
    course.paths.basics = { tagline: 'Match text exactly.', placementHints: 'Everyone starts at literals.' };
    const lesson = JSON.parse(f['cxm/lessons/literals.json']!);
    lesson.minutes = 5;
    lesson.sources = [{ title: 'MDN: Regular expressions', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions' }];
    lesson.beats[0] = { key: 'first-idea', goal: 'The learner matches a fixed word.', content: 'Most characters in a pattern match themselves.' };
    f = { ...f, 'cxm/course.json': JSON.stringify(course), 'cxm/lessons/literals.json': JSON.stringify(lesson) };
    expect(await validatePackage(bytes(f))).toEqual({ valid: true, issues: [] });
    const loaded = loadPackage(bytes(f));
    expect(loaded.ok && loaded.course.lessons.literals!.url).toBe('http://127.0.0.1:8787/cmi5/launch?au=literals');
  });

  it('escapes XML in titles', async () => {
    const f = scaffoldLesson(scaffoldCourse({ ...COURSE, title: 'A < B & "C"' }), { pathKey: 'p', key: 'l', title: '<x>' });
    expect(f['cmi5.xml']).toContain('A &lt; B &amp; &quot;C&quot;');
    expect(f['cmi5.xml']).toContain('&lt;x&gt;');
    expect((await validatePackage(bytes(f))).issues.every((i) => i.code === 'CXM-PKG-006' || i.code === 'CXM-PKG-007')).toBe(true);
  });

  it('throws on a bad key, a taken key and a missing course', () => {
    const c = scaffoldCourse(COURSE);
    expect(() => scaffoldLesson(c, { pathKey: 'Basics', key: 'x', title: 'X' })).toThrow(/path key "Basics"/);
    const one = scaffoldLesson(c, { pathKey: 'basics', key: 'x', title: 'X' });
    expect(() => scaffoldLesson(one, { pathKey: 'other', key: 'x', title: 'X' })).toThrow(/already used/);
    expect(() => scaffoldLesson(one, { pathKey: 'x', key: 'y', title: 'Y' })).toThrow(/already used by an AU/);
    expect(() => scaffoldLesson({}, { pathKey: 'basics', key: 'x', title: 'X' })).toThrow(/scaffold the course first/);
  });
});
