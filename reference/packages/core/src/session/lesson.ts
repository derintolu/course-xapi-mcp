// SPDX-License-Identifier: Apache-2.0
// Lesson flow: beats, review walk-throughs, the planted bug and reveal_bug (design §6.3 rules 3 and 4, §9.5).
import { runChecks, type CheckResult } from '../checks.ts';
import { CXM_EXT, DEFAULTS, activityIds } from '../constants.ts';
import { nextLessonId } from '../engine-keys.ts';
import { LIMITS, wrapLearner } from '../learner-text.ts';
import type { CourseModel, LessonModel } from '../model.ts';
import type { LearnerState } from '../state.ts';
import { Tx, current, fail, fileError, ref, returnToLms, textError } from './au-session.ts';
import type { Env, Step, StepData } from './env.ts';
import { isSatisfied, progress, recordOutcome, settle } from './satisfaction.ts';

export const publicChecks = (rs: CheckResult[]) => rs.map((r) => ({ passed: r.passed, message: r.message }));

export const beatObject = (l: LessonModel, key: string) => ({ id: activityIds.beat(l.auId, key), kind: 'beat' as const, name: `${l.title}: ${key}` });
export const fileObject = (l: LessonModel, file: string) => ({ id: activityIds.file(l.auId, file), kind: 'file' as const, name: `${l.title}: ${file}` });

/** The revealAfter in force for a bug: the author's value, the default 3, or null when reveal is off. */
export const revealAfter = (bug: NonNullable<LessonModel['bug']>) => (bug.revealAfter === undefined ? DEFAULTS.revealAfter : bug.revealAfter);

function bugStep(l: LessonModel) {
  return {
    step: 'bug',
    lesson: ref(l),
    bug: { file: l.bug!.file, code: l.bug!.code, label: 'AI-written code. One bug was planted on purpose. Find it.' },
    instruction: 'Show the code and ask the learner to find and fix the bug. Do not reveal or hint at where it is. Send their whole fixed file with check_code.',
  };
}

export function checkpointStep(l: LessonModel, state: LearnerState) {
  const cp = l.checkpoint!;
  const saved = cp.file !== undefined && Object.prototype.hasOwnProperty.call(state.files, cp.file);
  const file = cp.file ? (saved ? wrapLearner(state.files[cp.file]!) : (l.starterFiles?.[cp.file] ?? null)) : null;
  return {
    step: 'checkpoint',
    lesson: ref(l),
    checkpoint: { key: cp.key, kind: cp.kind, question: cp.question, ...(cp.file ? { file: cp.file, current_file: file } : {}) },
    instruction:
      cp.kind === 'code'
        ? `Ask the question. The learner edits ${cp.file} by hand. They may test it with check_code. Then send their explanation word for word, and the file, with submit_checkpoint.`
        : "Ask the question and send the learner's answer word for word with submit_checkpoint.",
  };
}

function pathComplete(course: CourseModel, pathKey: string) {
  return {
    step: 'path-complete',
    path: { key: pathKey, title: course.paths[pathKey]!.title },
    instruction: 'Congratulate the learner. Offer get_record so they can see their record.',
  };
}

function beatData(l: LessonModel, i: number, extra: StepData = {}) {
  const b = l.beats[i]!;
  return {
    step: 'beat',
    lesson: ref(l),
    ...extra,
    position: { beat: i + 1, of: l.beats.length },
    beat: { key: b.key, goal: b.goal, content: b.content, question: b.question ?? null },
    sources: l.sources,
    instruction: b.question
      ? 'Teach this beat in your own words, then ask exactly the question. Wait for the learner, then call next_beat with their reply as learner_reply.'
      : 'Teach this beat in your own words and check in with the learner, then call next_beat.',
  };
}

/**
 * The lesson in the open session is resolved (moveOn met, or left): terminate, settle satisfaction and move the
 * cursor to the next lesson in the path that is not skipped or satisfied, or mark the path done.
 */
export function leaveForNext(tx: Tx, fromKey: string): Step<StepData> {
  const course = tx.course;
  const c = tx.state.cursor!;
  tx.close();
  settle(tx);
  const skip = [...(tx.state.placement?.skip ?? []), ...Object.keys(course.lessons).filter((k) => isSatisfied(course, tx.state, k))];
  const nextKey = nextLessonId(course, c.pathKey, fromKey, skip);
  const from = ref(course.lessons[fromKey]!);
  if (!nextKey) {
    tx.state.cursor = { ...c, phase: 'done' };
    return tx.finish({ ...pathComplete(course, c.pathKey), lesson: from }, { type: 'done' });
  }
  tx.state.cursor = { pathKey: c.pathKey, lessonKey: nextKey, beat: 0, phase: 'beats' };
  const next = tx.nextFor(nextKey);
  const to = course.lessons[nextKey]!;
  return tx.finish(
    {
      step: 'lesson-complete',
      lesson: from,
      next_lesson: ref(to),
      instruction: next.type === 'return-to-lms' ? `Send the learner back to their LMS to launch "${to.title}".` : 'Call next_beat to start the next lesson.',
    },
    next,
  );
}

/** What follows the last beat: the bug, then `completed`, then the checkpoint or the end of the lesson. */
function afterBeats(tx: Tx, l: LessonModel): Step<StepData> {
  const p = progress(tx.state, l.key);
  const c = tx.state.cursor!;
  if (l.bug && !p.bug) {
    c.phase = 'bug';
    return tx.finish(bugStep(l), { type: 'continue' });
  }
  if (!p.completed) recordOutcome(tx, l.key, 'completed');
  if (l.checkpoint) {
    c.phase = 'checkpoint';
    settle(tx);
    return tx.finish(checkpointStep(l, tx.state), { type: 'continue' });
  }
  return leaveForNext(tx, l.key);
}

export function nextBeat(course: CourseModel, state: LearnerState, input: { learner_reply?: unknown }, env: Env): Step<StepData> {
  const cur = current(course, state);
  if (!cur.ok) return cur;
  const { cursor, lesson: l } = cur;
  if (cursor.phase === 'branch') return fail('a checkpoint answer is waiting for a branch; call choose_branch');
  const tx = new Tx(course, state, env);
  if (cursor.phase === 'done') return tx.finish(pathComplete(course, cursor.pathKey), { type: 'done' });
  if (cursor.awaitingReply) {
    const err = textError('learner_reply', input.learner_reply, LIMITS.text);
    if (err) return fail(`the last beat asked the learner a question; ask it, wait, and pass their answer word for word as learner_reply (${err})`);
  }
  if (!tx.enter(l.key)) return returnToLms(tx, l);
  const c = tx.state.cursor!;

  if (c.awaitingReply) {
    const owner = c.review ? course.lessons[c.review.lessonKey]! : l;
    const index = (c.review ? c.review.beat : c.beat) - 1;
    tx.allowed('answered', beatObject(owner, owner.beats[index]!.key), owner.key, { response: input.learner_reply as string });
    delete c.awaitingReply;
  }

  switch (c.phase) {
    case 'bug':
      return tx.finish(bugStep(l), { type: 'continue' });
    case 'checkpoint':
      return tx.finish(checkpointStep(l, tx.state), { type: 'continue' });
    case 'review': {
      const rv = c.review!;
      const target = course.lessons[rv.lessonKey]!;
      if (rv.beat < target.beats.length) {
        const b = target.beats[rv.beat]!;
        tx.allowed('experienced', beatObject(target, b.key), target.key);
        const data = { ...beatData(target, rv.beat, { review_for: ref(l) }), step: 'review', lesson: ref(l), review_of: ref(target) };
        rv.beat += 1;
        if (b.question) c.awaitingReply = true;
        return tx.finish(data, { type: 'continue' });
      }
      delete c.review;
      c.phase = 'checkpoint';
      return tx.finish({ ...checkpointStep(l, tx.state), review_done: ref(target) }, { type: 'continue' });
    }
    default: {
      if (c.beat < l.beats.length) {
        const b = l.beats[c.beat]!;
        tx.allowed('experienced', beatObject(l, b.key), l.key);
        const data = beatData(l, c.beat);
        c.beat += 1;
        if (b.question) c.awaitingReply = true;
        return tx.finish(data, { type: 'continue' });
      }
      return afterBeats(tx, l);
    }
  }
}

export function checkCode(course: CourseModel, state: LearnerState, input: { file?: unknown; content?: unknown }, env: Env): Step<StepData> {
  const cur = current(course, state);
  if (!cur.ok) return cur;
  const err = fileError(input.file, input.content);
  if (err) return fail(err);
  const file = input.file as string;
  const content = input.content as string;
  const { lesson: l, cursor } = cur;
  const cp = l.checkpoint;
  const atBug = cursor.phase === 'bug' && l.bug !== undefined;
  const atCode = cursor.phase === 'checkpoint' && cp?.kind === 'code';
  if (!atBug && !atCode) return fail('there is no code to check at this step; call next_beat to see the current step');
  if (atBug && file !== l.bug!.file) return fail(`the planted bug is in ${l.bug!.file}; send that whole file`);
  if (atCode && file !== cp!.file) return fail(`this checkpoint checks ${cp!.file}`);

  const tx = new Tx(course, state, env);
  if (!tx.enter(l.key)) return returnToLms(tx, l);
  tx.state.files[file] = content;

  if (atBug) {
    const bug = l.bug!;
    const r = runChecks(bug.fixChecks, { [file]: content });
    // Per-check results are neither recorded nor returned for a planted bug: they would point at it.
    tx.allowed(r.passed ? 'passed' : 'failed', fileObject(l, file), l.key, { success: r.passed, extensions: { [CXM_EXT.checks]: [] } });
    const p = progress(tx.state, l.key);
    if (!r.passed) {
      p.fixAttempts += 1;
      const after = revealAfter(bug);
      return tx.finish(
        {
          file,
          passed: false,
          hint: bug.hint ?? null,
          fix_attempts: p.fixAttempts,
          can_reveal: after !== null && p.fixAttempts >= after,
          instruction: 'Not fixed yet. Give the authored hint if it helps, without pointing at the bug, and let the learner try again.',
        },
        { type: 'continue' },
      );
    }
    tx.allowed('caught', { id: activityIds.bug(l.auId, bug.key), kind: 'planted-bug', name: `${l.title}: planted bug` }, l.key, { success: true });
    p.bug = 'caught';
    Object.assign(tx.state.cursor!, { phase: 'beats', beat: l.beats.length });
    return tx.finish(
      { file, passed: true, caught: true, explanation: bug.explanation, instruction: 'Ask the learner to explain what was wrong before you share the explanation. Then call next_beat.' },
      { type: 'continue' },
    );
  }

  const r = runChecks(cp!.checks ?? [], { [file]: content });
  tx.allowed(r.passed ? 'passed' : 'failed', fileObject(l, file), l.key, {
    success: r.passed,
    extensions: { [CXM_EXT.checks]: r.results.map(({ index, passed }) => ({ index, passed })) },
  });
  return tx.finish(
    { file, passed: r.passed, checks: publicChecks(r.results), instruction: 'Use the check messages as hints. When the learner is ready, call submit_checkpoint.' },
    { type: 'continue' },
  );
}

/** Reveals the planted bug after `revealAfter` failed fixes. The bug does not count as caught; the lesson can still pass. */
export function revealBug(course: CourseModel, state: LearnerState, env: Env): Step<StepData> {
  const cur = current(course, state);
  if (!cur.ok) return cur;
  const { lesson: l, cursor } = cur;
  const bug = l.bug;
  if (cursor.phase !== 'bug' || !bug) return fail('there is no planted bug to reveal at this step; call next_beat to see the current step');
  const after = revealAfter(bug);
  if (after === null) return fail('the author turned reveal_bug off for this lesson; keep helping the learner find the bug with hints');
  const tries = state.au[l.key]?.fixAttempts ?? 0;
  if (tries < after) return fail(`reveal_bug is allowed after ${after} failed fix attempts; the learner has made ${tries}. Keep helping with hints.`);

  const tx = new Tx(course, state, env);
  if (!tx.enter(l.key)) return returnToLms(tx, l);
  tx.allowed('revealed', { id: activityIds.bug(l.auId, bug.key), kind: 'planted-bug', name: `${l.title}: planted bug` }, l.key);
  progress(tx.state, l.key).bug = 'revealed';
  Object.assign(tx.state.cursor!, { phase: 'beats', beat: l.beats.length });
  return tx.finish(
    {
      revealed: true,
      file: bug.file,
      explanation: bug.explanation,
      instruction: 'Walk the learner through the explanation and let them fix the file. The bug counts as revealed, not caught. Then call next_beat.',
    },
    { type: 'continue' },
  );
}
