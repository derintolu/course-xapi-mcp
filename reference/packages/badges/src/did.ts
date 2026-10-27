// SPDX-License-Identifier: Apache-2.0
import { CONTEXTS } from './document-loader.ts';

/** The did:web DID for a public URL: host (port as `%3A`), then each path segment. */
export function didWeb(publicUrl: string): string {
  const u = new URL(publicUrl);
  const host = u.port ? `${u.hostname}%3A${u.port}` : u.hostname;
  const segments = u.pathname.split('/').filter((s) => s !== '');
  return ['did:web', host, ...segments].join(':');
}

/** A DID document listing each key as a Multikey assertion method. Old keys stay listed after a rotation. */
export function didDocument(did: string, keys: { id: string; publicKeyMultibase: string }[]): object {
  return {
    '@context': [CONTEXTS.didV1, CONTEXTS.multikeyV1],
    id: did,
    verificationMethod: keys.map((k) => ({ id: k.id, type: 'Multikey', controller: did, publicKeyMultibase: k.publicKeyMultibase })),
    assertionMethod: keys.map((k) => k.id),
  };
}
