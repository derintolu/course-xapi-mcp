// SPDX-License-Identifier: Apache-2.0
// Checkpoints and branches: retries, maxAttempts, review instead of redo, and jump waivers (design §6.3 rules 2, 4, 5).
import { runChecks, type CheckResult } from '../checks.ts';
import { CXM_EXT, activityIds } from '../constants.ts';
import { allowedBranches } from '../engine-keys.ts';
import { LIMITS, wrapLearner } from '../learner-text.ts';
import type { CourseModel, LessonModel } from '../model.ts';
import type { LearnerState } from '../state.ts';
import { REMOVED, Tx, current, fail, fileError, has, ref, returnToLms, textError } from './au-session.ts';
import type { Env, Step, StepData } from './env.ts';
import { fileObject, publicChecks } from './lesson.ts';
import { isSatisfied, progress, recordOutcome, settle, waive } from './satisfaction.ts';

const checkpointObject = (l: LessonModel) => ({ id: activityIds.checkpoint(l.auId, l.checkpoint!.key), kind: 'checkpoint' as const, name: `${l.title}: checkpoint` });

export function submitCheckpoint(course: CourseModel, state: LearnerState, input: { response?: unknown; files?: unknown }, env: Env): Step<StepData> {
  const cur = current(course, state);
  if (!cur.ok) return cur;
  const { lesson: l, cursor } = cur;
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
    content ??= has(state.files, cp.file!) ? state.files[cp.file!] : undefined;
    if (content === undefined) return fail(`send ${cp.file} in files`);
    const r = runChecks(cp.checks ?? [], { [cp.file!]: content });
    checksPassed = r.passed;
    results = r.results;
  }
  const allowed = allowedBranches(cp, checksPassed);

  const tx = new Tx(course, state, env);
  if (!tx.enter(l.key)) return returnToLms(tx, l);
  tx.allowed('answered', checkpointObject(l), l.key, { response });
  if (results) {
    tx.state.files[cp.file!] = content!;
    tx.allowed(checksPassed ? 'passed' : 'failed', fileObject(l, cp.file!), l.key, {
      success: checksPassed!,
      extensions: { [CXM_EXT.checks]: results.map(({ index, passed }) => ({ index, passed })) },
    });
  }
  tx.state.pending = { lessonKey: l.key, checkpointKey: cp.key, checksPassed, allowed: allowed.map((b) => b.key) };
  tx.state.cursor!.phase = 'branch';
  return tx.finish(
    {
      lesson: ref(l),
      question: cp.question,
      rubric: cp.rubric,
      learner_response: wrapLearner(response),
      checks_passed: checksPassed,
      ...(results ? { checks: publicChecks(results) } : {}),
      allowed_branches: allowed.map((b) => ({ key: b.key, when: b.when })),
      instruction: 'Judge the learner response against the rubric and the "when" text only. Then call choose_branch with one allowed branch key and a one-sentence rationale.',
    },
    { type: 'continue' },
  );
}

/** Lessons strictly between `from` and `to` in the path, when `to` is further ahead. */
function jumpedOver(course: CourseModel, pathKey: string, from: string, to: string): string[] {
  const lessons = course.paths[pathKey]!.lessons;
  const i = lessons.indexOf(from);
  const j = lessons.indexOf(to);
  return i >= 0 && j > i + 1 ? lessons.slice(i + 1, j) : [];
}

export function chooseBranch(course: CourseModel, state: LearnerState, input: { branch?: unknown; rationale?: unknown }, env: Env): Step<StepData> {
  const cur = current(course, state);
  if (!cur.ok) return cur;
  const p = state.pending;
  if (!p || cur.cursor.phase !== 'branch') return fail('there is no submitted checkpoint to branch from; call submit_checkpoint first');
  const allowedList = p.allowed.join(', ');
  if (typeof input.branch !== 'string' || !p.allowed.includes(input.branch)) {
    return fail(`"${String(input.branch).slice(0, 64)}" is not an allowed branch here; choose one of: ${allowedList}`);
  }
  const err = textError('rationale', input.rationale, LIMITS.rationale);
  if (err) return fail(`${err}; allowed branches: ${allowedList}`);
  const l = course.lessons[p.lessonKey];
  const b = l?.checkpoint?.branches.find((x) => x.key === input.branch);
  if (!l || !b || (b.to !== null && !has(course.lessons, b.to))) return fail(REMOVED);

  const tx = new Tx(course, state, env);
  if (!tx.enter(l.key)) return returnToLms(tx, l);
  const cp = l.checkpoint!;
  const s = tx.state.session!;
  const c = tx.state.cursor!;
  const jumped = b.success && b.to !== null ? jumpedOver(course, c.pathKey, l.key, b.to).filter((k) => !isSatisfied(course, tx.state, k)) : [];

  if (!b.success) s.attempts += 1;
  tx.allowed(b.success ? 'passed' : 'failed', checkpointObject(l), l.key, { success: b.success, ...(b.success ? {} : { extensions: { [CXM_EXT.attempt]: s.attempts } }) });
  tx.allowed('branched', checkpointObject(l), l.key, {
    extensions: {
      [CXM_EXT.branch]: b.key,
      [CXM_EXT.to]: b.to === null ? null : course.lessons[b.to]!.auId,
      [CXM_EXT.rationale]: input.rationale as string,
      ...(tx.option1 && jumped.length ? { [CXM_EXT['waive-recommended']]: jumped.map((k) => course.lessons[k]!.auId) } : {}),
    },
  });
  delete tx.state.pending;

  const prog = progress(tx.state, l.key);
  if (b.success) {
    if (!prog.passed) recordOutcome(tx, l.key, 'passed');
    // A success branch resolves the lesson visit: its session ends, even when the branch stays in or reviews it.
    tx.close();
  } else if (cp.maxAttempts !== undefined && s.attempts >= cp.maxAttempts) {
    // A defined failed never follows a defined passed in the registration (cmi5 9.3.5).
    if (!prog.passed) recordOutcome(tx, l.key, 'failed');
    tx.close();
  }

  const shared = { branch: b.key, success: b.success, message: b.message };
  if (b.to === null) {
    tx.close();
    settle(tx);
    c.phase = 'done';
    return tx.finish({ ...shared, path_complete: true, next_lesson: null, instruction: 'Share the message. The path is complete; offer get_record.' }, { type: 'done' });
  }
  if (b.to === l.key) {
    Object.assign(c, { beat: 0, phase: 'beats' });
    delete c.awaitingReply;
    settle(tx);
    return tx.finish({ ...shared, next_lesson: ref(l), instruction: 'Share the message and why this branch was taken. The lesson starts again from its first beat: call next_beat.' }, { type: 'continue' });
  }
  const target = course.lessons[b.to]!;
  if (isSatisfied(course, tx.state, b.to)) {
    c.phase = 'review';
    c.review = { lessonKey: b.to, beat: 0 };
    settle(tx);
    return tx.finish(
      { ...shared, review_of: ref(target), instruction: `Share the message. The learner reviews "${target.title}" here, then comes back to this checkpoint: call next_beat.` },
      { type: 'continue' },
    );
  }
  tx.close();
  if (!tx.option1) for (const k of jumped) waive(tx, k);
  settle(tx);
  tx.state.cursor = { pathKey: c.pathKey, lessonKey: b.to, beat: 0, phase: 'beats' };
  const next = tx.nextFor(b.to);
  return tx.finish(
    {
      ...shared,
      next_lesson: ref(target),
      ...(jumped.length ? (tx.option1 ? { waive_recommended: jumped } : { waived: jumped }) : {}),
      instruction:
        next.type === 'return-to-lms'
          ? `Share the message, then send the learner back to their LMS to launch "${target.title}".`
          : 'Share the message and why this branch was taken. Then call next_beat.',
    },
    next,
  );
}
