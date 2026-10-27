// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CMI5, type XapiStatement } from '@course-xapi-mcp/core';
import { buildDefined } from '@course-xapi-mcp/core/xapi';
import { createLmsSim, createTestLrs } from '../index.ts';

const LRS_URL = 'http://lrs.test/xapi';
const COURSE = 'https://example.org/course';
const AU = 'https://example.org/course/au1';

function setup(o: { versions?: ('1.0.3' | '2.0.0')[] } = {}) {
  const lrs = createTestLrs(o);
  const sim = createLmsSim({ lrs, lrsUrl: LRS_URL, courseId: COURSE, aus: [{ auId: AU, url: 'https://au.example/index.html', moveOn: 'CompletedOrPassed' }] });
  return { lrs, sim };
}

/** The AU's own statements, scripted with the core builders and timestamps after the launch. */
function auSession(l: { registration: string; sessionId: string; activityId: string }, lrs: { statements(): XapiStatement[] }, verbs: ('initialized' | 'completed' | 'passed' | 'failed' | 'terminated')[]) {
  const launched = lrs.statements().at(-1)!;
  const c = {
    actor: launched.actor,
    registration: l.registration,
    sessionId: l.sessionId,
    courseId: COURSE,
    language: 'en-US',
    rulesVersion: '0.2',
    custody: 'lms-launched' as const,
    practice: false,
  };
  let t = Date.parse(launched.timestamp);
  return verbs.map((v) => buildDefined(c, v, { au: { publisherId: AU, activityId: l.activityId } }, { id: randomUUID(), timestamp: new Date((t += 1000)).toISOString(), duration: 'PT1M' }));
}

/** What an AU does: POST its statements to the LRS with a token. */
async function post(lrs: ReturnType<typeof createTestLrs>, stmts: XapiStatement[]) {
  lrs.addToken('au-token');
  const res = await lrs.fetch(new Request(LRS_URL + '/statements', { method: 'POST', body: JSON.stringify(stmts), headers: { authorization: 'Basic au-token', 'x-experience-api-version': '1.0.3' } }));
  expect(res.status).toBe(200);
}

describe('cmi5 LMS simulator', () => {
  it('builds a launch URL with endpoint, fetch, actor, registration and activityId', async () => {
    const { sim } = setup();
    const l = await sim.launch(AU);
    const u = new URL(l.launchUrl);
    expect(u.origin + u.pathname).toBe('https://au.example/index.html');
    expect(u.searchParams.get('endpoint')).toBe(LRS_URL);
    expect(u.searchParams.get('fetch')).toMatch(/^http:\/\/lrs\.test\/xapi\/cmi5\/fetch\/.+/);
    expect(JSON.parse(u.searchParams.get('actor')!)).toHaveProperty('account.name');
    expect(u.searchParams.get('registration')).toBe(l.registration);
    expect(u.searchParams.get('activityId')).toBe(l.activityId);
  });

  it('serves the fetch URL once, then gives error-code 1', async () => {
    const { lrs, sim } = setup();
    const l = await sim.launch(AU);
    const fetchUrl = new URL(l.launchUrl).searchParams.get('fetch')!;
    expect(await (await lrs.fetch(new Request(fetchUrl, { method: 'POST' }))).json()).toEqual({ 'auth-token': l.token });
    expect(await (await lrs.fetch(new Request(fetchUrl, { method: 'POST' }))).json()).toEqual({ 'error-code': '1', 'error-text': 'already in use' });
    const about = await lrs.fetch(new Request(LRS_URL + '/about', { headers: { authorization: `Basic ${l.token}`, 'x-experience-api-version': '1.0.3' } }));
    expect(about.status).toBe(200);
  });

  it('writes LMS.LaunchData with the sessionid extension, publisher-id grouping, launchMode, moveOn and returnURL', async () => {
    const { lrs, sim } = setup();
    const l = await sim.launch(AU, { launchMode: 'Review', returnURL: 'https://lms.example/back' });
    const actor = JSON.parse(new URL(l.launchUrl).searchParams.get('actor')!);
    const q = new URLSearchParams({ activityId: l.activityId, agent: JSON.stringify(actor), registration: l.registration, stateId: 'LMS.LaunchData' });
    // The LMS wrote with its own token, which the test reads through the same handler.
    const tok = btoa(`${randomUUID()}:x`);
    lrs.addToken(tok);
    const res = await lrs.fetch(new Request(`${LRS_URL}/activities/state?${q}`, { headers: { authorization: `Basic ${tok}`, 'x-experience-api-version': '1.0.3' } }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { contextTemplate: { extensions: Record<string, string>; contextActivities: { grouping: { id: string }[] } }; launchMode: string; moveOn: string; returnURL: string };
    expect(data.contextTemplate.extensions[CMI5.extSessionId]).toBe(l.sessionId);
    expect(data.contextTemplate.contextActivities.grouping.map((g) => g.id)).toEqual([AU, COURSE]);
    expect([data.launchMode, data.moveOn, data.returnURL]).toEqual(['Review', 'CompletedOrPassed', 'https://lms.example/back']);
  });

  it('sends launched with the cmi5 category and the session id', async () => {
    const { lrs, sim } = setup();
    const l = await sim.launch(AU);
    const [s] = lrs.statements();
    expect(s.verb.id).toBe('http://adlnet.gov/expapi/verbs/launched');
    expect(s.object.id).toBe(l.activityId);
    expect(s.context.registration).toBe(l.registration);
    expect(s.context.contextActivities?.category?.map((a) => a.id)).toContain(CMI5.categoryCmi5);
    expect(s.context.extensions?.[CMI5.extSessionId]).toBe(l.sessionId);
  });

  it('works with an LRS that accepts only xAPI 2.0.0 when the LMS says so', async () => {
    const lrs = createTestLrs({ versions: ['2.0.0'] });
    const sim = createLmsSim({ lrs, lrsUrl: LRS_URL, courseId: COURSE, aus: [{ auId: AU, url: 'https://au.example/', moveOn: 'Passed' }], xapiVersion: '2.0.0' });
    await sim.launch(AU);
    expect(lrs.statements()).toHaveLength(1);
    await expect(setup({ versions: ['2.0.0'] }).sim.launch(AU)).rejects.toThrow(/400/);
  });

  it('problems() is empty after a good session and names a failed after a passed', async () => {
    const good = setup();
    const gl = await good.sim.launch(AU);
    await post(good.lrs, auSession(gl, good.lrs, ['initialized', 'completed', 'passed', 'terminated']));
    expect(good.sim.problems()).toEqual([]);

    const bad = setup();
    const bl = await bad.sim.launch(AU);
    const stmts = auSession(bl, bad.lrs, ['initialized', 'passed', 'failed', 'terminated']);
    await post(bad.lrs, stmts);
    const ps = bad.sim.problems();
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.some((p) => p.statementId === stmts[2].id)).toBe(true);
  });

  it('abandonLatest sends abandoned for the latest launch, in order', async () => {
    const { lrs, sim } = setup();
    const l = await sim.launch(AU);
    await sim.abandonLatest();
    const [, abandoned] = lrs.statements();
    expect(abandoned.verb.id).toBe('https://w3id.org/xapi/adl/verbs/abandoned');
    expect(abandoned.context.extensions?.[CMI5.extSessionId]).toBe(l.sessionId);
    expect(abandoned.result?.duration).toMatch(/^PT/);
    expect(sim.problems()).toEqual([]);
  });
});
