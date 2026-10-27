// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDocumentLoader, didDocument, didWeb } from '../src/index.ts';

describe('didWeb', () => {
  it('maps a public URL to did:web', () => {
    expect(didWeb('https://a.example/x')).toBe('did:web:a.example:x');
    expect(didWeb('https://a.example')).toBe('did:web:a.example');
    expect(didWeb('https://a.example/')).toBe('did:web:a.example');
    expect(didWeb('https://course.example:8443/a')).toBe('did:web:course.example%3A8443:a');
    expect(didWeb('https://a.example/x/y/')).toBe('did:web:a.example:x:y');
  });
});

describe('didDocument', () => {
  it('lists each key as a Multikey assertion method', () => {
    const did = 'did:web:a.example';
    const doc = didDocument(did, [{ id: did + '#k1', publicKeyMultibase: 'z6MkA' }, { id: did + '#k2', publicKeyMultibase: 'z6MkB' }]) as Record<string, any>;
    expect(doc['@context']).toEqual(['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1']);
    expect(doc.id).toBe(did);
    expect(doc.verificationMethod).toEqual([
      { id: did + '#k1', type: 'Multikey', controller: did, publicKeyMultibase: 'z6MkA' },
      { id: did + '#k2', type: 'Multikey', controller: did, publicKeyMultibase: 'z6MkB' },
    ]);
    expect(doc.assertionMethod).toEqual([did + '#k1', did + '#k2']);
  });
});

describe('createDocumentLoader', () => {
  const did = 'did:web:a.example';
  const doc = didDocument(did, [{ id: did + '#k1', publicKeyMultibase: 'z6MkA' }]);
  const load = createDocumentLoader({ [did]: doc });

  it('resolves the bundled contexts', async () => {
    for (const url of [
      'https://www.w3.org/ns/credentials/v2',
      'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json',
      'https://w3id.org/security/multikey/v1',
      'https://www.w3.org/ns/did/v1',
    ]) {
      const r = await load(url);
      expect(r.documentUrl).toBe(url);
      expect(r.document).toHaveProperty('@context');
    }
  });

  it('resolves given DID documents and their verification methods', async () => {
    expect((await load(did)).document).toEqual(doc);
    expect((await load(did + '#k1')).document).toMatchObject({ id: did + '#k1', type: 'Multikey', publicKeyMultibase: 'z6MkA' });
  });

  it('throws for anything else', async () => {
    await expect(load('https://example.com/ctx')).rejects.toThrow();
    await expect(load('did:web:other.example')).rejects.toThrow();
    await expect(load(did + '#missing')).rejects.toThrow();
  });

  it('bundles contexts whose SHA-256 matches sources.json', () => {
    const dir = new URL('../src/contexts/', import.meta.url);
    const sources = JSON.parse(readFileSync(new URL('sources.json', dir), 'utf8')) as { url: string; file: string; sha256: string }[];
    expect(sources).toHaveLength(4);
    for (const s of sources) {
      expect(createHash('sha256').update(readFileSync(new URL(s.file, dir))).digest('hex')).toBe(s.sha256);
    }
  });
});
