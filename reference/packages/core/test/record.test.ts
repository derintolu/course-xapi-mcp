// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { RECORD_FORMAT, parseRecord } from '../src/index.ts';
import { loadCourse } from './fixtures.ts';
import { runHappyPath } from './flow.ts';

const course = loadCourse();

describe('record round-trip', () => {
  it('survives JSON export and import unchanged', () => {
    const { record } = runHappyPath(course);
    const r = parseRecord(JSON.parse(JSON.stringify(record)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record).toEqual(record);
  });

  it('tracks completion, caught bugs, files and the cursor', () => {
    const { record } = runHappyPath(course);
    const st = record.courses['json-basics'];
    expect(st.completedLessons).toEqual(['what-is-json', 'fix-the-config']);
    expect(st.caughtBugs).toEqual(['fix-the-config/port-type']);
    expect(JSON.parse(st.files['config.json']).timeout).toBe(30);
    expect(st.cursor?.phase).toBe('done');
    expect(st.pending).toBeUndefined();
  });

  it.each([
    ['a foreign format', (r: any) => (r.format = 'something-else')],
    ['a newer version', (r: any) => (r.version = 2)],
    ['an invalid statement', (r: any) => (r.statements[0].actor.mbox = 'mailto:x@y.z')],
    ['a statement for another learner', (r: any) => (r.statements[0].actor.account.name = 'someone-else')],
    ['malformed course state', (r: any) => (r.courses['json-basics'].completedLessons = 'all')],
    ['a non-object', () => null],
  ])('rejects %s', (_, f) => {
    const { record } = runHappyPath(course);
    const raw: any = structuredClone(record);
    const out = f(raw);
    const r = parseRecord(out === null ? null : raw);
    expect(r.ok).toBe(false);
  });

  it('names its format', () => {
    expect(RECORD_FORMAT).toBe('learning-mcp/record');
  });
});
