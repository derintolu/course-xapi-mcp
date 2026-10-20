// The learner-owned record: course state plus an append-only list of xAPI statements.
// Generalised from learn-wp-reimagined/src/shared/record.ts: one record can hold several courses.
import type { Placement } from './engine.ts';
import { RULES_VERSION } from './rules.ts';
import type { Course } from './schema.ts';
import { buildStatement, iri, validateStatement, type ActivityKind, type VerbKey, type XapiResult, type XapiStatement, EXT } from './xapi.ts';

export const RECORD_FORMAT = 'learning-mcp/record';
export const RECORD_VERSION = 1;

export type Phase = 'beats' | 'bug' | 'checkpoint' | 'branch' | 'done';
export interface Cursor { pathId: string; lessonId: string; beat: number; phase: Phase; awaitingReply?: string }
export interface Pending { lessonId: string; checkpointId: string; checksPassed: boolean | null; allowed: string[] }

export interface CourseState {
  courseVersion: string;
  registration: string;
  placement?: Placement;
  cursor?: Cursor;
  completedLessons: string[];
  /** "lessonId/bugId" */
  caughtBugs: string[];
  files: Record<string, string>;
  pending?: Pending;
}

export interface LearningRecord {
  format: typeof RECORD_FORMAT;
  version: typeof RECORD_VERSION;
  learnerId: string;
  createdAt: string;
  updatedAt: string;
  courses: Record<string, CourseState>;
  statements: XapiStatement[];
}

/** Clock, id source and calling client. Injected so tests are deterministic. */
export interface Ctx { now(): string; uuid(): string; platform?: string }

export const defaultCtx = (platform?: string): Ctx => ({ now: () => new Date().toISOString(), uuid: () => crypto.randomUUID(), platform });

export function newRecord(ctx: Ctx): LearningRecord {
  const now = ctx.now();
  return { format: RECORD_FORMAT, version: RECORD_VERSION, learnerId: ctx.uuid(), createdAt: now, updatedAt: now, courses: {}, statements: [] };
}

export type RecordEvent =
  | { type: 'enrolled' }
  | { type: 'placed'; placement: Placement }
  | { type: 'beatAnswered'; lessonId: string; beatId: string; reply: string }
  | { type: 'beatServed'; lessonId: string; beatIndex: number }
  | { type: 'phase'; phase: Phase; beat?: number }
  | { type: 'movedTo'; lessonId: string }
  | { type: 'codeChecked'; lessonId: string; file: string; content: string; passed: boolean; checks: { index: number; passed: boolean }[] }
  | { type: 'bugCaught'; lessonId: string; bugId: string }
  | { type: 'checkpointSubmitted'; lessonId: string; response: string; checksPassed: boolean | null; allowed: string[] }
  | { type: 'branchChosen'; lessonId: string; branchId: string; rationale: string }
  | { type: 'lessonCompleted'; lessonId: string }
  | { type: 'pathCompleted'; pathId: string };

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export const activity = {
  path: (c: Course, id: string) => iri(c.activityBase, ['paths', id]),
  lesson: (c: Course, id: string) => iri(c.activityBase, ['lessons', id]),
  beat: (c: Course, l: string, b: string) => iri(c.activityBase, ['lessons', l, 'beats', b]),
  checkpoint: (c: Course, l: string, cp: string) => iri(c.activityBase, ['lessons', l, 'checkpoints', cp]),
  file: (c: Course, l: string, f: string) => iri(c.activityBase, ['lessons', l, 'files', f]),
  bug: (c: Course, l: string, b: string) => iri(c.activityBase, ['lessons', l, 'bugs', b]),
};

/** Applies one event and returns a new record. Never mutates its input. */
export function applyEvent(r: LearningRecord, c: Course, e: RecordEvent, ctx: Ctx): LearningRecord {
  const prev = has(r.courses, c.id) ? r.courses[c.id] : undefined;
  const st: CourseState = prev
    ? { ...prev, completedLessons: [...prev.completedLessons], caughtBugs: [...prev.caughtBugs], files: { ...prev.files }, cursor: prev.cursor && { ...prev.cursor } }
    : { courseVersion: c.version, registration: ctx.uuid(), completedLessons: [], caughtBugs: [], files: {} };
  const next: LearningRecord = { ...r, courses: { ...r.courses, [c.id]: st }, statements: [...r.statements], updatedAt: ctx.now() };

  const lesson = (id: string) => c.lessons[id];
  const add = (verb: VerbKey, object: { id: string; kind: ActivityKind; name: string }, parent: string, result?: XapiResult) => {
    next.statements.push(
      buildStatement({
        id: ctx.uuid(),
        timestamp: ctx.now(),
        learnerId: r.learnerId,
        registration: st.registration,
        language: c.language,
        rulesVersion: RULES_VERSION,
        platform: ctx.platform,
        verb,
        object,
        parent,
        grouping: c.activityBase,
        result,
      }),
    );
  };
  const inLesson = (lessonId: string) => activity.lesson(c, lessonId);

  switch (e.type) {
    case 'enrolled':
      break;
    case 'placed': {
      const p = e.placement;
      st.placement = p;
      st.cursor = { pathId: p.pathId, lessonId: p.startLessonId, beat: 0, phase: 'beats' };
      st.pending = undefined;
      add('placed', { id: activity.path(c, p.pathId), kind: 'path', name: c.paths[p.pathId].title }, c.activityBase, {
        response: p.reason,
        extensions: { [EXT.startLesson]: activity.lesson(c, p.startLessonId), [EXT.skipped]: p.skip.map((s) => activity.lesson(c, s)) },
      });
      break;
    }
    case 'beatAnswered': {
      const l = lesson(e.lessonId);
      add('answered', { id: activity.beat(c, l.id, e.beatId), kind: 'beat', name: `${l.title}: ${e.beatId}` }, inLesson(l.id), { response: e.reply });
      if (st.cursor) delete st.cursor.awaitingReply;
      break;
    }
    case 'beatServed': {
      const l = lesson(e.lessonId);
      const beat = l.beats[e.beatIndex];
      add('experienced', { id: activity.beat(c, l.id, beat.id), kind: 'beat', name: `${l.title}: ${beat.id}` }, inLesson(l.id));
      st.cursor = { ...st.cursor!, lessonId: l.id, beat: e.beatIndex + 1, phase: 'beats' };
      if (beat.question) st.cursor.awaitingReply = beat.id;
      else delete st.cursor.awaitingReply;
      break;
    }
    case 'phase':
      st.cursor = { ...st.cursor!, phase: e.phase, ...(e.beat === undefined ? {} : { beat: e.beat }) };
      break;
    case 'movedTo':
      st.cursor = { pathId: st.cursor!.pathId, lessonId: e.lessonId, beat: 0, phase: 'beats' };
      break;
    case 'codeChecked': {
      const l = lesson(e.lessonId);
      st.files[e.file] = e.content;
      add(e.passed ? 'passed' : 'failed', { id: activity.file(c, l.id, e.file), kind: 'file', name: `${l.title}: ${e.file}` }, inLesson(l.id), {
        success: e.passed,
        extensions: { [EXT.checks]: e.checks },
      });
      break;
    }
    case 'bugCaught': {
      const l = lesson(e.lessonId);
      const key = `${l.id}/${e.bugId}`;
      if (!st.caughtBugs.includes(key)) st.caughtBugs.push(key);
      add('caught', { id: activity.bug(c, l.id, e.bugId), kind: 'planted-bug', name: `${l.title}: planted bug` }, inLesson(l.id), { success: true });
      break;
    }
    case 'checkpointSubmitted': {
      const l = lesson(e.lessonId);
      const cp = l.checkpoint!;
      add('answered', { id: activity.checkpoint(c, l.id, cp.id), kind: 'checkpoint', name: `${l.title}: checkpoint` }, inLesson(l.id), { response: e.response });
      st.pending = { lessonId: l.id, checkpointId: cp.id, checksPassed: e.checksPassed, allowed: e.allowed };
      st.cursor = { ...st.cursor!, phase: 'branch' };
      break;
    }
    case 'branchChosen': {
      const l = lesson(e.lessonId);
      const cp = l.checkpoint!;
      const b = cp.branches.find((x) => x.id === e.branchId)!;
      const cpRef = { id: activity.checkpoint(c, l.id, cp.id), kind: 'checkpoint' as const, name: `${l.title}: checkpoint` };
      add(b.success ? 'passed' : 'failed', cpRef, inLesson(l.id), { success: b.success });
      add('branched', cpRef, inLesson(l.id), {
        extensions: { [EXT.branch]: b.id, [EXT.to]: b.to === null ? null : activity.lesson(c, b.to), [EXT.rationale]: e.rationale },
      });
      st.pending = undefined;
      st.cursor = b.to === null ? { ...st.cursor!, phase: 'done' } : { pathId: st.cursor!.pathId, lessonId: b.to, beat: 0, phase: 'beats' };
      break;
    }
    case 'lessonCompleted': {
      const l = lesson(e.lessonId);
      if (!st.completedLessons.includes(l.id)) st.completedLessons.push(l.id);
      add('completed', { id: activity.lesson(c, l.id), kind: 'lesson', name: l.title }, activity.path(c, l.pathId), { completion: true });
      break;
    }
    case 'pathCompleted':
      add('completed', { id: activity.path(c, e.pathId), kind: 'path', name: c.paths[e.pathId].title }, c.activityBase, { completion: true });
      st.cursor = { ...st.cursor!, phase: 'done' };
      break;
  }
  return next;
}

// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const PHASES = new Set(['beats', 'bug', 'checkpoint', 'branch', 'done']);

function courseStateError(id: string, s: unknown): string | undefined {
  if (!isObj(s)) return `course "${id}" must be an object`;
  if (typeof s.courseVersion !== 'string' || typeof s.registration !== 'string') return `course "${id}" needs courseVersion and registration`;
  if (!strings(s.completedLessons) || !strings(s.caughtBugs)) return `course "${id}": completedLessons and caughtBugs must be string arrays`;
  if (!isObj(s.files) || !Object.values(s.files).every((v) => typeof v === 'string')) return `course "${id}": files must map names to strings`;
  const cur = s.cursor;
  if (cur !== undefined && (!isObj(cur) || typeof cur.pathId !== 'string' || typeof cur.lessonId !== 'string' || !Number.isInteger(cur.beat) || !PHASES.has(cur.phase as string))) {
    return `course "${id}": cursor is malformed`;
  }
  const p = s.pending;
  if (p !== undefined && (!isObj(p) || typeof p.lessonId !== 'string' || typeof p.checkpointId !== 'string' || !strings(p.allowed))) {
    return `course "${id}": pending is malformed`;
  }
  return undefined;
}

/** Validates an exported record, including every statement, before it is trusted. */
export function parseRecord(raw: unknown): { ok: true; record: LearningRecord } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!isObj(raw)) return fail('record must be a JSON object');
  if (raw.format !== RECORD_FORMAT) return fail(`not a ${RECORD_FORMAT} file`);
  if (typeof raw.version === 'number' && raw.version > RECORD_VERSION) return fail('this record was made by a newer version');
  if (raw.version !== RECORD_VERSION) return fail('unsupported record version');
  if (typeof raw.learnerId !== 'string' || !raw.learnerId) return fail('learnerId must be a string');
  if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') return fail('createdAt and updatedAt must be strings');
  if (!isObj(raw.courses)) return fail('courses must be an object');
  for (const [id, s] of Object.entries(raw.courses)) {
    const err = courseStateError(id, s);
    if (err) return fail(err);
  }
  if (!Array.isArray(raw.statements)) return fail('statements must be an array');
  for (let i = 0; i < raw.statements.length; i++) {
    const errs = validateStatement(raw.statements[i]);
    if (errs.length) return fail(`statement ${i} is invalid: ${errs[0]}`);
    if ((raw.statements[i] as XapiStatement).actor.account.name !== raw.learnerId) return fail(`statement ${i} belongs to another learner`);
  }
  return { ok: true, record: raw as unknown as LearningRecord };
}
