// SPDX-License-Identifier: Apache-2.0
// The cmi5 AU-session engine (`@course-xapi-mcp/core/session`): pure functions over (course, learner state, env).
export type { Env, LaunchBinding, NextAction, Step, StepData } from './env.ts';
export { REMOVED, endSession, expireSession, newState, restartCourse } from './au-session.ts';
export { choosePlacement, startPlacement, type PlacementIntro } from './placement.ts';
export { checkCode, nextBeat, revealBug } from './lesson.ts';
export { chooseBranch, submitCheckpoint } from './checkpoint.ts';
export { isSatisfied } from './satisfaction.ts';
export { getLesson, listPaths, status, type Status } from './status.ts';
export { allowedBranches, nextLessonId, validatePlacement } from '../engine-keys.ts';
