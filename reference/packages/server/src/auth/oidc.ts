// SPDX-License-Identifier: Apache-2.0
// Option 2: federates sign-in to the course author's OpenID Provider with the authorization code flow,
// PKCE S256, `state` and `nonce`. The learner subject is the ID token's `sub`. The provider returns in
// query mode (not form_post): the browser cookie that binds the request is SameSite=Lax, which a
// cross-site POST would not carry.
import * as oidc from 'openid-client';
import { isLoopbackHost } from './clients.ts';
import type { FederationHooks } from './auth-server.ts';
import { CapacityError } from './stores.ts';

export interface OidcFederationOptions {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** The course server's `/oauth/callback` URL, as registered at the provider. */
  redirectUri: string;
  /** Default `['openid']`. */
  scopes?: string[];
  /** Replaces the global fetch for discovery, JWKS and token requests (tests). */
  fetch?: typeof fetch;
  /** Sign-ins waiting at the provider at once (default MAX_PENDING_SIGNINS); over it, `begin` throws CapacityError. */
  maxPending?: number;
}

/** A sign-in started at the provider lives this long, like the pending authorization request it serves. */
const PENDING_TTL_MS = 600_000;
/** Sign-ins started at the provider and not yet back, held at once. */
export const MAX_PENDING_SIGNINS = 10_000;

interface Pending {
  requestState: string;
  verifier: string;
  nonce: string;
  expiresAt: number;
}

/** Discovers the provider once and returns the hooks for `createAuthServer({ mode: 'federated' })`. */
export async function createOidcFederation(o: OidcFederationOptions): Promise<FederationHooks> {
  const issuer = new URL(o.issuer);
  const redirectUri = new URL(o.redirectUri).href;
  const scope = (o.scopes ?? ['openid']).join(' ');
  if (!scope.split(' ').includes('openid')) throw new TypeError('scopes must include openid');
  // Plain http only for a provider on this machine (development and tests); openid-client refuses it otherwise.
  const insecure = issuer.protocol === 'http:' && isLoopbackHost(issuer.hostname);
  const customFetch = o.fetch;
  const config = await oidc.discovery(issuer, o.clientId, o.clientSecret, undefined, {
    ...(customFetch ? { [oidc.customFetch]: (url: string, init: oidc.CustomFetchOptions) => customFetch(url, init as RequestInit) } : {}),
    // Verify ID token signatures against the provider's JWKS too, not only TLS to the token endpoint.
    execute: insecure ? [oidc.enableNonRepudiationChecks, oidc.allowInsecureRequests] : [oidc.enableNonRepudiationChecks],
  });
  const pending = new Map<string, Pending>();

  return {
    async begin(requestState) {
      const at = Date.now();
      for (const [k, p] of pending) if (p.expiresAt <= at) pending.delete(k);
      if (pending.size >= (o.maxPending ?? MAX_PENDING_SIGNINS)) throw new CapacityError('too many sign-ins are waiting at the identity provider');
      const state = oidc.randomState();
      const verifier = oidc.randomPKCECodeVerifier();
      const nonce = oidc.randomNonce();
      pending.set(state, { requestState, verifier, nonce, expiresAt: at + PENDING_TTL_MS });
      return oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope,
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
      }).href;
    },

    async complete(req) {
      const query = new URL(req.url).searchParams;
      const state = query.get('state') ?? '';
      const p = pending.get(state);
      if (!p || p.expiresAt <= Date.now()) throw new Error('unknown or expired sign-in state');
      // Spent on first use, whatever the outcome.
      pending.delete(state);
      // The registered redirect URI, not the URL the request arrived on (a proxy may rewrite it).
      const current = new URL(redirectUri);
      current.search = query.toString();
      const tokens = await oidc.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: p.verifier,
        expectedState: state,
        expectedNonce: p.nonce,
        idTokenExpected: true,
      });
      const sub = tokens.claims()?.sub;
      if (!sub) throw new Error('the ID token has no subject');
      return { subject: sub, state: p.requestState };
    },
  };
}
