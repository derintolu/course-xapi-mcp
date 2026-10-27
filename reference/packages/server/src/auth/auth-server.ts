// SPDX-License-Identifier: Apache-2.0
// The course server's own MCP authorization server (OAuth 2.1): authorization code with PKCE S256,
// dynamic client registration, client id metadata documents, rotating refresh tokens, and three ways to
// sign the learner in: own accounts (option 3), a federated identity provider (option 2), or pairing to
// an LMS launch (option 1). New code: it touches no other SSO or OAuth configuration.
import { createHash } from 'node:crypto';
import type { JWK } from 'jose';
import {
  DEFAULTS,
  actorKey,
  type AuthServer,
  type CourseModel,
  type LaunchContext,
  type LaunchStore,
  type LearnerRef,
} from '@course-xapi-mcp/core';
import { signIn, signUp } from './accounts.ts';
import { ClientError, isLoopbackHost, readCapped, registerClient, resolveClient } from './clients.ts';
import { PATHS, bearerChallenge, resourceMetadata, serverMetadata } from './metadata.ts';
import { accountsPage, errorPage, launchPage, redirectPage } from './pages.ts';
import { isS256Challenge, verifyS256 } from './pkce.ts';
import { MemoryAuthStore, type AuthRequest, type AuthStore, type Grant } from './stores.ts';
import { SCOPE, createAccessTokens, newSecret, secretHash, type AccessTokens } from './tokens.ts';

export interface FederationHooks {
  /** Returns the identity provider URL to send the browser to; `state` comes back through `complete`. */
  begin(state: string, redirectUri: string): Promise<string>;
  /** Handles `GET /oauth/callback`. */
  complete(req: Request): Promise<{ subject: string; state: string }>;
}

export interface AuthServerOptions {
  publicUrl: string;
  course: CourseModel;
  /** Ed25519 private JWK. */
  signingKey: JWK;
  mode: 'accounts' | 'federated' | 'launch-paired';
  launches?: LaunchStore;
  federation?: FederationHooks;
  store?: AuthStore;
  now?: () => number;
  /** Fetches client id metadata documents. */
  fetch?: typeof fetch;
}

/** A pending authorization request lives this long. */
const REQUEST_TTL_MS = 600_000;
const SESSION_TTL_S = 12 * 3600;
const MAX_WRONG_PAIRING_CODES = 5;
const PAIRING_CODE = new RegExp(`^[${DEFAULTS.pairingAlphabet}]{${DEFAULTS.pairingCodeLength}}$`);
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;
const ENDED = 'This sign-in request has ended or expired.';

type Params = { get(name: string): string | undefined; duplicated: boolean };

function params(sp: URLSearchParams): Params {
  const duplicated = [...new Set(sp.keys())].some((k) => sp.getAll(k).length > 1);
  return { get: (n) => sp.get(n) ?? undefined, duplicated };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

async function readForm(req: Request): Promise<Params | undefined> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return undefined;
  const text = await readCapped(req.body);
  return text === undefined ? undefined : params(new URLSearchParams(text));
}

function cookies(req: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

const isLive = (c: LaunchContext) => !c.terminatedAt && !c.supersededAt;

/** The option-1 learner subject: hex SHA-256 of endpoint, actor key and registration. */
export function launchSubject(c: LaunchContext): string {
  return createHash('sha256').update(c.endpoint + '\n' + actorKey(c.actor) + '\n' + c.registration).digest('hex');
}

export function createAuthServer(o: AuthServerOptions): AuthServer {
  const publicUrl = o.publicUrl.replace(/\/+$/, '');
  const base = new URL(publicUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const resource = publicUrl + '/mcp';
  const secureCookies = !isLoopbackHost(base.hostname);
  const store = o.store ?? new MemoryAuthStore();
  const now = o.now ?? Date.now;
  const fetchFn = o.fetch ?? fetch;
  if (o.mode === 'launch-paired' && !o.launches) throw new TypeError('launch-paired mode needs a LaunchStore');
  if (o.mode === 'federated' && !o.federation) throw new TypeError('federated mode needs FederationHooks');
  let tokens: Promise<AccessTokens> | undefined;
  const accessTokens = () => (tokens ??= createAccessTokens({ signingKey: o.signingKey, issuer: publicUrl, audience: resource, now }));

  const sessionCookie = (sid: string) =>
    `cxm_sid=${sid}; Path=${basePath || '/'}; Max-Age=${SESSION_TTL_S}; HttpOnly;${secureCookies ? ' Secure;' : ''} SameSite=Lax`;

  async function liveRequest(id: string | undefined): Promise<AuthRequest | undefined> {
    if (!id) return undefined;
    const r = await store.getRequest(id);
    if (!r || r.expiresAt <= now()) return undefined;
    return r;
  }

  async function cookieLaunch(req: Request): Promise<LaunchContext | undefined> {
    const id = cookies(req).get('cxm_launch');
    if (!id || !o.launches) return undefined;
    const c = await o.launches.get(id);
    return c && isLive(c) ? c : undefined;
  }

  /** Ends the request, mints a code and a browser session, and sends the browser back to the client. */
  async function issueCode(r: AuthRequest, grant: Grant, viaForm: boolean): Promise<Response> {
    await store.deleteRequest(r.id);
    const code = newSecret();
    await store.putCode(secretHash(code), {
      ...grant,
      clientId: r.clientId,
      redirectUri: r.redirectUri,
      codeChallenge: r.codeChallenge,
      expiresAt: now() + DEFAULTS.authCodeTtlS * 1000,
    });
    const sid = newSecret();
    await store.putSession(secretHash(sid), { ...grant, expiresAt: now() + SESSION_TTL_S * 1000 });
    const loc = new URL(r.redirectUri);
    loc.searchParams.set('code', code);
    if (r.state !== undefined) loc.searchParams.set('state', r.state);
    loc.searchParams.set('iss', publicUrl);
    const headers = { 'set-cookie': sessionCookie(sid) };
    if (viaForm) return redirectPage(loc.href, headers);
    return new Response(null, { status: 302, headers: { location: loc.href, 'cache-control': 'no-store', ...headers } });
  }

  /** Validates an authorization request; errors before the redirect URI is trusted render a page. */
  async function authorize(p: Params, req: Request): Promise<Response> {
    const client = await resolveClient(store, p.get('client_id') ?? '', fetchFn);
    if (!client) return errorPage('The agent asking to connect is not registered with this course.');
    const redirectUri = p.get('redirect_uri');
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return errorPage('The agent gave a return address it has not registered.');
    }
    const state = p.get('state');
    const fail = (error: string, description: string) => {
      const loc = new URL(redirectUri);
      loc.searchParams.set('error', error);
      loc.searchParams.set('error_description', description);
      if (state !== undefined) loc.searchParams.set('state', state);
      loc.searchParams.set('iss', publicUrl);
      return new Response(null, { status: 302, headers: { location: loc.href, 'cache-control': 'no-store' } });
    };
    if (p.duplicated) return fail('invalid_request', 'a parameter was sent more than once');
    if (p.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
    const challenge = p.get('code_challenge') ?? '';
    if (p.get('code_challenge_method') !== 'S256' || !isS256Challenge(challenge)) {
      return fail('invalid_request', 'PKCE with code_challenge_method S256 is required');
    }
    if (p.get('resource') !== resource) return fail('invalid_target', 'resource must be ' + resource);
    const scope = p.get('scope');
    if (scope !== undefined && scope.split(' ').some((s) => s !== '' && s !== SCOPE)) return fail('invalid_scope', 'the only scope is ' + SCOPE);

    const r: AuthRequest = {
      id: newSecret(),
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri,
      codeChallenge: challenge,
      state,
      expiresAt: now() + REQUEST_TTL_MS,
      wrongCodes: 0,
    };
    await store.putRequest(r);
    const shown = { requestId: r.id, clientName: r.clientName, courseTitle: o.course.title };
    if (o.mode === 'accounts') return accountsPage(shown);
    if (o.mode === 'launch-paired') return launchPage({ ...shown, withLaunch: !!(await cookieLaunch(req)) });
    const idp = await o.federation!.begin(r.id, publicUrl + PATHS.callback);
    return new Response(null, { status: 302, headers: { location: idp, 'cache-control': 'no-store' } });
  }

  /** Launch-paired mode: binds the request to the cookie's launch or to the launch a pairing code names. */
  async function pair(p: Params, req: Request): Promise<Response> {
    if (o.mode !== 'launch-paired') return errorPage(ENDED);
    const r = await liveRequest(p.get('request_id'));
    if (!r) return errorPage(ENDED);
    const shown = { requestId: r.id, clientName: r.clientName, courseTitle: o.course.title };
    const bind = async (c: LaunchContext) => {
      const subject = launchSubject(c);
      await o.launches!.update(c.launchId, { pairedSubject: subject });
      return issueCode(r, { subject, launchId: c.launchId }, true);
    };

    if (p.get('action') === 'continue') {
      const c = await cookieLaunch(req);
      if (c) return bind(c);
      return launchPage({ ...shown, withLaunch: false, status: 400, error: 'Your lesson launch was not found in this browser. Type the pairing code instead.' });
    }

    if (r.wrongCodes >= MAX_WRONG_PAIRING_CODES) {
      await store.deleteRequest(r.id);
      return errorPage('Too many wrong pairing codes. ' + ENDED);
    }
    const code = (p.get('pairing_code') ?? '').trim().toUpperCase();
    const c = PAIRING_CODE.test(code) ? await o.launches!.byPairingCode(code) : undefined;
    if (c && isLive(c) && Date.parse(c.pairingExpiresAt) > now() && (await store.spendPairingCode(c.launchId))) return bind(c);
    await store.putRequest({ ...r, wrongCodes: r.wrongCodes + 1 });
    return launchPage({ ...shown, withLaunch: false, status: 400, error: 'That code is wrong, used or expired. Check the lesson page and try again.' });
  }

  async function login(req: Request): Promise<Response> {
    if (o.mode !== 'accounts') return errorPage(ENDED);
    const p = await readForm(req);
    const r = await liveRequest(p?.get('request_id'));
    if (!p || !r) return errorPage(ENDED);
    const username = p.get('username') ?? '';
    const password = p.get('password') ?? '';
    const result = p.get('action') === 'signup' ? await signUp(store, username, password) : await signIn(store, username, password, now());
    if ('error' in result) {
      return accountsPage({ requestId: r.id, clientName: r.clientName, courseTitle: o.course.title, error: result.error, status: result.status });
    }
    return issueCode(r, { subject: result.subject }, true);
  }

  async function callback(req: Request): Promise<Response> {
    if (o.mode !== 'federated') return errorPage(ENDED);
    let done: { subject: string; state: string };
    try {
      done = await o.federation!.complete(req);
    } catch {
      return errorPage('Your identity provider did not complete the sign-in.');
    }
    const r = await liveRequest(done.state);
    if (!r || !done.subject) return errorPage(ENDED);
    return issueCode(r, { subject: done.subject }, false);
  }

  async function issueTokens(grant: Grant, clientId: string, familyId: string): Promise<Response> {
    const refresh = newSecret();
    await store.putRefresh(secretHash(refresh), { ...grant, clientId, familyId, expiresAt: now() + DEFAULTS.refreshTokenTtlS * 1000 });
    const accessToken = await (await accessTokens()).sign(grant);
    return json(
      { access_token: accessToken, token_type: 'Bearer', expires_in: DEFAULTS.accessTokenTtlS, refresh_token: refresh, scope: SCOPE },
      200,
      { pragma: 'no-cache' },
    );
  }

  async function token(req: Request): Promise<Response> {
    const p = await readForm(req);
    if (!p) return oauthError('invalid_request', 'send an application/x-www-form-urlencoded body of at most 64 KB');
    if (p.duplicated) return oauthError('invalid_request', 'a parameter was sent more than once');
    const clientId = p.get('client_id');
    if (!clientId) return oauthError('invalid_request', 'client_id is required');
    const res = p.get('resource');
    if (res !== undefined && res !== resource) return oauthError('invalid_target', 'resource must be ' + resource);
    const grantType = p.get('grant_type');

    if (grantType === 'authorization_code') {
      const code = p.get('code');
      const verifier = p.get('code_verifier');
      const redirectUri = p.get('redirect_uri');
      if (!code || !verifier || !redirectUri) return oauthError('invalid_request', 'code, code_verifier and redirect_uri are required');
      const hash = secretHash(code);
      const found = await store.redeemCode(hash);
      if (!found) return oauthError('invalid_grant', 'the code is not valid');
      const c = found.code;
      if (found.used) {
        if (c.familyId) await store.revokeFamily(c.familyId);
        return oauthError('invalid_grant', 'the code was already used');
      }
      if (c.expiresAt <= now()) return oauthError('invalid_grant', 'the code has expired');
      if (c.clientId !== clientId || c.redirectUri !== redirectUri) return oauthError('invalid_grant', 'the code was issued to another client or redirect URI');
      if (!verifyS256(verifier, c.codeChallenge)) return oauthError('invalid_grant', 'code_verifier does not match the code challenge');
      const familyId = newSecret();
      await store.setCodeFamily(hash, familyId);
      return issueTokens(c.launchId ? { subject: c.subject, launchId: c.launchId } : { subject: c.subject }, clientId, familyId);
    }

    if (grantType === 'refresh_token') {
      const refresh = p.get('refresh_token');
      if (!refresh) return oauthError('invalid_request', 'refresh_token is required');
      const found = await store.rotateRefresh(secretHash(refresh));
      if (!found) return oauthError('invalid_grant', 'the refresh token is not valid');
      const t = found.token;
      if (found.used) {
        await store.revokeFamily(t.familyId);
        return oauthError('invalid_grant', 'the refresh token was already used; sign in again');
      }
      if (t.expiresAt <= now()) return oauthError('invalid_grant', 'the refresh token has expired');
      if (t.clientId !== clientId) return oauthError('invalid_grant', 'the refresh token was issued to another client');
      return issueTokens(t.launchId ? { subject: t.subject, launchId: t.launchId } : { subject: t.subject }, clientId, t.familyId);
    }

    return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }

  async function register(req: Request): Promise<Response> {
    const text = await readCapped(req.body);
    let meta: unknown;
    try {
      meta = text === undefined ? undefined : JSON.parse(text);
    } catch {
      meta = undefined;
    }
    try {
      const c = await registerClient(store, meta, now());
      return json(
        {
          client_id: c.clientId,
          client_id_issued_at: c.issuedAt,
          ...(c.clientName !== undefined ? { client_name: c.clientName } : {}),
          redirect_uris: c.redirectUris,
          token_endpoint_auth_method: 'none',
          grant_types: c.grantTypes,
          response_types: ['code'],
        },
        201,
      );
    } catch (e) {
      if (e instanceof ClientError) return oauthError(e.code, e.message);
      throw e;
    }
  }

  async function learnerFor(g: Grant): Promise<LearnerRef | undefined> {
    if (o.mode === 'launch-paired') {
      if (!g.launchId) return undefined;
      const c = await o.launches!.get(g.launchId);
      if (!c) return undefined;
      return { kind: 'official', subject: g.subject, actor: c.actor, launchId: g.launchId };
    }
    if (g.launchId) return undefined;
    return { kind: 'official', subject: g.subject, actor: { objectType: 'Agent', account: { homePage: o.course.id, name: g.subject } } };
  }

  const routes: Record<string, Partial<Record<string, (req: Request) => Promise<Response>>>> = {
    [PATHS.resourceMetadata]: { GET: async () => json(resourceMetadata(publicUrl), 200, { 'cache-control': 'public, max-age=3600' }) },
    [PATHS.serverMetadata]: { GET: async () => json(serverMetadata(publicUrl), 200, { 'cache-control': 'public, max-age=3600' }) },
    [PATHS.register]: { POST: register },
    [PATHS.authorize]: {
      GET: (req) => authorize(params(new URL(req.url).searchParams), req),
      POST: async (req) => {
        const p = await readForm(req);
        if (!p) return errorPage('The form could not be read.');
        return p.get('request_id') !== undefined ? pair(p, req) : authorize(p, req);
      },
    },
    [PATHS.token]: { POST: token },
    [PATHS.callback]: { GET: callback },
    [PATHS.login]: { POST: login },
  };

  return {
    async routes(req) {
      const path = new URL(req.url).pathname;
      if (!path.startsWith(basePath)) return undefined;
      const methods = routes[path.slice(basePath.length)];
      if (!methods) return undefined;
      const handler = methods[req.method];
      if (!handler) return new Response(null, { status: 405, headers: { allow: Object.keys(methods).join(', ') } });
      return handler(req);
    },

    async authenticate(req) {
      const m = BEARER.exec(req.headers.get('authorization') ?? '');
      const grant = m ? await (await accessTokens()).verify(m[1]) : undefined;
      const learner = grant && (await learnerFor(grant));
      if (learner) return learner;
      return json({ error: 'invalid_token', error_description: 'sign in again through your agent' }, 401, { 'www-authenticate': bearerChallenge(publicUrl) });
    },

    async browserLearner(req) {
      const sid = cookies(req).get('cxm_sid');
      if (!sid) return undefined;
      const s = await store.getSession(secretHash(sid));
      if (!s || s.expiresAt <= now()) return undefined;
      return learnerFor(s);
    },
  };
}
