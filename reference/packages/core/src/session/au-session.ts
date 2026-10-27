// SPDX-License-Identifier: Apache-2.0
// One engine step over a copy of the learner state, and the cmi5 AU session lifecycle (design §6.3 rule 1, §8.1).
import { DEFAULTS, activityIds } from '../constants.ts';
import { LIMITS } from '../learner-text.ts';
import type { CourseModel } from '../model.ts';
import { RULES_VERSION } from '../rules.ts';
import type { AuSession, Cursor, LearnerState, SatisfactionEvent } from '../state.ts';
import { DURATION_VERBS, buildAllowed, buildDefined, isoDuration, type AuTarget, type Cmi5Context } from '../xapi/index.ts';
import type { ActivityKind, AllowedVerb, DefinedVerb, XapiResult, XapiStatement } from '../xapi/types.ts';
import type { Env, NextAction, Step } from './env.ts';

export const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
export const fail = (error: string) => ({ ok: false as const, error });
export const ref = (l: { key: string; title: string }) => ({ key: l.key, title: l.title });

export const REMOVED = 'this lesson is no longer in the course (it was updated); call choose_placement to continue';
export const NO_PLACEMENT = 'this learner has no placement in this course yet; call start_placement, then choose_placement';

/** A lesson AU or the placement AU, as a session needs it. */
interface Unit {
  key: string;
  auId: string;
  url: string;
  moveOn: string;
}

export function unitOf(course: CourseModel, key: string): Unit | undefined {
  if (has(course.lessons, key)) {
    const l = course.lessons[key]!;
    return { key, auId: l.auId, url: l.url, moveOn: l.moveOn };
  }
  const p = course.placement;
  if (p.key === key) return { key, auId: p.auId, url: p.url, moveOn: 'NotApplicable' };
  return undefined;
}

/**
 * True when the cursor points at a lesson or path the course no longer has, or at a step its lesson no longer
 * has (a bug or checkpoint removed by a course update, or a review of a removed lesson).
 */
export function cursorRemoved(course: CourseModel, c: Cursor): boolean {
  if (!has(course.lessons, c.lessonKey) || !has(course.paths, c.pathKey)) return true;
  const l = course.lessons[c.lessonKey]!;
  if (c.phase === 'bug' && !l.bug) return true;
  if ((c.phase === 'checkpoint' || c.phase === 'branch') && !l.checkpoint) return true;
  return (c.phase === 'review' || c.review !== undefined) && (c.review === undefined || !has(course.lessons, c.review.lessonKey) || !l.checkpoint);
}

/** The cursor and its lesson, or the error that tells the agent what to call. */
export function current(course: CourseModel, state: LearnerState) {
  const c = state.cursor;
  if (!c) return fail(NO_PLACEMENT);
  if (cursorRemoved(course, c)) return fail(REMOVED);
  return { ok: true as const, cursor: c, lesson: course.lessons[c.lessonKey]! };
}

export function textError(name: string, v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || v.trim().length === 0) return `${name} must be a non-empty string`;
  if (v.length > max) return `${name} is longer than ${max} characters`;
  return undefined;
}

export function fileError(file: unknown, content: unknown): string | undefined {
  if (typeof file !== 'string' || file.length === 0 || file.length > 128) return 'file must be a file name of 1 to 128 characters';
  if (typeof content !== 'string') return 'content must be a string';
  if (content.length > LIMITS.file) return `file content is larger than ${LIMITS.file} characters`;
  return undefined;
}

const iso = (ms: number) => new Date(ms).toISOString();
const CMI5_LAUNCH_EXT = {
  launchMode: 'https://w3id.org/xapi/cmi5/context/extensions/launchmode',
  launchUrl: 'https://w3id.org/xapi/cmi5/context/extensions/launchurl',
  moveOn: 'https://w3id.org/xapi/cmi5/context/extensions/moveon',
} as const;

/**
 * One engine step. Works on a copy of the state; collects statements and satisfaction events.
 * Every statement gets a timestamp 1 ms after the previous one, starting no earlier than 1 ms after the
 * state's last update, so statements stay ordered within a step and across steps.
 */
export class Tx {
  readonly course: CourseModel;
  readonly env: Env;
  state: LearnerState;
  readonly statements: XapiStatement[] = [];
  readonly events: SatisfactionEvent[] = [];
  /** The session id of the latest outcome (completed, passed, waived): satisfied statements share it. */
  outcomeSession: string | undefined;
  private t: number;
  private readonly nowMs: number;
  private touched = false;

  constructor(course: CourseModel, state: LearnerState, env: Env) {
    this.course = course;
    this.env = env;
    this.state = structuredClone(state);
    this.nowMs = Date.parse(env.now());
    this.t = Math.max(this.nowMs, Date.parse(state.updatedAt) + 1);
  }

  get option1(): boolean {
    return this.env.custody === 'lms-launched';
  }

  stamp(): string {
    return iso(this.t++);
  }

  ctx(sessionId: string): Cmi5Context {
    const launch = this.env.launch;
    return {
      actor: this.env.actor,
      registration: this.state.registration,
      sessionId,
      courseId: this.course.id,
      language: this.env.language ?? this.course.language,
      rulesVersion: RULES_VERSION,
      custody: this.env.custody,
      practice: this.env.practice,
      platform: this.env.platform,
      contextTemplate: this.option1 && launch?.sessionId === sessionId ? launch.contextTemplate : undefined,
    };
  }

  /** The AU as cmi5 names it. In option 1 the launched AU's activityId comes from the LMS. */
  target(key: string, auId: string): AuTarget {
    const launch = this.env.launch;
    const activityId = this.option1 && launch?.auKey === key ? launch.activityId : activityIds.au(auId);
    return { publisherId: auId, activityId };
  }

  private add(s: XapiStatement): XapiStatement {
    this.statements.push(s);
    return s;
  }

  /** A defined statement on the AU of `session`; duration is measured from the session start. */
  definedAu(verb: DefinedVerb, session: AuSession, extra: { timestamp?: string; durationTo?: string; extensions?: Record<string, unknown> } = {}): XapiStatement {
    const timestamp = extra.timestamp ?? this.stamp();
    const auId = session.auId ?? unitOf(this.course, session.auKey)!.auId;
    const duration = DURATION_VERBS.includes(verb) ? isoDuration(Math.max(0, Date.parse(extra.durationTo ?? timestamp) - Date.parse(session.startedAt))) : undefined;
    const s = buildDefined(this.ctx(session.id), verb, { au: this.target(session.auKey, auId) }, { id: this.env.uuid(), timestamp, duration, extensions: extra.extensions });
    return this.add(s);
  }

  /** A defined LMS-role statement in its own session or on a block or course (waived, satisfied). */
  definedLms(verb: 'waived' | 'satisfied', sessionId: string, target: Parameters<typeof buildDefined>[2], reason?: 'Tested Out'): XapiStatement {
    return this.add(buildDefined(this.ctx(sessionId), verb, target, { id: this.env.uuid(), timestamp: this.stamp(), reason }));
  }

  /** An allowed statement in the open session, with `parentKey`'s AU as the parent. */
  allowed(verb: AllowedVerb, object: { id: string; kind: ActivityKind; name: string }, parentKey: string, result?: XapiResult): XapiStatement {
    const s = this.state.session!;
    const u = unitOf(this.course, parentKey)!;
    return this.add(buildAllowed(this.ctx(s.id), verb, object, this.target(parentKey, u.auId), { id: this.env.uuid(), timestamp: this.stamp(), result }));
  }

  /**
   * Opens (or continues) the AU session for `key`; an open session on another AU is terminated first.
   * Options 2-4 send `launched` (Normal) and `initialized`; option 1 uses the bridge's session and sends neither.
   * Returns false in option 1 when `key` is not the launched AU, or the launch has ended: the learner has to
   * launch it from the LMS, and nothing is changed.
   */
  enter(key: string): boolean {
    const launch = this.env.launch;
    const s = this.state.session;
    if (this.option1 && (launch?.auKey !== key || launch.ended)) return false;
    if (s && s.auKey === key && (!this.option1 || s.id === launch!.sessionId)) {
      this.touched = true;
      return true;
    }
    if (s) this.close();
    const u = unitOf(this.course, key)!;
    const id = this.option1 ? launch!.sessionId : this.env.uuid();
    const session: AuSession = { id, auKey: key, auId: u.auId, startedAt: iso(this.t), lastActivityAt: iso(this.t), attempts: 0 };
    this.state.session = session;
    if (!this.option1) {
      this.definedAu('launched', session, {});
      const launched = this.statements[this.statements.length - 1]!;
      launched.context.extensions = {
        ...launched.context.extensions,
        [CMI5_LAUNCH_EXT.launchMode]: 'Normal',
        [CMI5_LAUNCH_EXT.launchUrl]: u.url,
        [CMI5_LAUNCH_EXT.moveOn]: u.moveOn,
      };
      this.definedAu('initialized', session);
    }
    this.touched = true;
    return true;
  }

  /**
   * Ends the open session with `terminated`. In option 1 a session from another (older or ended) launch is
   * dropped without a statement: the bridge's sweeper terminates it.
   */
  close(o: { at?: string; durationTo?: string } = {}): void {
    const s = this.state.session;
    if (!s) return;
    delete this.state.session;
    const launch = this.env.launch;
    if (this.option1 && (s.id !== launch?.sessionId || launch.ended)) return;
    if (s.auId === undefined && !unitOf(this.course, s.auKey)) return;
    this.definedAu('terminated', s, { timestamp: o.at, durationTo: o.durationTo });
  }

  /** Where the learner goes after moving to lesson `key`. */
  nextFor(key: string): NextAction {
    const launch = this.env.launch;
    if (this.option1 && (launch?.auKey !== key || launch.ended)) return { type: 'return-to-lms', lessonKey: key, ...(launch?.returnURL ? { returnURL: launch.returnURL } : {}) };
    return { type: 'continue' };
  }

  finish<T>(data: T, next?: NextAction): Step<T> {
    const last = this.statements.reduce((m, s) => Math.max(m, Date.parse(s.timestamp)), this.nowMs);
    this.state.updatedAt = iso(Math.max(last, Date.parse(this.state.updatedAt)));
    if (this.touched && this.state.session) this.state.session.lastActivityAt = this.state.updatedAt;
    return { ok: true, state: this.state, statements: this.statements, events: this.events, data, ...(next ? { next } : {}) };
  }
}

/** The data that sends the learner back to the LMS to launch `lesson` (option 1). */
export function returnToLms(tx: Tx, lesson: { key: string; title: string }) {
  return tx.finish(
    { step: 'return-to-lms', lesson: ref(lesson), instruction: `This lesson runs in its own LMS launch. Send the learner back to their LMS to launch "${lesson.title}", then continue here.` },
    tx.nextFor(lesson.key),
  );
}

export function newState(course: CourseModel, env: Env): LearnerState {
  const now = env.now();
  return {
    v: 1,
    courseVersion: course.version,
    registration: env.custody === 'lms-launched' && env.launch ? env.launch.registration : env.uuid(),
    createdAt: now,
    updatedAt: now,
    au: {},
    satisfied: { blocks: [], course: false },
    files: {},
    outbox: [],
    awards: [],
  };
}

/**
 * Closes a session idle longer than `DEFAULTS.sessionIdleMs` with `terminated` at its last activity + 1 ms, or,
 * when the course no longer has the cursor's lesson, closes the open session with `terminated` only.
 * In option 1 an idle session is dropped without a statement: the bridge's sweeper terminates idle launches.
 */
export function expireSession(course: CourseModel, state: LearnerState, env: Env): Step<null> {
  const s = state.session;
  const noop: Step<null> = { ok: true, state, statements: [], events: [], data: null };
  if (!s) return noop;
  const idle = Date.parse(env.now()) - Date.parse(s.lastActivityAt) > DEFAULTS.sessionIdleMs;
  const removed = (state.cursor !== undefined && cursorRemoved(course, state.cursor)) || !unitOf(course, s.auKey);
  if (!idle && !removed) return noop;
  const tx = new Tx(course, state, env);
  if (idle && tx.option1) delete tx.state.session;
  else tx.close(idle ? { at: iso(Date.parse(s.lastActivityAt) + 1), durationTo: s.lastActivityAt } : {});
  return tx.finish(null);
}

/** The learner is leaving: terminates the open AU session with its duration. */
export function endSession(course: CourseModel, state: LearnerState, env: Env): Step<{ ended: boolean; instruction: string }> {
  if (state.cursor && cursorRemoved(course, state.cursor)) return fail(REMOVED);
  const tx = new Tx(course, state, env);
  const ended = tx.state.session !== undefined;
  tx.close();
  return tx.finish({ ended, instruction: 'The session is closed. The learner can come back later; the next call opens a new session.' });
}

/** Starts the course again under a new registration. Only earned awards are kept. */
export function restartCourse(course: CourseModel, state: LearnerState, env: Env): Step<{ restarted: true; instruction: string }> {
  if (env.custody === 'lms-launched') return fail('your LMS owns the registrations for this course; ask it to start the course again');
  const tx = new Tx(course, state, env);
  tx.close();
  const fresh = newState(course, env);
  fresh.awards = tx.state.awards;
  // Statements not yet accepted by the record holder still belong to the old registration's record.
  fresh.outbox = tx.state.outbox;
  fresh.updatedAt = tx.state.updatedAt;
  tx.state = fresh;
  return tx.finish({ restarted: true as const, instruction: 'The course starts again from placement. Earned badges stay valid. Call start_placement.' });
}
