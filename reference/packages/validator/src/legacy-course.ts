// SPDX-License-Identifier: Apache-2.0
// The legacy single-file course.json format, read only by the converter (convert.ts).
// Generalised from learn-wp-reimagined/src/shared/schema.ts (Derin Tolu, GPL-2.0-or-later):
// branches are authored by id instead of a fixed advance/review/skip enum, and nothing is WordPress-specific.
import { z } from 'zod';

const text = z.string().trim().min(1);
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'ids are 1-64 chars of a-z, 0-9 and -, starting with a letter or digit');
// Relative POSIX paths such as "templates/index.html": no leading "/", no empty, "." or ".." segment,
// no backslash, and no segment that starts with a space.
const fileName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\s/\\][^/\\]*(\/[^\s/\\][^/\\]*)*$/, 'file names are relative paths with no empty segments, backslashes or leading spaces')
  .refine((f) => f.split('/').every((seg) => seg !== '.' && seg !== '..'), 'file names may not contain "." or ".." segments');

export const CheckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['contains', 'notContains']), file: fileName, value: z.string(), message: text }).strict(),
  z.object({ type: z.literal('regex'), file: fileName, pattern: text, flags: z.string().regex(/^[imsu]*$/).optional(), message: text }).strict(),
  z.object({ type: z.literal('json'), file: fileName, pointer: z.string(), equals: z.unknown(), message: text }).strict(),
]);

export const SourceSchema = z.object({ title: text, url: z.url() }).strict();

export const BeatSchema = z.object({ id, goal: text, content: text, question: text.optional() }).strict();

export const BranchSchema = z
  .object({ id, when: text, success: z.boolean(), to: id.nullable(), message: text })
  .strict();

export const CheckpointSchema = z
  .object({
    id,
    kind: z.enum(['free-text', 'code']),
    question: text,
    rubric: text,
    file: fileName.optional(),
    checks: z.array(CheckSchema).optional(),
    branches: z.array(BranchSchema).min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    const ids = c.branches.map((b) => b.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['branches'], message: 'branch ids must be unique' });
    if (!c.branches.some((b) => b.success)) ctx.addIssue({ code: 'custom', path: ['branches'], message: 'needs at least one branch with success: true' });
    if (c.kind === 'code') {
      if (!c.file) ctx.addIssue({ code: 'custom', path: ['file'], message: 'code checkpoint requires file' });
      if (!c.checks?.length) ctx.addIssue({ code: 'custom', path: ['checks'], message: 'code checkpoint requires checks' });
      if (!c.branches.some((b) => !b.success)) {
        ctx.addIssue({ code: 'custom', path: ['branches'], message: 'code checkpoint needs a branch with success: false for failed checks' });
      }
    }
  });

export const PlantedBugSchema = z
  .object({ id, file: fileName, code: text, explanation: text, hint: text.optional(), fixChecks: z.array(CheckSchema).min(1) })
  .strict();

export const LessonSchema = z
  .object({
    id,
    pathId: id,
    title: text,
    minutes: z.number().int().positive(),
    sources: z.array(SourceSchema).min(1),
    beats: z.array(BeatSchema).min(1),
    starterFiles: z.record(fileName, z.string()).optional(),
    bug: PlantedBugSchema.optional(),
    checkpoint: CheckpointSchema.optional(),
  })
  .strict()
  .superRefine((l, ctx) => {
    const ids = l.beats.map((b) => b.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['beats'], message: 'beat ids must be unique' });
  });

export const PathSchema = z
  .object({
    id,
    title: text,
    tagline: text,
    status: z.enum(['live', 'coming-soon']),
    lessons: z.array(id),
    placementHints: text,
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.status === 'live' && p.lessons.length === 0) ctx.addIssue({ code: 'custom', path: ['lessons'], message: 'a live path needs at least one lesson' });
  });

export const CourseSchema = z
  .object({
    id,
    title: text,
    description: text,
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'version must be semver'),
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'language must be an RFC 5646 tag such as "en"'),
    activityBase: z.url({ protocol: /^https$/ }).refine((u) => !u.endsWith('/') && !/[?#]/.test(u), 'activityBase must not end with / or contain ? or #'),
    license: text.optional(),
    rules: z.array(text).max(20).optional(),
    placement: z.object({ intro: text, maxQuestions: z.number().int().min(1).max(10) }).strict(),
    paths: z.record(id, PathSchema),
    lessons: z.record(id, LessonSchema),
  })
  .strict()
  .superRefine((c, ctx) => {
    const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
    for (const [key, p] of Object.entries(c.paths)) {
      if (p.id !== key) ctx.addIssue({ code: 'custom', path: ['paths', key], message: `path id "${p.id}" does not match key` });
      for (const lid of p.lessons) {
        if (!has(c.lessons, lid)) ctx.addIssue({ code: 'custom', path: ['paths', key, 'lessons'], message: `unknown lesson "${lid}"` });
        else if (c.lessons[lid].pathId !== key) {
          ctx.addIssue({ code: 'custom', path: ['paths', key, 'lessons'], message: `lesson "${lid}" belongs to path "${c.lessons[lid].pathId}"` });
        }
      }
    }
    if (!Object.values(c.paths).some((p) => p.status === 'live')) ctx.addIssue({ code: 'custom', path: ['paths'], message: 'needs at least one live path' });
    for (const [key, l] of Object.entries(c.lessons)) {
      if (l.id !== key) ctx.addIssue({ code: 'custom', path: ['lessons', key], message: `lesson id "${l.id}" does not match key` });
      if (!has(c.paths, l.pathId)) ctx.addIssue({ code: 'custom', path: ['lessons', key, 'pathId'], message: `unknown path "${l.pathId}"` });
      for (const b of l.checkpoint?.branches ?? []) {
        if (b.to !== null && !has(c.lessons, b.to)) {
          ctx.addIssue({ code: 'custom', path: ['lessons', key, 'checkpoint', 'branches'], message: `branch "${b.id}" targets unknown lesson "${b.to}"` });
        }
      }
    }
  });

export type Course = z.infer<typeof CourseSchema>;
export type Path = Course['paths'][string];
export type Lesson = Course['lessons'][string];
export type Beat = Lesson['beats'][number];
export type Checkpoint = NonNullable<Lesson['checkpoint']>;
export type Branch = Checkpoint['branches'][number];
export type PlantedBug = NonNullable<Lesson['bug']>;
export type Check = z.infer<typeof CheckSchema>;

export function parseCourse(raw: unknown): { ok: true; course: Course } | { ok: false; errors: string[] } {
  const r = CourseSchema.safeParse(raw);
  if (r.success) return { ok: true, course: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
