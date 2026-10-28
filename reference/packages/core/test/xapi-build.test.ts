// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ADL_VERBS, CMI5, CXM_ACTIVITY_TYPES, CXM_EXT, OB_XAPI, PRACTICE_CATEGORY, PROFILE_VERSION_IRI } from '../src/constants.ts';
import { buildAllowed, buildDefined, buildEarned, checkCmi5Order, checkProfile, isoDuration, validateStatement, type XapiStatement } from '../src/xapi/index.ts';
import { AU, AU_REF, COURSE, REG, SESSION, clock, ctx } from './xapi-fixtures.ts';

const cats = (s: XapiStatement) => (s.context.contextActivities?.category ?? []).map((a) => a.id);
const ids = (list: { id: string }[] | undefined) => (list ?? []).map((a) => a.id);
const next = clock();
const au = { au: AU_REF };
const clean = (s: XapiStatement) => {
  expect(validateStatement(s), JSON.stringify(s)).toEqual([]);
  expect(checkProfile(s), JSON.stringify(s)).toEqual([]);
};

describe('isoDuration', () => {
  it('formats milliseconds as ISO 8601 durations', () => {
    expect(isoDuration(12345)).toBe('PT12.345S');
    expect(isoDuration(3723000)).toBe('PT1H2M3S');
    expect(isoDuration(0)).toBe('PT0S');
    expect(isoDuration(60_000)).toBe('PT1M');
    expect(isoDuration(1500)).toBe('PT1.5S');
  });
  it('refuses negative or non-finite input', () => {
    expect(() => isoDuration(-1)).toThrow();
    expect(() => isoDuration(Number.NaN)).toThrow();
  });
});

describe('buildDefined', () => {
  it('defined passed has cmi5 + moveOn categories, AU object, duration, success true', () => {
    const s = buildDefined(ctx(), 'passed', au, { ...next(), duration: 'PT1M' });
    expect(cats(s)).toEqual(expect.arrayContaining([CMI5.categoryCmi5, CMI5.categoryMoveOn]));
    expect(s.object.id).toBe(AU + '/au');
    expect(s.result).toMatchObject({ success: true, duration: 'PT1M' });
    expect(s.context.extensions![CMI5.extSessionId]).toBe(SESSION);
    expect(s.verb.id).toBe(ADL_VERBS.passed);
    clean(s);
  });

  it('carries registration, session id, rules version, custody and the [publisherId, courseId] grouping', () => {
    const s = buildDefined(ctx(), 'initialized', au, next());
    expect(s.context.registration).toBe(REG);
    expect(s.context.extensions).toMatchObject({ [CMI5.extSessionId]: SESSION, [CXM_EXT['rules-version']]: '0.2', [CXM_EXT.custody]: 'server-kept' });
    expect(ids(s.context.contextActivities?.grouping)).toEqual([AU, COURSE]);
    expect(cats(s)).toEqual([CMI5.categoryCmi5]);
    expect(s.result).toBeUndefined();
    expect(s.context.platform).toBe('test-client');
    expect('version' in s).toBe(false);
    clean(s);
  });

  it('requires duration on completed, passed, failed, terminated and abandoned', () => {
    for (const v of ['completed', 'passed', 'failed', 'terminated', 'abandoned'] as const) {
      expect(() => buildDefined(ctx(), v, au, next()), v).toThrow(/duration/);
      clean(buildDefined(ctx(), v, au, { ...next(), duration: 'PT5S' }));
    }
  });

  it('sets success and completion by verb, and the moveOn category only with a result outcome', () => {
    const failed = buildDefined(ctx(), 'failed', au, { ...next(), duration: 'PT1S' });
    expect(failed.result).toMatchObject({ success: false });
    expect(cats(failed)).toContain(CMI5.categoryMoveOn);
    const completed = buildDefined(ctx(), 'completed', au, { ...next(), duration: 'PT1S' });
    expect(completed.result).toMatchObject({ completion: true });
    expect(completed.result?.success).toBeUndefined();
    const terminated = buildDefined(ctx(), 'terminated', au, { ...next(), duration: 'PT1S' });
    expect(cats(terminated)).not.toContain(CMI5.categoryMoveOn);
    expect(() => buildDefined(ctx(), 'passed', au, { ...next(), duration: 'PT1S', success: false })).toThrow();
  });

  it('waived requires a reason and has success and completion true', () => {
    expect(() => buildDefined(ctx(), 'waived', au, next())).toThrow(/reason/);
    const s = buildDefined(ctx(), 'waived', au, { ...next(), reason: 'Tested Out' });
    expect(s.result).toMatchObject({ success: true, completion: true, extensions: { [CMI5.extReason]: 'Tested Out' } });
    expect(cats(s)).toEqual(expect.arrayContaining([CMI5.categoryCmi5, CMI5.categoryMoveOn]));
    clean(s);
    const carried = buildDefined(ctx(), 'waived', au, { ...next(), reason: 'Administrative', extensions: { [CXM_EXT['carried-over']]: true } });
    expect(carried.result?.extensions).toEqual({ [CMI5.extReason]: 'Administrative', [CXM_EXT['carried-over']]: true });
    clean(carried);
  });

  it('satisfied takes a block or course object with the cmi5 activity type', () => {
    const block = buildDefined(ctx(), 'satisfied', { blockId: COURSE + '/paths/json' }, next());
    expect(block.object).toMatchObject({ id: COURSE + '/paths/json', definition: { type: 'https://w3id.org/xapi/cmi5/activitytype/block' } });
    expect(ids(block.context.contextActivities?.grouping)).toEqual([COURSE]);
    clean(block);
    const course = buildDefined(ctx(), 'satisfied', { courseId: COURSE }, next());
    expect(course.object).toMatchObject({ id: COURSE, definition: { type: 'https://w3id.org/xapi/cmi5/activitytype/course' } });
    clean(course);
    expect(() => buildDefined(ctx(), 'passed', { blockId: COURSE + '/paths/json' }, { ...next(), duration: 'PT1S' })).toThrow();
    expect(() => buildDefined(ctx(), 'satisfied', au, next())).toThrow();
  });

  it('merges the LMS contextTemplate and keeps the publisher id in grouping', () => {
    const lmsGroup = 'https://lms.example/courses/77';
    const c = ctx({
      custody: 'lms-launched',
      actor: { objectType: 'Agent', name: 'Ada', mbox: 'mailto:ada@example.org' },
      contextTemplate: {
        contextActivities: { grouping: [{ objectType: 'Activity', id: AU }, { objectType: 'Activity', id: lmsGroup }], other: [{ objectType: 'Activity', id: 'https://lms.example/x' }] },
        extensions: { [CMI5.extSessionId]: SESSION, 'https://lms.example/ext/tenant': 't1' },
      },
    });
    const s = buildDefined(c, 'initialized', au, next());
    expect(ids(s.context.contextActivities?.grouping)).toEqual([AU, COURSE, lmsGroup]);
    expect(ids(s.context.contextActivities?.other)).toEqual(['https://lms.example/x']);
    expect(s.context.extensions).toMatchObject({ 'https://lms.example/ext/tenant': 't1', [CMI5.extSessionId]: SESSION, [CXM_EXT.custody]: 'lms-launched' });
    expect(s.actor).toEqual({ objectType: 'Agent', name: 'Ada', mbox: 'mailto:ada@example.org' });
    expect(validateStatement(s)).toEqual([]);
    expect(checkProfile(s, { lmsActor: true })).toEqual([]);
  });

  it('does not let the contextTemplate change the session id', () => {
    const c = ctx({ contextTemplate: { extensions: { [CMI5.extSessionId]: 'other' } } });
    expect(() => buildDefined(c, 'initialized', au, next())).toThrow(/session/);
  });
});

describe('buildAllowed', () => {
  const beat = { id: AU + '/beats/intro', kind: 'beat' as const, name: 'Intro' };

  it('allowed statements carry the profile version category and never the cmi5 category', () => {
    const c = ctx({ contextTemplate: { contextActivities: { category: [{ objectType: 'Activity', id: CMI5.categoryCmi5 }] } } });
    const s = buildAllowed(c, 'experienced', beat, AU_REF, next());
    expect(cats(s)).toEqual([PROFILE_VERSION_IRI]);
    expect(ids(s.context.contextActivities?.parent)).toEqual([AU + '/au']);
    expect(ids(s.context.contextActivities?.grouping)).toEqual([AU, COURSE]);
    expect(s.object).toEqual({ objectType: 'Activity', id: beat.id, definition: { type: CXM_ACTIVITY_TYPES.beat, name: { en: 'Intro' } } });
    expect(s.context.extensions![CMI5.extSessionId]).toBe(SESSION);
    clean(s);
  });

  it('builds the cxm verbs with their results', () => {
    const cp = { id: AU + '/checkpoints/types', kind: 'checkpoint' as const, name: 'Types' };
    const failed = buildAllowed(ctx(), 'failed', cp, AU_REF, { ...next(), result: { success: false, extensions: { [CXM_EXT.attempt]: 1 } } });
    clean(failed);
    const branched = buildAllowed(ctx(), 'branched', cp, AU_REF, {
      ...next(),
      result: { extensions: { [CXM_EXT.branch]: 'ready', [CXM_EXT.to]: null, [CXM_EXT.rationale]: 'Names both types.' } },
    });
    clean(branched);
    const revealed = buildAllowed(ctx(), 'revealed', { id: AU + '/bugs/b1', kind: 'planted-bug', name: 'Bug' }, AU_REF, next());
    clean(revealed);
    expect(() => buildAllowed(ctx(), 'earned', beat, AU_REF, next())).toThrow(/buildEarned/);
  });

  it('practice statements carry the practice category', () => {
    const p = ctx({ practice: true, custody: 'practice', actor: { objectType: 'Agent', account: { homePage: 'https://course-xapi-mcp.sqwrlz.com/practice-learner', name: 'h1' } } });
    const a = buildAllowed(p, 'experienced', beat, AU_REF, next());
    const d = buildDefined(p, 'initialized', au, next());
    const e = buildEarned(p, { id: 'https://example.org/badges/1', name: 'B' }, 'urn:uuid:11111111-1111-4111-8111-111111111111', a.id, next());
    for (const s of [a, d, e]) {
      expect(cats(s)).toContain(PRACTICE_CATEGORY);
      clean(s);
    }
    expect(cats(d)).toContain(CMI5.categoryCmi5);
  });
});

describe('buildEarned', () => {
  it('earned refers to the earning statement and the credential id', () => {
    const earning = '00000000-0000-4000-8000-0000000000aa';
    const credential = 'urn:uuid:11111111-1111-4111-8111-111111111111';
    const s = buildEarned(ctx(), { id: 'https://example.org/badges/fix', name: 'Fixer' }, credential, earning, next());
    expect(s.verb.id).toBe(OB_XAPI.earned);
    expect(s.object).toEqual({ objectType: 'Activity', id: 'https://example.org/badges/fix', definition: { type: CXM_ACTIVITY_TYPES.achievement, name: { en: 'Fixer' } } });
    expect(s.result?.extensions).toEqual({ [OB_XAPI.badgeAssertion]: { '@id': credential } });
    expect(s.context.statement).toEqual({ objectType: 'StatementRef', id: earning });
    expect(cats(s)).toEqual([PROFILE_VERSION_IRI]);
    clean(s);
  });

  it('carries the cmi5 session id only when given one (sent inside an open AU session)', () => {
    const badge = { id: 'https://example.org/badges/fix', name: 'Fixer' };
    const credential = 'urn:uuid:11111111-1111-4111-8111-111111111111';
    const { sessionId: _, ...outside } = ctx();
    const alone = buildEarned(outside, badge, credential, '00000000-0000-4000-8000-0000000000aa', next());
    expect(alone.context.extensions).not.toHaveProperty([CMI5.extSessionId]);
    clean(alone);
    expect(checkCmi5Order([alone])).toEqual([]);
    const inside = buildEarned(ctx(), badge, credential, '00000000-0000-4000-8000-0000000000aa', next());
    expect(inside.context.extensions![CMI5.extSessionId]).toBe(SESSION);
    // A session's contextTemplate needs that session.
    expect(() => buildEarned({ ...outside, contextTemplate: { extensions: { [CMI5.extSessionId]: SESSION } } }, badge, credential, 'x', next())).toThrow(/session id/);
    // Any other statement without a session id still fails the profile.
    const unsessioned = buildAllowed(ctx(), 'experienced', { id: AU + '/beats/intro', kind: 'beat', name: 'Intro' }, AU_REF, next());
    delete unsessioned.context.extensions![CMI5.extSessionId];
    expect(checkProfile(unsessioned)).toContain('the cmi5 sessionid context extension is required');
  });
});
