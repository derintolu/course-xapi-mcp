// SPDX-License-Identifier: Apache-2.0
// Launch bridge class (custody option 1): the bundled cmi5 LMS simulator and test LRS launch AUs at the server
// under test, the scripted client pairs with the launch on the authorization page and connects over MCP. Checks:
// fetch once and server-side, LaunchData honoured, contextTemplate on every statement, initialized at once, the
// token never shown, the page, cookie and pairing-code binding, later launches attaching, return-to-lms, relaunch.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { XapiStatement } from '@course-xapi-mcp/core';
import {
  AU_IDS,
  COURSE_ID,
  LMS_ACTOR,
  MCP_URL,
  RETURN_URL,
  TEMPLATE_EXT,
  TEMPLATE_VALUE,
  authorize,
  browserPages,
  isDefined,
  jar,
  launchedLearner,
  ok,
  pair,
  pairingCodeOf,
  requireEnv,
  sessionOf,
  startLms,
  tokenOnLaunch,
  transcript,
  typePairingCode,
  verbOf,
  walkIntro,
  type FormFill,
  type Launch,
  type Learner,
  type Lms,
} from '../server/client.ts';

requireEnv({ custody: 'lms-launched' });

let lms: Lms;
const learners: Learner[] = [];
/** The walk: placement, then the intro lesson through to the next lesson. */
let walker: Learner;
let placed: { data: any };

beforeAll(async () => {
  lms = await startLms();
  walker = await launchedLearner(lms);
  learners.push(walker);
  ok(await walker.call('get_status'));
  ok(await walker.call('start_placement'));
  placed = ok(await walker.call('choose_placement', { pathKey: 'basics', startLessonKey: 'intro', skip: [], reason: 'Bridge class walk.' }));
  await walkIntro(walker, 'next');
  ok(await walker.call('next_beat'));
  ok(await walker.call('end_session'));
});
afterAll(async () => {
  await Promise.all(learners.map((l) => l.close()));
  await lms.close();
});

const mine = (l: Learner) => lms.launches.filter((x) => x.registration === l.registration);
const serverStatements = (list: XapiStatement[]) => list.filter((s) => !(isDefined(s) && verbOf(s) === 'launched'));
const requestsWith = (launch: Launch) => lms.requests.filter((r) => r.authorization === 'Basic ' + launch.token);

describe('the launch', () => {
  it('[CXM-BRG-019] parses the launch parameters and POSTs to fetch once, server-side', async () => {
    for (const launch of mine(walker)) {
      const path = new URL(launch.fetchUrl).pathname;
      expect(lms.requests.filter((r) => r.path === path)).toHaveLength(1);
      expect(lms.requests.find((r) => r.path === path)!.method).toBe('POST');
      expect(launch.page).not.toContain(launch.fetchUrl);
      expect(launch.page).not.toContain(path);
    }
    // A launch link with a broken parameter is refused before any fetch.
    const before = lms.requests.length;
    const good = await lms.sim.launch(AU_IDS.placement, { registration: randomUUID() });
    for (const [k, v] of [
      ['registration', 'not-a-uuid'],
      ['actor', '{"objectType":"Group"}'],
      ['fetch', 'ftp://127.0.0.1/x'],
    ]) {
      const u = new URL(good.launchUrl);
      u.searchParams.set(k!, v!);
      const res = await fetch(u);
      expect(res.status, k).toBeGreaterThanOrEqual(400);
      await res.text();
    }
    expect(lms.requests.slice(before).filter((r) => r.path.includes('/cmi5/fetch/'))).toEqual([]);
  });

  it('[CXM-BRG-020] reads and honours LMS.LaunchData and cmi5LearnerPreferences; every statement carries the launch contextTemplate', async () => {
    for (const launch of mine(walker)) {
      const reads = requestsWith(launch).filter((r) => r.method === 'GET');
      expect(reads.some((r) => r.path.endsWith('/activities/state') && r.query.get('stateId') === 'LMS.LaunchData'), launch.auKey).toBe(true);
      expect(reads.some((r) => r.path.endsWith('/agents/profile') && r.query.get('profileId') === 'cmi5LearnerPreferences'), launch.auKey).toBe(true);
    }
    const statements = serverStatements(await walker.record());
    expect(statements.length).toBeGreaterThan(8);
    for (const s of statements) {
      const launch = mine(walker).find((x) => x.sessionId === sessionOf(s));
      expect(launch, `${verbOf(s)} is in a launched session`).toBeDefined();
      expect(s.context.extensions?.[TEMPLATE_EXT], `${verbOf(s)} ${s.object.id}`).toBe(TEMPLATE_VALUE);
      const grouping = (s.context.contextActivities?.grouping ?? []).map((a) => a.id);
      expect(grouping).toContain(AU_IDS[launch!.auKey]);
      expect(grouping).toContain(COURSE_ID);
    }
  });

  it('[CXM-BRG-020] honours launchMode: a Review launch sends no cmi5 defined statement besides initialized and terminated (cmi5 10.2.2.0-11)', async () => {
    const l = await launchedLearner(lms);
    learners.push(l);
    ok(await l.mcp.call('start_placement'));
    ok(await l.mcp.call('choose_placement', { pathKey: 'basics', startLessonKey: 'intro', skip: [], reason: 'Review mode check.' }));
    const review = await lms.launch('intro', { registration: l.registration, launchMode: 'Review' });
    await walkIntro(l, 'next');
    const session = serverStatements(lms.lrs.statements().filter((s) => sessionOf(s) === review.sessionId));
    expect(session.length).toBeGreaterThan(4);
    expect(session.filter(isDefined).map(verbOf)).toEqual(['initialized', 'terminated']);
  });

  it('[CXM-BRG-021] stores the launch and sends initialized straight away, as the first statement of the session; terminated with its duration is the last', async () => {
    const launch = await lms.launch('placement', { registration: randomUUID() });
    expect(launch.status).toBe(200);
    // No tool call yet.
    const session = lms.lrs.statements().filter((s) => sessionOf(s) === launch.sessionId);
    expect(session.map(verbOf)).toEqual(['launched', 'initialized']);
    expect(requestsWith(launch).some((r) => r.method !== 'GET' && r.path.endsWith('/statements'))).toBe(true);
    // The walk's sessions start with initialized, and end with terminated and its duration.
    for (const l of mine(walker)) {
      const own = serverStatements(lms.lrs.statements().filter((s) => sessionOf(s) === l.sessionId));
      expect(verbOf(own[0]!), l.auKey).toBe('initialized');
      expect(verbOf(own.at(-1)!), l.auKey).toBe('terminated');
      expect(own.at(-1)!.result?.duration, l.auKey).toMatch(/^P/);
    }
  });

  it('[CXM-BRG-023] the bridge page tells the learner to continue in their agent and shows the MCP URL', () => {
    const page = mine(walker)[0]!.page;
    expect(page).toContain(MCP_URL);
    expect(page).toMatch(/agent/i);
  });
});

describe('pairing and launches', () => {
  it('[CXM-BRG-024] binds the grant through the bridge cookie, or a single-use six-character pairing code typed on the authorization page', async () => {
    // The cookie: the browser that launched.
    const byCookie = await lms.launch('placement', { registration: randomUUID() });
    const a = await pair(byCookie, 'cookie');
    expect(a.pages.some((p) => /type="text"/.test(p))).toBe(false);
    const la = await tokenOnLaunch(lms, a.accessToken, byCookie.registration);
    learners.push(la);
    ok(await la.call('start_placement'));

    // The code: another browser.
    const byCode = await lms.launch('placement', { registration: randomUUID() });
    const code = pairingCodeOf(byCode.page)!;
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    // A wrong code is refused.
    const wrong = code[0] === 'A' ? 'B' + code.slice(1) : 'A' + code.slice(1);
    await expect(authorize({ browser: jar(), fill: wrongOnce(wrong) })).rejects.toThrow();
    const b = await authorize({ browser: jar(), fill: typePairingCode(code) });
    const lb = await tokenOnLaunch(lms, b.accessToken, byCode.registration);
    learners.push(lb);
    ok(await lb.call('start_placement'));
    expect((await lb.record()).every((s) => s.context.registration === byCode.registration)).toBe(true);
    // Single use: the same code pairs no second agent, and the cookie's launch code is spent too.
    await expect(authorize({ browser: jar(), fill: typePairingCode(code) })).rejects.toThrow();
    await expect(authorize({ browser: jar(), fill: typePairingCode(pairingCodeOf(byCookie.page)!) })).rejects.toThrow();
  });

  it('[CXM-BRG-025] the grant binds to the registration, and later launches in it attach to the same agent connection', async () => {
    // The walk's one connection, paired on the placement launch, carried on into the intro and types launches.
    const sessions = new Set(serverStatements(await walker.record()).map(sessionOf));
    for (const key of ['placement', 'intro', 'types'] as const) {
      const launch = mine(walker).find((x) => x.auKey === key)!;
      expect(sessions.has(launch.sessionId), key).toBe(true);
    }
    // A launch in another registration does not attach to it.
    const elsewhere = await lms.launch('intro', { registration: randomUUID() });
    ok(await walker.call('get_status'));
    expect(lms.lrs.statements().filter((s) => sessionOf(s) === elsewhere.sessionId).map(verbOf)).toEqual(['launched', 'initialized']);
    expect((await walker.record()).every((s) => s.context.registration === walker.registration)).toBe(true);
  });

  it('[CXM-BRG-026] when the next lesson is a different AU, the result sends the learner back to the LMS (returnURL)', () => {
    expect(placed.data.next).toMatchObject({ type: 'return-to-lms', lessonKey: 'intro' });
    expect(placed.data.next.returnURL ?? placed.data.returnURL).toBe(RETURN_URL);
  });

  it('[CXM-BRG-028] on a relaunch the newest launch is live, and calls on the stale launch say it was relaunched elsewhere', async () => {
    const registration = randomUUID();
    const p = await lms.launch('placement', { registration });
    const first = await tokenOnLaunch(lms, (await pair(p)).accessToken, registration);
    learners.push(first);
    ok(await first.call('start_placement'));
    ok(await first.call('choose_placement', { pathKey: 'basics', startLessonKey: 'intro', skip: [], reason: 'Relaunch check.' }));
    // The LMS launched intro for `first`; a second agent pairs with that launch by its code.
    const intro1 = lms.launches.filter((x) => x.registration === registration && x.auKey === 'intro').at(-1)!;
    const old = await tokenOnLaunch(lms, (await pair(intro1, 'code')).accessToken, registration);
    learners.push(old);
    ok(await old.call('next_beat'));
    // The learner launches intro again from the LMS, and pairs there.
    const intro2 = await lms.launch('intro', { registration });
    const fresh = await tokenOnLaunch(lms, (await pair(intro2)).accessToken, registration);
    learners.push(fresh);
    const stale = await old.call('next_beat');
    expect(stale.isError).toBe(true);
    expect(stale.data.error).toMatch(/relaunched/i);
    const live = ok(await fresh.call('next_beat'));
    expect(live.data.step).toBeDefined();
    const last = (await fresh.record()).filter((s) => !(isDefined(s) && verbOf(s) === 'launched')).at(-1)!;
    expect(sessionOf(last)).toBe(intro2.sessionId);
  });

  it('[CXM-BRG-029] the actor is the one the LMS supplied, with no dual write and no anonymous copy', async () => {
    const all = lms.lrs.statements();
    expect(all.length).toBeGreaterThan(10);
    for (const s of all) expect(s.actor).toEqual(LMS_ACTOR);
    // The record the agent can read is the LMS's, not a copy elsewhere.
    const rec = ok(await walker.call('get_record'));
    const ids = new Set((await walker.record()).map((s) => s.id));
    for (const s of rec.data.record.statements as XapiStatement[]) {
      expect(ids.has(s.id)).toBe(true);
      expect(s.actor).toEqual(LMS_ACTOR);
    }
  });
});

// Last, so it scans every page and result the other tests produced.
describe('secrecy', () => {
  it('[CXM-BRG-022] the LMS token reaches neither the browser nor the agent', async () => {
    const launches = lms.launches;
    expect(launches.length).toBeGreaterThan(3);
    expect(browserPages.length).toBeGreaterThan(6);
    const shown = [...launches.map((l) => l.page), ...browserPages, ...transcript.map((t) => t.plain)];
    for (const l of launches) {
      for (const text of shown) expect(text.includes(l.token)).toBe(false);
      expect(l.browser.header().includes(l.token)).toBe(false);
    }
  });
});

/** Types `code` into the code field (for a wrong code: the page then shows the form again, and the flow is abandoned). */
function wrongOnce(code: string): FormFill {
  let typed = false;
  return (forms, page) => {
    if (typed) return undefined;
    typed = true;
    return typePairingCode(code)(forms, page);
  };
}
