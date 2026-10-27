// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADL_VERBS, CMI5, DEFAULTS, MemoryLaunchStore, type CourseModel } from '@course-xapi-mcp/core';
import { createLmsSim, createTestLrs } from '@course-xapi-mcp/conformance';
import { createBridge, newPairingCode, startSweeper } from '../src/index.ts';

const LRS_URL = 'https://lrs.example/xapi';
const COURSE_ID = 'https://example.org/course';
const LESSON_AU = 'https://example.org/course/lesson-1';
const PLACEMENT_AU = 'https://example.org/course/placement';
const MCP_URL = 'https://course.example/mcp';
const BRIDGE = 'https://course.example/cmi5/launch';
const MIN = 60_000;

const course = {
  id: COURSE_ID,
  title: 'Example course',
  language: 'en-US',
  custody: 'lms-launched',
  placement: { key: 'placement', auId: PLACEMENT_AU, url: `${BRIDGE}?au=placement`, title: 'Where to start', intro: '', maxQuestions: 3 },
  lessons: {
    'lesson-1': { key: 'lesson-1', auId: LESSON_AU, pathKey: 'p', title: 'First lesson', description: '', url: `${BRIDGE}?au=lesson-1`, moveOn: 'Completed', minutes: 10, sources: [], beats: [] },
  },
} as unknown as CourseModel;

function setup(o: { bridgeUrl?: string } = {}) {
  const lrs = createTestLrs();
  const sim = createLmsSim({
    lrs,
    lrsUrl: LRS_URL,
    courseId: COURSE_ID,
    aus: [
      { auId: LESSON_AU, url: `${o.bridgeUrl ?? BRIDGE}?au=lesson-1`, moveOn: 'Completed' },
      { auId: PLACEMENT_AU, url: `${o.bridgeUrl ?? BRIDGE}?au=placement`, moveOn: 'NotApplicable' },
    ],
  });
  const calls: { method: string; url: string }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ method: req.method, url: req.url });
    return lrs.fetch(req);
  }) as typeof fetch;
  // A fixed clock a second ahead of the simulator's wall-clock statements, advanced by hand.
  let t = Date.now() + 1000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const launches = new MemoryLaunchStore();
  const bridge = createBridge({ course, mcpUrl: MCP_URL, launches, now: clock.now, fetch: f });
  const fetchPosts = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/cmi5/fetch/')).length;
  const launchIdOf = (res: Response) => /cxm_launch=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1];
  return { lrs, sim, bridge, launches, clock, calls, fetchPosts, launchIdOf };
}

const verbs = (lrs: ReturnType<typeof createTestLrs>) => lrs.statements().map((s) => s.verb.id);

describe('launch', () => {
  it('fetches the token once and sends initialized first, with the contextTemplate session id and grouping', async () => {
    const { lrs, sim, bridge, fetchPosts } = setup();
    const l = await sim.launch(LESSON_AU);
    const res = (await bridge.fetch(new Request(l.launchUrl)))!;
    expect(res.status).toBe(200);
    expect(fetchPosts()).toBe(1);

    expect(verbs(lrs)).toEqual([ADL_VERBS.launched, ADL_VERBS.initialized]);
    const init = lrs.statements()[1];
    expect(init.context.extensions?.[CMI5.extSessionId]).toBe(l.sessionId);
    expect(init.context.registration).toBe(l.registration);
    expect(init.object.id).toBe(l.activityId);
    const grouping = init.context.contextActivities?.grouping?.map((a) => a.id);
    expect(grouping).toEqual(expect.arrayContaining([LESSON_AU, COURSE_ID]));
    expect(init.actor).toEqual(lrs.statements()[0].actor);
    expect(sim.problems()).toEqual([]);
  });

  it('stores the launch context against the cookie launch id', async () => {
    const { sim, bridge, launches, launchIdOf } = setup();
    const l = await sim.launch(LESSON_AU, { returnURL: 'https://lms.example/course' });
    const res = (await bridge.fetch(new Request(l.launchUrl)))!;
    const c = (await launches.get(launchIdOf(res)))!;
    expect(c).toMatchObject({
      endpoint: LRS_URL,
      authToken: l.token,
      registration: l.registration,
      activityId: l.activityId,
      auId: LESSON_AU,
      auKey: 'lesson-1',
      sessionId: l.sessionId,
      launchMode: 'Normal',
      moveOn: 'Completed',
      returnURL: 'https://lms.example/course',
    });
    expect(c.terminatedAt).toBeUndefined();
    expect(Date.parse(c.pairingExpiresAt) - Date.parse(c.initializedAt)).toBe(DEFAULTS.pairingTtlMs);
  });

  it('accepts the placement AU', async () => {
    const { sim, bridge } = setup();
    const res = (await bridge.fetch(new Request((await sim.launch(PLACEMENT_AU)).launchUrl)))!;
    expect(res.status).toBe(200);
  });

  it('keeps the token, endpoint and actor out of the page', async () => {
    const { sim, bridge, launches, launchIdOf } = setup();
    const l = await sim.launch(LESSON_AU);
    const res = (await bridge.fetch(new Request(l.launchUrl)))!;
    const page = await res.text();
    const c = (await launches.get(launchIdOf(res)))!;
    for (const secret of [l.token, LRS_URL, 'lrs.example', 'learner-1', 'lms.example', JSON.stringify(c.actor), l.registration]) {
      expect(page).not.toContain(secret);
    }
    expect(res.headers.get('location')).toBeNull();
    expect(page).toContain('Continue in your agent');
    expect(page).toContain(`value="${MCP_URL}"`);
    for (const host of ['Claude:', 'ChatGPT:', 'Cursor:', 'Claude Code:']) expect(page).toContain(host);
    expect(page).toContain(c.pairingCode);
    expect(page).toContain('Type this code only on the sign-in page, never in the chat.');
  });

  it('sets the cxm_launch cookie HttpOnly, Secure, SameSite=Lax, Max-Age=600', async () => {
    const { sim, bridge, launchIdOf } = setup();
    const res = (await bridge.fetch(new Request((await sim.launch(LESSON_AU)).launchUrl)))!;
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^cxm_launch=[^;]+;/);
    expect(launchIdOf(res)).toMatch(/^[0-9a-f-]{36}$/);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=600', 'Path=/']) expect(cookie).toContain(attr);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('leaves Secure off the cookie on a loopback bridge', async () => {
    const { sim, bridge } = setup({ bridgeUrl: 'http://127.0.0.1:8787/cmi5/launch' });
    const res = (await bridge.fetch(new Request((await sim.launch(LESSON_AU)).launchUrl)))!;
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });

  it('stores Browse and Review launches with their mode', async () => {
    const { sim, bridge, launches, launchIdOf } = setup();
    for (const mode of ['Browse', 'Review'] as const) {
      const res = (await bridge.fetch(new Request((await sim.launch(LESSON_AU, { launchMode: mode })).launchUrl)))!;
      expect((await launches.get(launchIdOf(res)))!.launchMode).toBe(mode);
    }
  });

  it('answers undefined for other paths', async () => {
    const { bridge } = setup();
    expect(await bridge.fetch(new Request('https://course.example/mcp'))).toBeUndefined();
  });
});

describe('pairing codes', () => {
  it('are 6 characters from the pairing alphabet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = newPairingCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(490);
  });
});

describe('relaunch', () => {
  it('a second launch of the same AU supersedes the first, which then gets no statements', async () => {
    const { lrs, sim, bridge, launches, clock, launchIdOf } = setup();
    const first = launchIdOf((await bridge.fetch(new Request((await sim.launch(LESSON_AU)).launchUrl)))!);
    clock.advance(MIN);
    const second = launchIdOf((await bridge.fetch(new Request((await sim.launch(LESSON_AU)).launchUrl)))!);

    const a = (await launches.get(first))!;
    const b = (await launches.get(second))!;
    expect(a.supersededAt).toBe(b.initializedAt);
    expect(b.supersededAt).toBeUndefined();
    expect((await launches.latestFor(LRS_URL, 'https://lms.example|learner-1', a.registration, 'lesson-1'))!.launchId).toBe(second);

    clock.advance(31 * MIN);
    expect(await bridge.sweep()).toBe(1);
    await bridge.terminate(first);
    const firstSession = lrs.statements().filter((s) => s.context.extensions?.[CMI5.extSessionId] === a.sessionId);
    expect(firstSession.map((s) => s.verb.id)).toEqual([ADL_VERBS.launched, ADL_VERBS.initialized]);
    const terminated = lrs.statements().filter((s) => s.verb.id === ADL_VERBS.terminated);
    expect(terminated.map((s) => s.context.extensions?.[CMI5.extSessionId])).toEqual([b.sessionId]);
    expect(sim.problems()).toEqual([]);
  });

  it('a launch of another AU leaves the first live', async () => {
    const { sim, bridge, launches, launchIdOf } = setup();
    const first = launchIdOf((await bridge.fetch(new Request((await sim.launch(LESSON_AU)).launchUrl)))!);
    await bridge.fetch(new Request((await sim.launch(PLACEMENT_AU)).launchUrl));
    expect((await launches.get(first))!.supersededAt).toBeUndefined();
  });
});

describe('sweep', () => {
  it('terminates a launch idle for 31 minutes, with a duration, and the order stays cmi5-legal', async () => {
    const { lrs, sim, bridge, launches, clock, launchIdOf } = setup();
    const id = launchIdOf((await bridge.fetch(new Request((await sim.launch(LESSON_AU)).launchUrl)))!);
    clock.advance(29 * MIN);
    expect(await bridge.sweep()).toBe(0);
    clock.advance(2 * MIN);
    expect(await bridge.sweep()).toBe(1);

    const t = lrs.statements().at(-1)!;
    expect(t.verb.id).toBe(ADL_VERBS.terminated);
    expect(t.result?.duration).toBe('PT31M');
    expect(t.context.extensions?.[CMI5.extSessionId]).toBe((await launches.get(id))!.sessionId);
    expect((await launches.get(id))!.terminatedAt).toBe(t.timestamp);
    expect(sim.problems()).toEqual([]);

    expect(await bridge.sweep()).toBe(0);
    await bridge.terminate(id);
    expect(lrs.statements().filter((s) => s.verb.id === ADL_VERBS.terminated)).toHaveLength(1);
  });

  it('counts idle time from the last activity', async () => {
    const { sim, bridge, launches, clock, launchIdOf } = setup();
    const id = launchIdOf((await bridge.fetch(new Request((await sim.launch(LESSON_AU)).launchUrl)))!);
    clock.advance(20 * MIN);
    await launches.update(id, { lastActivityAt: new Date(clock.now()).toISOString() });
    clock.advance(20 * MIN);
    expect(await bridge.sweep()).toBe(0);
    clock.advance(11 * MIN);
    expect(await bridge.sweep()).toBe(1);
  });

  it('terminates an active session 51 minutes after the token fetch, before the token is likely to expire', async () => {
    const { lrs, sim, bridge, launches, clock, launchIdOf } = setup();
    const id = launchIdOf((await bridge.fetch(new Request((await sim.launch(LESSON_AU)).launchUrl)))!);
    const active = async () => launches.update(id, { lastActivityAt: new Date(clock.now()).toISOString() });
    for (let m = 0; m < 49; m += 7) {
      clock.advance(7 * MIN);
      await active();
      expect(await bridge.sweep()).toBe(0);
    }
    clock.advance(2 * MIN);
    await active();
    expect(await bridge.sweep()).toBe(1);
    const t = lrs.statements().at(-1)!;
    expect(t.verb.id).toBe(ADL_VERBS.terminated);
    expect(t.result?.duration).toBe('PT51M');
    expect(sim.problems()).toEqual([]);
  });

  it('keeps a launch live and retries when the record holder refuses terminated', async () => {
    const { lrs, sim, bridge, launches, clock, launchIdOf } = setup();
    const id = launchIdOf((await bridge.fetch(new Request((await sim.launch(LESSON_AU)).launchUrl)))!);
    clock.advance(31 * MIN);
    lrs.failNext(1, 503);
    expect(await bridge.sweep()).toBe(0);
    expect((await launches.get(id))!.terminatedAt).toBeUndefined();
    expect(await bridge.sweep()).toBe(1);
    expect(verbs(lrs).at(-1)).toBe(ADL_VERBS.terminated);
  });

  it('skips a launch that custody already terminated', async () => {
    const { lrs, sim, bridge, launches, clock, launchIdOf } = setup();
    const id = launchIdOf((await bridge.fetch(new Request((await sim.launch(LESSON_AU)).launchUrl)))!);
    await launches.update(id, { terminatedAt: new Date(clock.now()).toISOString() });
    clock.advance(31 * MIN);
    expect(await bridge.sweep()).toBe(0);
    expect(verbs(lrs)).not.toContain(ADL_VERBS.terminated);
  });
});

describe('startSweeper', () => {
  afterEach(() => vi.useRealTimers());

  it('sweeps on the interval until stopped', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => 0);
    const stop = startSweeper({ sweep }, 60_000);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sweep).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sweep).toHaveBeenCalledTimes(3);
  });
});

describe('refused launches', () => {
  it('a reused fetch URL renders the error page and sends nothing', async () => {
    const { lrs, sim, bridge, launches, launchIdOf } = setup();
    const l = await sim.launch(LESSON_AU);
    const first = launchIdOf((await bridge.fetch(new Request(l.launchUrl)))!);
    const before = lrs.statements().length;
    const res = (await bridge.fetch(new Request(l.launchUrl)))!;
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    const page = await res.text();
    expect(page).toContain('already been used');
    expect(page).toContain('cmi5 error 1');
    expect(lrs.statements()).toHaveLength(before);
    expect((await launches.get(first))!.supersededAt).toBeUndefined();
  });

  it('refuses an http://evil.example endpoint without fetching', async () => {
    const { sim, bridge, calls } = setup();
    const u = new URL((await sim.launch(LESSON_AU)).launchUrl);
    u.searchParams.set('endpoint', 'http://evil.example/xapi');
    const before = calls.length;
    const res = (await bridge.fetch(new Request(u)))!;
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('evil.example');
    expect(calls).toHaveLength(before);
  });

  it.each([
    ['au', 'not-a-lesson'],
    ['au', 'constructor'],
    ['fetch', 'http://evil.example/fetch'],
    ['actor', '{"name":"no ifi"}'],
    ['actor', 'not json'],
    ['registration', 'abc'],
    ['activityId', 'not an iri'],
  ])('refuses a bad %s (%s) without fetching', async (param, value) => {
    const { sim, bridge, fetchPosts } = setup();
    const u = new URL((await sim.launch(LESSON_AU)).launchUrl);
    u.searchParams.set(param, value);
    const res = (await bridge.fetch(new Request(u)))!;
    expect(res.status).toBe(400);
    expect(fetchPosts()).toBe(0);
  });

  it('refuses a launch whose contextTemplate names another AU, after the fetch, and sends nothing', async () => {
    const { lrs, sim, bridge } = setup();
    const u = new URL((await sim.launch(PLACEMENT_AU)).launchUrl);
    u.searchParams.set('au', 'lesson-1');
    const before = lrs.statements().length;
    const res = (await bridge.fetch(new Request(u)))!;
    expect(res.status).toBe(502);
    expect(lrs.statements()).toHaveLength(before);
  });

  it('stores nothing when initialized is refused', async () => {
    const { lrs, sim, bridge } = setup();
    const l = await sim.launch(LESSON_AU);
    const realFetch = lrs.fetch;
    lrs.fetch = async (req) => (req.method === 'PUT' && new URL(req.url).pathname.endsWith('/statements') ? new Response(null, { status: 500 }) : realFetch(req));
    const res = (await bridge.fetch(new Request(l.launchUrl)))!;
    expect(res.status).toBe(502);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(verbs(lrs)).toEqual([ADL_VERBS.launched]);
  });
});

