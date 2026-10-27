// SPDX-License-Identifier: Apache-2.0
// Pairing codes: what the learner types on the sign-in page when the bridge's cookie is not there.
import { getRandomValues } from 'node:crypto';
import { DEFAULTS } from '@course-xapi-mcp/core';

/** A fresh code of `DEFAULTS.pairingCodeLength` characters from `DEFAULTS.pairingAlphabet`, uniformly random. */
export function newPairingCode(): string {
  const alphabet = DEFAULTS.pairingAlphabet;
  // Rejection sampling: bytes at or above the largest multiple of the alphabet size would bias the result.
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < DEFAULTS.pairingCodeLength) {
    for (const b of getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < DEFAULTS.pairingCodeLength) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}
