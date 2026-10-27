import { describe, expect, it } from 'vitest';
import { ACTOR_HOMEPAGE, PROFILE_VERSION, VERBS, checkProfile, validateStatement } from '../src/index.ts';
import { loadCourse } from './fixtures.ts';
import { runHappyPath } from './flow.ts';

const course = loadCourse();
const { record } = runHappyPath(course);
const verbKey = (id: string) => Object.entries(VERBS).find(([, v]) => v.id === id)?.[0];

describe('statements from a full run', () => {
  it('emits the expected verbs in order', () => {
    expect(record.statements.map((s) => verbKey(s.verb.id))).toEqual([
      'placed',
      'experienced', 'answered', 'experienced', 'answered',
      'answered', 'passed', 'branched', 'completed',
      'experienced', 'answered',
      'failed', 'passed', 'caught',
      'answered', 'passed', 'passed', 'branched', 'completed', 'completed',
    ]);
  });

  it('every statement is valid xAPI and conforms to the profile', () => {
    for (const s of record.statements) {
      expect(validateStatement(s), JSON.stringify(s)).toEqual([]);
      expect(checkProfile(s), JSON.stringify(s)).toEqual([]);
    }
  });

  it('uses an anonymous actor, UTC timestamps, no version and the profile category', () => {
    for (const s of record.statements) {
      expect(s.actor).toEqual({ objectType: 'Agent', account: { homePage: ACTOR_HOMEPAGE, name: record.learnerId } });
      expect(s.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect('version' in s).toBe(false);
      expect(s.context.contextActivities.category).toEqual([{ objectType: 'Activity', id: PROFILE_VERSION }]);
      expect(s.context.platform).toBe('test-client');
      expect(s.object.id.startsWith(course.activityBase + '/')).toBe(true);
    }
  });

  it('records the branch, target and rationale on branched statements', () => {
    const b = record.statements.find((s) => verbKey(s.verb.id) === 'branched')!;
    expect(b.object.id).toBe(`${course.activityBase}/lessons/what-is-json/checkpoints/types`);
    expect(Object.values(b.result!.extensions!)).toEqual(['ready', `${course.activityBase}/lessons/fix-the-config`, 'Names both types and a reason.']);
  });
});

describe('validateStatement rejects', () => {
  const good = () => structuredClone(record.statements[1]) as any;
  it.each([
    ['an mbox on the actor', (s: any) => (s.actor.mbox = 'mailto:a@b.c')],
    ['a name on the actor', (s: any) => (s.actor.name = 'Ada')],
    ['a version', (s: any) => (s.version = '2.0.0')],
    ['an extra property', (s: any) => (s.extra = 1)],
    ['a non-UTC timestamp', (s: any) => (s.timestamp = '2026-10-19T12:00:00.000+01:00')],
    ['contextAgents', (s: any) => (s.context.contextAgents = [])],
    ['a single-object contextActivities value', (s: any) => (s.context.contextActivities.parent = s.context.contextActivities.parent[0])],
    ['a non-IRI extension key', (s: any) => (s.context.extensions = { 'rules-version': 'v0.1' })],
    ['a bad registration', (s: any) => (s.context.registration = 'abc')],
    ['a non-UUID id', (s: any) => (s.id = 'x')],
  ])('%s', (_, f) => {
    const s = good();
    f(s);
    expect(validateStatement(s).length).toBeGreaterThan(0);
  });

  it('checkProfile rejects an unknown verb or a wrong activity type', () => {
    const a = good();
    a.verb.id = 'http://example.org/verbs/liked';
    expect(checkProfile(a).length).toBeGreaterThan(0);
    const b = good();
    b.object.definition.type = 'http://adlnet.gov/expapi/activities/course';
    expect(checkProfile(b).length).toBeGreaterThan(0);
  });
});
