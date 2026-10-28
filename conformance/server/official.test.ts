// SPDX-License-Identifier: Apache-2.0
// Course server class, custody options 1 to 3 (skipped in option 4): authorization, the record holder for the
// option (LMS's LRS, the author's LRS, the server's own store), viewing and exporting, registrations and restarts.
import { randomBytes, createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { actorKey, type XapiAgent, type XapiStatement } from '@course-xapi-mcp/core';
import type { StateScope } from '../lib/index.ts';
import { validateStatement } from '@course-xapi-mcp/core/xapi';
import {
  COURSE_ID,
  CUSTODY,
  EXPORT_URL,
  LRS_URL,
  MCP_URL,
  OFFICIAL,
  ORIGIN,
  REDIRECT_URI,
  REPLY,
  authMetadata,
  beatsUntil,
  connect,
  exportedStatements,
  fetchExport,
  gapName,
  knownGap,
  newLearner,
  ok,
  place,
  requireEnv,
  startLms,
  stepIs,
  verbOf,
  type Learner,
  type Lms,
} from './client.ts';

requireEnv();

const OPTION1 = CUSTODY === 'lms-launched';
const LRS_HOLDER = CUSTODY === 'lms-launched' || CUSTODY === 'author-lrs';
const lrsHeaders = { authorization: 'Basic ' + btoa('test:test'), 'x-experience-api-version': '1.0.3' };

let lms: Lms | undefined;
const open: Learner[] = [];
beforeAll(async () => {
  if (OPTION1) lms = await startLms();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((l) => l.close()));
});
afterAll(async () => {
  await lms?.close();
});
async function learner(): Promise<Learner> {
  const l = await newLearner(lms);
  open.push(l);
  return l;
}

/** Sends a request to the LRS the record lives in (option 1: the LMS's, option 2: the author's). */
function lrsFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...lrsHeaders, ...(init.headers as Record<string, string>) };
  if (OPTION1) return lms!.lrs.fetch(new Request(`${lms!.lrsUrl}/${path}`, { ...init, headers }));
  return fetch(`${LRS_URL!.replace(/\/+$/, '')}/${path}`, { ...init, headers });
}

/** The query that names one State API document. */
const scopeQuery = (d: StateScope) => {
  const q = new URLSearchParams({ activityId: d.activityId, agent: JSON.stringify(d.agent), stateId: d.stateId });
  if (d.registration) q.set('registration', d.registration);
  return q;
};

/**
 * The State API documents the server wrote for this learner, found from traffic the suite sees, not from where a
 * server is expected to keep them. Option 1: the PUTs the server sent the LMS's LRS with this learner's launch tokens.
 * Option 2: the bundled test LRS lists the documents it holds; those under this learner's actor.
 */
async function stateDocuments(l: Learner): Promise<StateScope[]> {
  if (OPTION1) {
    const tokens = new Set(lms!.launches.filter((x) => x.registration === l.registration).map((x) => 'Basic ' + x.token));
    const found = new Map<string, StateScope>();
    for (const r of lms!.requests) {
      if (r.method !== 'PUT' || !r.path.endsWith('/activities/state') || !tokens.has(r.authorization ?? '')) continue;
      const registration = r.query.get('registration');
      const d: StateScope = { activityId: r.query.get('activityId')!, agent: JSON.parse(r.query.get('agent')!), ...(registration ? { registration } : {}), stateId: r.query.get('stateId')! };
      found.set(scopeQuery(d).toString(), d);
    }
    return [...found.values()];
  }
  const actor = actorKey((await l.record())[0]!.actor);
  const all = (await (await lrsFetch('cxm-test/state')).json()) as StateScope[];
  return all.filter((d) => actorKey(d.agent) === actor);
}

const registrations = (list: XapiStatement[]) => [...new Set(list.map((s) => s.context?.registration))];

describe.skipIf(!OFFICIAL)('authorization and identity', () => {
  it('[CXM-BRG-011] is its own OAuth 2.1 authorization server: federated sign-in in option 2, own accounts in option 3', async () => {
    const { status, www, resource, as } = await authMetadata();
    expect(status).toBe(401);
    expect(www).toMatch(/^Bearer /);
    expect(resource.resource).toBe(MCP_URL);
    expect(new URL(resource.authorization_servers[0]).origin).toBe(ORIGIN);
    expect(as.issuer).toBe(resource.authorization_servers[0]);
    expect(as.code_challenge_methods_supported).toContain('S256');
    expect(as.response_types_supported).toContain('code');
    expect(new URL(as.authorization_endpoint).origin).toBe(ORIGIN);
    expect(new URL(as.token_endpoint).origin).toBe(ORIGIN);
    // A token the server did not issue is refused.
    const forged = await fetch(MCP_URL, { method: 'POST', headers: { authorization: 'Bearer forged.token.value', 'content-type': 'application/json' }, body: '{}' });
    expect(forged.status).toBe(401);

    // Where the authorization page sends the browser.
    const reg = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: 'probe', token_endpoint_auth_method: 'none' }) });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url'),
      code_challenge_method: 'S256',
      state: 's',
      resource: resource.resource,
    });
    const page = await fetch(`${as.authorization_endpoint}?${q}`, { redirect: 'manual' });
    if (CUSTODY === 'author-lrs') {
      expect(page.status).toBe(302);
      const idp = new URL(page.headers.get('location')!);
      expect(idp.origin).not.toBe(ORIGIN);
      expect(idp.searchParams.get('scope')?.split(' ')).toContain('openid');
    } else {
      expect(page.status).toBe(200);
      const html = await page.text();
      if (CUSTODY === 'server-kept') expect(html).toMatch(/type="password"/);
    }
    // Without the PKCE challenge the request is refused back to the client.
    q.delete('code_challenge');
    const noPkce = await fetch(`${as.authorization_endpoint}?${q}`, { redirect: 'manual' });
    expect(new URL(noPkce.headers.get('location') ?? 'http://x/').searchParams.get('error')).toBe('invalid_request');
  });

  it.skipIf(OPTION1)('[CXM-BRG-012] options 2 and 3: the actor is an account under the course IRI base, named by the identity provider subject', async () => {
    const l = await learner();
    await place(l, 'intro');
    const actors = (await l.record()).map((s) => s.actor);
    expect(actors.length).toBeGreaterThan(0);
    const first = actors[0]! as XapiAgent;
    expect(first.account?.homePage).toBe(COURSE_ID);
    expect(first.account?.name).toBeTruthy();
    for (const a of actors) expect(a).toEqual(first);
  });

  it('[CXM-BRG-013] mints the registration, reuses it on return, and mints a new one on restart_course', async () => {
    const l = await learner();
    await place(l, 'intro');
    ok(await l.call('next_beat'));
    // The learner returns through a new agent connection.
    const back = await connect({ url: l.url, token: l.token });
    try {
      ok(await back.call('next_beat'));
    } finally {
      await back.close();
    }
    const regs = registrations((await l.record()).filter((s) => !(OPTION1 && verbOf(s) === 'launched')));
    const current = regs.at(-1);
    expect(current).toMatch(/^[0-9a-f-]{36}$/);
    const recent = (await l.record()).slice(-4);
    for (const s of recent) expect(s.context.registration).toBe(current);
    if (OPTION1) return;
    ok(await l.call('restart_course'));
    await place(l, 'intro');
    const after = (await l.record()).at(-1)!;
    expect(after.context.registration).not.toBe(current);
  });

  it('[CXM-SRV-012] restart_course: a new registration in options 2 and 3, the old one unchanged; in option 1 the learner asks the LMS', async () => {
    const l = await learner();
    await place(l, 'intro');
    await beatsUntil(l, stepIs('checkpoint'));
    if (OPTION1) {
      const r = await l.call('restart_course');
      expect(r.isError).toBe(true);
      expect(r.data.error).toMatch(/LMS/);
      return;
    }
    const before = await l.record();
    const old = before.at(-1)!.context.registration;
    const oldCount = before.filter((s) => s.context.registration === old).length;
    ok(await l.call('restart_course'));
    const status = ok(await l.call('get_status'));
    expect(status.data.next_tools).toContain('start_placement');
    await place(l, 'intro');
    const after = await l.record();
    // Only the open session of the old registration is closed; nothing else of it changes.
    const oldAfter = after.filter((s) => s.context.registration === old);
    expect(oldAfter.length - oldCount).toBeLessThanOrEqual(1);
    expect(oldAfter.slice(oldCount).map(verbOf).filter((v) => v !== 'terminated')).toEqual([]);
    expect(after.at(-1)!.context.registration).not.toBe(old);
  });
});

describe.skipIf(!OFFICIAL)('the record holder', () => {
  it('[CXM-CUS-003] the learner can view and export their record', async () => {
    const l = await learner();
    await place(l, 'intro');
    const rec = ok(await l.call('get_record'));
    expect(rec.data.record.statements.length).toBeGreaterThan(0);
    const ids = (await l.record()).map((s) => s.id);
    for (const s of rec.data.record.statements as XapiStatement[]) expect(ids).toContain(s.id);
    if (OPTION1) return;
    const status = ok(await l.call('get_status'));
    expect(status.data.links.view).toMatch(/^https?:\/\//);
    expect(status.data.links.export).toMatch(/^https?:\/\//);
    if (!EXPORT_URL) return;
    const { status: code, body } = await fetchExport();
    expect(code).toBe(200);
    expect(exportedStatements(body)!.map((s) => s.id).sort()).toEqual([...ids].sort());
  });

  it('[CXM-CUS-008] offers no tool that deletes the official record', async () => {
    const l = await learner();
    await place(l, 'intro');
    const before = (await l.record()).length;
    expect((await l.call('delete_practice_record')).isError).toBe(true);
    for (const t of await l.mcp.tools()) expect(t.name === 'delete_practice_record' || !/delete|erase|remove/i.test(t.name), t.name).toBe(true);
    expect((await l.record()).length).toBe(before);
  });

  it.skipIf(knownGap('CXM-CUS-008 deletion link'))(gapName('CXM-CUS-008 deletion link', '[CXM-CUS-008] get_status gives the record holder link for deletion'), async () => {
    const l = await learner();
    await place(l, 'intro');
    const status = ok(await l.call('get_status'));
    expect(status.data.links.delete).toMatch(/^https?:\/\//);
  });

  it.skipIf(!LRS_HOLDER)('[CXM-CUS-006] options 1 and 2: every statement, including the learner free-text answer, reaches the official record in real time', async () => {
    const l = await learner();
    await place(l, 'intro');
    ok(await l.call('next_beat'));
    ok(await l.call('next_beat'));
    const r = ok(await l.call('next_beat', { learner_reply: REPLY }));
    expect(r.data.delivery ?? 'delivered').toBe('delivered');
    // Read straight after the call: no queue and no confirm step.
    const answered = (await l.record()).filter((s) => verbOf(s) === 'answered');
    expect(answered.at(-1)?.result?.response).toBe(REPLY);
  });

  it.skipIf(!LRS_HOLDER)('[CXM-CUS-019] options 1 and 2: the LRS is authoritative for the working state', async () => {
    const l = await learner();
    await place(l, 'intro');
    ok(await l.call('next_beat'));
    // Erase every State API document the server wrote for this learner, wherever it put them.
    const docs = await stateDocuments(l);
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) {
      const del = await lrsFetch(`activities/state?${scopeQuery(d)}`, { method: 'DELETE' });
      expect(del.status).toBe(204);
    }
    const r = await l.call('next_beat');
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.data)).toMatch(/start_placement/);
  });

  it.skipIf(!OPTION1)('[CXM-CUS-009] option 1: statements go to the LMS endpoint with the session token, and working state to its State API', async () => {
    const l = await learner();
    await place(l, 'intro');
    ok(await l.call('next_beat'));
    const tokens = new Set(lms!.launches.filter((x) => x.registration === l.registration).map((x) => 'Basic ' + x.token));
    const mine = lms!.requests.filter((r) => r.authorization && tokens.has(r.authorization));
    expect(mine.some((r) => r.method !== 'GET' && r.path.endsWith('/statements'))).toBe(true);
    expect(mine.some((r) => r.method === 'PUT' && r.path.endsWith('/activities/state'))).toBe(true);
    // Every write to the LMS's LRS uses a launch token, never another credential.
    const anyLaunch = new Set(lms!.launches.map((x) => 'Basic ' + x.token));
    for (const r of lms!.requests.filter((x) => x.method !== 'GET' && !x.path.includes('/cmi5/fetch/'))) expect(anyLaunch.has(r.authorization ?? '')).toBe(true);
  });

  it.skipIf(!OPTION1)('[CXM-CUS-010] option 1: get_record returns what the token reads for the registration and a receipt of the statements sent', async () => {
    const l = await learner();
    await place(l, 'intro');
    ok(await l.call('next_beat'));
    const rec = ok(await l.call('get_record'));
    const held = await l.record();
    expect((rec.data.record.statements as XapiStatement[]).map((s) => s.id).sort()).toEqual(held.map((s) => s.id).sort());
    const receipt = rec.data.record.receipt as { id: string; verb: string; object: string; timestamp: string }[];
    expect(receipt.length).toBeGreaterThan(0);
    for (const r of receipt) {
      const s = held.find((x) => x.id === r.id);
      expect(s, `receipt ${r.id} is in the record`).toBeDefined();
      expect(r.object).toBe(s!.object.id);
    }
    // Every statement the tools sent.
    for (const s of held.filter((x) => !['launched', 'initialized', 'terminated'].includes(verbOf(x)))) expect(receipt.map((r) => r.id), verbOf(s)).toContain(s.id);
  });

  it.skipIf(!OPTION1 || knownGap('CXM-CUS-010 launch statements'))(
    gapName('CXM-CUS-010 launch statements', '[CXM-CUS-010] option 1: the receipt also lists the initialized and terminated the server sent at launch and end'),
    async () => {
      const l = await learner();
      await place(l, 'intro');
      const rec = ok(await l.call('get_record'));
      const receipt = (rec.data.record.receipt as { id: string }[]).map((r) => r.id);
      for (const s of (await l.record()).filter((x) => verbOf(x) === 'initialized' || verbOf(x) === 'terminated')) expect(receipt, verbOf(s)).toContain(s.id);
    },
  );

  it.skipIf(!OPTION1 || knownGap('CXM-CUS-010 LMS link'))(gapName('CXM-CUS-010 LMS link', '[CXM-CUS-010] option 1: get_record gives the LMS link'), async () => {
    const l = await learner();
    await place(l, 'intro');
    const rec = ok(await l.call('get_record'));
    expect(JSON.stringify(rec.data.links)).toMatch(/https?:\/\//);
  });

  it.skipIf(CUSTODY !== 'author-lrs')('[CXM-CUS-011] option 2: statements go to the author LRS, and working state and registrations to its State API', async () => {
    const l = await learner();
    await place(l, 'intro');
    const held = await l.record();
    expect(held.length).toBeGreaterThan(0);
    const registration = held.at(-1)!.context.registration!;
    const docs = await stateDocuments(l);
    expect(docs.length).toBeGreaterThan(0);
    // The registration is kept in the State API: as a document's scope, or inside a document.
    const bodies = await Promise.all(docs.map(async (d) => (await lrsFetch(`activities/state?${scopeQuery(d)}`)).text()));
    expect(docs.some((d) => d.registration === registration) || bodies.some((b) => b.includes(registration))).toBe(true);
  });

  it.skipIf(CUSTODY !== 'author-lrs')('[CXM-CUS-012] option 2: get_record and the export page are both read from the LRS', async () => {
    const l = await learner();
    await place(l, 'intro');
    const lrs = (await l.record()).map((s) => s.id).sort();
    const rec = ok(await l.call('get_record'));
    expect((rec.data.record.statements as XapiStatement[]).map((s) => s.id).sort()).toEqual(lrs);
    expect(EXPORT_URL).toBeDefined();
    const { body } = await fetchExport();
    expect(exportedStatements(body)!.map((s) => s.id).sort()).toEqual(lrs);
  });

  it.skipIf(CUSTODY !== 'server-kept')('[CXM-CUS-013] option 3: get_record and the export page give the record in an xAPI statement export format', async () => {
    const l = await learner();
    await place(l, 'intro');
    const rec = ok(await l.call('get_record'));
    const { status, body } = await fetchExport();
    expect(status).toBe(200);
    const exported = exportedStatements(body)!;
    expect(exported.length).toBeGreaterThan(0);
    for (const s of exported) expect(validateStatement(s)).toEqual([]);
    expect((rec.data.record.statements as XapiStatement[]).map((s) => s.id).sort()).toEqual(exported.map((s) => s.id).sort());
  });

  it.skipIf(CUSTODY !== 'server-kept')('[CXM-CUS-014] option 3: publishes a deletion and retention policy', async () => {
    const l = await learner();
    const status = ok(await l.call('get_status'));
    const res = await fetch(status.data.links.policy);
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(20);
  });
});
