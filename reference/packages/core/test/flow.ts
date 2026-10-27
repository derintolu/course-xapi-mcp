// SPDX-License-Identifier: Apache-2.0
import { chooseBranch, checkCode, choosePlacement, nextBeat, startPlacement, submitCheckpoint, type Course, type LearningRecord, type SessionResult } from '../src/index.ts';
import { testCtx } from './fixtures.ts';

/** Drives the example course end to end through the session API, failing loudly on any refusal. */
export function runHappyPath(course: Course) {
  const ctx = testCtx();
  let record: LearningRecord = startPlacement(course, undefined, ctx).record!;
  const step = <T>(r: SessionResult<T>) => {
    if (!r.ok) throw new Error(r.error);
    record = r.record;
    return r.data;
  };
  step(choosePlacement(course, record, { pathId: 'json', startLessonId: 'what-is-json', skip: [], reason: 'New to JSON.' }, ctx));
  step(nextBeat(course, record, {}, ctx));
  step(nextBeat(course, record, { learner_reply: '"42" is a string because of the quotes.' }, ctx));
  step(nextBeat(course, record, { learner_reply: 'No, the trailing comma is an error.' }, ctx));
  step(submitCheckpoint(course, record, { response: 'One is a number, one is a string; a server may reject the string.' }, ctx));
  step(chooseBranch(course, record, { branch: 'ready', rationale: 'Names both types and a reason.' }, ctx));
  step(nextBeat(course, record, {}, ctx));
  step(nextBeat(course, record, { learner_reply: 'A string, so a program may treat "false" as truthy.' }, ctx));
  step(checkCode(course, record, { file: 'config.json', content: '{"name":"demo","port":"8080","debug":false}' }, ctx));
  step(checkCode(course, record, { file: 'config.json', content: '{"name":"demo","port":8080,"debug":false}' }, ctx));
  step(nextBeat(course, record, {}, ctx));
  step(
    submitCheckpoint(
      course,
      record,
      { response: 'timeout is a number because the program compares it with elapsed time.', files: { 'config.json': '{"name":"demo","port":8080,"debug":false,"timeout":30}' } },
      ctx,
    ),
  );
  step(chooseBranch(course, record, { branch: 'done', rationale: 'Checks passed and the reason is right.' }, ctx));
  return { record, ctx };
}
