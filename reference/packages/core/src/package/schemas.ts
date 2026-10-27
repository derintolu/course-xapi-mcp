// SPDX-License-Identifier: Apache-2.0
// zod schemas and JSON Schema output for the two JSON files of a course package.
// Titles, descriptions, ids and lesson order live in cmi5.xml, not here.
// Cross-reference rules (duplicates, file names, targets) are reported by the validator, not by refinements.
import { z } from 'zod';
import { SITE } from '../constants.ts';

const text = z.string().trim().min(1);
const key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'keys are 1-64 chars of a-z, 0-9 and -, starting with a letter or digit');
// Relative POSIX paths such as "templates/index.html": no leading "/", no empty, "." or ".." segment,
// no backslash, and no segment that starts with a space.
const fileName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\s/\\][^/\\]*(\/[^\s/\\][^/\\]*)*$/, 'file names are relative paths with no empty segments, backslashes or leading spaces')
  .refine((f) => f.split('/').every((seg) => seg !== '.' && seg !== '..'), 'file names may not contain "." or ".." segments');

const secret = { 'x-cxm-secret': true } as const;

export const CheckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['contains', 'notContains']), file: fileName, value: z.string(), message: text }).strict(),
  z.object({ type: z.literal('regex'), file: fileName, pattern: text, flags: z.string().regex(/^[imsu]*$/).optional(), message: text }).strict(),
  z.object({ type: z.literal('json'), file: fileName, pointer: z.string(), equals: z.unknown(), message: text }).strict(),
]);

const SourceSchema = z.object({ title: text, url: z.url() }).strict();

const BeatSchema = z.object({ key, goal: text, content: text, question: text.optional() }).strict();

const BranchSchema = z.object({ key, when: text, success: z.boolean(), to: key.nullable(), message: text }).strict();

const CheckpointSchema = z
  .object({
    key,
    kind: z.enum(['free-text', 'code']),
    question: text,
    rubric: text,
    file: fileName.optional(),
    checks: z.array(CheckSchema).optional(),
    branches: z.array(BranchSchema).min(1),
    maxAttempts: z.number().int().positive().optional(),
  })
  .strict();

const PlantedBugSchema = z
  .object({
    key,
    file: fileName,
    code: text,
    hint: text.optional(),
    revealAfter: z.number().int().positive().nullable().optional(),
    explanation: text.meta(secret),
    fixChecks: z.array(CheckSchema).min(1).meta(secret),
  })
  .strict();

const ReferenceSolutionSchema = z
  .object({ files: z.record(fileName, z.string()), bugFix: z.string().optional() })
  .strict()
  .meta(secret);

/** Extension keys are IRIs or reversed domain names such as `com.example/thing`. */
const extensionKey = z.string().regex(/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+|[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S+)$/, 'extension keys are IRIs or reversed-domain names');
const ExtensionsSchema = z.record(extensionKey, z.unknown());

export const LessonJsonSchema = z
  .object({
    minutes: z.number().int().positive(),
    sources: z.array(SourceSchema).optional(),
    starterFiles: z.record(fileName, z.string()).optional(),
    beats: z.array(BeatSchema).min(1),
    bug: PlantedBugSchema.optional(),
    checkpoint: CheckpointSchema.optional(),
    referenceSolution: ReferenceSolutionSchema.optional(),
    extensions: ExtensionsSchema.optional(),
  })
  .strict();

const BadgeAlignmentSchema = z
  .object({
    targetName: text,
    targetUrl: z.url(),
    targetDescription: text.optional(),
    targetFramework: text.optional(),
    targetCode: text.optional(),
    targetType: text.optional(),
  })
  .strict();

const BadgeDeclSchema = z
  .object({
    id: z.url(),
    name: text,
    description: text,
    criteria: z.object({ narrative: text }).strict(),
    image: z.url().optional(),
    achievementType: text,
    alignment: z.array(BadgeAlignmentSchema).optional(),
    awardOn: z.enum(['au-moveon', 'block-satisfied', 'course-satisfied', 'any-path']),
    for: key.optional(),
    countWaived: z.boolean().default(false),
    includeScore: z.boolean().default(false),
  })
  .strict();

const BadgeIssuerSchema = z
  .object({ signer: z.enum(['record-holder', 'course-server']), claimPage: z.url(), name: text.optional() })
  .strict();

const PathEntrySchema = z.union([
  z.object({ tagline: text, placementHints: text.optional() }).strict(),
  z.object({ status: z.literal('coming-soon'), title: text, tagline: text }).strict(),
]);

export const CourseJsonSchema = z
  .object({
    specVersion: text,
    flavour: z.enum(['authoring', 'distribution']),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'version must be semver'),
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'language must be an RFC 5646 tag such as "en"'),
    license: text.optional(),
    rules: z.array(text).max(20).optional(),
    placement: z.object({ intro: text, maxQuestions: z.number().int().min(1).max(10) }).strict(),
    custody: z.enum(['lms-launched', 'author-lrs', 'server-kept', 'practice']),
    allowPractice: z.boolean().default(false),
    paths: z.record(key, PathEntrySchema),
    badges: z.array(BadgeDeclSchema).optional(),
    badgeIssuer: BadgeIssuerSchema.optional(),
    extensions: ExtensionsSchema.optional(),
  })
  .strict();

export type CourseJson = z.infer<typeof CourseJsonSchema>;
export type LessonJson = z.infer<typeof LessonJsonSchema>;

export const COURSE_SCHEMA_ID = SITE + '/schema/draft/course.schema.json';
export const LESSON_SCHEMA_ID = SITE + '/schema/draft/lesson.schema.json';

function jsonSchema(schema: z.ZodType, id: string, title: string): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
  const { $schema, ...rest } = out;
  return { $schema, $id: id, title, ...rest };
}

export function courseJsonSchema(): Record<string, unknown> {
  return jsonSchema(CourseJsonSchema, COURSE_SCHEMA_ID, 'course-xapi-mcp course.json');
}

export function lessonJsonSchema(): Record<string, unknown> {
  return jsonSchema(LessonJsonSchema, LESSON_SCHEMA_ID, 'course-xapi-mcp lesson JSON');
}
