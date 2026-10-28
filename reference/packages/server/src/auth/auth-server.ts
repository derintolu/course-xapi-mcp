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
import { ClientError, createClientResolver, isLoopbackHost, readCapped, registerClient, resolveWithDns, type ResolveHost } from './clients.ts';
import { PATHS, bearerChallenge, resourceMetadata, serverMetadata } from './metadata.ts';
import { accountsPage, consentPage, errorPage, launchPage, redirectPage } from './pages.ts';
import { isS256Challenge, verifyS256 } from './pkce.ts';
import { CapacityError, MemoryAuthStore, type AuthRequest, type AuthStore, type Grant } from './stores.ts';
import { SCOPE, createAccessTokens, newSecret, secretHash, type AccessTokens } from './tokens.ts';

export interface FederationHooks {
  /** Returns the identity provider URL to send the browser to; `state` comes back through `complete`. */
  begin(state: string, redirectUri: string): Promise<string>;
  /** Handles `GET /oauth/callback`. */
  complete(req: Request): Promise<{ subject: string; state: string }>;
}

/** The authorization server, and the erase the option 3 record delete form uses. */
export interface LearnerAuthServer extends AuthServer {
  /** Forgets everything kept to sign this learner subject in: account, refresh tokens, codes, sessions. Takes no learner lock. */
  eraseLearner(subject: string): Promise<void>;
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
  /** Replaces the built-in https GET for client id metadata documents (tests); the default checks addresses again at connect time. */
  fetch?: typeof fetch;
  /** Resolves a metadata document host to its addresses before the fetch (default: DNS). Non-public addresses are refused. */
  resolveHost?: ResolveHost;
}

/** A pending authorization request lives this long. */
const REQUEST_TTL_MS = 600_000;
const SESSION_TTL_S = 12 * 3600;
const PAIRING_ATTEMPTS_PER_REQUEST = 5;
/** Wrong pairing codes the whole server accepts per pairing-code lifetime, across all requests and clients. */
export const PAIRING_GUESS_BUDGET = 100;
const BROWSER_COOKIE = 'cxm_areq';
const pairingRequestKey = (requestId: string) => 'pairing-request:' + requestId;
const PAIRING_CODE = new RegExp(`^[${DEFAULTS.pairingAlphabet}]{${DEFAULTS.pairingCodeLength}}$`);
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;
const ENDED = 'This sign-in request has ended or expired.';
const BUSY = 'Too many people are signing in to this course right now. Wait a few minutes and try again.';

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

export function createAuthServer(o: AuthServerOptions): LearnerAuthServer {
  const base = new URL(o.publicUrl);
  if (base.pathname !== '/' || base.search || base.hash) throw new TypeError('publicUrl must be an origin with no path, query or fragment');
  const publicUrl = base.origin;
  const resource = publicUrl + '/mcp';
  const secureCookies = !isLoopbackHost(base.hostname);
  const now = o.now ?? Date.now;
  const store = o.store ?? new MemoryAuthStore({ now });
  const resolveClient = createClientResolver({ store, fetch: o.fetch, resolveHost: o.resolveHost ?? resolveWithDns, now });
  if (o.mode === 'launch-paired' && !o.launches) throw new TypeError('launch-paired mode needs a LaunchStore');
  if (o.mode === 'federated' && !o.federation) throw new TypeError('federated mode needs FederationHooks');
  let tokens: Promise<AccessTokens> | undefined;
  const accessTokens = () => (tokens ??= createAccessTokens({ signingKey: o.signingKey, issuer: publicUrl, audience: resource, now }));

  const sessionCookie = (sid: string) =>
    `cxm_sid=${sid}; Path=/; Max-Age=${SESSION_TTL_S}; HttpOnly;${secureCookies ? ' Secure;' : ''} SameSite=Lax`;
  const browserCookie = (id: string) =>
    `${BROWSER_COOKIE}=${id}; Path=/oauth; Max-Age=${REQUEST_TTL_MS / 1000}; HttpOnly;${secureCookies ? ' Secure;' : ''} SameSite=Lax`;

  /** A pending request that has not expired and belongs to the browser that opened it. */
  async function liveRequest(id: string | undefined, req: Request): Promise<AuthRequest | undefined> {
    const browser = cookies(req).get(BROWSER_COOKIE);
    if (!id || !browser) return undefined;
    const r = await store.getRequest(id);
    if (!r || r.expiresAt <= now() || r.browser !== secretHash(browser)) return undefined;
    return r;
  }

  async function cookieLaunch(req: Request): Promise<LaunchContext | undefined> {
    const id = cookies(req).get('cxm_launch');
    if (!id || !o.launches) return undefined;
    const c = await o.launches.get(id);
    return c && isLive(c) ? c : undefined;
  }

  /** Ends the request, mints a code and a browser session, and sends the browser back to the client (always after a form POST). */
  async function issueCode(r: AuthRequest, grant: Grant, onTaken?: () => Promise<void>): Promise<Response> {
    // Concurrent submissions of one request (two Allow clicks, two Continue posts) mint at most one code.
    if (!(await store.takeRequest(r.id))) return errorPage(ENDED);
    await store.clearAttempts(pairingRequestKey(r.id));
    await onTaken?.();
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
    return redirectPage(loc.href, { 'set-cookie': sessionCookie(sid) });
  }

  /** Validates an authorization request; errors before the redirect URI is trusted render a page. */
  async function authorize(p: Params, req: Request): Promise<Response> {
    const client = await resolveClient(p.get('client_id') ?? '');
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

    const known = cookies(req).get(BROWSER_COOKIE);
    const browser = known && /^[A-Za-z0-9_-]{43}$/.test(known) ? known : newSecret();
    const r: AuthRequest = {
      id: newSecret(),
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri,
      codeChallenge: challenge,
      state,
      expiresAt: now() + REQUEST_TTL_MS,
      browser: secretHash(browser),
    };
    const res = await (async () => {
      await store.putRequest(r);
      if (o.mode === 'accounts') return accountsPage(shown(r));
      if (o.mode === 'launch-paired') return launchPage({ ...shown(r), withLaunch: !!(await cookieLaunch(req)) });
      try {
        const idp = await o.federation!.begin(r.id, publicUrl + PATHS.callback);
        return new Response(null, { status: 302, headers: { location: idp, 'cache-control': 'no-store' } });
      } catch (e) {
        await store.deleteRequest(r.id);
        throw e;
      }
    })().catch((e: unknown) => {
      if (e instanceof CapacityError) return errorPage(BUSY, 503);
      throw e;
    });
    if (browser !== known) res.headers.append('set-cookie', browserCookie(browser));
    return res;
  }

  const shown = (r: AuthRequest) => ({ requestId: r.id, clientName: r.clientName, courseTitle: o.course.title, redirectUri: r.redirectUri });

  /** POST /oauth/authorize for a pending request: the pairing step (option 1) or the consent step (option 2). */
  async function continueRequest(p: Params, req: Request): Promise<Response> {
    if (o.mode === 'launch-paired') return pair(p, req);
    if (o.mode === 'federated') return consent(p, req);
    return errorPage(ENDED);
  }

  /** Federated mode: the learner signed in at the identity provider; now they allow or refuse this agent. */
  async function consent(p: Params, req: Request): Promise<Response> {
    const r = await liveRequest(p.get('request_id'), req);
    if (!r || !r.federatedSubject) return errorPage(ENDED);
    if (p.get('action') === 'allow') return issueCode(r, { subject: r.federatedSubject });
    await store.deleteRequest(r.id);
    const loc = new URL(r.redirectUri);
    loc.searchParams.set('error', 'access_denied');
    if (r.state !== undefined) loc.searchParams.set('state', r.state);
    loc.searchParams.set('iss', publicUrl);
    return redirectPage(loc.href);
  }

  /** Launch-paired mode: binds the request to the cookie's launch or to the launch a pairing code names. */
  async function pair(p: Params, req: Request): Promise<Response> {
    const r = await liveRequest(p.get('request_id'), req);
    if (!r) return errorPage(ENDED);
    const bind = (c: LaunchContext) => {
      const subject = launchSubject(c);
      return issueCode(r, { subject, launchId: c.launchId }, async () => {
        // Binding by cookie spends the code too, so it cannot pair a second browser later.
        await store.spendPairingCode(c.launchId);
        await o.launches!.update(c.launchId, { pairedSubject: subject });
      });
    };

    if (p.get('action') === 'continue') {
      const c = await cookieLaunch(req);
      if (c) return bind(c);
      return launchPage({ ...shown(r), withLaunch: false, status: 400, error: 'Your lesson launch was not found in this browser. Type the pairing code instead.' });
    }

    // Attempts are recorded before the lookup, so concurrent guesses cannot exceed either limit. The
    // server-wide budget is checked first, so a request it turns away keeps its own attempts.
    const at = now();
    if (!(await store.reserveAttempt('pairing-all', at, at - DEFAULTS.pairingTtlMs, PAIRING_GUESS_BUDGET))) {
      return launchPage({ ...shown(r), withLaunch: false, status: 429, error: 'Too many pairing attempts on this server right now. Wait a few minutes, or launch the lesson again from your LMS in this browser.' });
    }
    if (!(await store.reserveAttempt(pairingRequestKey(r.id), at, at - REQUEST_TTL_MS, PAIRING_ATTEMPTS_PER_REQUEST))) {
      await store.releaseAttempt('pairing-all', at);
      await store.deleteRequest(r.id);
      await store.clearAttempts(pairingRequestKey(r.id));
      return errorPage('Too many wrong pairing codes. ' + ENDED);
    }
    const code = (p.get('pairing_code') ?? '').trim().toUpperCase();
    const c = PAIRING_CODE.test(code) ? await o.launches!.byPairingCode(code) : undefined;
    if (c && isLive(c) && Date.parse(c.pairingExpiresAt) > now() && (await store.spendPairingCode(c.launchId))) {
      await store.releaseAttempt('pairing-all', at);
      return bind(c);
    }
    return launchPage({ ...shown(r), withLaunch: false, status: 400, error: 'That code is wrong, used or expired. Check the lesson page and try again.' });
  }

  async function login(req: Request): Promise<Response> {
    if (o.mode !== 'accounts') return errorPage(ENDED);
    const p = await readForm(req);
    const r = p && (await liveRequest(p.get('request_id'), req));
    if (!p || !r) return errorPage(ENDED);
    const username = p.get('username') ?? '';
    const password = p.get('password') ?? '';
    const result = p.get('action') === 'signup' ? await signUp(store, username, password) : await signIn(store, username, password, now());
    if ('error' in result) {
      return accountsPage({ ...shown(r), error: result.error, status: result.status });
    }
    return issueCode(r, { subject: result.subject });
  }

  async function callback(req: Request): Promise<Response> {
    if (o.mode !== 'federated') return errorPage(ENDED);
    let done: { subject: string; state: string };
    try {
      done = await o.federation!.complete(req);
    } catch {
      return errorPage('Your identity provider did not complete the sign-in.');
    }
    const r = await liveRequest(done.state, req);
    if (!r || r.federatedSubject || !done.subject) return errorPage(ENDED);
    await store.putRequest({ ...r, federatedSubject: done.subject });
    return consentPage(shown(r));
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
        if (c.familyId) await store.revokeFamily(c.familyId, c.subject);
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
        await store.revokeFamily(t.familyId, t.subject);
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
    // An erased learner's access tokens and sessions sign nobody in, so nothing is written for an account that is gone.
    if (o.mode === 'accounts' && !(await store.hasAccount(g.subject))) return undefined;
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
        return p.get('request_id') !== undefined ? continueRequest(p, req) : authorize(p, req);
      },
    },
    [PATHS.token]: { POST: token },
    [PATHS.callback]: { GET: callback },
    [PATHS.login]: { POST: login },
  };

  return {
    async routes(req) {
      const methods = routes[new URL(req.url).pathname];
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

    eraseLearner: (subject) => store.eraseLearner(subject),
  };
}
