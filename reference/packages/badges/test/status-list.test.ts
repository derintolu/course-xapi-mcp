// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { BitstringStatusList } from '@digitalbazaar/vc-bitstring-status-list';
import { createStatusList, statusListCredential } from '../src/index.ts';

describe('createStatusList', () => {
  it('allocates distinct random indexes in [0, 131072)', () => {
    const list = createStatusList();
    const seen = new Set<number>();
    for (let n = 0; n < 500; n++) {
      const i = list.allocate();
      expect(Number.isInteger(i)).toBe(true);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(131_072);
      expect(seen.has(i)).toBe(false);
      seen.add(i);
    }
    // Random, not sequential.
    expect([...seen].slice(0, 5)).not.toEqual([0, 1, 2, 3, 4]);
  });

  it('refuses to allocate past its length', () => {
    const list = createStatusList(8);
    for (let n = 0; n < 8; n++) list.allocate();
    expect(() => list.allocate()).toThrow();
  });

  it('revokes and reports revocation', () => {
    const list = createStatusList();
    const i = list.allocate();
    expect(list.isRevoked(i)).toBe(false);
    list.revoke(i);
    expect(list.isRevoked(i)).toBe(true);
  });

  it('encodes a GZIP base64url multibase bitstring that round-trips', async () => {
    const list = createStatusList();
    const a = list.allocate();
    const b = list.allocate();
    list.revoke(a);
    const encoded = list.encode();
    expect(encoded.startsWith('u')).toBe(true);
    const decoded = await BitstringStatusList.decode({ encodedList: encoded });
    expect(decoded.length).toBe(131_072);
    expect(decoded.getStatus(a)).toBe(true);
    expect(decoded.getStatus(b)).toBe(false);
  });

  it('builds the status entry and an unsigned status list credential', () => {
    const list = createStatusList();
    const i = list.allocate();
    expect(list.entry('https://course.example/status/1', i)).toEqual({
      id: `https://course.example/status/1#${i}`,
      type: 'BitstringStatusListEntry',
      statusPurpose: 'revocation',
      statusListIndex: String(i),
      statusListCredential: 'https://course.example/status/1',
    });
    const vc = statusListCredential({ listUrl: 'https://course.example/status/1', issuer: 'did:web:course.example', list, validFrom: '2026-10-27T00:00:00Z' }) as Record<string, any>;
    expect(vc.type).toEqual(['VerifiableCredential', 'BitstringStatusListCredential']);
    expect(vc.id).toBe('https://course.example/status/1');
    expect(vc.credentialSubject).toMatchObject({ type: 'BitstringStatusList', statusPurpose: 'revocation', encodedList: list.encode() });
    expect(vc).not.toHaveProperty('proof');
  });
});
