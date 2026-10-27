// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { StoreConflictError } from '@course-xapi-mcp/core';
import { Cmi5FetchError, LrsError, createLrsClient, fetchAuthToken } from '../src/index.ts';

type Call = { url: string; method: string; headers: Headers; body?: string };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

function stub(handler: (call: Call, n: number) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const r = await handler(call, calls.length);
    const status = r.status ?? 200;
    const noBody = status === 204 || r.body === undefined;
    return new Response(noBody ? null : JSON.stringify(r.body), { status, headers: r.headers });
  }) as typeof fetch;
  return { f, calls };
}

const basic = { type: 'basic', key: 'k', secret: 'sekrit' } as const;
const b64 = Buffer.from('k:sekrit').toString('base64');
const stmt = (id: string) => ({
  id,
  actor: { account: { homePage: 'https://x.example', name: 'a' } },
  verb: { id: 'https://v.example/v', display: { 'en-US': 'v' } },
  object: { objectType: 'Activity' as const, id: 'https://a.example/1' },
  context: { registration: '11111111-1111-4111-8111-111111111111' },
  timestamp: '2026-01-01T00:00:00.000Z',
});
const agent = { account: { homePage: 'https://x.example', name: 'a' } };

describe('version negotiation', () => {
  it('picks 2.0.0 when about lists it', async () => {
    const { f, calls } = stub(() => ({ body: { version: ['1.0.3', '2.0.0'] } }));
    const c = createLrsClient({ endpoint: 'https://lrs.example/xapi/', auth: basic, fetch: f });
    expect(await c.version()).toBe('2.0.0');
    expect(await c.version()).toBe('2.0.0');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://lrs.example/xapi/about');
  });
  it('picks 1.0.3 when only that is listed', async () => {
    const { f } = stub(() => ({ body: { version: ['1.0.3'] } }));
    expect(await createLrsClient({ endpoint: 'https://lrs.example/xapi', auth: basic, fetch: f }).version()).toBe('1.0.3');
  });
  it('uses a fixed version without calling about', async () => {
    const { f, calls } = stub(() => ({ status: 204 }));
    const c = createLrsClient({ endpoint: 'https://lrs.example/xapi', auth: basic, version: '2.0.0', fetch: f });
    expect(await c.version()).toBe('2.0.0');
    await c.putStatement(stmt('s1'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('x-experience-api-version')).toBe('2.0.0');
  });
});

describe('requests', () => {
  it('carries the version header and Basic auth on every request', async () => {
    const { f, calls } = stub((c) => (c.url.endsWith('/about') ? { body: { version: ['1.0.3'] } } : { status: 204 }));
    const c = createLrsClient({ endpoint: 'https://lrs.example/xapi', auth: basic, fetch: f });
    await c.putStatement(stmt('s1'));
    for (const call of calls) {
      expect(call.headers.get('x-experience-api-version')).toBe('1.0.3');
      expect(call.headers.get('authorization')).toBe(`Basic ${b64}`);
    }
    expect(calls[1]!.method).toBe('PUT');
    expect(calls[1]!.url).toBe('https://lrs.example/xapi/statements?statementId=s1');
  });
  it('sends a token as the Basic credential verbatim', async () => {
    const { f, calls } = stub(() => ({ status: 204 }));
    const c = createLrsClient({ endpoint: 'https://lrs.example/xapi', auth: { type: 'token', value: 'abc123' }, version: '1.0.3', fetch: f });
    await c.putStatement(stmt('s1'));
    expect(calls[0]!.headers.get('authorization')).toBe('Basic abc123');
  });
});

describe('statements', () => {
  const mk = (handler: Parameters<typeof stub>[0]) => {
    const s = stub(handler);
    return { ...s, c: createLrsClient({ endpoint: 'https://lrs.example/xapi', auth: basic, version: '1.0.3', fetch: s.f }) };
  };
  it('treats 409 on PUT as delivered', async () => {
    const { c } = mk(() => ({ status: 409 }));
    await expect(c.putStatement(stmt('s1'))).resolves.toBeUndefined();
  });
  it('throws LrsError with the status on other failures', async () => {
    const { c } = mk(() => ({ status: 500 }));
    await expect(c.putStatement(stmt('s1'))).rejects.toMatchObject({ name: 'LrsError', status: 500 });
  });
  it('POST 409 falls back to one PUT per statement', async () => {
    const { c, calls } = mk((call) => ({ status: call.method === 'POST' ? 409 : 204 }));
    await c.postStatements([stmt('a'), stmt('b')]);
    expect(calls.map((x) => x.method)).toEqual(['POST', 'PUT', 'PUT']);
    expect(calls[2]!.url).toContain('statementId=b');
  });
  it('POST success sends the list', async () => {
    const { c, calls } = mk(() => ({ body: ['a', 'b'] }));
    await c.postStatements([stmt('a'), stmt('b')]);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body!)).toHaveLength(2);
  });
  it('follows more across three pages and sends the query', async () => {
    const { c, calls } = mk((_c, n) =>
      n === 1 ? { body: { statements: [stmt('1')], more: '/xapi/statements?cursor=2' } }
      : n === 2 ? { body: { statements: [stmt('2')], more: '/xapi/statements?cursor=3' } }
      : { body: { statements: [stmt('3')], more: '' } });
    const got = await c.getStatements({ agent, verb: 'https://v.example/v', registration: 'r', since: '2026-01-01T00:00:00Z', limit: 1 });
    expect(got.map((s) => s.id)).toEqual(['1', '2', '3']);
    const u = new URL(calls[0]!.url);
    expect(JSON.parse(u.searchParams.get('agent')!)).toEqual(agent);
    expect(u.searchParams.get('verb')).toBe('https://v.example/v');
    expect(u.searchParams.get('limit')).toBe('1');
    expect(calls[2]!.url).toBe('https://lrs.example/xapi/statements?cursor=3');
    expect(calls[2]!.headers.get('authorization')).toBe(`Basic ${b64}`);
  });
  it('refuses a more link to another origin', async () => {
    const { c, calls } = mk(() => ({ body: { statements: [stmt('1')], more: 'https://evil.example/x' } }));
    await expect(c.getStatements({})).rejects.toBeInstanceOf(LrsError);
    expect(calls).toHaveLength(1);
  });
});

describe('state and profile', () => {
  const key = { activityId: 'https://a.example/1', agent, registration: 'r1', stateId: 'cursor' };
  const mk = (handler: Parameters<typeof stub>[0]) => {
    const s = stub(handler);
    return { ...s, c: createLrsClient({ endpoint: 'https://lrs.example/xapi', auth: basic, version: '1.0.3', fetch: s.f }) };
  };
  it('getState returns body and etag, undefined on 404', async () => {
    const a = mk(() => ({ body: { n: 1 }, headers: { ETag: '"e1"' } }));
    expect(await a.c.getState(key)).toEqual({ body: { n: 1 }, etag: '"e1"' });
    const u = new URL(a.calls[0]!.url);
    expect(u.pathname).toBe('/xapi/activities/state');
    expect(u.searchParams.get('stateId')).toBe('cursor');
    expect(u.searchParams.get('registration')).toBe('r1');
    const b = mk(() => ({ status: 404 }));
    expect(await b.c.getState(key)).toBeUndefined();
  });
  it('putState sends If-Match and returns the etag', async () => {
    const { c, calls } = mk(() => ({ status: 204, headers: { ETag: '"e2"' } }));
    expect(await c.putState(key, { n: 2 }, { ifMatch: '"e1"' })).toEqual({ etag: '"e2"' });
    expect(calls[0]!.headers.get('if-match')).toBe('"e1"');
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ n: 2 });
  });
  it('putState sends If-None-Match', async () => {
    const { c, calls } = mk(() => ({ status: 204 }));
    await c.putState(key, {}, { ifNoneMatch: '*' });
    expect(calls[0]!.headers.get('if-none-match')).toBe('*');
  });
  it('412 on putState throws StoreConflictError', async () => {
    const { c } = mk(() => ({ status: 412 }));
    await expect(c.putState(key, {}, { ifMatch: '"x"' })).rejects.toBeInstanceOf(StoreConflictError);
  });
  it('getAgentProfile returns the document, undefined on 404', async () => {
    const a = mk(() => ({ body: { p: 1 } }));
    expect(await a.c.getAgentProfile(agent, 'prof')).toEqual({ p: 1 });
    expect(new URL(a.calls[0]!.url).searchParams.get('profileId')).toBe('prof');
    const b = mk(() => ({ status: 404 }));
    expect(await b.c.getAgentProfile(agent, 'prof')).toBeUndefined();
  });
});

describe('failures', () => {
  it('a timeout throws LrsError status 0 without the secret', async () => {
    const f = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    const c = createLrsClient({ endpoint: 'https://lrs.example/xapi', auth: basic, version: '1.0.3', fetch: f, timeoutMs: 20 });
    const err = await c.putStatement(stmt('s1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LrsError);
    expect((err as LrsError).status).toBe(0);
    expect((err as LrsError).message).toBe('the record holder is not responding; try again shortly');
    expect((err as LrsError).message).not.toContain('sekrit');
    expect((err as LrsError).message).not.toContain(b64);
  });
  it('a network error throws LrsError status 0', async () => {
    const f = (async () => { throw new TypeError('fetch failed https://k:sekrit@lrs'); }) as unknown as typeof fetch;
    const c = createLrsClient({ endpoint: 'https://lrs.example/xapi', auth: basic, version: '1.0.3', fetch: f });
    const err = (await c.getStatements({}).catch((e: unknown) => e)) as LrsError;
    expect(err.status).toBe(0);
    expect(err.message).not.toContain('sekrit');
  });
});

describe('fetchAuthToken', () => {
  it('returns auth-token and POSTs', async () => {
    const { f, calls } = stub(() => ({ body: { 'auth-token': 'dG9r' } }));
    expect(await fetchAuthToken('https://lms.example/fetch?x=1', f)).toBe('dG9r');
    expect(calls[0]!.method).toBe('POST');
  });
  it('maps error-code 1 to Cmi5FetchError', async () => {
    const { f } = stub(() => ({ body: { 'error-code': '1', 'error-text': 'already fetched' } }));
    const err = await fetchAuthToken('https://lms.example/fetch', f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Cmi5FetchError);
    expect((err as Cmi5FetchError).code).toBe('1');
  });
  it('maps an unrecognised reply to code 3', async () => {
    const { f } = stub(() => ({ status: 500, body: { nope: true } }));
    await expect(fetchAuthToken('https://lms.example/fetch', f)).rejects.toMatchObject({ code: '3' });
  });
});
