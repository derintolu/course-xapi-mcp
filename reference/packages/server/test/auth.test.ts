// SPDX-License-Identifier: Apache-2.0
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SignJWT, importJWK, type JWK } from 'jose';
import { DEFAULTS, MemoryLaunchStore, actorKey, type AuthServer, type CourseModel, type LaunchContext, type LearnerRef } from '@course-xapi-mcp/core';
import { PAIRING_GUESS_BUDGET, createAuthServer } from '../src/auth/auth-server.ts';
import { DirectoryAuthStore } from '../src/auth/directory-store.ts';
import { CapacityError, MemoryAuthStore, type AuthStore } from '../src/auth/stores.ts';
import { guardedLookup, isPublicAddress } from '../src/auth/clients.ts';

const PUBLIC = 'https://course.example';
const RESOURCE = PUBLIC + '/mcp';
const REDIRECT = 'http://127.0.0.1:33418/callback';
const WWW_AUTH = `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp", scope="cxm:learn"`;
const course = { id: 'https://example.org/courses/demo', title: 'Demo course' } as CourseModel;
const signingKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as JWK;
const T0 = Date.parse('2026-10-27T10:00:00Z');
/** Metadata document hosts resolve to a public address in tests. */
const publicHost = async () => ['93.184.216.34'];

let t = T0;
const now = () => t;
beforeEach(() => {
  t = T0;
});

const b64url = (b: Buffer) => b.toString('base64url');
function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

const get = (path: string, headers: Record<string, string> = {}) => new Request(PUBLIC + path, { headers });
const form = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(PUBLIC + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
  });

async function route(s: AuthServer, req: Request): Promise<Response> {
  const res = await s.routes(req);
  if (!res) throw new Error('route not handled: ' + req.url);
  return res;
}

async function register(s: AuthServer, meta: Record<string, unknown> = {}) {
  const res = await route(s, new Request(PUBLIC + '/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Test agent', ...meta }),
  }));
  return { res, body: (await res.json()) as Record<string, any> };
}

function authorizeQuery(clientId: string, challenge: string, over: Record<string, string> = {}) {
  return '/oauth/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: RESOURCE,
    scope: 'cxm:learn',
    ...over,
  });
}

const requestId = (html: string) => {
  const m = /name="request_id" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('no request_id in page');
  return m[1];
};

function cookie(res: Response, name: string): string | undefined {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(name + '=')) return c;
  return undefined;
}

/** The `cxm_areq=...` pair the authorize page set, which every later step of that request must send. */
function browserOf(res: Response): string {
  const c = cookie(res, 'cxm_areq');
  if (!c) throw new Error('no cxm_areq cookie');
  return c.split(';')[0];
}

/** The redirect back to the client: a 302 after a GET, or (after a form POST, which the CSP's form-action would block) a page that navigates there. */
async function redirectFrom(res: Response): Promise<URL> {
  if (res.status === 302) return new URL(res.headers.get('location')!);
  expect(res.status).toBe(200);
  const m = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(await res.text());
  if (!m) throw new Error('no redirect in page');
  return new URL(m[1].replaceAll('&amp;', '&'));
}

async function codeFrom(res: Response): Promise<string> {
  const loc = await redirectFrom(res);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  expect(loc.searchParams.get('state')).toBe('st-1');
  expect(loc.searchParams.get('iss')).toBe(PUBLIC);
  return loc.searchParams.get('code')!;
}

const tokenReq = (body: Record<string, string>) => form('/oauth/token', body);

async function exchange(s: AuthServer, clientId: string, code: string, verifier: string, over: Record<string, string> = {}) {
  const res = await route(s, tokenReq({
    grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: RESOURCE, ...over,
  }));
  return { res, body: (await res.json()) as Record<string, any> };
}

const bearer = (token: string) => new Request(RESOURCE, { method: 'POST', headers: { authorization: 'Bearer ' + token } });

function accountsServer(store: AuthStore = new MemoryAuthStore({ now })) {
  return createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'accounts', store, now });
}

/** Signs up (or in) through the accounts page and returns the authorization code response. */
async function accountsLogin(s: AuthServer, clientId: string, challenge: string, action: 'signup' | 'signin', username: string, password: string) {
  const page = await route(s, get(authorizeQuery(clientId, challenge)));
  expect(page.status).toBe(200);
  const id = requestId(await page.text());
  return route(s, form('/oauth/login', { request_id: id, action, username, password }, { cookie: browserOf(page) }));
}

async function fullAccountsFlow(s: AuthServer, username = 'ada.l', password = 'correct horse battery') {
  const { body: client } = await register(s);
  const { verifier, challenge } = pkce();
  const res = await accountsLogin(s, client.client_id, challenge, 'signup', username, password);
  const code = await codeFrom(res);
  return { client, verifier, challenge, code, loginRes: res };
}

describe('metadata', () => {
  it('serves RFC 9728 protected resource metadata', async () => {
    const s = accountsServer();
    const res = await route(s, get('/.well-known/oauth-protected-resource/mcp'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [PUBLIC], scopes_supported: ['cxm:learn'] });
  });

  it('serves RFC 8414 authorization server metadata', async () => {
    const s = accountsServer();
    const res = await route(s, get('/.well-known/oauth-authorization-server'));
    expect(await res.json()).toMatchObject({
      issuer: PUBLIC,
      authorization_endpoint: PUBLIC + '/oauth/authorize',
      token_endpoint: PUBLIC + '/oauth/token',
      registration_endpoint: PUBLIC + '/oauth/register',
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'],
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['cxm:learn'],
    });
  });

  it('leaves other paths to the caller', async () => {
    expect(await accountsServer().routes(get('/mcp'))).toBeUndefined();
  });
});

describe('client registration', () => {
  it('registers a public client (RFC 7591)', async () => {
    const { res, body } = await register(accountsServer());
    expect(res.status).toBe(201);
    expect(body.client_id).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body).toMatchObject({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', client_name: 'Test agent' });
    expect(body.client_secret).toBeUndefined();
  });

  it('refuses confidential clients and unsafe redirect URIs', async () => {
    const s = accountsServer();
    for (const meta of [
      { token_endpoint_auth_method: 'client_secret_basic' },
      { redirect_uris: ['http://evil.example/cb'] },
      { redirect_uris: ['javascript:alert(1)'] },
      { redirect_uris: [] },
    ]) {
      const { res, body } = await register(s, meta);
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/^invalid_(client_metadata|redirect_uri)$/);
    }
  });

  it('accepts a client id metadata document and its redirect URI, and refuses a mismatching one', async () => {
    const docUrl = 'https://agent.example/oauth/client.json';
    const fetched: { url: string; init?: RequestInit }[] = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      fetched.push({ url: String(url), init });
      return new Response(JSON.stringify({ client_id: docUrl, client_name: 'Doc agent', redirect_uris: [REDIRECT] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const s = createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'accounts', now, fetch: fetchStub, resolveHost: publicHost });
    const { challenge } = pkce();

    const ok = await route(s, get(authorizeQuery(docUrl, challenge)));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Doc agent');
    expect(fetched[0].url).toBe(docUrl);
    expect(fetched[0].init?.redirect).toBe('manual');
    expect(fetched[0].init?.signal).toBeInstanceOf(AbortSignal);

    const bad = await route(s, get(authorizeQuery(docUrl, challenge, { redirect_uri: 'http://127.0.0.1:9/other' })));
    expect(bad.status).toBe(400);
    expect(bad.headers.get('location')).toBeNull();
  });

  it('refuses a metadata document that redirects, is too large, or names another client id', async () => {
    const docUrl = 'https://agent.example/client.json';
    const responses = [
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/c.json' } }),
      new Response(JSON.stringify({ client_id: docUrl, redirect_uris: [REDIRECT], pad: 'x'.repeat(70_000) })),
      new Response(JSON.stringify({ client_id: 'https://other.example/c.json', redirect_uris: [REDIRECT] })),
    ];
    const fetchStub = (async () => responses.shift()!) as unknown as typeof fetch;
    const s = createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'accounts', now, fetch: fetchStub, resolveHost: publicHost });
    const { challenge } = pkce();
    for (let i = 0; i < 3; i++) expect((await route(s, get(authorizeQuery(docUrl, challenge)))).status).toBe(400);
    expect(responses).toHaveLength(0);
  });

  it('caches a metadata document for 5 minutes', async () => {
    const docUrl = 'https://agent.example/client.json';
    let calls = 0;
    const fetchStub = (async () => {
      calls++;
      return new Response(JSON.stringify({ client_id: docUrl, redirect_uris: [REDIRECT] }));
    }) as unknown as typeof fetch;
    const s = createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'accounts', now, fetch: fetchStub, resolveHost: publicHost });
    for (let i = 0; i < 3; i++) expect((await route(s, get(authorizeQuery(docUrl, pkce().challenge)))).status).toBe(200);
    expect(calls).toBe(1);
    t += 300_001;
    expect((await route(s, get(authorizeQuery(docUrl, pkce().challenge)))).status).toBe(200);
    expect(calls).toBe(2);
  });

  it('never fetches a metadata document from a private, loopback or link-local address', async () => {
    let calls = 0;
    const fetchStub = (async (url: string) => {
      calls++;
      return new Response(JSON.stringify({ client_id: url, redirect_uris: [REDIRECT] }));
    }) as unknown as typeof fetch;
    const resolved: Record<string, string[]> = {
      'metadata.internal.example': ['169.254.169.254'],
      'mixed.example': ['93.184.216.34', '10.0.0.7'],
      'mapped.example': ['::ffff:127.0.0.1'],
      'ula.example': ['fd12:3456::1'],
    };
    const resolveHost = async (h: string) => resolved[h] ?? ['93.184.216.34'];
    const s = createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'accounts', now, fetch: fetchStub, resolveHost });
    for (const host of ['10.0.0.5', '127.0.0.1', '[::1]', '[::127.0.0.1]', '[::ffff:10.0.0.1]', '[64:ff9b:1::a00:1]', '[2002:a00:1::]', '[fec0::1]', '192.168.1.2', '[fe80::1]', 'localhost', 'metadata.internal.example', 'mixed.example', 'mapped.example', 'ula.example']) {
      const res = await route(s, get(authorizeQuery(`https://${host}/client.json`, pkce().challenge)));
      expect(res.status, host).toBe(400);
    }
    expect(calls).toBe(0);
    expect((await route(s, get(authorizeQuery('https://public.example/client.json', pkce().challenge)))).status).toBe(200);
    expect(calls).toBe(1);
  });
});

describe('metadata document addresses', () => {
  it('classifies public and non-public addresses, including IPv4 embedded in IPv6', () => {
    for (const a of ['93.184.216.34', '2606:2800:220:1::1', '::ffff:93.184.216.34']) expect(isPublicAddress(a), a).toBe(true);
    for (const a of ['::', '::1', '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:0:a00:1', '64:ff9b::a00:1', '64:ff9b:1::1', '2002:7f00:1::', 'fec0::1', 'fd00::1', '100.64.0.1', 'not-an-ip']) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });

  it('checks the address again when the socket connects, so a rebinding name is refused', async () => {
    const answers = [['93.184.216.34'], ['127.0.0.1']];
    let calls = 0;
    const resolveHost = async () => answers[Math.min(calls++, 1)];
    const s = createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'accounts', now, resolveHost });
    const res = await route(s, get(authorizeQuery('https://rebind.example/client.json', pkce().challenge)));
    expect(res.status).toBe(400);
    expect(calls).toBe(2);
  });

  it('the guarded lookup answers single and all-address forms and refuses any non-public answer', async () => {
    const lookupWith = (addresses: string[], all: boolean) =>
      new Promise<unknown>((resolve) =>
        guardedLookup(async () => addresses)('h.example', { all }, ((err: Error | null, a: unknown, f?: number) => resolve(err ? err : { a, f })) as never),
      );
    expect(await lookupWith(['93.184.216.34'], false)).toEqual({ a: '93.184.216.34', f: 4 });
    expect(await lookupWith(['93.184.216.34', '2606:2800:220:1::1'], true)).toEqual({ a: [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }], f: undefined });
    expect(await lookupWith(['93.184.216.34', '10.0.0.1'], true)).toBeInstanceOf(Error);
    expect(await lookupWith([], false)).toBeInstanceOf(Error);
  });
});

describe('authorization code flow', () => {
  it('yields a token that authenticate turns into an official LearnerRef', async () => {
    const s = accountsServer();
    const { client, verifier, code } = await fullAccountsFlow(s);
    const { res, body } = await exchange(s, client.client_id, code, verifier);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: DEFAULTS.accessTokenTtlS, scope: 'cxm:learn' });
    expect(Buffer.from(body.refresh_token, 'base64url')).toHaveLength(32);

    const [header, payload] = body.access_token.split('.').slice(0, 2).map((p: string) => JSON.parse(Buffer.from(p, 'base64url').toString()));
    expect(header.alg).toBe('EdDSA');
    expect(payload).toMatchObject({ iss: PUBLIC, aud: RESOURCE, scope: 'cxm:learn' });
    expect(payload.exp - payload.iat).toBe(3600);

    const l = (await s.authenticate(bearer(body.access_token))) as LearnerRef;
    expect(l).toMatchObject({ kind: 'official', subject: payload.sub });
    expect(l.actor).toEqual({ objectType: 'Agent', account: { homePage: course.id, name: payload.sub } });
  });

  it('refuses a wrong code_verifier', async () => {
    const s = accountsServer();
    const { client, code } = await fullAccountsFlow(s);
    const { res, body } = await exchange(s, client.client_id, code, pkce().verifier);
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_grant');
  });

  it('refuses a reused code', async () => {
    const s = accountsServer();
    const { client, verifier, code } = await fullAccountsFlow(s);
    const first = await exchange(s, client.client_id, code, verifier);
    expect(first.res.status).toBe(200);
    const again = await exchange(s, client.client_id, code, verifier);
    expect(again.res.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
    // Replaying a code revokes what it issued.
    const refreshed = await route(s, tokenReq({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: client.client_id }));
    expect(refreshed.status).toBe(400);
  });

  it('refuses an expired code', async () => {
    const s = accountsServer();
    const { client, verifier, code } = await fullAccountsFlow(s);
    t += DEFAULTS.authCodeTtlS * 1000 + 1;
    const { res, body } = await exchange(s, client.client_id, code, verifier);
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_grant');
  });

  it('refuses a wrong resource at the authorization and token endpoints', async () => {
    const s = accountsServer();
    const { body: client } = await register(s);
    const { challenge } = pkce();
    const res = await route(s, get(authorizeQuery(client.client_id, challenge, { resource: 'https://other.example/mcp' })));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('invalid_target');
    expect(loc.searchParams.get('code')).toBeNull();

    const flow = await fullAccountsFlow(s, 'grace.h');
    const tok = await exchange(s, flow.client.client_id, flow.code, flow.verifier, { resource: 'https://other.example/mcp' });
    expect(tok.res.status).toBe(400);
    expect(tok.body.error).toBe('invalid_target');
  });

  it('requires PKCE S256', async () => {
    const s = accountsServer();
    const { body: client } = await register(s);
    for (const over of [{ code_challenge_method: 'plain' }, { code_challenge: '' }] as Record<string, string>[]) {
      const res = await route(s, get(authorizeQuery(client.client_id, pkce().challenge, over)));
      expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    }
  });

  it('refuses an unregistered redirect URI without redirecting', async () => {
    const s = accountsServer();
    const { body: client } = await register(s);
    const res = await route(s, get(authorizeQuery(client.client_id, pkce().challenge, { redirect_uri: REDIRECT + '/x' })));
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('authenticate', () => {
  it('answers 401 with the resource metadata challenge when the token is missing, invalid or for another audience', async () => {
    const store = new MemoryAuthStore({ now });
    const s = accountsServer(store);
    // Accounts mode signs in only a subject that has an account.
    await store.createAccount({ id: 'someone', username: 'someone', salt: '', hash: '' });
    const key = await importJWK(signingKey, 'EdDSA');
    const otherKey = await importJWK(generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as JWK, 'EdDSA');
    const sign = (aud: string, k: CryptoKey | Uint8Array, subject = 'someone') =>
      new SignJWT({ scope: 'cxm:learn' }).setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt' }).setIssuer(PUBLIC).setAudience(aud)
        .setSubject(subject).setIssuedAt(T0 / 1000).setExpirationTime(T0 / 1000 + 3600).sign(k);
    const otherAudience = await sign('https://other.example/mcp', key);
    const otherSigner = await sign(RESOURCE, otherKey);
    expect(await s.authenticate(bearer(await sign(RESOURCE, key)))).not.toBeInstanceOf(Response);

    const noAccount = await sign(RESOURCE, key, 'no-such-account');
    for (const req of [new Request(RESOURCE), bearer('not-a-jwt'), bearer(otherAudience), bearer(otherSigner), bearer(noAccount)]) {
      const res = await s.authenticate(req);
      expect(res).toBeInstanceOf(Response);
      expect((res as Response).status).toBe(401);
      expect((res as Response).headers.get('www-authenticate')).toBe(WWW_AUTH);
    }
  });

  it('refuses an expired access token', async () => {
    const s = accountsServer();
    const { client, verifier, code } = await fullAccountsFlow(s);
    const { body } = await exchange(s, client.client_id, code, verifier);
    t += DEFAULTS.accessTokenTtlS * 1000 + 1000;
    expect(((await s.authenticate(bearer(body.access_token))) as Response).status).toBe(401);
  });
});

describe('refresh tokens', () => {
  it('rotate on use, and reusing a rotated one revokes the family', async () => {
    const s = accountsServer();
    const { client, verifier, code } = await fullAccountsFlow(s);
    const { body: first } = await exchange(s, client.client_id, code, verifier);
    const r1 = await route(s, tokenReq({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: client.client_id }));
    expect(r1.status).toBe(200);
    const second = (await r1.json()) as Record<string, any>;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(((await s.authenticate(bearer(second.access_token))) as LearnerRef).kind).toBe('official');

    const reuse = await route(s, tokenReq({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: client.client_id }));
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as any).error).toBe('invalid_grant');
    const after = await route(s, tokenReq({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: client.client_id }));
    expect(after.status).toBe(400);
  });

  it('expire after 30 days and belong to their client', async () => {
    const s = accountsServer();
    const { client, verifier, code } = await fullAccountsFlow(s);
    const { body } = await exchange(s, client.client_id, code, verifier);
    const wrongClient = await route(s, tokenReq({ grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: 'someone-else' }));
    expect(wrongClient.status).toBe(400);
    const s2 = accountsServer();
    const f2 = await fullAccountsFlow(s2);
    const { body: b2 } = await exchange(s2, f2.client.client_id, f2.code, f2.verifier);
    t += DEFAULTS.refreshTokenTtlS * 1000 + 1;
    const expired = await route(s2, tokenReq({ grant_type: 'refresh_token', refresh_token: b2.refresh_token, client_id: f2.client.client_id }));
    expect(expired.status).toBe(400);
  });
});

describe('accounts mode', () => {
  it('signs up, then signs in, and sets the browser session cookie', async () => {
    const store = new MemoryAuthStore({ now });
    const s = accountsServer(store);
    const { client, loginRes, code, verifier } = await fullAccountsFlow(s, 'ada.l', 'correct horse battery');
    const sid = cookie(loginRes, 'cxm_sid')!;
    expect(sid).toMatch(/HttpOnly/);
    expect(sid).toMatch(/Secure/);
    expect(sid).toMatch(/SameSite=Lax/);
    expect(sid).toMatch(/Max-Age=43200/);
    const { body } = await exchange(s, client.client_id, code, verifier);
    const fromToken = (await s.authenticate(bearer(body.access_token))) as LearnerRef;

    const browser = await s.browserLearner(get('/record', { cookie: sid.split(';')[0] }));
    expect(browser?.subject).toBe(fromToken.subject);
    t += 12 * 3600 * 1000 + 1;
    expect(await s.browserLearner(get('/record', { cookie: sid.split(';')[0] }))).toBeUndefined();
    t = T0;

    const { verifier: v2, challenge: c2 } = pkce();
    const signin = await accountsLogin(s, client.client_id, c2, 'signin', 'ada.l', 'correct horse battery');
    const { body: b2 } = await exchange(s, client.client_id, await codeFrom(signin), v2);
    expect(((await s.authenticate(bearer(b2.access_token))) as LearnerRef).subject).toBe(fromToken.subject);
  });

  it('eraseLearner signs the learner out everywhere: access token, refresh token, browser session and password', async () => {
    const store = new MemoryAuthStore({ now });
    const s = accountsServer(store);
    const { client, loginRes, code, verifier } = await fullAccountsFlow(s, 'ada.l', 'correct horse battery');
    const sid = cookie(loginRes, 'cxm_sid')!.split(';')[0];
    const { body } = await exchange(s, client.client_id, code, verifier);
    const learner = (await s.authenticate(bearer(body.access_token))) as LearnerRef;
    expect(learner.subject).toBeTruthy();
    // Another learner is not touched.
    const other = await fullAccountsFlow(s, 'grace.h', 'correct horse battery');
    const { body: otherTokens } = await exchange(s, other.client.client_id, other.code, other.verifier);

    await s.eraseLearner(learner.subject);
    expect(((await s.authenticate(bearer(body.access_token))) as Response).status).toBe(401);
    expect(await s.browserLearner(get('/record', { cookie: sid }))).toBeUndefined();
    const refreshed = await route(s, tokenReq({ grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: client.client_id }));
    expect(refreshed.status).toBe(400);
    expect((await accountsLogin(s, client.client_id, pkce().challenge, 'signin', 'ada.l', 'correct horse battery')).status).toBe(400);
    expect(await s.authenticate(bearer(otherTokens.access_token))).not.toBeInstanceOf(Response);
  });

  it.each(['refresh_token', 'authorization_code'] as const)('a %s grant an erase overtakes issues nothing, and leaves nothing of the learner on disk', async (grant) => {
    const dir = await mkdtemp(join(tmpdir(), 'cxm-auth-'));
    try {
      const inner = await DirectoryAuthStore.open(join(dir, 'auth'), { now });
      // The grant stalls right after the store step that precedes issuing (the rotation, or recording the code's family).
      const stalled = grant === 'refresh_token' ? 'rotateRefresh' : 'setCodeFamily';
      let hold: Promise<void> | undefined;
      let release!: () => void;
      let entered!: () => void;
      const inStep = new Promise<void>((r) => (entered = r));
      const store = new Proxy(inner, {
        get(target, p) {
          const v = Reflect.get(target, p) as unknown;
          if (typeof v !== 'function') return v;
          if (p !== stalled) return v.bind(target);
          return async (...args: unknown[]) => {
            const out = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            if (hold) {
              entered();
              await hold;
            }
            return out;
          };
        },
      }) as AuthStore;
      const s = accountsServer(store);
      const { client, code, verifier } = await fullAccountsFlow(s);
      const subject = (await inner.getAccount('ada.l'))!.id;
      let body: Record<string, string>;
      if (grant === 'refresh_token') {
        const { body: tokens } = await exchange(s, client.client_id, code, verifier);
        body = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id };
      } else {
        body = { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: RESOURCE };
      }
      hold = new Promise<void>((r) => (release = r));
      const pending = route(s, tokenReq(body));
      await inStep;
      await s.eraseLearner(subject);
      release();
      const res = await pending;
      expect(res.status).toBe(400);
      expect(((await res.json()) as Record<string, string>).error).toBe('invalid_grant');
      for (const e of await readdir(join(dir, 'auth'), { withFileTypes: true, recursive: true })) {
        if (e.isFile()) expect(await readFile(join(e.parentPath, e.name), 'utf8')).not.toContain(subject);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validates usernames and passwords and refuses a taken username', async () => {
    const s = accountsServer();
    await fullAccountsFlow(s, 'ada.l');
    const { body: client } = await register(s);
    for (const [u, p] of [['ab', 'long enough password'], ['Ada!', 'long enough password'], ['ok.name', 'short'], ['ada.l', 'another long password']]) {
      const res = await accountsLogin(s, client.client_id, pkce().challenge, 'signup', u, p);
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('refuses the sixth bad password within 15 minutes, even if correct', async () => {
    const s = accountsServer();
    const { client } = await fullAccountsFlow(s, 'ada.l', 'correct horse battery');
    for (let i = 0; i < 5; i++) {
      const res = await accountsLogin(s, client.client_id, pkce().challenge, 'signin', 'ada.l', 'wrong password ' + i);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('username or password is wrong');
    }
    const sixth = await accountsLogin(s, client.client_id, pkce().challenge, 'signin', 'ada.l', 'wrong password 6');
    expect(sixth.status).toBe(429);
    const correct = await accountsLogin(s, client.client_id, pkce().challenge, 'signin', 'ada.l', 'correct horse battery');
    expect(correct.status).toBe(429);
    t += 15 * 60 * 1000 + 1;
    const later = await accountsLogin(s, client.client_id, pkce().challenge, 'signin', 'ada.l', 'correct horse battery');
    expect((await redirectFrom(later)).searchParams.get('code')).toBeTruthy();
  });

  it('uses a non-secure cookie only on loopback', async () => {
    const local = 'http://127.0.0.1:8787';
    const s = createAuthServer({ publicUrl: local, course, signingKey, mode: 'accounts', now });
    const reg = await route(s, new Request(local + '/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT] }), headers: { 'content-type': 'application/json' } }));
    const client = (await reg.json()) as any;
    const { challenge } = pkce();
    const q = authorizeQuery(client.client_id, challenge, { resource: local + '/mcp' });
    const page = await route(s, new Request(local + q));
    expect(cookie(page, 'cxm_areq')).not.toMatch(/Secure/);
    const res = await route(s, new Request(local + '/oauth/login', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: browserOf(page) },
      body: new URLSearchParams({ request_id: requestId(await page.text()), action: 'signup', username: 'ada.l', password: 'correct horse battery' }),
    }));
    expect(res.status).toBe(200);
    expect(cookie(res, 'cxm_sid')).not.toMatch(/Secure/);
  });

  it('refuses a login posted from a browser that did not open the request', async () => {
    const s = accountsServer();
    const { body: client } = await register(s);
    const page = await route(s, get(authorizeQuery(client.client_id, pkce().challenge)));
    expect(cookie(page, 'cxm_areq')).toMatch(/HttpOnly.*Secure.*SameSite=Lax/);
    const id = requestId(await page.text());
    const body = { request_id: id, action: 'signup', username: 'ada.l', password: 'correct horse battery' };
    for (const headers of [{}, { cookie: 'cxm_areq=' + 'A'.repeat(43) }] as Record<string, string>[]) {
      const res = await route(s, form('/oauth/login', body, headers));
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain('http-equiv="refresh"');
    }
    expect((await route(s, form('/oauth/login', body, { cookie: browserOf(page) }))).status).toBe(200);
  });

  it('counts concurrent bad passwords before hashing, so parallel guesses cannot pass the limit', async () => {
    const s = accountsServer();
    const { client } = await fullAccountsFlow(s, 'ada.l', 'correct horse battery');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => accountsLogin(s, client.client_id, pkce().challenge, 'signin', 'ada.l', 'wrong password ' + i)),
    );
    expect(results.filter((r) => r.status === 400)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
  });

  it('does not count a successful sign-in against the limit', async () => {
    const s = accountsServer();
    const { client } = await fullAccountsFlow(s, 'ada.l', 'correct horse battery');
    for (let i = 0; i < 4; i++) await accountsLogin(s, client.client_id, pkce().challenge, 'signin', 'ada.l', 'wrong password ' + i);
    for (let i = 0; i < 3; i++) {
      expect((await accountsLogin(s, client.client_id, pkce().challenge, 'signin', 'ada.l', 'correct horse battery')).status).toBe(200);
    }
    expect((await accountsLogin(s, client.client_id, pkce().challenge, 'signin', 'ada.l', 'wrong again')).status).toBe(400);
    expect((await accountsLogin(s, client.client_id, pkce().challenge, 'signin', 'ada.l', 'wrong again 2')).status).toBe(429);
  });
});

describe('launch-paired mode', () => {
  const actor = { objectType: 'Agent' as const, account: { homePage: 'https://lms.example', name: 'learner-7' } };
  function launch(over: Partial<LaunchContext> = {}): LaunchContext {
    return {
      launchId: 'launch-1', endpoint: 'https://lms.example/lrs/', authToken: 'secret-token', tokenFetchedAt: new Date(T0).toISOString(),
      actor, registration: '2f0d6c3e-8c1a-4b55-9d8e-6a3f2a1b0c9d', activityId: 'https://lms.example/act/1', auId: 'https://example.org/courses/demo/au1',
      auKey: 'lesson-1', contextTemplate: {}, launchMode: 'Normal', moveOn: 'Completed', sessionId: 'sess-1',
      initializedAt: new Date(T0).toISOString(), pairingCode: 'ABC234', pairingExpiresAt: new Date(T0 + DEFAULTS.pairingTtlMs).toISOString(), ...over,
    };
  }
  const expectedSubject = (c: LaunchContext) =>
    createHash('sha256').update(c.endpoint + '\n' + actorKey(c.actor) + '\n' + c.registration).digest('hex');

  async function setup(over: Partial<LaunchContext> = {}) {
    const launches = new MemoryLaunchStore({ now });
    const c = launch(over);
    await launches.put(c);
    const s = createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'launch-paired', launches, now });
    const { body: client } = await register(s);
    return { s, launches, c, client };
  }

  /** Opens the authorize page; `post` sends a form for that request from the same browser. */
  async function page(s: AuthServer, clientId: string, launchCookie?: string) {
    const p = pkce();
    const res = await route(s, get(authorizeQuery(clientId, p.challenge), launchCookie ? { cookie: launchCookie } : {}));
    expect(res.status).toBe(200);
    const html = await res.text();
    const id = requestId(html);
    const jar = [browserOf(res), launchCookie].filter(Boolean).join('; ');
    const post = (body: Record<string, string>) => route(s, form('/oauth/authorize', { request_id: id, ...body }, { cookie: jar }));
    return { ...p, html, id, post };
  }

  it('binds the launch named by the cxm_launch cookie, and that spends the pairing code', async () => {
    const { s, launches, c, client } = await setup();
    const p = await page(s, client.client_id, 'cxm_launch=launch-1');
    expect(p.html).toContain('127.0.0.1:33418');
    const res = await p.post({ action: 'continue' });
    const { body } = await exchange(s, client.client_id, await codeFrom(res), p.verifier);
    const payload = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url').toString());
    expect(payload.cxm_launch).toBe('launch-1');
    const l = (await s.authenticate(bearer(body.access_token))) as LearnerRef;
    expect(l).toEqual({ kind: 'official', subject: expectedSubject(c), actor, launchId: 'launch-1' });
    expect((await launches.get('launch-1'))?.pairedSubject).toBe(expectedSubject(c));
    expect(JSON.stringify(body)).not.toContain('secret-token');
    expect(cookie(res, 'cxm_sid')).toBeTruthy();

    const other = await page(s, client.client_id);
    expect((await other.post({ pairing_code: 'ABC234' })).status).toBe(400);
  });

  it('mints one code when the same request is continued twice at once', async () => {
    const { s, client } = await setup();
    const p = await page(s, client.client_id, 'cxm_launch=launch-1');
    const results = await Promise.all([p.post({ action: 'continue' }), p.post({ action: 'continue' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('asks for the pairing code when the cookie names no live launch', async () => {
    const { s, launches, client } = await setup();
    await launches.update('launch-1', { terminatedAt: new Date(T0).toISOString() });
    const p = await page(s, client.client_id, 'cxm_launch=launch-1');
    expect(p.html).toContain('name="pairing_code"');
    expect((await p.post({ action: 'continue' })).status).toBe(400);
  });

  it('accepts a correct pairing code once, case-insensitively', async () => {
    const { s, c, client } = await setup();
    const p = await page(s, client.client_id);
    expect(p.html).toContain('name="pairing_code"');
    const res = await p.post({ pairing_code: ' abc234 ' });
    const { body } = await exchange(s, client.client_id, await codeFrom(res), p.verifier);
    expect(((await s.authenticate(bearer(body.access_token))) as LearnerRef).subject).toBe(expectedSubject(c));

    const p2 = await page(s, client.client_id);
    const again = await p2.post({ pairing_code: 'ABC234' });
    expect(again.status).toBe(400);
    expect(again.headers.get('location')).toBeNull();
  });

  it('refuses an expired pairing code', async () => {
    const { s, client } = await setup();
    t += DEFAULTS.pairingTtlMs + 1;
    const p = await page(s, client.client_id);
    expect((await p.post({ pairing_code: 'ABC234' })).status).toBe(400);
  });

  it('ends the request at the sixth wrong code', async () => {
    const { s, client } = await setup();
    const p = await page(s, client.client_id);
    for (let i = 0; i < 5; i++) {
      const res = await p.post({ pairing_code: 'ZZZZZ' + i });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('name="pairing_code"');
    }
    const sixth = await p.post({ pairing_code: 'ZZZZZZ' });
    expect(sixth.status).toBe(400);
    expect(await sixth.text()).not.toContain('name="pairing_code"');
    const right = await p.post({ pairing_code: 'ABC234' });
    expect(right.status).toBe(400);
    expect(right.headers.get('location')).toBeNull();
  });

  it('counts concurrent wrong codes on one request before the lookup', async () => {
    const { s, client } = await setup();
    const p = await page(s, client.client_id);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => p.post({ pairing_code: 'ZZZZZ' + i })));
    const texts = await Promise.all(results.map((r) => r.text()));
    expect(texts.filter((h) => h.includes('name="pairing_code"'))).toHaveLength(5);
    expect(texts.filter((h) => h.includes('Too many wrong pairing codes'))).toHaveLength(5);
  });

  it('limits wrong codes across all requests and clients', async () => {
    const { s, client } = await setup();
    for (let n = 0; n < PAIRING_GUESS_BUDGET / 5; n++) {
      const p = await page(s, client.client_id);
      for (let i = 0; i < 5; i++) expect((await p.post({ pairing_code: 'ZZZZZ' + i })).status).toBe(400);
    }
    const { body: other } = await register(s);
    const p = await page(s, other.client_id);
    expect((await p.post({ pairing_code: 'ABC234' })).status).toBe(429);
    t += DEFAULTS.pairingTtlMs + 1;
    const p2 = await page(s, other.client_id);
    const after = await p2.post({ pairing_code: 'ZZZZZZ' });
    expect(after.status).toBe(400);
    expect(await after.text()).toContain('name="pairing_code"');
  });
});

describe('federated mode', () => {
  function federatedServer() {
    let begun: { state: string; redirectUri: string } | undefined;
    const federation = {
      async begin(state: string, redirectUri: string) {
        begun = { state, redirectUri };
        return 'https://idp.example/authorize?x=1';
      },
      async complete(req: Request) {
        return { subject: 'idp-sub-1', state: new URL(req.url).searchParams.get('state')! };
      },
    };
    const s = createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'federated', federation, now });
    return { s, begun: () => begun! };
  }

  async function toCallback(s: AuthServer, begun: () => { state: string; redirectUri: string }) {
    const { body: client } = await register(s);
    const { verifier, challenge } = pkce();
    const res = await route(s, get(authorizeQuery(client.client_id, challenge)));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://idp.example/authorize?x=1');
    expect(begun().redirectUri).toBe(PUBLIC + '/oauth/callback');
    const browser = browserOf(res);
    const back = await route(s, get('/oauth/callback?state=' + encodeURIComponent(begun().state), { cookie: browser }));
    return { client, verifier, browser, back };
  }

  it('signs in at the identity provider, then asks for consent before any code is issued', async () => {
    const { s, begun } = federatedServer();
    const { client, verifier, browser, back } = await toCallback(s, begun);
    expect(back.status).toBe(200);
    expect(back.headers.get('location')).toBeNull();
    const html = await back.text();
    expect(html).not.toContain('code=');
    expect(html).toContain('Test agent');
    expect(html).toContain('127.0.0.1:33418');

    const allow = await route(s, form('/oauth/authorize', { request_id: requestId(html), action: 'allow' }, { cookie: browser }));
    const { body } = await exchange(s, client.client_id, await codeFrom(allow), verifier);
    expect(((await s.authenticate(bearer(body.access_token))) as LearnerRef).subject).toBe('idp-sub-1');
    expect((await route(s, get('/oauth/callback?state=' + encodeURIComponent(begun().state), { cookie: browser }))).status).toBe(400);
  });

  it('mints one code when Allow is posted twice at once', async () => {
    const { s, begun } = federatedServer();
    const { browser, back } = await toCallback(s, begun);
    const id = requestId(await back.text());
    const allow = () => route(s, form('/oauth/authorize', { request_id: id, action: 'allow' }, { cookie: browser }));
    const results = await Promise.all([allow(), allow()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('sends access_denied when the learner refuses, and refuses a callback or consent from another browser', async () => {
    const { s, begun } = federatedServer();
    const { body: client } = await register(s);
    await route(s, get(authorizeQuery(client.client_id, pkce().challenge)));
    expect((await route(s, get('/oauth/callback?state=' + encodeURIComponent(begun().state)))).status).toBe(400);

    const { browser, back } = await toCallback(s, begun);
    const id = requestId(await back.text());
    expect((await route(s, form('/oauth/authorize', { request_id: id, action: 'allow' }))).status).toBe(400);
    const deny = await route(s, form('/oauth/authorize', { request_id: id, action: 'deny' }, { cookie: browser }));
    const loc = await redirectFrom(deny);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('code')).toBeNull();
    expect((await route(s, form('/oauth/authorize', { request_id: id, action: 'allow' }, { cookie: browser }))).status).toBe(400);
  });
});

describe('configuration', () => {
  it('refuses a publicUrl with a path', () => {
    expect(() => createAuthServer({ publicUrl: 'https://course.example/course', course, signingKey, mode: 'accounts' })).toThrow(/publicUrl/);
    expect(() => createAuthServer({ publicUrl: 'https://course.example/', course, signingKey, mode: 'accounts' })).not.toThrow();
  });
});

describe('pages', () => {
  it('escape a client_name and carry the CSP and frame headers', async () => {
    const s = accountsServer();
    const { body: client } = await register(s, { client_name: '<script>alert(1)</script>' });
    const res = await route(s, get(authorizeQuery(client.client_id, pkce().challenge)));
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('bounded memory (R62)', () => {
  const request = (id: string, expiresAt: number) => ({ id, clientId: 'c', redirectUri: REDIRECT, codeChallenge: 'x', expiresAt, browser: 'b' });

  it('sweeps expired authorization requests, codes (after a replay grace) and sessions when new ones are put', async () => {
    const store = new MemoryAuthStore({ now });
    await store.putRequest(request('old', t + 1000));
    await store.putCode('old-code', { subject: 's', clientId: 'c', redirectUri: REDIRECT, codeChallenge: 'x', expiresAt: t + 1000 });
    await store.putSession('old-session', { subject: 's', expiresAt: t + 1000 });
    await store.putRefresh('old-refresh', { subject: 's', clientId: 'c', familyId: 'f', expiresAt: t + 1000 });
    t += 2000;
    // Within the grace a replayed code is still recognised (so its family can be revoked).
    await store.putCode('new-code', { subject: 's', clientId: 'c', redirectUri: REDIRECT, codeChallenge: 'x', expiresAt: t + 60_000 });
    expect(await store.redeemCode('old-code')).toBeDefined();
    t += 11 * 60_000;
    await store.putRequest(request('new', t + 600_000));
    await store.putCode('newer-code', { subject: 's', clientId: 'c', redirectUri: REDIRECT, codeChallenge: 'x', expiresAt: t + 60_000 });
    await store.putSession('new-session', { subject: 's', expiresAt: t + 1000 });
    await store.putRefresh('new-refresh', { subject: 's', clientId: 'c', familyId: 'g', expiresAt: t + 1000 });
    expect(await store.getRequest('old')).toBeUndefined();
    expect(await store.redeemCode('old-code')).toBeUndefined();
    expect(await store.getSession('old-session')).toBeUndefined();
    expect(await store.rotateRefresh('old-refresh')).toBeUndefined();
    expect(await store.getRequest('new')).toBeDefined();
    expect(await store.getSession('new-session')).toBeDefined();
  });

  it('caps pending authorization requests: over the cap, authorize answers 503 and keeps nothing', async () => {
    const store = new MemoryAuthStore({ now, maxRequests: 2 });
    const s = accountsServer(store);
    const { body: client } = await register(s);
    for (let i = 0; i < 2; i++) expect((await route(s, get(authorizeQuery(client.client_id, pkce().challenge)))).status).toBe(200);
    const full = await route(s, get(authorizeQuery(client.client_id, pkce().challenge)));
    expect(full.status).toBe(503);
    expect(await full.text()).not.toContain('name="request_id"');
    // Once the pending ones expire, sign-in works again.
    t += 11 * 60_000;
    expect((await route(s, get(authorizeQuery(client.client_id, pkce().challenge)))).status).toBe(200);
  });

  it('caps dynamic client registrations: the oldest registration makes way for a new one', async () => {
    const store = new MemoryAuthStore({ now, maxClients: 2 });
    const s = accountsServer(store);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { res, body } = await register(s);
      expect(res.status).toBe(201);
      ids.push(body.client_id);
    }
    expect(await store.getClient(ids[0]!)).toBeUndefined();
    expect(await store.getClient(ids[1]!)).toBeDefined();
    expect(await store.getClient(ids[2]!)).toBeDefined();
  });

  it('a federated sign-in the provider cannot take now (too many pending) answers 503 and keeps no request', async () => {
    const store = new MemoryAuthStore({ now });
    const federation = { begin: async () => Promise.reject(new CapacityError('too many sign-ins in progress')), complete: async () => ({ subject: 'x', state: 'y' }) };
    const s = createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'federated', federation, store, now });
    const { body: client } = await register(s);
    const res = await route(s, get(authorizeQuery(client.client_id, pkce().challenge)));
    expect(res.status).toBe(503);
    const store2 = new MemoryAuthStore({ now, maxRequests: 1 });
    // The request was dropped, so it does not hold a place under the cap either.
    const s2 = createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'federated', federation, store: store2, now });
    const { body: c2 } = await register(s2);
    for (let i = 0; i < 2; i++) expect((await route(s2, get(authorizeQuery(c2.client_id, pkce().challenge)))).status).toBe(503);
    await store2.putRequest(request('fits', t + 1000));
    expect(await store2.getRequest('fits')).toBeDefined();
  });
});
