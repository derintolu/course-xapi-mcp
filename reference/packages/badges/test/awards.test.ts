// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { SatisfactionEvent } from '@course-xapi-mcp/core';
import { awardsFor } from '../src/index.ts';
import { badge, course, state } from './fixtures.ts';

const REG = '11111111-1111-4111-8111-111111111111';
const auEvent = (lessonKey: string, o: Partial<{ waived: boolean; carriedOver: boolean }> = {}): SatisfactionEvent => ({
  type: 'au',
  lessonKey,
  statementId: 'st-' + lessonKey,
  waived: false,
  carriedOver: false,
  ...o,
});
const blockEvent = (pathKey: string): SatisfactionEvent => ({ type: 'block', pathKey, statementId: 'st-block-' + pathKey });

describe('awardsFor', () => {
  it('gives one award per badge per registration', () => {
    const c = course([badge({ id: 'https://course.example/badges/a1', awardOn: 'au-moveon', for: 'a1' })]);
    const first = awardsFor(c, state({ a1: {} }), [auEvent('a1'), auEvent('a1')]);
    expect(first).toEqual([{ badgeId: 'https://course.example/badges/a1', registration: REG, earningStatementId: 'st-a1', testedOut: 0 }]);
    const again = awardsFor(c, state({ a1: {} }, [{ badgeId: 'https://course.example/badges/a1', statementId: 'x' }]), [auEvent('a1')]);
    expect(again).toEqual([]);
  });

  it('ignores au events for other lessons', () => {
    const c = course([badge({ id: 'b-a1', awardOn: 'au-moveon', for: 'a1' })]);
    expect(awardsFor(c, state(), [auEvent('a2')])).toEqual([]);
  });

  it('gives no lesson badge for a waived lesson without countWaived, and one with it', () => {
    const tested = state({ a1: { waived: 'Tested Out', passed: false, completed: false } });
    const without = course([badge({ id: 'b-a1', awardOn: 'au-moveon', for: 'a1' })]);
    expect(awardsFor(without, tested, [auEvent('a1', { waived: true })])).toEqual([]);
    const withIt = course([badge({ id: 'b-a1', awardOn: 'au-moveon', for: 'a1', countWaived: true })]);
    expect(awardsFor(withIt, tested, [auEvent('a1', { waived: true })])).toEqual([
      { badgeId: 'b-a1', registration: REG, earningStatementId: 'st-a1', testedOut: 1 },
    ]);
  });

  it('gives no lesson badge for a carried-over lesson, even with countWaived, and withholds its path badge', () => {
    const carried = state({ a1: { waived: 'Administrative', carriedOver: true }, a2: {}, a3: {} });
    const c = course([
      badge({ id: 'b-a1', awardOn: 'au-moveon', for: 'a1', countWaived: true }),
      badge({ id: 'b-path-a', awardOn: 'block-satisfied', for: 'a' }),
    ]);
    expect(awardsFor(c, carried, [auEvent('a1', { waived: true, carriedOver: true }), blockEvent('a')])).toEqual([]);
  });

  it('awards a path badge on its block event and counts tested-out lessons', () => {
    const c = course([badge({ id: 'b-path-a', awardOn: 'block-satisfied', for: 'a' })]);
    const s = state({ a1: { waived: 'Tested Out' }, a2: { waived: 'Tested Out' }, a3: {} });
    expect(awardsFor(c, s, [blockEvent('b'), blockEvent('a')])).toEqual([
      { badgeId: 'b-path-a', registration: REG, earningStatementId: 'st-block-a', testedOut: 2 },
    ]);
  });

  it('awards a course badge on the course event', () => {
    const c = course([badge({ id: 'b-course', awardOn: 'course-satisfied' })]);
    const s = state({ a1: {}, a2: { waived: 'Tested Out' }, a3: {}, b1: {} });
    expect(awardsFor(c, s, [{ type: 'course', statementId: 'st-course' }])).toEqual([
      { badgeId: 'b-course', registration: REG, earningStatementId: 'st-course', testedOut: 1 },
    ]);
    expect(awardsFor(c, s, [blockEvent('a')])).toEqual([]);
  });

  it('fires any-path once, on the first block event', () => {
    const c = course([badge({ id: 'b-any', awardOn: 'any-path' })]);
    const s = state({ a1: {}, a2: {}, a3: {}, b1: {} });
    expect(awardsFor(c, s, [blockEvent('b'), blockEvent('a')])).toEqual([
      { badgeId: 'b-any', registration: REG, earningStatementId: 'st-block-b', testedOut: 0 },
    ]);
    const later = state({ a1: {}, a2: {}, a3: {}, b1: {} }, [{ badgeId: 'b-any', statementId: 'st-block-b' }]);
    expect(awardsFor(c, later, [blockEvent('a')])).toEqual([]);
  });
});
