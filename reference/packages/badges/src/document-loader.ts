// SPDX-License-Identifier: Apache-2.0
// A JSON-LD document loader that never reaches the network: it resolves the bundled
// contexts (recorded in contexts/sources.json) and the DID documents it is given.
import { readFileSync } from 'node:fs';

export const CONTEXTS = {
  credentialsV2: 'https://www.w3.org/ns/credentials/v2',
  obV3: 'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json',
  multikeyV1: 'https://w3id.org/security/multikey/v1',
  didV1: 'https://www.w3.org/ns/did/v1',
} as const;

const sources = JSON.parse(readFileSync(new URL('./contexts/sources.json', import.meta.url), 'utf8')) as { url: string; file: string }[];
const bundled = new Map<string, object>(
  sources.map((s) => [s.url, JSON.parse(readFileSync(new URL('./contexts/' + s.file, import.meta.url), 'utf8')) as object]),
);

export interface RemoteDocument {
  contextUrl: null;
  documentUrl: string;
  document: object;
}

export type DocumentLoader = (url: string) => Promise<RemoteDocument>;

export function createDocumentLoader(didDocs: Record<string, object> = {}): DocumentLoader {
  return async (url) => {
    const found = resolve(url, didDocs);
    if (!found) throw new Error(`Document loader refuses "${url}": only bundled contexts and the given DID documents resolve.`);
    return { contextUrl: null, documentUrl: url, document: structuredClone(found) };
  };
}

function resolve(url: string, didDocs: Record<string, object>): object | undefined {
  const context = bundled.get(url);
  if (context) return context;
  const hash = url.indexOf('#');
  const did = hash < 0 ? url : url.slice(0, hash);
  if (!Object.hasOwn(didDocs, did)) return undefined;
  const doc = didDocs[did] as { '@context'?: unknown; verificationMethod?: { id: string }[] };
  if (hash < 0) return doc;
  const method = doc.verificationMethod?.find((m) => m.id === url);
  return method && { '@context': doc['@context'], ...method };
}
