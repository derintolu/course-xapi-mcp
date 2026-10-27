// SPDX-License-Identifier: Apache-2.0
// The course tools as plain functions over (course, record). No MCP here: the reference server,
// a browser UI or any other host can call these and get identical behaviour and statements.
import { allowedBranches, nextLessonId, validatePlacement } from './engine.ts';
import { runChecks, type CheckResult } from './checks.ts';
import { LIMITS, wrapLearner } from './learner-text.ts';
import { applyEvent, newRecord, type Ctx, type CourseState, type LearningRecord, type RecordEvent } from './record.ts';
import type { Course, Lesson } from './schema.ts';

export type SessionResult<T> = { ok: true; record: LearningRecord; data: T } | { ok: false; error: string };
type Read<T> = { ok: true; data: T } | { ok: false; error: string };

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const fail = (error: string) => ({ ok: false as const, error });
const ref = (l: Lesson) => ({ id: l.id, title: l.title });

class Tx {
  record: LearningRecord;
  private course: Course;
  private ctx: Ctx;
  constructor(record: LearningRecord, course: Course, ctx: Ctx) {
    this.record = record;
    this.course = course;
    this.ctx = ctx;
  }
  apply(...events: RecordEvent[]) {
    for (const e of events) this.record = applyEvent(this.record, this.course, e, this.ctx);
    return this;
  }
  get state(): CourseState {
    return this.record.courses[this.course.id];
  }
}

function textError(name: string, v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || v.trim().length === 0) return `${name} must be a non-empty string`;
  if (v.length > max) return `${name} is longer than ${max} characters`;
  return undefined;
}

function fileError(file: unknown, content: unknown): string | undefined {
  if (typeof file !== 'string' || file.length === 0 || file.length > 128) return 'file must be a file name of 1 to 128 characters';
  if (typeof content !== 'string') return 'content must be a string';
  if (content.length > LIMITS.file) return `file content is larger than ${LIMITS.file} characters`;
  return undefined;
}

/** Finds the course state and current lesson, or explains what to call first. */
function current(course: Course, record: LearningRecord) {
  const st = has(record.courses, course.id) ? record.courses[course.id] : undefined;
  if (!st?.cursor) return fail('this record has no placement in this course yet; call start_placement, then choose_placement');
  const c = st.cursor;
  if (!has(course.lessons, c.lessonId) || !has(course.paths, c.pathId)) {
    return fail('this record points at a lesson this course no longer has; call choose_placement again');
  }
  return { ok: true as const, st, cursor: c, lesson: course.lessons[c.lessonId] };
}

// --- read-only -------------------------------------------------------------

export function listPaths(course: Course) {
  return {
    course: { id: course.id, title: course.title, description: course.description, version: course.version, language: course.language, license: course.license ?? null },
    paths: Object.values(course.paths).map((p) => ({
      id: p.id,
      title: p.title,
      tagline: p.tagline,
      status: p.status,
      lessons: p.lessons.map((id) => ref(course.lessons[id])),
    })),
  };
}

export function getLesson(course: Course, lessonId: string): Read<object> {
  if (typeof lessonId !== 'string' || !has(course.lessons, lessonId)) return fail(`unknown lesson; lessons: ${Object.keys(course.lessons).join(', ')}`);
  const l = course.lessons[lessonId];
  return {
    ok: true,
    data: {
      lesson: { ...ref(l), pathId: l.pathId, minutes: l.minutes, sources: l.sources },
      beats: l.beats.map((b) => ({ id: b.id, goal: b.goal })),
      has_planted_bug: Boolean(l.bug),
      checkpoint: l.checkpoint ? { kind: l.checkpoint.kind, question: l.checkpoint.question } : null,
    },
  };
}

// --- placement -------------------------------------------------------------

export function startPlacement(course: Course, record: LearningRecord | undefined, ctx: Ctx) {
  const tx = new Tx(record ?? newRecord(ctx), course, ctx);
  if (!has(tx.record.courses, course.id)) tx.apply({ type: 'enrolled' });
  const live = Object.values(course.paths).filter((p) => p.status === 'live');
  return {
    ok: true as const,
    record: tx.record,
    data: {
      intro: course.placement.intro,
      max_questions: course.placement.maxQuestions,
      paths: live.map((p) => ({ id: p.id, title: p.title, tagline: p.tagline, hints: p.placementHints, lessons: p.lessons.map((id) => ref(course.lessons[id])) })),
      next: `Ask the learner at most ${course.placement.maxQuestions} short questions, one at a time. Then call choose_placement with a pathId, a startLessonId from that path, the lessons before it to skip, and a one-sentence reason.`,
    },
  };
}

export function choosePlacement(course: Course, record: LearningRecord, input: unknown, ctx: Ctx): SessionResult<object> {
  const v = validatePlacement(course, input);
  if (!v.ok) return fail(v.error);
  const tx = new Tx(record, course, ctx).apply({ type: 'placed', placement: v.placement });
  const start = course.lessons[v.placement.startLessonId];
  return { ok: true, record: tx.record, data: { placed: v.placement, start_lesson: ref(start), next: 'Call next_beat to get the first beat.' } };
}

// --- lesson flow -----------------------------------------------------------

function bugStep(l: Lesson) {
  return {
    step: 'bug' as const,
    lesson: ref(l),
    bug: { file: l.bug!.file, code: l.bug!.code, label: 'AI-written code. One bug was planted on purpose. Find it.' },
    next: 'Show the code and ask the learner to find and fix the bug. Do not reveal or hint at where it is. Send their whole fixed file with check_code.',
  };
}

function checkpointStep(l: Lesson, st: CourseState) {
  const cp = l.checkpoint!;
  const file = cp.file ? (st.files[cp.file] ?? l.starterFiles?.[cp.file] ?? null) : null;
  return {
    step: 'checkpoint' as const,
    lesson: ref(l),
    checkpoint: { kind: cp.kind, question: cp.question, ...(cp.file ? { file: cp.file, current_file: file } : {}) },
    next:
      cp.kind === 'code'
        ? `Ask the question. The learner edits ${cp.file} by hand. They may test it with check_code. Then send their explanation word for word, and the file, with submit_checkpoint.`
        : 'Ask the question and send the learner\'s answer word for word with submit_checkpoint.',
  };
}

/** Decides what follows the last beat: the bug, the checkpoint, or completion. */
function afterBeats(course: Course, tx: Tx, l: Lesson) {
  if (l.bug && !tx.state.caughtBugs.includes(`${l.id}/${l.bug.id}`)) {
    tx.apply({ type: 'phase', phase: 'bug' });
    return bugStep(l);
  }
  if (l.checkpoint) {
    tx.apply({ type: 'phase', phase: 'checkpoint' });
    return checkpointStep(l, tx.state);
  }
  tx.apply({ type: 'lessonCompleted', lessonId: l.id });
  const pathId = tx.state.cursor!.pathId;
  const nextId = nextLessonId(course, pathId, l.id, tx.state.placement?.skip ?? []);
  if (nextId) {
    tx.apply({ type: 'movedTo', lessonId: nextId });
    return { step: 'lesson-complete' as const, lesson: ref(l), next_lesson: ref(course.lessons[nextId]), next: 'Call next_beat to start the next lesson.' };
  }
  tx.apply({ type: 'pathCompleted', pathId });
  return pathComplete(course, pathId);
}

function pathComplete(course: Course, pathId: string) {
  return {
    step: 'path-complete' as const,
    path: { id: pathId, title: course.paths[pathId].title },
    next: 'Congratulate the learner. Offer get_record so they can keep their record, and remind them they can delete it with delete_record.',
  };
}

export function nextBeat(course: Course, record: LearningRecord, input: { learner_reply?: unknown }, ctx: Ctx): SessionResult<object> {
  const cur = current(course, record);
  if (!cur.ok) return cur;
  const { cursor } = cur;
  const tx = new Tx(record, course, ctx);
  if (cursor.phase === 'done') return { ok: true, record, data: pathComplete(course, cursor.pathId) };
  if (cursor.phase === 'branch') return fail('a checkpoint answer is waiting for a branch; call choose_branch');

  const l = cur.lesson;
  if (cursor.awaitingReply) {
    const err = textError('learner_reply', input.learner_reply, LIMITS.text);
    if (err) return fail(`the last beat asked the learner a question; ask it, wait, and pass their answer word for word as learner_reply (${err})`);
    tx.apply({ type: 'beatAnswered', lessonId: l.id, beatId: cursor.awaitingReply, reply: input.learner_reply as string });
  }

  if (cursor.phase === 'bug') return { ok: true, record: tx.record, data: bugStep(l) };
  if (cursor.phase === 'checkpoint') return { ok: true, record: tx.record, data: checkpointStep(l, tx.state) };

  const i = tx.state.cursor!.beat;
  if (i < l.beats.length) {
    tx.apply({ type: 'beatServed', lessonId: l.id, beatIndex: i });
    const b = l.beats[i];
    return {
      ok: true,
      record: tx.record,
      data: {
        step: 'beat',
        lesson: ref(l),
        position: { beat: i + 1, of: l.beats.length },
        beat: { id: b.id, goal: b.goal, content: b.content, question: b.question ?? null },
        sources: l.sources,
        next: b.question
          ? 'Teach this beat in your own words, then ask exactly the question. Wait for the learner, then call next_beat with their reply as learner_reply.'
          : 'Teach this beat in your own words and check in with the learner, then call next_beat.',
      },
    };
  }
  const data = afterBeats(course, tx, l);
  return { ok: true, record: tx.record, data };
}

export function checkCode(course: Course, record: LearningRecord, input: { file?: unknown; content?: unknown }, ctx: Ctx): SessionResult<object> {
  const cur = current(course, record);
  if (!cur.ok) return cur;
  const err = fileError(input.file, input.content);
  if (err) return fail(err);
  const file = input.file as string;
  const content = input.content as string;
  const { lesson: l, cursor } = cur;
  const tx = new Tx(record, course, ctx);

  if (cursor.phase === 'bug' && l.bug) {
    if (file !== l.bug.file) return fail(`the planted bug is in ${l.bug.file}; send that whole file`);
    const r = runChecks(l.bug.fixChecks, { [file]: content });
    // Per-check results are not recorded or returned for a planted bug: they would point at it.
    tx.apply({ type: 'codeChecked', lessonId: l.id, file, content, passed: r.passed, checks: [] });
    if (!r.passed) {
      return { ok: true, record: tx.record, data: { file, passed: false, hint: l.bug.hint ?? null, next: 'Not fixed yet. Give the authored hint if it helps, without pointing at the bug, and let the learner try again.' } };
    }
    tx.apply({ type: 'bugCaught', lessonId: l.id, bugId: l.bug.id }, { type: 'phase', phase: 'beats', beat: l.beats.length });
    return {
      ok: true,
      record: tx.record,
      data: { file, passed: true, caught: true, explanation: l.bug.explanation, next: 'Ask the learner to explain what was wrong before you share the explanation. Then call next_beat.' },
    };
  }

  const cp = l.checkpoint;
  if (cursor.phase === 'checkpoint' && cp?.kind === 'code') {
    if (file !== cp.file) return fail(`this checkpoint checks ${cp.file}`);
    const r = runChecks(cp.checks!, { [file]: content });
    tx.apply({ type: 'codeChecked', lessonId: l.id, file, content, passed: r.passed, checks: r.results.map(({ index, passed }) => ({ index, passed })) });
    return { ok: true, record: tx.record, data: { file, passed: r.passed, checks: publicChecks(r.results), next: 'Use the check messages as hints. When the learner is ready, call submit_checkpoint.' } };
  }
  return fail('there is no code to check at this step; call next_beat to see the current step');
}

const publicChecks = (rs: CheckResult[]) => rs.map((r) => ({ passed: r.passed, message: r.message }));

export function submitCheckpoint(course: Course, record: LearningRecord, input: { response?: unknown; files?: unknown }, ctx: Ctx): SessionResult<{
  allowed_branches: { id: string; when: string }[];
  checks_passed: boolean | null;
  learner_response: string;
  [k: string]: unknown;
}> {
  const cur = current(course, record);
  if (!cur.ok) return cur;
  const { lesson: l, cursor, st } = cur;
  if (cursor.phase !== 'checkpoint' || !l.checkpoint) {
    return fail(cursor.phase === 'branch' ? 'this checkpoint is already submitted; call choose_branch' : 'the learner is not at a checkpoint yet; call next_beat');
  }
  const err = textError('response', input.response, LIMITS.text);
  if (err) return fail(err);
  const response = input.response as string;
  const cp = l.checkpoint;

  let content: string | undefined;
  if (input.files !== undefined) {
    if (input.files === null || typeof input.files !== 'object' || Array.isArray(input.files)) return fail('files must map file names to contents');
    const entries = Object.entries(input.files as Record<string, unknown>);
    if (entries.length > LIMITS.files) return fail(`send at most ${LIMITS.files} files`);
    for (const [f, c] of entries) {
      const e = fileError(f, c);
      if (e) return fail(e);
    }
    if (cp.file && has(input.files, cp.file)) content = (input.files as Record<string, string>)[cp.file];
  }

  let checksPassed: boolean | null = null;
  let results: CheckResult[] | undefined;
  if (cp.kind === 'code') {
    content ??= st.files[cp.file!];
    if (content === undefined) return fail(`send ${cp.file} in files`);
    const r = runChecks(cp.checks!, { [cp.file!]: content });
    checksPassed = r.passed;
    results = r.results;
  }
  const allowed = allowedBranches(cp, checksPassed);
  const tx = new Tx(record, course, ctx).apply({ type: 'checkpointSubmitted', lessonId: l.id, response, checksPassed, allowed: allowed.map((b) => b.id) });
  if (results) {
    tx.apply({ type: 'codeChecked', lessonId: l.id, file: cp.file!, content: content!, passed: checksPassed!, checks: results.map(({ index, passed }) => ({ index, passed })) });
  }
  return {
    ok: true,
    record: tx.record,
    data: {
      lesson: ref(l),
      question: cp.question,
      rubric: cp.rubric,
      learner_response: wrapLearner(response),
      checks_passed: checksPassed,
      ...(results ? { checks: publicChecks(results) } : {}),
      allowed_branches: allowed.map((b) => ({ id: b.id, when: b.when })),
      next: 'Judge the learner response against the rubric and the "when" text only. Then call choose_branch with one allowed branch id and a one-sentence rationale.',
    },
  };
}

export function chooseBranch(course: Course, record: LearningRecord, input: { branch?: unknown; rationale?: unknown }, ctx: Ctx): SessionResult<object> {
  const cur = current(course, record);
  if (!cur.ok) return cur;
  const p = cur.st.pending;
  if (!p || cur.cursor.phase !== 'branch') return fail('there is no submitted checkpoint to branch from; call submit_checkpoint first');
  const allowedList = p.allowed.join(', ');
  if (typeof input.branch !== 'string' || !p.allowed.includes(input.branch)) {
    return fail(`"${String(input.branch).slice(0, 64)}" is not an allowed branch here; choose one of: ${allowedList}`);
  }
  const err = textError('rationale', input.rationale, LIMITS.rationale);
  if (err) return fail(`${err}; allowed branches: ${allowedList}`);
  const l = course.lessons[p.lessonId];
  const b = l.checkpoint!.branches.find((x) => x.id === input.branch)!;
  const tx = new Tx(record, course, ctx).apply({ type: 'branchChosen', lessonId: l.id, branchId: b.id, rationale: input.rationale as string });
  if (b.success) tx.apply({ type: 'lessonCompleted', lessonId: l.id });
  if (b.to === null) tx.apply({ type: 'pathCompleted', pathId: cur.cursor.pathId });
  return {
    ok: true,
    record: tx.record,
    data: {
      branch: b.id,
      success: b.success,
      message: b.message,
      next_lesson: b.to === null ? null : ref(course.lessons[b.to]),
      path_complete: b.to === null,
      next: b.to === null ? 'Share the message. The path is complete; offer get_record.' : 'Share the message and why this branch was taken. Then call next_beat.',
    },
  };
}
