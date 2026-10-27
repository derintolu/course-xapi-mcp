// SPDX-License-Identifier: Apache-2.0
// The practice copy (option 4): an unofficial, learner-held record of a practice run, and its handle.
// A practice copy can only ever continue as practice; nothing here can produce an official record.
import { PRACTICE_CATEGORY, PRACTICE_HOMEPAGE, PRACTICE_LABEL } from './constants.ts';
import type { LearnerState } from './state.ts';
import { checkProfile } from './xapi/profile-check.ts';
import type { XapiAccount, XapiStatement } from './xapi/types.ts';
import { validateStatement } from './xapi/validate.ts';

export const PRACTICE_FORMAT = 'course-xapi-mcp/practice-record';
export const PRACTICE_VERSION = 1;

/** The practice actor: an anonymous account under the practice home page. */
export interface PracticeActor {
  objectType?: 'Agent';
  account: XapiAccount;
}

export interface PracticeRecord {
  format: typeof PRACTICE_FORMAT;
  version: number;
  official: false;
  label: typeof PRACTICE_LABEL;
  courseId: string;
  actor: PracticeActor;
  createdAt: string;
  updatedAt: string;
  state: LearnerState;
  statements: XapiStatement[];
}

const NOT_PRACTICE = 'this is not a course-xapi-mcp practice copy';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function stateProblem(s: unknown): string | undefined {
  if (!isObj(s) || s.v !== 1) return 'its state is not a version 1 learner state';
  for (const k of ['courseVersion', 'registration', 'createdAt', 'updatedAt'] as const) if (!isStr(s[k])) return `its state has no ${k}`;
  if (!isObj(s.au)) return 'its state has no au progress';
  if (!isObj(s.satisfied) || !isStrList(s.satisfied.blocks) || typeof s.satisfied.course !== 'boolean') return 'its state has no satisfied block list';
  if (!isObj(s.files) || !Object.values(s.files).every(isStr)) return 'its state files must be text';
  if (!Array.isArray(s.outbox)) return 'its state has no outbox';
  if (!Array.isArray(s.awards)) return 'its state has no awards list';
  return undefined;
}

function statementProblem(s: unknown, actorName: string): string | undefined {
  const id = isObj(s) && isStr(s.id) ? s.id : '(no id)';
  const invalid = validateStatement(s);
  if (invalid.length) return `statement ${id} is not valid xAPI: ${invalid.join('; ')}`;
  const st = s as XapiStatement;
  if (!(st.context?.contextActivities?.category ?? []).some((a) => a.id === PRACTICE_CATEGORY)) {
    return `statement ${id} does not carry the practice category ${PRACTICE_CATEGORY}`;
  }
  const a = st.actor as { account?: XapiAccount; mbox?: unknown; mbox_sha1sum?: unknown; openid?: unknown; name?: unknown };
  if (a.account?.homePage !== PRACTICE_HOMEPAGE || a.account.name !== actorName || a.mbox !== undefined || a.mbox_sha1sum !== undefined || a.openid !== undefined || a.name !== undefined) {
    return `statement ${id} has an actor other than this practice copy's actor`;
  }
  const off = checkProfile(st);
  if (off.length) return `statement ${id} does not follow the course-xapi-mcp profile: ${off.join('; ')}`;
  return undefined;
}

/**
 * Checks an exported practice copy before `resume_practice` continues it. Refuses anything that is not a
 * practice copy of this course: another format (an official export, a `learning-mcp/record` file), a newer
 * version, another course, or any statement that is invalid, off-profile, not labelled practice or by another actor.
 */
export function parsePracticeRecord(raw: unknown, courseId: string): { ok: true; record: PracticeRecord } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!isObj(raw) || raw.format !== PRACTICE_FORMAT) return fail(NOT_PRACTICE);
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) return fail(NOT_PRACTICE);
  if (raw.version > PRACTICE_VERSION) {
    return fail(`this practice copy was made by a newer version (${raw.version}); this server reads version ${PRACTICE_VERSION}`);
  }
  if (raw.official !== false || raw.label !== PRACTICE_LABEL) return fail(NOT_PRACTICE);
  if (raw.courseId !== courseId) return fail(`this practice copy is for another course (${String(raw.courseId)}), not ${courseId}`);
  const actor = raw.actor;
  if (!isObj(actor) || !isObj(actor.account) || actor.account.homePage !== PRACTICE_HOMEPAGE || !isStr(actor.account.name) || !actor.account.name) {
    return fail(`this practice copy's actor must be an account under ${PRACTICE_HOMEPAGE}`);
  }
  if (Object.keys(actor).some((k) => k !== 'objectType' && k !== 'account') || (actor.objectType !== undefined && actor.objectType !== 'Agent')) {
    return fail(`this practice copy's actor must be an account under ${PRACTICE_HOMEPAGE}`);
  }
  if (!isStr(raw.createdAt) || !isStr(raw.updatedAt)) return fail('this practice copy has no createdAt or updatedAt');
  const sp = stateProblem(raw.state);
  if (sp) return fail(`this practice copy is damaged: ${sp}`);
  if (!Array.isArray(raw.statements)) return fail('this practice copy has no statement list');
  const name = actor.account.name;
  for (const s of [...raw.statements, ...(raw.state as LearnerState).outbox]) {
    const p = statementProblem(s, name);
    if (p) return fail(p);
  }
  return { ok: true, record: raw as unknown as PracticeRecord };
}

const HANDLE = /^cxp_[A-Za-z0-9_-]{32}$/;

/** A new practice handle: "cxp_" plus 192 random bits, base64url. It is a bearer secret and never appears in statements. */
export function newPracticeHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
  return `cxp_${b64}`;
}

export const isPracticeHandle = (h: unknown): h is string => typeof h === 'string' && HANDLE.test(h);
