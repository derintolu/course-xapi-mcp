// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CourseJsonSchema, LessonJsonSchema, courseJsonSchema, lessonJsonSchema } from '../src/package/index.ts';
import type { LessonJson } from '../src/package/index.ts';
import type { PlantedBug } from '../src/model.ts';

const root = new URL('../../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const readJson = (p: string) => JSON.parse(read(p));

const minCourse = {
  specVersion: '0.2',
  flavour: 'authoring',
  version: '1.0.0',
  language: 'en',
  placement: { intro: 'Tell me what you know.', maxQuestions: 3 },
  custody: 'server-kept',
  paths: { json: { tagline: 'Learn JSON' }, later: { status: 'coming-soon', title: 'Later', tagline: 'Soon' } },
};
const minLesson = { minutes: 10, beats: [{ key: 'one', goal: 'g', content: 'c' }] };

describe('package schemas', () => {
  it('accepts the minimal course and lesson objects', () => {
    const c = CourseJsonSchema.safeParse(minCourse);
    expect(c.success).toBe(true);
    if (c.success) expect(c.data.allowPractice).toBe(false);
    expect(LessonJsonSchema.safeParse(minLesson).success).toBe(true);
  });

  it('rejects unknown keys outside extensions', () => {
    expect(CourseJsonSchema.safeParse({ ...minCourse, extra: 1 }).success).toBe(false);
    expect(LessonJsonSchema.safeParse({ ...minLesson, extra: 1 }).success).toBe(false);
    expect(CourseJsonSchema.safeParse({ ...minCourse, extensions: { 'com.example/x': { any: 1 } } }).success).toBe(true);
    expect(LessonJsonSchema.safeParse({ ...minLesson, extensions: { 'https://example.com/x': 1 } }).success).toBe(true);
    expect(LessonJsonSchema.safeParse({ ...minLesson, extensions: { nodomain: 1 } }).success).toBe(false);
  });

  it('rejects titles, ids and lesson order in JSON', () => {
    expect(LessonJsonSchema.safeParse({ ...minLesson, title: 'x' }).success).toBe(false);
    expect(CourseJsonSchema.safeParse({ ...minCourse, paths: { json: { tagline: 't', title: 'x' } } }).success).toBe(false);
  });

  it('bounds rules and placement', () => {
    expect(CourseJsonSchema.safeParse({ ...minCourse, rules: Array(21).fill('r') }).success).toBe(false);
    expect(CourseJsonSchema.safeParse({ ...minCourse, placement: { intro: 'i', maxQuestions: 11 } }).success).toBe(false);
  });

  it('marks secret fields in the JSON Schema', () => {
    const s = JSON.stringify(lessonJsonSchema());
    expect(s).toMatch(/"explanation":\{[^}]*"x-cxm-secret":true/);
    const props = (lessonJsonSchema() as any).properties;
    expect(props.bug.properties.fixChecks['x-cxm-secret']).toBe(true);
    expect(props.referenceSolution['x-cxm-secret']).toBe(true);
    expect(props.bug.properties.code['x-cxm-secret']).toBeUndefined();
  });

  it('carries the permanent $id values', () => {
    expect(courseJsonSchema().$id).toBe('https://course-xapi-mcp.sqwrlz.com/schema/draft/course.schema.json');
    expect(lessonJsonSchema().$id).toBe('https://course-xapi-mcp.sqwrlz.com/schema/draft/lesson.schema.json');
    expect(courseJsonSchema().$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('matches schema/draft/*.json (run npm run schemas after changes)', () => {
    expect(readJson('schema/draft/course.schema.json')).toEqual(courseJsonSchema());
    expect(readJson('schema/draft/lesson.schema.json')).toEqual(lessonJsonSchema());
  });

  it('z.infer of the schemas is assignable to the model fragments', () => {
    const bug = {} as NonNullable<LessonJson['bug']>;
    const _: PlantedBug = bug;
    void _;
    expect(true).toBe(true);
  });

  it('cxm.xsd is well formed and targets the cxm namespace', () => {
    const xsd = read('schema/draft/cxm.xsd');
    expect(xsd).toContain('targetNamespace="https://course-xapi-mcp.sqwrlz.com/course/v1"');
    for (const n of ['course', 'lesson', 'path', 'key', 'role', 'specVersion', 'mcp', 'src', 'placement']) expect(xsd).toContain(`"${n}"`);
  });

  it('vendors the cmi5 CourseStructure.xsd unchanged', () => {
    expect(read('schema/vendor/cmi5/CourseStructure.xsd')).toBe(read('docs/research/cmi5/CourseStructure.xsd'));
  });
});
