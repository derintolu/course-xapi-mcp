// SPDX-License-Identifier: Apache-2.0
// AU outcomes, waivers and block/course satisfaction in the LMS role (design §6.3 rules 3, 5 and 6).
import type { CourseModel } from '../model.ts';
import type { AuProgress, LearnerState } from '../state.ts';
import { has, unitOf, type Tx } from './au-session.ts';

/** The learner's progress on lesson `key`, created empty when missing. */
export function progress(state: LearnerState, key: string): AuProgress {
  if (!has(state.au, key)) state.au[key] = { completed: false, passed: false, failed: false, carriedOver: false, fixAttempts: 0 };
  return state.au[key]!;
}

/** True when the lesson's moveOn is met in this registration (completed, completed and passed, or waived). */
export function isSatisfied(course: CourseModel, state: LearnerState, key: string): boolean {
  const l = course.lessons[key];
  const p = has(state.au, key) ? state.au[key] : undefined;
  if (!l || !p) return false;
  if (p.waived) return true;
  return l.moveOn === 'Completed' ? p.completed : p.completed && p.passed;
}

/** Sends the defined `completed`, `passed` or `failed` on the open session's AU and records it; reports a newly met moveOn. */
export function recordOutcome(tx: Tx, key: string, verb: 'completed' | 'passed' | 'failed'): void {
  const session = tx.state.session!;
  const was = isSatisfied(tx.course, tx.state, key);
  const s = tx.definedAu(verb, session);
  progress(tx.state, key)[verb] = true;
  if (verb === 'failed') return;
  tx.outcomeSession = session.id;
  if (!was && isSatisfied(tx.course, tx.state, key)) tx.events.push({ type: 'au', lessonKey: key, statementId: s.id, waived: false, carriedOver: false });
}

/** Waives lesson `key` with reason "Tested Out", in its own session (options 2-4; the LMS role). */
export function waive(tx: Tx, key: string): void {
  const sessionId = tx.env.uuid();
  const u = unitOf(tx.course, key)!;
  const was = isSatisfied(tx.course, tx.state, key);
  const s = tx.definedLms('waived', sessionId, { au: tx.target(key, u.auId) }, 'Tested Out');
  progress(tx.state, key).waived = 'Tested Out';
  tx.outcomeSession = sessionId;
  if (!was) tx.events.push({ type: 'au', lessonKey: key, statementId: s.id, waived: true, carriedOver: false });
}

/**
 * Sends `satisfied` for each newly satisfied block, then the course, in the session of the latest outcome
 * (options 2-4). In option 1 only the LMS may do this, so nothing is sent.
 */
export function settle(tx: Tx): void {
  const sessionId = tx.outcomeSession;
  if (tx.option1 || !sessionId) return;
  const sat = tx.state.satisfied;
  const blocks = Object.values(tx.course.paths).filter((p) => p.status === 'live' && p.blockId);
  for (const p of blocks) {
    if (sat.blocks.includes(p.key) || !p.lessons.every((k) => isSatisfied(tx.course, tx.state, k))) continue;
    const s = tx.definedLms('satisfied', sessionId, { blockId: p.blockId! });
    sat.blocks.push(p.key);
    tx.events.push({ type: 'block', pathKey: p.key, statementId: s.id });
  }
  if (!sat.course && blocks.length > 0 && blocks.every((p) => sat.blocks.includes(p.key))) {
    const s = tx.definedLms('satisfied', sessionId, { courseId: tx.course.id });
    sat.course = true;
    tx.events.push({ type: 'course', statementId: s.id });
  }
}
