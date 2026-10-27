// SPDX-License-Identifier: Apache-2.0
// Builds the learning-mcp xAPI Profile (JSON-LD) from the same constants the statement builder uses,
// so the published profile and the emitted statements cannot drift apart.
// Written to profile/xapi-profile.jsonld by scripts/build-profile.mjs.
import { ACTIVITY_TYPES, ACTOR_HOMEPAGE, EXT, PROFILE_ID, PROFILE_VERSION, VERBS, VERB_OBJECTS, type ActivityKind, type VerbKey } from './xapi.ts';

const en = (s: string) => ({ en: s });
const T = (name: string) => `${PROFILE_VERSION}/templates/${name}`;
const P = (name: string) => `${PROFILE_VERSION}/patterns/${name}`;

const VERB_TEXT: Partial<Record<VerbKey, [string, string]>> = {
  placed: ['placed', 'The learner was placed into a learning path at a start lesson, by an agent choosing among authored options that the course server validated.'],
  branched: ['branched', 'After a checkpoint, the learner was sent along one authored branch. The agent chose the branch against the rubric; the course server validated it. The result extensions name the branch, its target and the agent rationale.'],
  caught: ['caught', 'The learner found and fixed a bug that the course author planted in AI-written code, as shown by the authored fix checks passing.'],
};

const TYPE_TEXT: Partial<Record<ActivityKind, [string, string]>> = {
  path: ['learning path', 'An ordered sequence of lessons within a course.'],
  beat: ['teaching beat', 'One authored teaching step inside a lesson: a goal, the key content, and optionally a question for the learner. The agent delivers it in its own words.'],
  checkpoint: ['checkpoint', 'A question inside a lesson whose answer decides which authored branch the learner takes. Free-text answers are judged by the agent against an authored rubric; code answers are decided by deterministic checks.'],
  file: ['learner file', 'A text file the learner edits by hand and submits for deterministic checks.'],
  'planted-bug': ['planted bug', 'A deliberate mistake the course author planted in AI-written code. The course server never reveals it to the agent before it is fixed.'],
};

const EXT_TEXT: Record<keyof typeof EXT, [string, 'ResultExtension' | 'ContextExtension', string, object]> = {
  branch: ['branch', 'ResultExtension', 'The authored id of the branch taken.', { type: 'string' }],
  to: ['branch target', 'ResultExtension', 'The activity IRI of the lesson the branch leads to, or null when the branch ends the path.', { type: ['string', 'null'] }],
  rationale: ['judge rationale', 'ResultExtension', 'The agent\'s one-sentence reason for choosing the branch (agent-written, at most 300 characters).', { type: 'string', maxLength: 300 }],
  checks: ['check results', 'ResultExtension', 'Per-check results of the authored deterministic checks, by check index. Empty for planted-bug fixes, so the record does not point at the bug.', { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, passed: { type: 'boolean' } }, required: ['index', 'passed'] } }],
  startLesson: ['start lesson', 'ResultExtension', 'The activity IRI of the lesson the learner starts at after placement.', { type: 'string' }],
  skipped: ['skipped lessons', 'ResultExtension', 'Activity IRIs of lessons the placement skipped.', { type: 'array', items: { type: 'string' } }],
  rulesVersion: ['rules version', 'ContextExtension', 'The version of the learning-mcp agent rules the course server sent with this step, for example "v0.1".', { type: 'string' }],
};

const common = [
  { location: '$.actor.account.homePage', all: [ACTOR_HOMEPAGE] },
  { location: '$.context.contextActivities.category[*].id', any: [PROFILE_VERSION] },
  { location: '$.context.registration', presence: 'included' },
  { location: `$.context.extensions['${EXT.rulesVersion}']`, presence: 'included' },
  { location: '$.version', presence: 'excluded' },
  { location: '$.actor.mbox', presence: 'excluded' },
  { location: '$.actor.name', presence: 'excluded' },
];

interface TemplateSpec { name: string; verb: VerbKey; object: ActivityKind; label: string; text: string; rules?: object[] }

const TEMPLATES: TemplateSpec[] = [
  { name: 'placed', verb: 'placed', object: 'path', label: 'placed into a path', text: 'Emitted by choose_placement.', rules: [{ location: `$.result.extensions['${EXT.startLesson}']`, presence: 'included' }, { location: '$.result.response', presence: 'recommended', scopeNote: en('The agent-written placement reason.') }] },
  { name: 'beat-experienced', verb: 'experienced', object: 'beat', label: 'experienced a beat', text: 'Emitted when next_beat serves a beat.' },
  { name: 'beat-answered', verb: 'answered', object: 'beat', label: 'answered a beat question', text: 'Emitted when next_beat carries the learner reply to the previous beat question.', rules: [{ location: '$.result.response', presence: 'included', scopeNote: en('The learner\'s own words.') }] },
  { name: 'checkpoint-answered', verb: 'answered', object: 'checkpoint', label: 'answered a checkpoint', text: 'Emitted by submit_checkpoint.', rules: [{ location: '$.result.response', presence: 'included', scopeNote: en('The learner\'s own words.') }] },
  { name: 'checkpoint-passed', verb: 'passed', object: 'checkpoint', label: 'passed a checkpoint', text: 'Emitted by choose_branch when the branch has success: true.', rules: [{ location: '$.result.success', all: [true] }] },
  { name: 'checkpoint-failed', verb: 'failed', object: 'checkpoint', label: 'did not pass a checkpoint', text: 'Emitted by choose_branch when the branch has success: false.', rules: [{ location: '$.result.success', all: [false] }] },
  { name: 'branched', verb: 'branched', object: 'checkpoint', label: 'branched at a checkpoint', text: 'Emitted by choose_branch after the server validated the branch.', rules: [{ location: `$.result.extensions['${EXT.branch}']`, presence: 'included' }, { location: `$.result.extensions['${EXT.rationale}']`, presence: 'included' }] },
  { name: 'file-passed', verb: 'passed', object: 'file', label: 'file passed checks', text: 'Emitted by check_code or submit_checkpoint when every authored check passes.', rules: [{ location: '$.result.success', all: [true] }] },
  { name: 'file-failed', verb: 'failed', object: 'file', label: 'file failed checks', text: 'Emitted by check_code or submit_checkpoint when any authored check fails.', rules: [{ location: '$.result.success', all: [false] }] },
  { name: 'bug-caught', verb: 'caught', object: 'planted-bug', label: 'caught a planted bug', text: 'Emitted by check_code when the authored fix checks pass.', rules: [{ location: '$.result.success', all: [true] }] },
  { name: 'lesson-completed', verb: 'completed', object: 'lesson', label: 'completed a lesson', text: 'Emitted when a lesson finishes: a success branch, or the end of a lesson with no checkpoint.', rules: [{ location: '$.result.completion', all: [true] }] },
  { name: 'path-completed', verb: 'completed', object: 'path', label: 'completed a path', text: 'Emitted when a branch with target null ends the path, or the last lesson completes.', rules: [{ location: '$.result.completion', all: [true] }] },
];

export function buildProfile() {
  const concepts: object[] = [];
  for (const k of Object.keys(VERB_TEXT) as VerbKey[]) {
    const [label, def] = VERB_TEXT[k]!;
    concepts.push({ id: VERBS[k].id, type: 'Verb', inScheme: PROFILE_VERSION, prefLabel: en(label), definition: en(def) });
  }
  for (const k of Object.keys(TYPE_TEXT) as ActivityKind[]) {
    const [label, def] = TYPE_TEXT[k]!;
    concepts.push({ id: ACTIVITY_TYPES[k], type: 'ActivityType', inScheme: PROFILE_VERSION, prefLabel: en(label), definition: en(def) });
  }
  for (const k of Object.keys(EXT_TEXT) as (keyof typeof EXT)[]) {
    const [label, type, def, schema] = EXT_TEXT[k];
    concepts.push({ id: EXT[k], type, inScheme: PROFILE_VERSION, prefLabel: en(label), definition: en(def), inlineSchema: JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', ...schema }) });
  }

  for (const t of TEMPLATES) {
    if (!VERB_OBJECTS[t.verb].includes(t.object)) throw new Error(`template ${t.name} disagrees with VERB_OBJECTS`);
  }
  const templates = TEMPLATES.map((t) => ({
    id: T(t.name),
    type: 'StatementTemplate',
    inScheme: PROFILE_VERSION,
    prefLabel: en(t.label),
    definition: en(t.text),
    verb: VERBS[t.verb].id,
    objectActivityType: ACTIVITY_TYPES[t.object],
    contextGroupingActivityType: [ACTIVITY_TYPES.course],
    rules: [...common, ...(t.rules ?? [])],
  }));

  const pattern = (name: string, label: string | null, body: object, primary = false) => ({
    id: P(name),
    type: 'Pattern',
    ...(primary ? { primary: true } : {}),
    ...(label ? { inScheme: PROFILE_VERSION, prefLabel: en(label), definition: en(label) } : {}),
    ...body,
  });
  const patterns = [
    pattern('beat', null, { sequence: [T('beat-experienced'), P('optional-beat-answer')] }),
    pattern('optional-beat-answer', null, { optional: T('beat-answered') }),
    pattern('file-result', null, { alternates: [T('file-passed'), T('file-failed')] }),
    pattern('bug-attempts', null, { sequence: [P('file-results'), T('file-passed'), T('bug-caught')] }),
    pattern('file-results', null, { zeroOrMore: P('file-result') }),
    pattern('checkpoint-outcome', null, { alternates: [T('checkpoint-passed'), T('checkpoint-failed')] }),
    pattern('checkpoint', null, { sequence: [P('file-results'), T('checkpoint-answered'), P('file-results'), P('checkpoint-outcome'), T('branched')] }),
    pattern('optional-bug', null, { optional: P('bug-attempts') }),
    pattern('optional-checkpoint', null, { optional: P('checkpoint') }),
    pattern('optional-lesson-completed', null, { optional: T('lesson-completed') }),
    pattern('beats', null, { oneOrMore: P('beat') }),
    pattern('lesson', 'One pass through a lesson: beats, then an optional planted bug, then an optional checkpoint, then completion when it was passed.', {
      sequence: [P('beats'), P('optional-bug'), P('optional-checkpoint'), P('optional-lesson-completed')],
    }),
    pattern('lessons', null, { zeroOrMore: P('lesson') }),
    pattern('optional-placed', null, { optional: T('placed') }),
    pattern('optional-path-completed', null, { optional: T('path-completed') }),
    pattern('course-registration', 'Everything one learner does in one course registration: an optional placement, any number of lesson passes, and path completion.', {
      sequence: [P('optional-placed'), P('lessons'), P('optional-path-completed')],
    }, true),
  ];

  return {
    '@context': 'https://w3id.org/xapi/profiles/context',
    id: PROFILE_ID,
    type: 'Profile',
    conformsTo: 'https://w3id.org/xapi/profiles#1.0',
    prefLabel: en('learning-mcp'),
    definition: en('Statements for learning that runs inside an AI agent through a Model Context Protocol course server: authored beats, server-validated branching, deterministic checks and planted-bug catches, about an anonymous learner who owns the record. Draft; unofficial.'),
    seeAlso: 'https://github.com/derintolu/learning-mcp',
    versions: [{ id: PROFILE_VERSION, generatedAtTime: '2026-10-19T00:00:00Z' }],
    author: { type: 'Person', name: 'Derin Tolu (draft by Claude)', url: 'https://github.com/derintolu' },
    concepts,
    templates,
    patterns,
  };
}
