// SPDX-License-Identifier: Apache-2.0
// PKCE (RFC 7636), S256 only.
import { createHash, timingSafeEqual } from 'node:crypto';

/** A verifier is 43 to 128 unreserved characters; an S256 challenge is 43 base64url characters. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function isS256Challenge(challenge: string): boolean {
  return CHALLENGE.test(challenge);
}

export function verifyS256(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier) || !CHALLENGE.test(challenge)) return false;
  const computed = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  return timingSafeEqual(computed, Buffer.from(challenge));
}
