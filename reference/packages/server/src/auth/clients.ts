// SPDX-License-Identifier: Apache-2.0
// OAuth clients: dynamic registration (RFC 7591, public clients only) and client id metadata documents
// (an https `client_id` naming a JSON document that lists the client's redirect URIs).
import { randomBytes } from 'node:crypto';
import type { AuthStore, ClientRecord } from './stores.ts';

/** Metadata documents and request bodies are read up to 64 KB. */
export const BODY_LIMIT = 65_536;
const METADATA_TIMEOUT_MS = 5000;
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;
const MAX_NAME_LENGTH = 200;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const REFUSED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:']);

export class ClientError extends Error {
  readonly code: 'invalid_client_metadata' | 'invalid_redirect_uri';
  constructor(code: 'invalid_client_metadata' | 'invalid_redirect_uri', message: string) {
    super(message);
    this.code = code;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

/** Reads a body up to `limit` bytes; undefined when it is larger. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, limit = BODY_LIMIT): Promise<string | undefined> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** https anywhere, http only on loopback, or a private-use scheme of a native app; never a fragment. */
export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > MAX_URI_LENGTH) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || uri.includes('#') || u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return isLoopbackHost(u.hostname);
  return !REFUSED_SCHEMES.has(u.protocol);
}

function clientName(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > MAX_NAME_LENGTH) throw new ClientError('invalid_client_metadata', 'client_name must be a string of at most 200 characters');
  return v;
}

function redirectUris(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_REDIRECT_URIS) {
    throw new ClientError('invalid_redirect_uri', 'redirect_uris must list 1 to 10 URIs');
  }
  for (const uri of v) {
    if (!isAllowedRedirectUri(uri)) throw new ClientError('invalid_redirect_uri', 'a redirect URI must be https, http on loopback, or an app scheme, without a fragment');
  }
  return [...v];
}

function publicOnly(meta: Record<string, unknown>) {
  if (meta.token_endpoint_auth_method !== undefined && meta.token_endpoint_auth_method !== 'none') {
    throw new ClientError('invalid_client_metadata', 'only public clients (token_endpoint_auth_method "none") are supported');
  }
}

/** Validates RFC 7591 metadata and stores a new public client. */
export async function registerClient(store: AuthStore, meta: unknown, now: number): Promise<ClientRecord & { grantTypes: string[] }> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new ClientError('invalid_client_metadata', 'the body must be a JSON object');
  const m = meta as Record<string, unknown>;
  publicOnly(m);
  const grantTypes = m.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code') || grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    throw new ClientError('invalid_client_metadata', 'grant_types must be authorization_code, optionally with refresh_token');
  }
  if (m.response_types !== undefined && (!Array.isArray(m.response_types) || m.response_types.some((r) => r !== 'code'))) {
    throw new ClientError('invalid_client_metadata', 'response_types must be ["code"]');
  }
  const c: ClientRecord = {
    clientId: randomBytes(24).toString('base64url'),
    clientName: clientName(m.client_name),
    redirectUris: redirectUris(m.redirect_uris),
    issuedAt: Math.floor(now / 1000),
  };
  await store.putClient(c);
  return { ...c, grantTypes: grantTypes as string[] };
}

function isMetadataDocumentUrl(clientId: string): boolean {
  if (!clientId.startsWith('https://')) return false;
  try {
    const u = new URL(clientId);
    return u.pathname !== '/' && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Fetches a client id metadata document: 5 s timeout, 64 KB cap, no redirects. */
async function fetchMetadataDocument(clientId: string, fetchFn: typeof fetch): Promise<ClientRecord | undefined> {
  try {
    const res = await fetchFn(clientId, {
      redirect: 'manual',
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return undefined;
    }
    const text = await readCapped(res.body);
    if (text === undefined) return undefined;
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (!doc || typeof doc !== 'object' || doc.client_id !== clientId) return undefined;
    publicOnly(doc);
    return { clientId, clientName: clientName(doc.client_name), redirectUris: redirectUris(doc.redirect_uris), issuedAt: 0 };
  } catch {
    return undefined;
  }
}

/** A registered client, or the client a metadata document URL describes. */
export async function resolveClient(store: AuthStore, clientId: string, fetchFn: typeof fetch): Promise<ClientRecord | undefined> {
  if (!clientId) return undefined;
  if (isMetadataDocumentUrl(clientId)) return fetchMetadataDocument(clientId, fetchFn);
  return store.getClient(clientId);
}
