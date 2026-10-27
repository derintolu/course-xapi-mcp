// SPDX-License-Identifier: Apache-2.0
// Access tokens (JWT, EdDSA) and opaque secrets (codes, refresh tokens, session ids).
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, importJWK, jwtVerify, type JWK } from 'jose';
import { DEFAULTS } from '@course-xapi-mcp/core';
import type { Grant } from './stores.ts';

export const SCOPE = 'cxm:learn';
const TYP = 'at+jwt';

/** 32 random bytes, base64url. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** The key a secret is stored under. */
export function secretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export interface AccessTokens {
  sign(g: Grant): Promise<string>;
  /** The grant the token carries, or undefined when it is invalid, expired, or for another issuer or audience. */
  verify(token: string): Promise<Grant | undefined>;
}

export async function createAccessTokens(o: { signingKey: JWK; issuer: string; audience: string; now: () => number }): Promise<AccessTokens> {
  if (o.signingKey.kty !== 'OKP' || o.signingKey.crv !== 'Ed25519' || !o.signingKey.d) {
    throw new TypeError('signingKey must be an Ed25519 private JWK');
  }
  const privateKey = await importJWK(o.signingKey, 'EdDSA');
  const { d: _, ...pub } = o.signingKey;
  const publicKey = await importJWK(pub, 'EdDSA');
  return {
    async sign(g) {
      const iat = Math.floor(o.now() / 1000);
      const claims: Record<string, string> = { scope: SCOPE };
      if (g.launchId) claims.cxm_launch = g.launchId;
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', typ: TYP, ...(o.signingKey.kid ? { kid: o.signingKey.kid } : {}) })
        .setIssuer(o.issuer)
        .setAudience(o.audience)
        .setSubject(g.subject)
        .setIssuedAt(iat)
        .setExpirationTime(iat + DEFAULTS.accessTokenTtlS)
        .setJti(randomBytes(16).toString('base64url'))
        .sign(privateKey);
    },
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, publicKey, {
          issuer: o.issuer,
          audience: o.audience,
          algorithms: ['EdDSA'],
          typ: TYP,
          currentDate: new Date(o.now()),
          requiredClaims: ['sub', 'exp', 'iat'],
        });
        if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes(SCOPE) || !payload.sub) return undefined;
        const launchId = payload.cxm_launch;
        if (launchId !== undefined && typeof launchId !== 'string') return undefined;
        return launchId ? { subject: payload.sub, launchId } : { subject: payload.sub };
      } catch {
        return undefined;
      }
    },
  };
}
