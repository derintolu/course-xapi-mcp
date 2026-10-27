// SPDX-License-Identifier: Apache-2.0
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JWK } from 'jose';
import type { AuthServer, CourseModel, LearnerRef } from '@course-xapi-mcp/core';
import { createAuthServer } from '../src/auth/auth-server.ts';
import { createOidcFederation } from '../src/auth/oidc.ts';
import { startFakeIdp, type FakeIdp } from './fake-idp.ts';

const PUBLIC = 'https://course.example';
const RESOURCE = PUBLIC + '/mcp';
const CALLBACK = PUBLIC + '/oauth/callback';
const REDIRECT = 'http://127.0.0.1:33418/callback';
const course = { id: 'https://example.org/courses/demo', title: 'Demo course' } as CourseModel;
const signingKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as JWK;

let idp: FakeIdp;
let s: AuthServer;
beforeAll(async () => {
  idp = await startFakeIdp();
});
afterAll(() => idp.close());
beforeEach(async () => {
  idp.misbehave(undefined);
  idp.setSubject('idp-user-1');
  const federation = await createOidcFederation({ issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, redirectUri: CALLBACK });
  s = createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'federated', federation });
});

const b64url = (b: Buffer) => b.toString('base64url');

async function route(req: Request): Promise<Response> {
  const res = await s.routes(req);
  if (!res) throw new Error('route not handled: ' + req.url);
  return res;
}

const form = (path: string, body: Record<string, string>, cookie: string) =>
  new Request(PUBLIC + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(body),
  });

/** The agent registers and opens /oauth/authorize; the browser follows the course server to the IdP and back. */
async function toIdpReturn() {
  const reg = await route(new Request(PUBLIC + '/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Test agent' }),
  }));
  const client = (await reg.json()) as { client_id: string };
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const start = await route(new Request(PUBLIC + '/oauth/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'agent-state',
    resource: RESOURCE,
    scope: 'cxm:learn',
  })));
  expect(start.status).toBe(302);
  const idpUrl = new URL(start.headers.get('location')!);
  expect(idpUrl.origin).toBe(idp.issuer);
  const cookie = start.headers.getSetCookie().find((c) => c.startsWith('cxm_areq='))!.split(';')[0];
  const atIdp = await fetch(idpUrl, { redirect: 'manual' });
  expect(atIdp.status).toBe(302);
  const back = new URL(atIdp.headers.get('location')!);
  expect(back.origin + back.pathname).toBe(CALLBACK);
  return { client, verifier, cookie, back };
}

const callback = (url: URL, cookie: string) => route(new Request(url, { headers: { cookie } }));

async function signInError(url: URL, cookie: string) {
  const res = await callback(url, cookie);
  expect(res.status).toBe(400);
  const html = await res.text();
  expect(html).toContain('Sign-in problem');
  expect(html).not.toContain('name="request_id"');
  expect(html).not.toContain(idp.clientSecret);
  return html;
}

describe('OIDC federation', () => {
  it('authorizes an agent whose learner subject is the IdP sub', async () => {
    idp.setSubject('alice@idp');
    const { client, verifier, cookie, back } = await toIdpReturn();
    const q = idp.lastAuthorization()!;
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')).toBeTruthy();
    expect(q.get('nonce')).toBeTruthy();
    expect(q.get('scope')).toBe('openid');
    expect(q.get('redirect_uri')).toBe(CALLBACK);
    expect(q.get('response_mode')).toBeNull();

    const consent = await callback(back, cookie);
    expect(consent.status).toBe(200);
    const html = await consent.text();
    const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1];
    const allow = await route(form('/oauth/authorize', { request_id: requestId, action: 'allow' }, cookie));
    const m = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(await allow.text())!;
    const code = new URL(m[1].replaceAll('&amp;', '&')).searchParams.get('code')!;
    const tok = await route(form('/oauth/token', {
      grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: RESOURCE,
    }, ''));
    const body = (await tok.json()) as { access_token: string };
    const learner = (await s.authenticate(new Request(RESOURCE, { method: 'POST', headers: { authorization: 'Bearer ' + body.access_token } }))) as LearnerRef;
    expect(learner.subject).toBe('alice@idp');
    expect(learner.actor).toEqual({ objectType: 'Agent', account: { homePage: course.id, name: 'alice@idp' } });
  });

  it('refuses a wrong state', async () => {
    const { cookie, back } = await toIdpReturn();
    const wrong = new URL(back);
    wrong.searchParams.set('state', 'not-the-state');
    await signInError(wrong, cookie);
    // The real return still works afterwards: a forged state does not spend the pending sign-in.
    expect((await callback(back, cookie)).status).toBe(200);
  });

  it('uses each IdP state once', async () => {
    const { cookie, back } = await toIdpReturn();
    expect((await callback(back, cookie)).status).toBe(200);
    await signInError(back, cookie);
  });

  it('refuses an ID token with a bad nonce', async () => {
    idp.misbehave('wrong-nonce');
    const { cookie, back } = await toIdpReturn();
    await signInError(back, cookie);
  });

  it('refuses an ID token signed by another key', async () => {
    idp.misbehave('foreign-key');
    const { cookie, back } = await toIdpReturn();
    await signInError(back, cookie);
  });

  it('renders the error page for an IdP error and never shows the client secret', async () => {
    idp.misbehave('denied');
    const denied = await toIdpReturn();
    expect(denied.back.searchParams.get('error')).toBe('access_denied');
    await signInError(denied.back, denied.cookie);

    idp.misbehave('token-error');
    const echoed = await toIdpReturn();
    await signInError(echoed.back, echoed.cookie);
  });

  it('discovers once at startup and refuses a non-https issuer that is not loopback', async () => {
    let calls = 0;
    const never: typeof fetch = async () => {
      calls++;
      throw new Error('no network');
    };
    await expect(createOidcFederation({ issuer: 'http://idp.example', clientId: 'x', redirectUri: CALLBACK, fetch: never })).rejects.toThrow();
    expect(calls).toBe(0);
    const counting: typeof fetch = (input, init) => {
      calls++;
      return fetch(input, init);
    };
    const federation = await createOidcFederation({ issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, redirectUri: CALLBACK, fetch: counting });
    expect(calls).toBe(1);
    await federation.begin('a', CALLBACK);
    await federation.begin('b', CALLBACK);
    expect(calls).toBe(1);
  });
});
