// xAPI statements for learning-mcp: profile IRIs, builder and validators.
// Ported and extended from learn-wp-reimagined/src/shared/xapi.ts.
// Target: IEEE 9274.1.1-2023 (xAPI 2.0), while staying valid xAPI 1.0.3 (see docs/xapi-profile.md).

export const NS = 'https://w3id.org/learning-mcp';
export const PROFILE_ID = `${NS}/xapi`;
export const PROFILE_VERSION = `${PROFILE_ID}/v0.1`;
export const ACTOR_HOMEPAGE = `${NS}/learner`;

const ADL_VERB = 'http://adlnet.gov/expapi/verbs';
const ADL_TYPE = 'http://adlnet.gov/expapi/activities';

export type VerbKey = 'placed' | 'experienced' | 'answered' | 'passed' | 'failed' | 'completed' | 'branched' | 'caught';
export const VERBS: Record<VerbKey, { id: string; display: string }> = {
  placed: { id: `${PROFILE_ID}/verbs/placed`, display: 'placed' },
  experienced: { id: `${ADL_VERB}/experienced`, display: 'experienced' },
  answered: { id: `${ADL_VERB}/answered`, display: 'answered' },
  passed: { id: `${ADL_VERB}/passed`, display: 'passed' },
  failed: { id: `${ADL_VERB}/failed`, display: 'failed' },
  completed: { id: `${ADL_VERB}/completed`, display: 'completed' },
  branched: { id: `${PROFILE_ID}/verbs/branched`, display: 'branched' },
  caught: { id: `${PROFILE_ID}/verbs/caught`, display: 'caught' },
};

export type ActivityKind = 'course' | 'path' | 'lesson' | 'beat' | 'checkpoint' | 'file' | 'planted-bug';
export const ACTIVITY_TYPES: Record<ActivityKind, string> = {
  course: `${ADL_TYPE}/course`,
  lesson: `${ADL_TYPE}/lesson`,
  path: `${PROFILE_ID}/activity-types/path`,
  beat: `${PROFILE_ID}/activity-types/beat`,
  checkpoint: `${PROFILE_ID}/activity-types/checkpoint`,
  file: `${PROFILE_ID}/activity-types/file`,
  'planted-bug': `${PROFILE_ID}/activity-types/planted-bug`,
};

export const EXT = {
  branch: `${PROFILE_ID}/extensions/branch`,
  to: `${PROFILE_ID}/extensions/to`,
  rationale: `${PROFILE_ID}/extensions/rationale`,
  checks: `${PROFILE_ID}/extensions/checks`,
  startLesson: `${PROFILE_ID}/extensions/start-lesson`,
  skipped: `${PROFILE_ID}/extensions/skipped`,
  rulesVersion: `${PROFILE_ID}/extensions/rules-version`,
} as const;

/** Which object activity types each verb may be used with in this profile. */
export const VERB_OBJECTS: Record<VerbKey, ActivityKind[]> = {
  placed: ['path'],
  experienced: ['beat'],
  answered: ['beat', 'checkpoint'],
  passed: ['checkpoint', 'file'],
  failed: ['checkpoint', 'file'],
  completed: ['lesson', 'path'],
  branched: ['checkpoint'],
  caught: ['planted-bug'],
};

export interface ActivityRef { objectType: 'Activity'; id: string }
export interface Activity extends ActivityRef { definition: { type: string; name: Record<string, string> } }

export interface XapiResult {
  success?: boolean;
  completion?: boolean;
  response?: string;
  extensions?: Record<string, unknown>;
}

export interface XapiStatement {
  id: string;
  actor: { objectType: 'Agent'; account: { homePage: string; name: string } };
  verb: { id: string; display: Record<string, string> };
  object: Activity;
  result?: XapiResult;
  context: {
    registration: string;
    platform?: string;
    language: string;
    contextActivities: { parent: ActivityRef[]; grouping: ActivityRef[]; category: ActivityRef[] };
    extensions: Record<string, unknown>;
  };
  timestamp: string;
}

/** Joins IRI path segments onto a base, percent-encoding each segment. */
export const iri = (base: string, segments: string[]) => [base, ...segments.map(encodeURIComponent)].join('/');

export interface StatementInput {
  id: string;
  timestamp: string;
  learnerId: string;
  registration: string;
  language: string;
  rulesVersion: string;
  platform?: string;
  verb: VerbKey;
  object: { id: string; kind: ActivityKind; name: string };
  parent: string;
  grouping: string;
  result?: XapiResult;
}

export function buildStatement(i: StatementInput): XapiStatement {
  const v = VERBS[i.verb];
  const s: XapiStatement = {
    id: i.id,
    actor: { objectType: 'Agent', account: { homePage: ACTOR_HOMEPAGE, name: i.learnerId } },
    verb: { id: v.id, display: { [i.language]: v.display } },
    object: { objectType: 'Activity', id: i.object.id, definition: { type: ACTIVITY_TYPES[i.object.kind], name: { [i.language]: i.object.name } } },
    context: {
      registration: i.registration,
      language: i.language,
      contextActivities: {
        parent: [{ objectType: 'Activity', id: i.parent }],
        grouping: [{ objectType: 'Activity', id: i.grouping }],
        category: [{ objectType: 'Activity', id: PROFILE_VERSION }],
      },
      extensions: { [EXT.rulesVersion]: i.rulesVersion },
    },
    timestamp: i.timestamp,
  };
  if (i.platform) s.context.platform = i.platform;
  if (i.result) s.result = i.result;
  return s;
}

// ---------------------------------------------------------------------------
// Validation against the parts of xAPI 2.0 this project uses.

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIri = (v: unknown) => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`]+$/.test(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,}Z$/;
const LANG = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

const TOP = new Set(['id', 'actor', 'verb', 'object', 'result', 'context', 'timestamp']);
const CONTEXT = new Set(['registration', 'instructor', 'team', 'contextActivities', 'revision', 'platform', 'language', 'statement', 'extensions']);
const RESULT = new Set(['score', 'success', 'completion', 'response', 'duration', 'extensions']);
const CA = new Set(['parent', 'grouping', 'category', 'other']);

function unknownKeys(o: Record<string, unknown>, allowed: Set<string>, where: string, e: string[]) {
  for (const k of Object.keys(o)) if (!allowed.has(k)) e.push(`${where}: unknown property "${k}"`);
}

function langMap(v: unknown, where: string, e: string[]) {
  if (!isObj(v) || !Object.entries(v).every(([k, s]) => LANG.test(k) && typeof s === 'string')) e.push(`${where} must be a language map`);
}

function extensions(v: unknown, where: string, e: string[]) {
  if (v === undefined) return;
  if (!isObj(v)) return void e.push(`${where}.extensions must be an object`);
  for (const k of Object.keys(v)) if (!isIri(k)) e.push(`${where}.extensions key "${k}" must be an IRI`);
}

/** Returns a list of problems; empty means the statement is valid for this project's use of xAPI 2.0 (and 1.0.3). */
export function validateStatement(s: unknown): string[] {
  if (!isObj(s)) return ['statement must be an object'];
  const e: string[] = [];
  unknownKeys(s, TOP, 'statement', e);
  if (typeof s.id !== 'string' || !UUID.test(s.id)) e.push('id must be a UUID');

  const a = s.actor;
  if (!isObj(a) || a.objectType !== 'Agent' || !isObj(a.account) || !isIri(a.account.homePage) || typeof a.account.name !== 'string' || !a.account.name) {
    e.push('actor must be an Agent with an account { homePage IRI, name }');
  } else {
    for (const k of ['name', 'mbox', 'mbox_sha1sum', 'openid']) if (k in a) e.push(`actor must be anonymous: "${k}" is not allowed`);
    unknownKeys(a, new Set(['objectType', 'account']), 'actor', e);
    unknownKeys(a.account, new Set(['homePage', 'name']), 'actor.account', e);
  }

  if (!isObj(s.verb) || !isIri(s.verb.id)) e.push('verb.id must be an IRI');
  else if (s.verb.display !== undefined) langMap(s.verb.display, 'verb.display', e);

  const o = s.object;
  if (!isObj(o) || !isIri(o.id)) e.push('object.id must be an IRI');
  else {
    if (o.objectType !== undefined && o.objectType !== 'Activity') e.push('object.objectType must be Activity');
    if (o.definition !== undefined) {
      if (!isObj(o.definition)) e.push('object.definition must be an object');
      else {
        if (o.definition.type !== undefined && !isIri(o.definition.type)) e.push('object.definition.type must be an IRI');
        if (o.definition.name !== undefined) langMap(o.definition.name, 'object.definition.name', e);
      }
    }
  }

  if (typeof s.timestamp !== 'string' || !UTC_TIMESTAMP.test(s.timestamp) || Number.isNaN(Date.parse(s.timestamp))) {
    e.push('timestamp must be RFC 3339 UTC with millisecond precision');
  }

  if (s.result !== undefined) {
    const r = s.result;
    if (!isObj(r)) e.push('result must be an object');
    else {
      unknownKeys(r, RESULT, 'result', e);
      if (r.success !== undefined && typeof r.success !== 'boolean') e.push('result.success must be a boolean');
      if (r.completion !== undefined && typeof r.completion !== 'boolean') e.push('result.completion must be a boolean');
      if (r.response !== undefined && typeof r.response !== 'string') e.push('result.response must be a string');
      extensions(r.extensions, 'result', e);
    }
  }

  if (s.context !== undefined) {
    const c = s.context;
    if (!isObj(c)) e.push('context must be an object');
    else {
      unknownKeys(c, CONTEXT, 'context', e);
      if (c.registration !== undefined && (typeof c.registration !== 'string' || !UUID.test(c.registration))) e.push('context.registration must be a UUID');
      if (c.platform !== undefined && typeof c.platform !== 'string') e.push('context.platform must be a string');
      if (c.language !== undefined && (typeof c.language !== 'string' || !LANG.test(c.language))) e.push('context.language must be an RFC 5646 tag');
      extensions(c.extensions, 'context', e);
      const ca = c.contextActivities;
      if (ca !== undefined) {
        if (!isObj(ca)) e.push('context.contextActivities must be an object');
        else {
          unknownKeys(ca, CA, 'context.contextActivities', e);
          for (const [k, list] of Object.entries(ca)) {
            if (!Array.isArray(list)) e.push(`context.contextActivities.${k} must be an array`);
            else if (!list.every((x) => isObj(x) && isIri(x.id) && (x.objectType === undefined || x.objectType === 'Activity'))) {
              e.push(`context.contextActivities.${k} entries must be Activities with an IRI id`);
            }
          }
        }
      }
    }
  }
  return e;
}

/** Returns a list of problems; empty means the statement conforms to the learning-mcp profile. */
export function checkProfile(s: XapiStatement): string[] {
  const e: string[] = [];
  const verb = (Object.keys(VERBS) as VerbKey[]).find((k) => VERBS[k].id === s.verb?.id);
  if (!verb) return [`verb ${s.verb?.id} is not in the learning-mcp profile`];
  const kind = (Object.keys(ACTIVITY_TYPES) as ActivityKind[]).find((k) => ACTIVITY_TYPES[k] === s.object?.definition?.type);
  if (!kind || !VERB_OBJECTS[verb].includes(kind)) e.push(`verb "${verb}" may not be used with object type ${s.object?.definition?.type}`);
  if (s.actor?.account?.homePage !== ACTOR_HOMEPAGE) e.push(`actor.account.homePage must be ${ACTOR_HOMEPAGE}`);
  const ca = s.context?.contextActivities;
  if (!ca?.category?.some((c) => c.id === PROFILE_VERSION)) e.push('context.contextActivities.category must include the profile version');
  if (ca?.grouping?.length !== 1) e.push('context.contextActivities.grouping must hold the course');
  if (ca?.parent?.length !== 1) e.push('context.contextActivities.parent must hold the lesson or path');
  if (!s.context?.registration) e.push('context.registration is required');
  if (typeof s.context?.extensions?.[EXT.rulesVersion] !== 'string') e.push('the rules-version context extension is required');
  const r = s.result;
  if ((verb === 'passed' || verb === 'caught') && r?.success !== true) e.push(`"${verb}" needs result.success true`);
  if (verb === 'failed' && r?.success !== false) e.push('"failed" needs result.success false');
  if (verb === 'completed' && r?.completion !== true) e.push('"completed" needs result.completion true');
  if (verb === 'answered' && typeof r?.response !== 'string') e.push('"answered" needs result.response');
  if (verb === 'branched' && (typeof r?.extensions?.[EXT.branch] !== 'string' || typeof r?.extensions?.[EXT.rationale] !== 'string' || !(EXT.to in (r?.extensions ?? {})))) {
    e.push('"branched" needs the branch, to and rationale result extensions');
  }
  if (verb === 'placed' && typeof r?.extensions?.[EXT.startLesson] !== 'string') e.push('"placed" needs the start-lesson result extension');
  return e;
}
