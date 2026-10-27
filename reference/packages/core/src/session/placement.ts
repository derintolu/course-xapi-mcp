// SPDX-License-Identifier: Apache-2.0
// Placement: the placement AU session, the placed statement and skip waivers (design §6.3 rule 5).
import { CXM_EXT } from '../constants.ts';
import { validatePlacement } from '../engine-keys.ts';
import type { CourseModel } from '../model.ts';
import type { LearnerState } from '../state.ts';
import { Tx, fail, newState, ref, returnToLms } from './au-session.ts';
import type { Env, Step, StepData } from './env.ts';
import { isSatisfied, settle, waive } from './satisfaction.ts';

export interface PlacementIntro {
  intro: string;
  maxQuestions: number;
  paths: { key: string; title: string; tagline: string; hints: string | null; lessons: { key: string; title: string }[] }[];
  instruction: string;
}

/** The activity id of a path: its cmi5 block id. */
export const pathActivityId = (course: CourseModel, pathKey: string) => course.paths[pathKey]!.blockId ?? `${course.id}/paths/${encodeURIComponent(pathKey)}`;

/** Opens the placement AU session and returns the placement guide. */
export function startPlacement(course: CourseModel, state: LearnerState | undefined, env: Env): Step<PlacementIntro | StepData> {
  const tx = new Tx(course, state ?? newState(course, env), env);
  const p = course.placement;
  if (!tx.enter(p.key)) return returnToLms(tx, p);
  const live = Object.values(course.paths).filter((x) => x.status === 'live');
  return tx.finish(
    {
      intro: p.intro,
      maxQuestions: p.maxQuestions,
      paths: live.map((x) => ({ key: x.key, title: x.title, tagline: x.tagline, hints: x.placementHints ?? null, lessons: x.lessons.map((k) => ref(course.lessons[k]!)) })),
      instruction: `Ask the learner at most ${p.maxQuestions} short questions, one at a time. Then call choose_placement with a pathKey, a startLessonKey from that path, the lessons before it to skip, and a one-sentence reason.`,
    },
    { type: 'continue' },
  );
}

/**
 * Records the placement (`placed` in the placement session, which then terminates) and moves the cursor to the
 * start lesson. Skipped lessons are waived "Tested Out" in options 2-4, or listed in `waive-recommended` in option 1.
 */
export function choosePlacement(course: CourseModel, state: LearnerState, input: unknown, env: Env): Step<StepData> {
  const v = validatePlacement(course, input);
  if (!v.ok) return fail(v.error);
  const pl = v.placement;
  const tx = new Tx(course, state, env);
  const p = course.placement;
  if (!tx.enter(p.key)) return returnToLms(tx, p);

  const toWaive = pl.skip.filter((k) => !isSatisfied(course, tx.state, k));
  const auIds = (keys: string[]) => keys.map((k) => course.lessons[k]!.auId);
  tx.allowed('placed', { id: pathActivityId(course, pl.pathKey), kind: 'path', name: course.paths[pl.pathKey]!.title }, p.key, {
    response: pl.reason,
    extensions: {
      [CXM_EXT['start-lesson']]: course.lessons[pl.startLessonKey]!.auId,
      [CXM_EXT.skipped]: auIds(pl.skip),
      ...(tx.option1 && toWaive.length ? { [CXM_EXT['waive-recommended']]: auIds(toWaive) } : {}),
    },
  });
  tx.state.placement = pl;
  tx.state.cursor = { pathKey: pl.pathKey, lessonKey: pl.startLessonKey, beat: 0, phase: 'beats' };
  delete tx.state.pending;
  tx.close();
  if (!tx.option1) for (const k of toWaive) waive(tx, k);
  settle(tx);

  const start = course.lessons[pl.startLessonKey]!;
  const next = tx.nextFor(start.key);
  return tx.finish(
    {
      placed: { pathKey: pl.pathKey, startLessonKey: pl.startLessonKey, skip: pl.skip },
      start_lesson: ref(start),
      ...(tx.option1 ? { waive_recommended: toWaive } : { waived: toWaive }),
      instruction: next.type === 'return-to-lms' ? `Send the learner back to their LMS to launch "${start.title}".` : 'Call next_beat to get the first beat.',
    },
    next,
  );
}
