// SPDX-License-Identifier: Apache-2.0
// Data Integrity proofs with eddsa-rdfc-2022 and Ed25519 Multikeys.
import { DataIntegrityProof } from '@digitalbazaar/data-integrity';
import * as Ed25519Multikey from '@digitalbazaar/ed25519-multikey';
import { cryptosuite } from '@digitalbazaar/eddsa-rdfc-2022-cryptosuite';
import * as vc from '@digitalbazaar/vc';
import { createDocumentLoader } from './document-loader.ts';

export interface SigningKey {
  id: string;
  controller: string;
  publicKeyMultibase: string;
  secretKeyMultibase: string;
}

/** A new Ed25519 Multikey whose id is `<controllerDid>#<publicKeyMultibase>`. */
export async function generateKey(controllerDid: string): Promise<SigningKey> {
  const pair = await Ed25519Multikey.generate({ controller: controllerDid });
  const k = await pair.export({ publicKey: true, secretKey: true, includeContext: false });
  return { id: k.id, controller: k.controller, publicKeyMultibase: k.publicKeyMultibase, secretKeyMultibase: k.secretKeyMultibase };
}

/** Returns a signed copy; `unsigned` is left untouched. */
export async function signCredential(unsigned: object, key: SigningKey): Promise<object> {
  const pair = await Ed25519Multikey.from({ type: 'Multikey', ...key });
  const suite = new DataIntegrityProof({ signer: pair.signer(), cryptosuite });
  return vc.issue({ credential: structuredClone(unsigned), suite, documentLoader: createDocumentLoader() });
}

/**
 * Verifies the proof against the given DID documents (keyed by DID). Revocation is not
 * checked here: the status list is a separate credential the caller fetches and checks.
 */
export async function verifyCredential(signed: object, didDocs: Record<string, object>): Promise<{ verified: boolean; errors: string[] }> {
  const suite = new DataIntegrityProof({ cryptosuite });
  try {
    const r = await vc.verifyCredential({
      credential: signed,
      suite,
      documentLoader: createDocumentLoader(didDocs),
      checkStatus: async () => ({ verified: true }),
    });
    return r.verified ? { verified: true, errors: [] } : { verified: false, errors: collectErrors(r) };
  } catch (e) {
    return { verified: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
}

function collectErrors(r: vc.VerifyResult): string[] {
  const out: string[] = [];
  const add = (e: unknown) => {
    if (!e) return;
    if (Array.isArray(e)) return e.forEach(add);
    const err = e as { message?: string; errors?: unknown };
    if (err.errors) add(err.errors);
    else out.push(err.message ?? String(e));
  };
  add(r.error);
  for (const p of r.results ?? []) add(p.error);
  return out.length ? [...new Set(out)] : ['Verification failed.'];
}
