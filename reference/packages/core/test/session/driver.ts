// SPDX-License-Identifier: Apache-2.0
// Drives the session engine in tests: a deterministic env, step bookkeeping and statement helpers.
import { expect } from 'vitest';
import { CMI5 } from '../../src/constants.ts';
import type { CourseModel } from '../../src/model.ts';
import * as engine from '../../src/session/index.ts';
import type { Env, Step, StepData } from '../../src/session/index.ts';
import type { LearnerState, SatisfactionEvent } from '../../src/state.ts';
import { checkCmi5Order, checkProfile, validateStatement, type XapiStatement } from '../../src/xapi/index.ts';
import { COURSE_ID, course as fixture } from '../fixtures/course-model.ts';

export const START = Date.parse('2026-10-27T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

export interface TestEnv extends Env {
  advance(ms: number): void;
  readonly t: number;
}

export function makeEnv(over: Partial<Env> = {}): TestEnv {
  let t = START;
  let n = 0;
  const env: TestEnv = {
    now: () => iso(t),
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    actor: { objectType: 'Agent', account: { homePage: COURSE_ID, name: 'learner-1' } },
    custody: 'server-kept',
    practice: false,
    platform: 'test-client',
    advance: (ms: number) => {
      t += ms;
    },
    get t() {
      return t;
    },
    ...over,
  };
  return env;
}

/** One learner going through the engine: each step's state feeds the next; statements and events accumulate. */
export class Run {
  course: CourseModel;
  env: TestEnv;
  state: LearnerState | undefined;
  statements: XapiStatement[] = [];
  events: SatisfactionEvent[] = [];
  last: (Step<unknown> & { ok: true }) | undefined;

  constructor(course: CourseModel = fixture, env: TestEnv = makeEnv()) {
    this.course = course;
    this.env = env;
  }

  /** Runs one step; a refusal returns the error without changing anything. The clock moves 1 s after each call. */
  try<T>(fn: (state: LearnerState) => Step<T>): Step<T> {
    const r = fn(this.state as LearnerState);
    this.env.advance(1000);
    if (r.ok) {
      this.state = r.state;
      this.statements.push(...r.statements);
      this.events.push(...r.events);
      this.last = r as Step<unknown> & { ok: true };
    }
    return r;
  }

  /** Runs one step and fails the test on a refusal. */
  do<T = StepData>(fn: (state: LearnerState) => Step<T>): Step<T> & { ok: true } {
    const r = this.try(fn);
    if (!r.ok) throw new Error(`unexpected refusal: ${r.error}`);
    return r;
  }

  start() {
    return this.do((s) => engine.startPlacement(this.course, s, this.env));
  }
  place(pathKey = 'p', startLessonKey = 'a', skip: string[] = [], reason = 'New to the topic.') {
    return this.do((s) => engine.choosePlacement(this.course, s, { pathKey, startLessonKey, skip, reason }, this.env));
  }
  beat(learner_reply?: string) {
    return this.do((s) => engine.nextBeat(this.course, s, learner_reply === undefined ? {} : { learner_reply }, this.env));
  }
  code(content: string, file = 'config.json') {
    return this.do((s) => engine.checkCode(this.course, s, { file, content }, this.env));
  }
  submit(response: string, files?: Record<string, string>) {
    return this.do((s) => engine.submitCheckpoint(this.course, s, files ? { response, files } : { response }, this.env));
  }
  branch(branch: string, rationale = 'Fits the rubric.') {
    return this.do((s) => engine.chooseBranch(this.course, s, { branch, rationale }, this.env));
  }
  reveal() {
    return this.try((s) => engine.revealBug(this.course, s, this.env));
  }
  expire() {
    return this.do((s) => engine.expireSession(this.course, s, this.env));
  }

  /** From a fresh learner to lesson a's checkpoint, passing a's beats. */
  toCheckpointA() {
    this.start();
    this.place();
    this.beat();
    this.beat();
    return this.beat('No, it is a string.');
  }

  /** Lesson a passed, then lesson b up to its code checkpoint with the bug caught. */
  toCheckpointB() {
    this.toCheckpointA();
    this.submit('One is a number and one a string; a program compares numbers.');
    this.branch('ready');
    this.beat();
    this.beat();
    this.code('{"port":8080}');
    return this.beat();
  }
}

export const BAD_FILE = '{"port":8080}';
export const GOOD_FILE = '{"port":8080,"timeout":30}';

export const verbName = (s: XapiStatement) => Object.values(s.verb.display)[0]!;
export const verbs = (list: XapiStatement[]) => list.map(verbName);
export const isDefined = (s: XapiStatement) => (s.context.contextActivities?.category ?? []).some((a) => a.id === CMI5.categoryCmi5);
export const defined = (list: XapiStatement[]) => list.filter(isDefined);
export const sessionOf = (s: XapiStatement) => s.context.extensions?.[CMI5.extSessionId] as string;
export const strictlyIncreasing = (ts: string[]) => ts.every((t, i) => i === 0 || Date.parse(t) > Date.parse(ts[i - 1]!));

/** Every statement valid under xAPI 1.0.3 and 2.0 and the cxm profile, and the whole set in cmi5 order. */
export function expectClean(list: XapiStatement[], o: { lmsActor?: boolean } = {}) {
  for (const s of list) {
    expect(validateStatement(s), JSON.stringify(s)).toEqual([]);
    expect(checkProfile(s, o), JSON.stringify(s)).toEqual([]);
  }
  expect(checkCmi5Order(list)).toEqual([]);
}
