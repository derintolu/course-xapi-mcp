// SPDX-License-Identifier: Apache-2.0
// Validation against the parts of xAPI 1.0.3 and 2.0 that cmi5-shaped course-xapi-mcp statements use.
import { isIsoDuration } from './duration.ts';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isIri = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`]+$/.test(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,}Z$/;
const LANG = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
const SHA1 = /^[0-9a-f]{40}$/i;

const TOP = new Set(['id', 'actor', 'verb', 'object', 'result', 'context', 'timestamp']);
const ACTOR = new Set(['objectType', 'name', 'mbox', 'mbox_sha1sum', 'openid', 'account']);
const CONTEXT = new Set(['registration', 'instructor', 'team', 'contextActivities', 'revision', 'platform', 'language', 'statement', 'extensions']);
const RESULT = new Set(['score', 'success', 'completion', 'response', 'duration', 'extensions']);
const SCORE = new Set(['scaled', 'raw', 'min', 'max']);
const CA = new Set(['parent', 'grouping', 'category', 'other']);
const IFIS = ['mbox', 'mbox_sha1sum', 'openid', 'account'] as const;

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

/** An xAPI Agent with exactly one inverse functional identifier (xAPI 2.4.2.1). */
function agent(a: unknown, e: string[]) {
  if (!isObj(a)) return void e.push('actor must be an Agent');
  unknownKeys(a, ACTOR, 'actor', e);
  if (a.objectType !== undefined && a.objectType !== 'Agent') e.push('actor.objectType must be Agent');
  if (a.name !== undefined && typeof a.name !== 'string') e.push('actor.name must be a string');
  const ifis = IFIS.filter((k) => a[k] !== undefined);
  if (ifis.length !== 1) e.push(`actor must have exactly one inverse functional identifier (mbox, mbox_sha1sum, openid or account), found ${ifis.length}`);
  if (a.mbox !== undefined && (typeof a.mbox !== 'string' || !/^mailto:[^\s@]+@[^\s@]+$/.test(a.mbox))) e.push('actor.mbox must be a mailto: IRI');
  if (a.mbox_sha1sum !== undefined && (typeof a.mbox_sha1sum !== 'string' || !SHA1.test(a.mbox_sha1sum))) e.push('actor.mbox_sha1sum must be a hex SHA-1');
  if (a.openid !== undefined && !isIri(a.openid)) e.push('actor.openid must be an IRI');
  if (a.account !== undefined) {
    const acc = a.account;
    if (!isObj(acc) || !isIri(acc.homePage) || typeof acc.name !== 'string' || !acc.name) e.push('actor.account must be { homePage IRI, name }');
    else unknownKeys(acc, new Set(['homePage', 'name']), 'actor.account', e);
  }
}

function score(v: unknown, e: string[]) {
  if (!isObj(v)) return void e.push('result.score must be an object');
  unknownKeys(v, SCORE, 'result.score', e);
  for (const k of SCORE) if (v[k] !== undefined && !isNum(v[k])) e.push(`result.score.${k} must be a number`);
  const { scaled, raw, min, max } = v as Record<string, number | undefined>;
  if (isNum(scaled) && (scaled < -1 || scaled > 1)) e.push('result.score.scaled must be between -1 and 1');
  if (isNum(min) && isNum(max) && min >= max) e.push('result.score.min must be less than max');
  if (isNum(raw) && ((isNum(min) && raw < min) || (isNum(max) && raw > max))) e.push('result.score.raw must be between min and max');
}

/**
 * Returns a list of problems; empty means the statement is valid for this project's use of xAPI 2.0 (and 1.0.3).
 * The actor may be any xAPI Agent; whether it is one the course server may mint is `checkProfile`'s job.
 */
export function validateStatement(s: unknown): string[] {
  if (!isObj(s)) return ['statement must be an object'];
  const e: string[] = [];
  unknownKeys(s, TOP, 'statement', e);
  if (typeof s.id !== 'string' || !UUID.test(s.id)) e.push('id must be a UUID');

  agent(s.actor, e);

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
        if (o.definition.description !== undefined) langMap(o.definition.description, 'object.definition.description', e);
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
      if (r.duration !== undefined && !isIsoDuration(r.duration)) e.push('result.duration must be an ISO 8601 duration');
      if (r.score !== undefined) score(r.score, e);
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
      if (c.statement !== undefined) {
        const ref = c.statement;
        if (!isObj(ref) || ref.objectType !== 'StatementRef' || typeof ref.id !== 'string' || !UUID.test(ref.id)) e.push('context.statement must be a StatementRef with a UUID id');
        else unknownKeys(ref, new Set(['objectType', 'id']), 'context.statement', e);
      }
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
