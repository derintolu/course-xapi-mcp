// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { buildCredential, createStatusList, didDocument, didWeb, generateKey, signCredential, statusListCredential, verifyCredential } from '../src/index.ts';
import { badge } from './fixtures.ts';

async function setup() {
  const did = didWeb('https://course.example');
  const key = await generateKey(did);
  const list = createStatusList();
  const unsigned = buildCredential({
    badge: badge({ id: 'https://course.example/badges/a', awardOn: 'block-satisfied', for: 'a', image: 'https://course.example/badges/a.png', alignment: [{ targetName: 'JSON', targetUrl: 'https://example.org/json', targetType: 'CFItem' }] }),
    issuer: { id: did, name: 'Course Server' },
    recipient: { email: 'learner@example.com', salt: 'c2FsdHNhbHRzYWx0c2FsdA' },
    award: { badgeId: 'https://course.example/badges/a', registration: 'r', earningStatementId: '22222222-2222-4222-8222-222222222222', testedOut: 1 },
    credentialId: 'urn:uuid:33333333-3333-4333-8333-333333333333',
    validFrom: '2026-01-01T00:00:00Z',
    status: list.entry('https://course.example/status/1', list.allocate()),
    assessed: 'mixed',
  });
  const didDocs = { [did]: didDocument(did, [key]) };
  return { did, key, unsigned, didDocs };
}

describe('signCredential / verifyCredential', () => {
  it('generates a Multikey under the controller DID', async () => {
    const key = await generateKey('did:web:course.example');
    expect(key.controller).toBe('did:web:course.example');
    expect(key.id.startsWith('did:web:course.example#')).toBe(true);
    expect(key.publicKeyMultibase).toMatch(/^z6Mk/);
    expect(typeof key.secretKeyMultibase).toBe('string');
  });

  it('signs with eddsa-rdfc-2022 and verifies against the DID document', async () => {
    const { key, unsigned, didDocs } = await setup();
    const signed = (await signCredential(unsigned, key)) as Record<string, any>;
    expect(signed.proof).toMatchObject({ type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: key.id, proofPurpose: 'assertionMethod' });
    expect(unsigned).not.toHaveProperty('proof');
    expect(await verifyCredential(signed, didDocs)).toEqual({ verified: true, errors: [] });
  });

  it('fails verification when the achievement name is tampered with', async () => {
    const { key, unsigned, didDocs } = await setup();
    const signed = (await signCredential(unsigned, key)) as Record<string, any>;
    const tampered = structuredClone(signed);
    tampered.credentialSubject.achievement.name = 'Something else';
    const r = await verifyCredential(tampered, didDocs);
    expect(r.verified).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('fails verification without the issuer DID document', async () => {
    const { key, unsigned } = await setup();
    const signed = await signCredential(unsigned, key);
    expect((await verifyCredential(signed, {})).verified).toBe(false);
  });

  it('signs and verifies a status list credential', async () => {
    const { did, key, didDocs } = await setup();
    const list = createStatusList();
    list.revoke(list.allocate());
    const signed = await signCredential(statusListCredential({ listUrl: 'https://course.example/status/1', issuer: did, list, validFrom: '2026-01-01T00:00:00Z' }), key);
    expect(await verifyCredential(signed, didDocs)).toEqual({ verified: true, errors: [] });
  });

  it('signs a credential that carries a score (includeScore), using only OB 3.0 terms', async () => {
    const { did, key, didDocs } = await setup();
    const list = createStatusList();
    const unsigned = buildCredential({
      badge: badge({ id: 'https://course.example/badges/s', awardOn: 'au-moveon', for: 'a1', includeScore: true }),
      issuer: { id: did, name: 'Course Server' },
      recipient: { did: 'did:example:wallet' },
      award: { badgeId: 'https://course.example/badges/s', registration: 'r', earningStatementId: '22222222-2222-4222-8222-222222222222', testedOut: 0 },
      credentialId: 'urn:uuid:44444444-4444-4444-8444-444444444444',
      validFrom: '2026-01-01T00:00:00Z',
      status: list.entry('https://course.example/status/1', list.allocate()),
      assessed: 'checks',
      score: { raw: 7, min: 0, max: 10 },
    });
    const signed = await signCredential(unsigned, key);
    expect(await verifyCredential(signed, didDocs)).toEqual({ verified: true, errors: [] });
  });
});
