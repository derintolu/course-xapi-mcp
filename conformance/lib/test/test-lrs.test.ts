// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestLrs, type TestLrs } from '../index.ts';

const BASE = 'http://lrs.test/xapi';
const AUTH = 'Basic ' + btoa('test:test');
const AGENT = JSON.stringify({ account: { homePage: 'https://lms.example', name: 'a' } });
const statement = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  actor: { account: { homePage: 'https://lms.example', name: 'a' } },
  verb: { id: 'http://adlnet.gov/expapi/verbs/experienced', display: { 'en-US': 'experienced' } },
  object: { objectType: 'Activity', id: 'https://example.org/act' },
  timestamp: '2026-01-01T00:00:00.000Z',
  ...over,
});

function send(lrs: TestLrs, path: string, init: RequestInit & { version?: string | null; auth?: string | null } = {}) {
  const { version = '1.0.3', auth = AUTH, ...rest } = init;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(rest.headers as Record<string, string>) };
  if (version) headers['x-experience-api-version'] = version;
  if (auth) headers.authorization = auth;
  return lrs.fetch(new Request(BASE + path, { ...rest, headers }));
}
const stateQuery = (id = 'doc') => `/activities/state?activityId=${encodeURIComponent('https://example.org/act')}&agent=${encodeURIComponent(AGENT)}&stateId=${id}`;

let open: TestLrs | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('test LRS', () => {
  it('round-trips state with an ETag and refuses a stale If-Match with 412', async () => {
    const lrs = createTestLrs();
    const put = await send(lrs, stateQuery(), { method: 'PUT', body: '{"n":1}' });
    expect(put.status).toBe(204);
    const etag = put.headers.get('etag')!;
    const got = await send(lrs, stateQuery());
    expect(got.status).toBe(200);
    expect(got.headers.get('etag')).toBe(etag);
    expect(await got.json()).toEqual({ n: 1 });

    expect((await send(lrs, stateQuery(), { method: 'PUT', body: '{"n":2}', headers: { 'if-match': etag } })).status).toBe(204);
    expect((await send(lrs, stateQuery(), { method: 'PUT', body: '{"n":3}', headers: { 'if-match': etag } })).status).toBe(412);
    expect(await (await send(lrs, stateQuery())).json()).toEqual({ n: 2 });
  });

  it('answers 412 to If-None-Match: * on an existing document, and deletes', async () => {
    const lrs = createTestLrs();
    expect((await send(lrs, stateQuery(), { method: 'PUT', body: '1', headers: { 'if-none-match': '*' } })).status).toBe(204);
    expect((await send(lrs, stateQuery(), { method: 'PUT', body: '2', headers: { 'if-none-match': '*' } })).status).toBe(412);
    expect((await send(lrs, stateQuery(), { method: 'DELETE' })).status).toBe(204);
    expect((await send(lrs, stateQuery())).status).toBe(404);
  });

  it('keeps agent profile documents', async () => {
    const lrs = createTestLrs();
    const q = `/agents/profile?agent=${encodeURIComponent(AGENT)}&profileId=p`;
    expect((await send(lrs, q)).status).toBe(404);
    expect((await send(lrs, q, { method: 'PUT', body: '{"x":1}' })).status).toBe(204);
    expect(await (await send(lrs, q)).json()).toEqual({ x: 1 });
  });

  it('PUT of an existing statement id gives 409 for different content and 204 for identical content', async () => {
    const lrs = createTestLrs();
    const s = statement();
    const put = (body: unknown) => send(lrs, `/statements?statementId=${s.id}`, { method: 'PUT', body: JSON.stringify(body) });
    expect((await put(s)).status).toBe(204);
    expect((await put({ ...s })).status).toBe(204);
    expect((await put(statement({ id: s.id, timestamp: '2026-01-02T00:00:00.000Z' }))).status).toBe(409);
    expect(lrs.statements()).toHaveLength(1);
  });

  it('POSTs, filters and pages statements', async () => {
    const lrs = createTestLrs();
    const reg = randomUUID();
    const a = statement();
    const b = statement({ verb: { id: 'http://adlnet.gov/expapi/verbs/passed', display: { 'en-US': 'passed' } }, context: { registration: reg } });
    const c = statement();
    expect((await send(lrs, '/statements', { method: 'POST', body: JSON.stringify([a, b, c]) })).status).toBe(200);
    expect(lrs.statements().map((s) => s.id)).toEqual([a.id, b.id, c.id]);

    const one = (await (await send(lrs, `/statements?statementId=${b.id}`)).json()) as { id: string };
    expect(one.id).toBe(b.id);
    const byVerb = (await (await send(lrs, `/statements?verb=${encodeURIComponent(b.verb.id)}`)).json()) as { statements: { id: string }[] };
    expect(byVerb.statements.map((s) => s.id)).toEqual([b.id]);
    const byReg = (await (await send(lrs, `/statements?registration=${reg}`)).json()) as { statements: unknown[] };
    expect(byReg.statements).toHaveLength(1);
    const byAgent = (await (await send(lrs, `/statements?agent=${encodeURIComponent(AGENT)}&activity=${encodeURIComponent(a.object.id)}`)).json()) as { statements: unknown[] };
    expect(byAgent.statements).toHaveLength(3);

    const first = (await (await send(lrs, '/statements?limit=2&ascending=true')).json()) as { statements: { id: string }[]; more: string };
    expect(first.statements.map((s) => s.id)).toEqual([a.id, b.id]);
    const second = (await (await send(lrs, first.more.replace('/xapi', ''))).json()) as { statements: { id: string }[]; more: string };
    expect(second.statements.map((s) => s.id)).toEqual([c.id]);
    expect(second.more).toBe('');
  });

  it('answers 400 without the version header and for an invalid statement, 401 without credentials', async () => {
    const lrs = createTestLrs();
    expect((await send(lrs, '/about', { version: null })).status).toBe(400);
    expect((await send(lrs, '/about', { auth: null })).status).toBe(401);
    expect((await send(lrs, '/about', { auth: 'Basic ' + btoa('test:wrong') })).status).toBe(401);
    const bad = await send(lrs, '/statements', { method: 'POST', body: JSON.stringify(statement({ timestamp: 'yesterday' })) });
    expect(bad.status).toBe(400);
    expect(lrs.statements()).toEqual([]);
  });

  it('accepts a known token as Basic credentials', async () => {
    const lrs = createTestLrs();
    expect((await send(lrs, '/about', { auth: 'Basic tok' })).status).toBe(401);
    lrs.addToken('tok');
    expect((await send(lrs, '/about', { auth: 'Basic tok' })).status).toBe(200);
  });

  it('failNext(1, 503) fails exactly one request', async () => {
    const lrs = createTestLrs();
    lrs.failNext(1, 503);
    expect((await send(lrs, '/about')).status).toBe(503);
    expect((await send(lrs, '/about')).status).toBe(200);
  });

  it('accepts both versions when configured and rejects 2.0.0 when only 1.0.3 is', async () => {
    const both = createTestLrs();
    expect((await send(both, '/about', { version: '1.0.3' })).status).toBe(200);
    expect((await send(both, '/about', { version: '2.0.0' })).status).toBe(200);
    const old = createTestLrs({ versions: ['1.0.3'] });
    expect((await send(old, '/about', { version: '1.0.3' })).status).toBe(200);
    expect((await send(old, '/about', { version: '2.0.0' })).status).toBe(400);
  });

  it('serves a registered fetch URL once', async () => {
    const lrs = createTestLrs();
    lrs.registerFetch('f1', 'secret-token');
    const post = () => lrs.fetch(new Request(BASE + '/cmi5/fetch/f1', { method: 'POST' }));
    expect(await (await post()).json()).toEqual({ 'auth-token': 'secret-token' });
    expect(await (await post()).json()).toEqual({ 'error-code': '1', 'error-text': 'already in use' });
    expect((await send(lrs, '/about', { auth: 'Basic secret-token' })).status).toBe(200);
  });

  it('reset clears statements and documents', async () => {
    const lrs = createTestLrs();
    await send(lrs, '/statements', { method: 'POST', body: JSON.stringify(statement()) });
    await send(lrs, stateQuery(), { method: 'PUT', body: '1' });
    lrs.reset();
    expect(lrs.statements()).toEqual([]);
    expect((await send(lrs, stateQuery())).status).toBe(404);
  });

  it('listen serves the same handlers over HTTP on 127.0.0.1', async () => {
    const lrs = (open = createTestLrs({ credentials: [{ key: 'k', secret: 's' }] }));
    const url = await lrs.listen();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const headers = { authorization: 'Basic ' + btoa('k:s'), 'x-experience-api-version': '1.0.3', 'content-type': 'application/json' };
    const s = statement();
    expect((await fetch(`${url}/statements`, { method: 'POST', headers, body: JSON.stringify(s) })).status).toBe(200);
    expect(lrs.statements()).toHaveLength(1);
    expect((await fetch(`${url}/about`)).status).toBe(401);
  });
});
