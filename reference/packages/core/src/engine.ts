// SPDX-License-Identifier: Apache-2.0
// Placement validation, branch rules and path walking.
// Ported and generalised from learn-wp-reimagined/src/shared/engine.ts.
import type { Branch, Checkpoint, Course } from './schema.ts';

export interface Placement { pathId: string; startLessonId: string; skip: string[]; reason: string }

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function validatePlacement(c: Course, raw: unknown): { ok: true; placement: Placement } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('placement must be an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.pathId !== 'string' || !has(c.paths, r.pathId)) {
    return fail(`unknown path; choose one of: ${Object.values(c.paths).filter((p) => p.status === 'live').map((p) => p.id).join(', ')}`);
  }
  const path = c.paths[r.pathId];
  if (path.status !== 'live') return fail('path is not live');
  if (typeof r.startLessonId !== 'string') return fail('startLessonId must be a string');
  const startIdx = path.lessons.indexOf(r.startLessonId);
  if (startIdx < 0) return fail(`startLessonId is not in the path; lessons in order: ${path.lessons.join(', ')}`);
  if (!Array.isArray(r.skip) || !r.skip.every((s) => typeof s === 'string')) return fail('skip must be an array of lesson ids');
  const before = new Set(path.lessons.slice(0, startIdx));
  if (!r.skip.every((s) => before.has(s as string))) return fail('skip may only contain lessons before the start lesson');
  if (typeof r.reason !== 'string' || r.reason.trim().length === 0 || r.reason.length > 300) return fail('reason must be 1 to 300 characters');
  return { ok: true, placement: { pathId: path.id, startLessonId: r.startLessonId, skip: [...new Set(r.skip as string[])], reason: r.reason } };
}

/**
 * The branches an agent may choose after a checkpoint submission.
 * checksPassed is null when the checkpoint has no deterministic checks.
 * A failed check leaves only the branches that do not count as a pass.
 */
export function allowedBranches(cp: Checkpoint, checksPassed: boolean | null): Branch[] {
  return checksPassed === false ? cp.branches.filter((b) => !b.success) : [...cp.branches];
}

export function nextLessonId(c: Course, pathId: string, afterLessonId: string | null, skip: string[]): string | null {
  if (!has(c.paths, pathId)) return null;
  const lessons = c.paths[pathId].lessons;
  const start = afterLessonId === null ? 0 : lessons.indexOf(afterLessonId) + 1;
  if (afterLessonId !== null && start === 0) return null;
  for (let i = start; i < lessons.length; i++) if (!skip.includes(lessons[i])) return lessons[i];
  return null;
}
