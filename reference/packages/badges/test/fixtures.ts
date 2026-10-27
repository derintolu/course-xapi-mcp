// SPDX-License-Identifier: Apache-2.0
import type { AuProgress, BadgeDecl, CourseModel, LearnerState, LessonModel } from '@course-xapi-mcp/core';

const lesson = (key: string, pathKey: string): LessonModel => ({
  key,
  auId: `https://course.example/au/${key}`,
  pathKey,
  title: key,
  description: key,
  url: `lessons/${key}.html`,
  moveOn: 'CompletedAndPassed',
  minutes: 10,
  sources: [],
  beats: [],
});

export const badge = (o: Partial<BadgeDecl> & Pick<BadgeDecl, 'id' | 'awardOn'>): BadgeDecl => ({
  name: 'Badge ' + o.id,
  description: 'A badge.',
  criteria: { narrative: 'Finish the work.' },
  achievementType: 'Competency',
  countWaived: false,
  includeScore: false,
  ...o,
});

export function course(badges: BadgeDecl[]): CourseModel {
  return {
    specVersion: '0.2',
    flavour: 'distribution',
    id: 'https://course.example/c',
    title: 'Course',
    description: 'A course.',
    mcp: 'https://course.example/mcp',
    version: '1',
    language: 'en',
    rules: [],
    placement: { key: 'p', auId: 'https://course.example/au/placement', url: 'p.html', title: 'P', intro: 'P', maxQuestions: 3 },
    custody: 'server-kept',
    allowPractice: false,
    badges,
    paths: {
      a: { key: 'a', blockId: 'https://course.example/block/a', title: 'A', tagline: 'A', status: 'live', lessons: ['a1', 'a2', 'a3'] },
      b: { key: 'b', blockId: 'https://course.example/block/b', title: 'B', tagline: 'B', status: 'live', lessons: ['b1'] },
    },
    lessons: Object.fromEntries(
      [lesson('a1', 'a'), lesson('a2', 'a'), lesson('a3', 'a'), lesson('b1', 'b')].map((l) => [l.key, l]),
    ),
  };
}

const done: AuProgress = { completed: true, passed: true, failed: false, carriedOver: false, fixAttempts: 0 };

export function state(au: Record<string, Partial<AuProgress>> = {}, awards: LearnerState['awards'] = []): LearnerState {
  return {
    v: 1,
    courseVersion: '1',
    registration: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
    au: Object.fromEntries(Object.entries(au).map(([k, v]) => [k, { ...done, ...v }])),
    satisfied: { blocks: [], course: false },
    files: {},
    outbox: [],
    awards,
  };
}
