// SPDX-License-Identifier: Apache-2.0
// Shared inputs for the cmi5-shaped xAPI tests.
import type { Cmi5Context } from '../src/xapi/index.ts';

export const COURSE = 'https://course-xapi-mcp.sqwrlz.com/examples/json-basics';
export const AU = COURSE + '/lessons/what-is-json';
export const AU_REF = { publisherId: AU, activityId: AU + '/au' };
export const REG = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
export const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

export function ctx(over: Partial<Cmi5Context> = {}): Cmi5Context {
  return {
    actor: { objectType: 'Agent', account: { homePage: COURSE, name: 'learner-1' } },
    registration: REG,
    sessionId: SESSION,
    courseId: COURSE,
    language: 'en',
    rulesVersion: '0.2',
    custody: 'server-kept',
    practice: false,
    platform: 'test-client',
    ...over,
  };
}

/** Deterministic statement ids and timestamps, 1 ms apart. */
export function clock(start = '2026-10-27T12:00:00.000Z') {
  let t = Date.parse(start);
  let n = 0;
  return () => ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, timestamp: new Date(t++).toISOString() });
}
