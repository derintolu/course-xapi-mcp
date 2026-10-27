// SPDX-License-Identifier: Apache-2.0
// Input and output schemas and annotations of the 16 tools, per endpoint kind. `npm run schemas` writes them to
// schema/draft/tools/ (official endpoint) and schema/draft/tools/practice/ (practice endpoint).
import * as z from 'zod/v4';
import { LIMITS, TOOL_NAMES, type ToolName } from '@course-xapi-mcp/core';

/** `official`: custody options 1 to 3, identity from the bearer token. `practice`: option 4, identity from the handle. */
export type EndpointKind = 'official' | 'practice';

/** Longest practice copy `resume_practice` reads, in characters. */
export const RECORD_MAX = 4_000_000;

const key = z.string().max(64);
const handle = z.string().max(64).describe('The practice handle returned by start_placement or resume_practice. It is a secret: give it to the learner once and put it nowhere else.');
const learnerText = (what: string) => z.string().max(LIMITS.text).describe(`${what}, word for word.`);
const fileName = z.string().max(128);

/** Tool-specific arguments, before the practice handle is added. */
const ARGS: Record<ToolName, (kind: EndpointKind) => z.ZodRawShape> = {
  get_status: () => ({}),
  list_paths: () => ({}),
  start_placement: () => ({}),
  choose_placement: () => ({
    pathKey: key.describe('An authored path key from start_placement.'),
    startLessonKey: key.describe('A lesson key in that path.'),
    skip: z.array(key).max(100).describe('Lessons before the start lesson that the learner skips.'),
    reason: z.string().max(LIMITS.rationale).describe('One sentence on why this placement fits.'),
  }),
  get_lesson: () => ({ lessonKey: key.describe('A lesson key from list_paths.') }),
  next_beat: () => ({ learner_reply: learnerText("The learner's reply to the last beat's question").optional() }),
  check_code: () => ({ file: fileName.describe('The file name the step names.'), content: z.string().max(LIMITS.file).describe('The whole file, as the learner edited it by hand.') }),
  reveal_bug: () => ({}),
  submit_checkpoint: () => ({
    response: learnerText("The learner's checkpoint answer"),
    files: z
      .record(fileName, z.string().max(LIMITS.file))
      .refine((f) => Object.keys(f).length <= LIMITS.files, { message: `send at most ${LIMITS.files} files` })
      .meta({ maxProperties: LIMITS.files })
      .optional()
      .describe(`For a code checkpoint: file name to the whole file, at most ${LIMITS.files} files.`),
  }),
  choose_branch: () => ({ branch: key.describe('One allowed branch key from submit_checkpoint.'), rationale: z.string().max(LIMITS.rationale).describe('One sentence: why this branch fits the rubric.') }),
  end_session: () => ({}),
  get_record: () => ({}),
  get_badges: () => ({}),
  restart_course: () => ({}),
  resume_practice: (kind): z.ZodRawShape => (kind === 'practice' ? { record: z.string().max(RECORD_MAX).describe('An exported practice copy, as JSON text.') } : {}),
  delete_practice_record: () => ({}),
};

/** Which tools take the practice handle on the practice endpoint, and whether it is required. */
const HANDLE: Partial<Record<ToolName, 'optional' | 'required'>> = {
  get_status: 'optional',
  start_placement: 'optional',
  choose_placement: 'required',
  next_beat: 'required',
  check_code: 'required',
  reveal_bug: 'required',
  submit_checkpoint: 'required',
  choose_branch: 'required',
  end_session: 'required',
  get_record: 'required',
  restart_course: 'required',
  delete_practice_record: 'required',
};

export const READ_ONLY_TOOLS: readonly ToolName[] = ['get_status', 'list_paths', 'get_lesson', 'get_record', 'get_badges'];

export function toolInput(name: ToolName, kind: EndpointKind): z.ZodObject {
  const shape = { ...ARGS[name](kind) };
  const h = kind === 'practice' ? HANDLE[name] : undefined;
  if (h) shape.handle = h === 'required' ? handle : handle.optional();
  return z.object(shape).strict();
}

export function toolInputJsonSchema(name: ToolName, kind: EndpointKind): Record<string, unknown> {
  return z.toJSONSchema(toolInput(name, kind), { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
}

export function toolAnnotations(name: ToolName) {
  const readOnly = READ_ONLY_TOOLS.includes(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: name === 'delete_practice_record',
    idempotentHint: readOnly || name === 'delete_practice_record',
    openWorldHint: false,
  };
}

const RULES = {
  type: 'object',
  properties: {
    version: { type: 'string' },
    digest: { type: 'array', items: { type: 'string' } },
    course: { type: 'array', items: { type: 'string' } },
    full: { type: 'string' },
  },
  required: ['version', 'digest', 'course', 'full'],
  additionalProperties: false,
};

const CXM = {
  type: 'object',
  properties: {
    custody: { enum: ['lms-launched', 'author-lrs', 'server-kept', 'practice'] },
    official: { type: 'boolean' },
    label: { type: 'string' },
    lesson: { type: 'string' },
    step: { type: 'string' },
  },
  required: ['custody', 'official'],
  additionalProperties: false,
};

const NEXT = {
  type: 'object',
  properties: { type: { enum: ['continue', 'return-to-lms', 'done'] }, lessonKey: { type: 'string' }, returnURL: { type: 'string' } },
  required: ['type'],
  additionalProperties: false,
};

/** Fields some tools add on success. Every one is optional, so an error result (ok false) matches too. */
const TOOL_FIELDS: Partial<Record<ToolName, Record<string, unknown>>> = {
  get_status: {
    holder: { type: 'string' },
    links: { type: 'object', additionalProperties: { type: 'string' } },
    position: { type: 'object', additionalProperties: true },
    next_tools: { type: 'array', items: { type: 'string' } },
    practiceUrl: { type: 'string' },
  },
  start_placement: { handle: { type: 'string' } },
  resume_practice: { handle: { type: 'string' } },
  get_record: { record: { type: 'object', additionalProperties: true }, note: { type: 'string' } },
  get_badges: { badges: { type: 'array', items: { type: 'object', additionalProperties: true } }, claimPage: { type: ['string', 'null'] } },
  delete_practice_record: { deleted: { type: 'boolean' } },
};

/**
 * Output schema as plain JSON Schema: every result has ok, rules and cxm; errors add error; tool fields are open.
 * Written by hand so free-form fields are spelled `additionalProperties: true`.
 */
export function toolOutputJsonSchema(name: ToolName): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      error: { type: 'string' },
      next: NEXT,
      returnURL: { type: 'string' },
      delivery: { enum: ['delivered', 'pending'] },
      ...TOOL_FIELDS[name],
      rules: RULES,
      cxm: CXM,
    },
    required: ['ok', 'rules', 'cxm'],
    additionalProperties: true,
  };
}

export { TOOL_NAMES };
