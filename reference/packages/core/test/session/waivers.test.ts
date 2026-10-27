// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { CMI5, CXM_EXT } from '../../src/constants.ts';
import { choosePlacement } from '../../src/session/index.ts';
import { COURSE_ID } from '../fixtures/course-model.ts';
import { Run, expectClean, sessionOf, verbName, verbs } from './driver.ts';

describe('session engine: waivers (options 2-4)', () => {
  it('placement skips and forward success branches waive with reason Tested Out (options 2-4)', () => {
    const run = new Run();
    run.start();
    const placed = run.place('p', 'b', ['a'], 'Already knows lesson A.');
    expect(verbs(placed.statements)).toEqual(['placed', 'terminated', 'waived']);
    const [p, term, w] = placed.statements as [typeof placed.statements[0], typeof placed.statements[0], typeof placed.statements[0]];
    expect(p.result!.extensions).toMatchObject({ [CXM_EXT['start-lesson']]: `${COURSE_ID}/lessons/b`, [CXM_EXT.skipped]: [`${COURSE_ID}/lessons/a`] });
    expect(p.result!.extensions![CXM_EXT['waive-recommended']]).toBeUndefined();
    expect(w.object.id).toBe(`${COURSE_ID}/lessons/a/au`);
    expect(w.result).toMatchObject({ success: true, completion: true, extensions: { [CMI5.extReason]: 'Tested Out' } });
    expect(sessionOf(w)).not.toBe(sessionOf(term));
    expect(placed.data).toMatchObject({ waived: ['a'], start_lesson: { key: 'b' } });
    expect(placed.events).toEqual([{ type: 'au', lessonKey: 'a', statementId: w.id, waived: true, carriedOver: false }]);
    expect(run.state!.au.a!.waived).toBe('Tested Out');
    expectClean(run.statements);
  });

  it('a forward success branch waives each jumped lesson in its own session, and waived lessons count towards the block', () => {
    const run = new Run();
    run.toCheckpointA();
    run.submit('I already know all of B.');
    const r = run.branch('skip', 'Knows B already.');
    expect(verbs(r.statements)).toEqual(['passed', 'branched', 'passed', 'terminated', 'waived']);
    const waived = r.statements.find((s) => verbName(s) === 'waived')!;
    expect(waived.object.id).toBe(`${COURSE_ID}/lessons/b/au`);
    const lessonSession = sessionOf(r.statements[0]!);
    expect(sessionOf(waived)).not.toBe(lessonSession);
    expect(r.data).toMatchObject({ waived: ['b'], next_lesson: { key: 'c' } });
    expect(r.events.map((e) => e.type === 'au' && [e.lessonKey, e.waived])).toEqual([['a', false], ['b', true]]);
    expect(run.state!.cursor).toMatchObject({ lessonKey: 'c', phase: 'beats' });

    run.beat();
    const end = run.beat();
    expect(verbs(end.statements)).toEqual(['completed', 'terminated', 'satisfied']);
    expect(end.events.map((e) => e.type)).toEqual(['au', 'block']);
    expectClean(run.statements);
  });

  it('a lesson already satisfied is not waived again', () => {
    const run = new Run();
    run.toCheckpointA();
    run.submit('Ready.');
    run.branch('ready');
    run.start();
    const again = run.place('p', 'c', ['a', 'b'], 'Placed again.');
    expect(again.statements.filter((s) => verbName(s) === 'waived').map((s) => s.object.id)).toEqual([`${COURSE_ID}/lessons/b/au`]);
  });

  it('satisfying every block sends satisfied for the course after the last block', () => {
    const run = new Run();
    run.start();
    run.place('p', 'c', ['a', 'b'], 'Knows A and B.');
    run.beat();
    const p = run.beat();
    expect(verbs(p.statements)).toEqual(['completed', 'terminated', 'satisfied']);
    run.start();
    run.place('q', 'q1', [], 'Wants q too.');
    run.beat();
    const q = run.beat();
    expect(verbs(q.statements)).toEqual(['completed', 'terminated', 'satisfied', 'satisfied']);
    expect(q.statements.at(-2)!.object.id).toBe(`${COURSE_ID}/paths/q`);
    expect(q.statements.at(-1)!.object.id).toBe(COURSE_ID);
    expect(q.events.map((e) => e.type)).toEqual(['au', 'block', 'course']);
    expect(run.state!.satisfied).toEqual({ blocks: ['p', 'q'], course: true });
    expectClean(run.statements);
  });

  it('refuses an invalid placement and records nothing', () => {
    const run = new Run();
    run.start();
    const before = run.statements.length;
    const r = run.try((s) => choosePlacement(run.course, s, { pathKey: 'p', startLessonKey: 'b', skip: ['c'], reason: 'x' }, run.env));
    expect(r).toEqual({ ok: false, error: 'skip may only contain lessons before the start lesson' });
    expect(run.statements.length).toBe(before);
  });
});
