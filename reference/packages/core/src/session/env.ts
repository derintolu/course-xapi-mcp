// SPDX-License-Identifier: Apache-2.0
// What the session engine is given per call, and what each engine step returns.
import type { CustodyOption } from '../model.ts';
import type { LearnerState, SatisfactionEvent } from '../state.ts';
import type { ContextTemplate, XapiAgent, XapiStatement } from '../xapi/types.ts';

/** The cmi5 launch this call is bound to (option 1 only), taken from the bridge's `LaunchContext`. */
export interface LaunchBinding {
  auKey: string;
  activityId: string;
  registration: string;
  sessionId: string;
  contextTemplate: ContextTemplate;
  launchMode: 'Normal' | 'Browse' | 'Review';
  returnURL?: string;
  /** True once this launch's session was terminated (`LaunchContext.terminatedAt` is set); the learner must relaunch from the LMS. */
  ended?: boolean;
}

/** Clock, id source, learner and custody for one call. Injected so tests are deterministic. */
export interface Env {
  now(): string;
  uuid(): string;
  actor: XapiAgent;
  custody: CustodyOption;
  practice: boolean;
  language?: string;
  platform?: string;
  launch?: LaunchBinding;
}

export type NextAction = { type: 'continue' } | { type: 'return-to-lms'; returnURL?: string; lessonKey: string } | { type: 'done' };

export type Step<T> =
  | { ok: true; state: LearnerState; statements: XapiStatement[]; events: SatisfactionEvent[]; data: T; next?: NextAction }
  | { ok: false; error: string };

/** Result data the server passes on to the agent. */
export type StepData = Record<string, unknown>;
