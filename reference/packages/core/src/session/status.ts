// SPDX-License-Identifier: Apache-2.0
// Read-only views: position and next tools, the path list and a lesson outline. Never secrets.
import type { CourseModel } from '../model.ts';
import type { LearnerState, Phase } from '../state.ts';
import { cursorRemoved, fail, has, ref } from './au-session.ts';
import type { Env } from './env.ts';
import { revealAfter } from './lesson.ts';

export interface Status {
  position: { pathKey?: string; lessonKey?: string; phase?: Phase };
  next: string[];
}

/** Where the learner is and which tools fit next. */
export function status(course: CourseModel, state: LearnerState | undefined, _env: Env): Status {
  const c = state?.cursor;
  if (!state || !c) return { position: {}, next: state?.session?.auKey === course.placement.key ? ['choose_placement'] : ['start_placement'] };
  if (cursorRemoved(course, c)) return { position: {}, next: ['choose_placement'] };
  const position = { pathKey: c.pathKey, lessonKey: c.lessonKey, phase: c.phase };
  const l = course.lessons[c.lessonKey]!;
  const open = state.session ? ['end_session'] : [];
  switch (c.phase) {
    case 'beats':
    case 'review':
      return { position, next: ['next_beat', ...open] };
    case 'bug': {
      const after = revealAfter(l.bug!);
      const canReveal = after !== null && (state.au[l.key]?.fixAttempts ?? 0) >= after;
      return { position, next: ['check_code', ...(canReveal ? ['reveal_bug'] : []), ...open] };
    }
    case 'checkpoint':
      return { position, next: [...(l.checkpoint?.kind === 'code' ? ['check_code'] : []), 'submit_checkpoint', ...open] };
    case 'branch':
      return { position, next: ['choose_branch', ...open] };
    case 'done':
      return { position, next: ['get_record', 'restart_course'] };
  }
}

export function listPaths(course: CourseModel) {
  return {
    course: { id: course.id, title: course.title, description: course.description, version: course.version, language: course.language, license: course.license ?? null },
    paths: Object.values(course.paths).map((p) => ({
      key: p.key,
      title: p.title,
      tagline: p.tagline,
      status: p.status,
      lessons: p.lessons.filter((k) => has(course.lessons, k)).map((k) => ref(course.lessons[k]!)),
    })),
  };
}

export function getLesson(course: CourseModel, lessonKey: string) {
  if (typeof lessonKey !== 'string' || !has(course.lessons, lessonKey)) return fail(`unknown lesson; lessons: ${Object.keys(course.lessons).join(', ')}`);
  const l = course.lessons[lessonKey]!;
  return {
    ok: true as const,
    data: {
      lesson: { ...ref(l), pathKey: l.pathKey, description: l.description, minutes: l.minutes, sources: l.sources },
      beats: l.beats.map((b) => ({ key: b.key, goal: b.goal })),
      has_planted_bug: Boolean(l.bug),
      checkpoint: l.checkpoint ? { kind: l.checkpoint.kind, question: l.checkpoint.question } : null,
    },
  };
}
