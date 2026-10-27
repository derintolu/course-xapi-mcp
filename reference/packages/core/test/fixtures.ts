// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCourse, type Course } from '../src/index.ts';

const path = fileURLToPath(new URL('../../../../examples/json-basics/course.json', import.meta.url));

export const rawCourse = (): unknown => JSON.parse(readFileSync(path, 'utf8'));

export function loadCourse(): Course {
  const r = parseCourse(rawCourse());
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.course;
}

/** Deterministic clock and ids for tests. */
export function testCtx() {
  let t = Date.parse('2026-10-19T12:00:00.000Z');
  let n = 0;
  return {
    now: () => new Date((t += 1000)).toISOString(),
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    platform: 'test-client',
  };
}
