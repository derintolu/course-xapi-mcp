// SPDX-License-Identifier: Apache-2.0
// Builds the course-xapi-mcp xAPI Profile (xAPI Profiles 1.0, JSON-LD) from the same constants and templates the
// statement builders and checkProfile use, so the published profile and the emitted statements cannot drift apart.
// Written to profile/xapi-profile.jsonld by `npm run profile`.
import { CMI5, CXM_ACTIVITY_TYPES, CXM_EXT, CXM_VERBS, OB_XAPI, PRACTICE_CATEGORY, PROFILE_ID, PROFILE_VERSION_IRI, SITE } from '../constants.ts';
import { CUSTODY_OPTIONS } from '../model.ts';
import { ACTIVITY_TYPE, DURATION_VERBS, TEMPLATES, VERB_IRI, type Template } from './templates.ts';

const en = (s: string) => ({ en: s });
const V = PROFILE_VERSION_IRI;
const T = (name: string) => `${V}/templates/${name}`;
const P = (name: string) => `${V}/patterns/${name}`;
const schema = (s: object) => JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', ...s });

const VERB_TEXT: Record<keyof typeof CXM_VERBS, [string, string]> = {
  placed: ['placed', 'The learner was placed into a learning path at a start lesson, by an agent choosing among authored options that the course server validated. Recorded inside the placement AU session.'],
  branched: ['branched', 'After a checkpoint, the learner was sent along one authored branch. The agent chose the branch against the rubric; the course server validated it. The result extensions name the branch, its target and the agent rationale.'],
  caught: ['caught', 'The learner found and fixed a bug that the course author planted in AI-written code, as shown by the authored fix checks passing.'],
  revealed: ['revealed', 'After the author-set number of failed fix attempts, the course server revealed a planted bug to the learner. A revealed bug does not count as caught.'],
};

const TYPE_TEXT: Record<keyof typeof CXM_ACTIVITY_TYPES, [string, string]> = {
  path: ['learning path', 'An ordered sequence of lessons within a course; a cmi5 block.'],
  beat: ['teaching beat', 'One authored teaching step inside a lesson: a goal, the key content, and optionally a question for the learner. The agent delivers it in its own words.'],
  checkpoint: ['checkpoint', 'A question inside a lesson whose answer decides which authored branch the learner takes. Free-text answers are judged by the agent against an authored rubric; code answers are decided by deterministic checks.'],
  file: ['learner file', 'A text file the learner edits by hand and submits for deterministic checks.'],
  'planted-bug': ['planted bug', 'A deliberate mistake the course author planted in AI-written code. The course server never reveals it to the agent before it is caught or revealed.'],
  achievement: ['achievement', 'An Open Badges 3.0 Achievement a learner earned in a course registration.'],
};

type ExtKind = 'ResultExtension' | 'ContextExtension';
const EXT_TEXT: Record<keyof typeof CXM_EXT, [string, ExtKind, string, object]> = {
  branch: ['branch', 'ResultExtension', 'The authored key of the branch taken.', { type: 'string' }],
  to: ['branch target', 'ResultExtension', 'The AU activity id of the lesson the branch leads to, or null when the branch ends the path.', { type: ['string', 'null'] }],
  rationale: ['judge rationale', 'ResultExtension', "The agent's one-sentence reason for choosing the branch (agent-written, at most 300 characters).", { type: 'string', maxLength: 300 }],
  checks: ['check results', 'ResultExtension', 'Per-check results of the authored deterministic checks, by check index. Empty for planted-bug fixes, so the record does not point at the bug.', { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, passed: { type: 'boolean' } }, required: ['index', 'passed'] } }],
  'start-lesson': ['start lesson', 'ResultExtension', 'The AU activity id of the lesson the learner starts at after placement.', { type: 'string' }],
  skipped: ['skipped lessons', 'ResultExtension', 'AU activity ids of lessons the placement skipped.', { type: 'array', items: { type: 'string' } }],
  'waive-recommended': ['waive recommended', 'ResultExtension', 'On placed or branched in LMS-launched custody: AU ids the course server recommends the LMS waive with reason "Tested Out". Only the LMS may waive.', { type: 'array', items: { type: 'string' } }],
  'carried-over': ['carried over', 'ResultExtension', 'On a waived statement with reason "Administrative": the lesson was carried over from an earlier record version. It never counts towards a badge.', { type: 'boolean' }],
  attempt: ['attempt', 'ResultExtension', 'The 1-based number of this checkpoint attempt within the AU session.', { type: 'integer', minimum: 1 }],
  'rules-version': ['rules version', 'ContextExtension', 'The version of the course-xapi-mcp agent rules the course server sent with this step, for example "0.2".', { type: 'string' }],
  custody: ['record custody', 'ContextExtension', 'Who holds the record this statement was written to.', { type: 'string', enum: [...CUSTODY_OPTIONS] }],
};

const VERB_LABEL: Record<string, string> = {
  launched: 'launched', initialized: 'initialized', completed: 'completed', passed: 'passed', failed: 'failed', terminated: 'terminated',
  abandoned: 'abandoned', waived: 'waived', satisfied: 'satisfied', placed: 'placed into', experienced: 'experienced', answered: 'answered',
  branched: 'branched at', caught: 'caught', revealed: 'was shown', earned: 'earned',
};

const DEFINED_TEXT: Record<string, string> = {
  launched: 'The LMS role launched the AU (cmi5 9.3.1).',
  initialized: 'First statement of an AU session (cmi5 9.3.2). Sent when the first tool call on a lesson opens its session.',
  completed: 'The learner experienced all the material of the lesson: the last beat, and the planted bug caught or revealed (cmi5 9.3.3). At most once per registration.',
  passed: 'A success branch was chosen at the lesson checkpoint (cmi5 9.3.4). At most once per registration.',
  failed: 'The author-set maximum number of checkpoint attempts ran out in this session (cmi5 9.3.5). Never after a defined passed in the registration.',
  terminated: 'Last statement of an AU session (cmi5 9.3.8).',
  abandoned: 'The LMS role closed a session that ended abnormally (cmi5 9.3.6).',
  waived: 'The LMS role waived the lesson: "Tested Out" for lessons skipped by placement or a success branch, "Administrative" for lessons carried over (cmi5 9.3.7).',
  'satisfied-block': 'The LMS role found every lesson of a path satisfied (cmi5 9.3.9).',
  'satisfied-course': 'The LMS role found every lesson of the course satisfied (cmi5 9.3.9).',
};

const cat = '$.context.contextActivities.category[*].id';
const extRule = (where: 'context' | 'result', iri: string, more: object = { presence: 'included' }) => ({ location: `$.${where}.extensions['${iri}']`, ...more });
const minted = en('Applies to actors the course server mints. In LMS-launched custody the actor is the LMS-supplied agent, copied verbatim.');

const common = [
  { location: '$.context.registration', presence: 'included' },
  extRule('context', CMI5.extSessionId),
  extRule('context', CXM_EXT['rules-version']),
  extRule('context', CXM_EXT.custody, { presence: 'included', any: [...CUSTODY_OPTIONS] }),
  { location: '$.context.contextActivities.grouping[*].id', presence: 'included', scopeNote: en('The publisher id of the AU (from the cmi5 contextTemplate) and the course id.') },
  { location: '$.version', presence: 'excluded' },
  { location: '$.context.contextAgents', presence: 'excluded' },
  { location: '$.context.contextGroups', presence: 'excluded' },
  ...['mbox', 'mbox_sha1sum', 'openid', 'name'].map((k) => ({ location: `$.actor.${k}`, presence: 'excluded', scopeNote: minted })),
];

const isTrue = (location: string) => ({ location, presence: 'included', all: [true] });
const isFalse = (location: string) => ({ location, presence: 'included', all: [false] });

function name(t: Template): string {
  return t.kind === 'defined' ? `cmi5-${t.verb}${t.object === 'au' ? '' : '-' + t.object}` : `${t.verb}-${t.object}`;
}

function rules(t: Template): object[] {
  const r: object[] = [];
  if (t.kind === 'defined') {
    r.push({ location: cat, presence: 'included', any: [CMI5.categoryCmi5] });
    const outcome = ['completed', 'passed', 'failed', 'waived'].includes(t.verb);
    r.push(outcome ? { location: cat, any: [CMI5.categoryMoveOn] } : { location: cat, none: [CMI5.categoryMoveOn] });
    if ((DURATION_VERBS as readonly string[]).includes(t.verb)) r.push({ location: '$.result.duration', presence: 'included' });
    if (t.verb === 'passed' || t.verb === 'waived') r.push(isTrue('$.result.success'));
    if (t.verb === 'failed') r.push(isFalse('$.result.success'));
    if (t.verb === 'completed' || t.verb === 'waived') r.push(isTrue('$.result.completion'));
    if (t.verb === 'waived') r.push(extRule('result', CMI5.extReason, { presence: 'included', any: ['Tested Out', 'Administrative'] }));
    return r;
  }
  r.push({ location: cat, presence: 'included', any: [V] }, { location: cat, none: [CMI5.categoryCmi5, CMI5.categoryMoveOn] });
  if (t.kind === 'badge') {
    r.push(extRule('result', OB_XAPI.badgeAssertion), { location: '$.context.statement.id', presence: 'included', scopeNote: en('The statement that earned the badge.') });
    return r;
  }
  r.push({ location: '$.context.contextActivities.parent[*].id', presence: 'included', scopeNote: en('The AU activity id.') });
  if (t.verb === 'passed' || t.verb === 'caught') r.push(isTrue('$.result.success'));
  if (t.verb === 'failed') r.push(isFalse('$.result.success'));
  if (t.verb === 'answered') r.push({ location: '$.result.response', presence: 'included', scopeNote: en("The learner's own words.") });
  if (t.verb === 'failed' && t.object === 'checkpoint') r.push(extRule('result', CXM_EXT.attempt, { presence: 'recommended' }));
  if (t.verb === 'branched') r.push(extRule('result', CXM_EXT.branch), extRule('result', CXM_EXT.to), extRule('result', CXM_EXT.rationale));
  if (t.verb === 'placed') r.push(extRule('result', CXM_EXT['start-lesson']), { location: '$.result.response', presence: 'recommended', scopeNote: en('The agent-written placement reason.') });
  return r;
}

function text(t: Template): [string, string] {
  if (t.kind === 'defined') {
    const key = t.verb === 'satisfied' ? `satisfied-${t.object}` : t.verb;
    return [`cmi5 ${t.verb}${t.object === 'au' ? '' : ' ' + t.object}`, DEFINED_TEXT[key]!];
  }
  if (t.kind === 'badge') return ['earned an achievement', 'Written by the badge issuer after it issues the Open Badges 3.0 credential. Refers to the earning statement and the credential id.'];
  const what = t.object === 'planted-bug' ? 'a planted bug' : `a ${TYPE_TEXT[t.object as keyof typeof TYPE_TEXT][0]}`;
  return [`${VERB_LABEL[t.verb]} ${what}`, `cmi5 allowed statement inside an AU session, with the AU activity id as parent.`];
}

export function buildProfile(): object {
  const concepts: object[] = [];
  for (const k of Object.keys(VERB_TEXT) as (keyof typeof CXM_VERBS)[]) {
    const [label, def] = VERB_TEXT[k];
    concepts.push({ id: CXM_VERBS[k], type: 'Verb', inScheme: V, prefLabel: en(label), definition: en(def) });
  }
  for (const k of Object.keys(TYPE_TEXT) as (keyof typeof CXM_ACTIVITY_TYPES)[]) {
    const [label, def] = TYPE_TEXT[k];
    concepts.push({ id: CXM_ACTIVITY_TYPES[k], type: 'ActivityType', inScheme: V, prefLabel: en(label), definition: en(def) });
  }
  for (const k of Object.keys(EXT_TEXT) as (keyof typeof CXM_EXT)[]) {
    const [label, type, def, s] = EXT_TEXT[k];
    concepts.push({ id: CXM_EXT[k], type, inScheme: V, prefLabel: en(label), definition: en(def), inlineSchema: schema(s) });
  }
  concepts.push({
    id: PRACTICE_CATEGORY,
    type: 'Activity',
    inScheme: V,
    activityDefinition: {
      '@context': 'https://w3id.org/xapi/profiles/activity-context',
      name: en('practice run'),
      description: en('Category on every statement of a practice run. A practice run is not an official record and cannot earn badges.'),
    },
  });

  const templates = TEMPLATES.map((t) => {
    const [label, def] = text(t);
    const type = ACTIVITY_TYPE[t.object];
    return {
      id: T(name(t)),
      type: 'StatementTemplate',
      inScheme: V,
      prefLabel: en(label),
      definition: en(def),
      verb: VERB_IRI[t.verb],
      ...(type && t.object !== 'au' ? { objectActivityType: type } : {}),
      rules: [...common, ...rules(t)],
    };
  });

  const allowed = TEMPLATES.filter((t) => t.kind === 'allowed').map((t) => T(name(t)));
  const pattern = (id: string, body: object, label?: string) => ({
    id: P(id),
    type: 'Pattern',
    ...(label ? { primary: true, inScheme: V, prefLabel: en(label), definition: en(label) } : {}),
    ...body,
  });
  const patterns = [
    pattern('session-statement', { alternates: [...allowed, T('cmi5-completed'), T('cmi5-passed'), T('cmi5-failed')] }),
    pattern('session-body', { zeroOrMore: P('session-statement') }),
    pattern('optional-launched', { optional: T('cmi5-launched') }),
    pattern('session-end', { alternates: [T('cmi5-terminated'), T('cmi5-abandoned')] }),
    pattern(
      'au-session',
      { sequence: [P('optional-launched'), T('cmi5-initialized'), P('session-body'), P('session-end')] },
      'One AU session (informative): launched when the server holds the LMS role, initialized, allowed statements and the defined outcomes, then terminated or abandoned. The conformance suite checks cmi5 order directly.',
    ),
  ];

  return {
    '@context': 'https://w3id.org/xapi/profiles/context',
    id: PROFILE_ID,
    type: 'Profile',
    conformsTo: 'https://w3id.org/xapi/profiles#1.0',
    prefLabel: en('course-xapi-mcp'),
    definition: en(
      'cmi5-shaped statements for learning that runs inside an AI agent through a Model Context Protocol course server: authored beats, server-validated branching, deterministic checks, planted-bug catches and Open Badges earned. Draft.',
    ),
    seeAlso: SITE + '/spec/draft/',
    versions: [{ id: V, generatedAtTime: '2026-10-27T00:00:00Z' }],
    author: { type: 'Person', name: 'Derin Tolu (draft by Claude)', url: 'https://github.com/derintolu' },
    concepts,
    templates,
    patterns,
  };
}
