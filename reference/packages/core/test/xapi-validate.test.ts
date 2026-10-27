// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { CMI5, CXM_EXT, PRACTICE_CATEGORY, PRACTICE_HOMEPAGE, PROFILE_VERSION_IRI } from '../src/constants.ts';
import { buildAllowed, buildDefined, checkProfile, validateStatement } from '../src/xapi/index.ts';
import { AU, AU_REF, clock, ctx } from './xapi-fixtures.ts';

const next = clock();
const beat = { id: AU + '/beats/intro', kind: 'beat' as const, name: 'Intro' };
const good = () => structuredClone(buildAllowed(ctx(), 'answered', beat, AU_REF, { ...next(), result: { response: 'a string' } })) as any;
const defined = () => structuredClone(buildDefined(ctx(), 'passed', { au: AU_REF }, { ...next(), duration: 'PT1M' })) as any;

describe('validateStatement', () => {
  it('accepts built statements', () => {
    expect(validateStatement(good())).toEqual([]);
    expect(validateStatement(defined())).toEqual([]);
  });

  it.each([
    ['an mbox beside the account (two identifiers)', (s: any) => (s.actor.mbox = 'mailto:a@b.c')],
    ['a version', (s: any) => (s.version = '2.0.0')],
    ['an extra property', (s: any) => (s.extra = 1)],
    ['a non-UTC timestamp', (s: any) => (s.timestamp = '2026-10-19T12:00:00.000+01:00')],
    ['contextAgents', (s: any) => (s.context.contextAgents = [])],
    ['contextGroups', (s: any) => (s.context.contextGroups = [])],
    ['a single-object contextActivities value', (s: any) => (s.context.contextActivities.parent = s.context.contextActivities.parent[0])],
    ['a non-IRI extension key', (s: any) => (s.context.extensions = { 'rules-version': 'v0.1' })],
    ['a bad registration', (s: any) => (s.context.registration = 'abc')],
    ['a non-UUID id', (s: any) => (s.id = 'x')],
    ['a bad duration', (s: any) => (s.result.duration = 'P1X')],
    ['an empty duration', (s: any) => (s.result.duration = 'PT')],
    ['a scaled score above 1', (s: any) => (s.result.score = { scaled: 1.5 })],
    ['a raw score outside min and max', (s: any) => (s.result.score = { raw: 11, min: 0, max: 10 })],
    ['an unknown score property', (s: any) => (s.result.score = { scaled: 0.5, percent: 50 })],
    ['a context.statement that is not a StatementRef', (s: any) => (s.context.statement = { objectType: 'Statement', id: s.id })],
    ['a context.statement with a bad id', (s: any) => (s.context.statement = { objectType: 'StatementRef', id: 'x' })],
    ['a bad contextActivities.other entry', (s: any) => (s.context.contextActivities.other = [{ id: 'not an iri' }])],
    ['an actor with no identifier', (s: any) => (s.actor = { objectType: 'Agent', name: 'Ada' })],
    ['an mbox that is not mailto', (s: any) => (s.actor = { mbox: 'ada@example.org' })],
    ['a bad mbox_sha1sum', (s: any) => (s.actor = { mbox_sha1sum: 'xyz' })],
    ['an account without homePage', (s: any) => (s.actor = { account: { name: 'n' } })],
    ['a Group actor', (s: any) => (s.actor.objectType = 'Group')],
  ])('rejects %s', (_, f) => {
    const s = good();
    f(s);
    expect(validateStatement(s).length).toBeGreaterThan(0);
  });

  it.each([
    ['an LMS mbox actor with a name', { objectType: 'Agent', name: 'Ada', mbox: 'mailto:ada@example.org' }],
    ['an mbox_sha1sum actor', { mbox_sha1sum: 'a'.repeat(40) }],
    ['an openid actor', { openid: 'https://id.example.org/ada' }],
    ['an account actor without objectType', { account: { homePage: 'https://lms.example', name: '42' } }],
  ])('accepts %s', (_, actor) => {
    const s = good();
    s.actor = actor;
    expect(validateStatement(s)).toEqual([]);
  });

  it('accepts durations, scores, context.statement and contextActivities.other', () => {
    const s = good();
    s.result.duration = 'P1DT2H3M4.5S';
    s.result.score = { scaled: 0.8, raw: 8, min: 0, max: 10 };
    s.context.statement = { objectType: 'StatementRef', id: '00000000-0000-4000-8000-0000000000ff' };
    s.context.contextActivities.other = [{ objectType: 'Activity', id: 'https://example.org/other' }];
    expect(validateStatement(s)).toEqual([]);
  });
});

describe('checkProfile', () => {
  it('rejects a minted actor with mbox; accepts the same actor with { lmsActor: true }', () => {
    const s = good();
    s.actor = { objectType: 'Agent', mbox: 'mailto:ada@example.org' };
    expect(validateStatement(s)).toEqual([]);
    expect(checkProfile(s).join('\n')).toMatch(/mbox/);
    expect(checkProfile(s, { lmsActor: true })).toEqual([]);
  });

  it.each(['name', 'mbox_sha1sum', 'openid'])('rejects a minted actor carrying %s', (k) => {
    const s = good();
    s.actor[k] = k === 'mbox_sha1sum' ? 'a'.repeat(40) : k === 'openid' ? 'https://id.example.org/a' : 'Ada';
    expect(checkProfile(s).join('\n')).toContain(k);
  });

  it('requires the course id as homePage, or the practice home page in practice', () => {
    const s = good();
    s.actor.account.homePage = 'https://elsewhere.example';
    expect(checkProfile(s).length).toBeGreaterThan(0);
    const p = good();
    p.context.contextActivities.category.push({ objectType: 'Activity', id: PRACTICE_CATEGORY });
    expect(checkProfile(p).join('\n')).toContain(PRACTICE_HOMEPAGE);
    p.actor.account.homePage = PRACTICE_HOMEPAGE;
    expect(checkProfile(p)).toEqual([]);
  });

  it('rejects an unknown verb or a wrong activity type', () => {
    const a = good();
    a.verb.id = 'http://example.org/verbs/liked';
    expect(checkProfile(a).length).toBeGreaterThan(0);
    const b = good();
    b.object.definition.type = 'http://adlnet.gov/expapi/activities/course';
    expect(checkProfile(b).length).toBeGreaterThan(0);
  });

  it.each([
    ['allowed with the cmi5 category', (s: any) => s.context.contextActivities.category.push({ objectType: 'Activity', id: CMI5.categoryCmi5 }), good],
    ['allowed without the profile version category', (s: any) => (s.context.contextActivities.category = []), good],
    ['answered without a response', (s: any) => delete s.result.response, good],
    ['no session id', (s: any) => delete s.context.extensions[CMI5.extSessionId], good],
    ['no rules version', (s: any) => delete s.context.extensions[CXM_EXT['rules-version']], good],
    ['an unknown custody', (s: any) => (s.context.extensions[CXM_EXT.custody] = 'cloud'), good],
    ['no grouping', (s: any) => delete s.context.contextActivities.grouping, good],
    ['no parent on an allowed statement', (s: any) => delete s.context.contextActivities.parent, good],
    ['defined passed without duration', (s: any) => delete s.result.duration, defined],
    ['defined passed with success false', (s: any) => (s.result.success = false), defined],
    ['defined passed without the moveOn category', (s: any) => (s.context.contextActivities.category = [{ objectType: 'Activity', id: CMI5.categoryCmi5 }]), defined],
    ['defined passed with the profile version category only', (s: any) => (s.context.contextActivities.category = [{ objectType: 'Activity', id: PROFILE_VERSION_IRI }]), defined],
  ])('rejects %s', (_, f, make) => {
    const s = make();
    f(s);
    expect(checkProfile(s).length).toBeGreaterThan(0);
  });

  it('rejects the moveOn category on a defined statement without success or completion', () => {
    const s = structuredClone(buildDefined(ctx(), 'initialized', { au: AU_REF }, next())) as any;
    expect(checkProfile(s)).toEqual([]);
    s.context.contextActivities.category.push({ objectType: 'Activity', id: CMI5.categoryMoveOn });
    expect(checkProfile(s).length).toBeGreaterThan(0);
  });
});
