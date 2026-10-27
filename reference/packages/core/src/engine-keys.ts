// SPDX-License-Identifier: Apache-2.0
// Placement validation, branch rules and path walking over the key-based CourseModel.
// Ported from engine.ts (which stays until the legacy modules are removed).
import { LIMITS } from './learner-text.ts';
import type { Branch, Checkpoint, CourseModel } from './model.ts';
import type { Placement } from './state.ts';

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function validatePlacement(c: CourseModel, raw: unknown): { ok: true; placement: Placement } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('placement must be an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.pathKey !== 'string' || !has(c.paths, r.pathKey)) {
    return fail(`unknown path; choose one of: ${Object.values(c.paths).filter((p) => p.status === 'live').map((p) => p.key).join(', ')}`);
  }
  const path = c.paths[r.pathKey]!;
  if (path.status !== 'live') return fail('path is not live');
  if (typeof r.startLessonKey !== 'string') return fail('startLessonKey must be a string');
  const startIdx = path.lessons.indexOf(r.startLessonKey);
  if (startIdx < 0) return fail(`startLessonKey is not in the path; lessons in order: ${path.lessons.join(', ')}`);
  if (!Array.isArray(r.skip) || !r.skip.every((s) => typeof s === 'string')) return fail('skip must be an array of lesson keys');
  const before = new Set(path.lessons.slice(0, startIdx));
  if (!r.skip.every((s) => before.has(s as string))) return fail('skip may only contain lessons before the start lesson');
  if (typeof r.reason !== 'string' || r.reason.trim().length === 0 || r.reason.length > LIMITS.rationale) {
    return fail(`reason must be 1 to ${LIMITS.rationale} characters`);
  }
  return { ok: true, placement: { pathKey: path.key, startLessonKey: r.startLessonKey, skip: [...new Set(r.skip as string[])], reason: r.reason } };
}

/**
 * The branches an agent may choose after a checkpoint submission.
 * checksPassed is null when the checkpoint has no deterministic checks.
 * A failed check leaves only the branches that do not count as a pass.
 */
export function allowedBranches(cp: Checkpoint, checksPassed: boolean | null): Branch[] {
  return checksPassed === false ? cp.branches.filter((b) => !b.success) : [...cp.branches];
}

/** The first lesson after `afterLessonKey` (or the first in the path, for null) that is not in `skip`. */
export function nextLessonId(c: CourseModel, pathKey: string, afterLessonKey: string | null, skip: string[]): string | null {
  if (!has(c.paths, pathKey)) return null;
  const lessons = c.paths[pathKey]!.lessons;
  const start = afterLessonKey === null ? 0 : lessons.indexOf(afterLessonKey) + 1;
  if (afterLessonKey !== null && start === 0) return null;
  for (let i = start; i < lessons.length; i++) if (!skip.includes(lessons[i]!)) return lessons[i]!;
  return null;
}
