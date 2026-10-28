// SPDX-License-Identifier: Apache-2.0
import { LrsError } from './client.ts';

/** The LMS refused the cmi5 auth-token fetch. Codes follow cmi5: 1 already fetched, 2 not found, 3 other. */
export class Cmi5FetchError extends Error {
  code: '1' | '2' | '3';
  constructor(code: '1' | '2' | '3', message: string) {
    super(message);
    this.name = 'Cmi5FetchError';
    this.code = code;
  }
}

/** POSTs to the cmi5 fetch URL once and returns the auth-token (already the Basic credential). */
export async function fetchAuthToken(fetchUrl: string, f: typeof fetch = fetch): Promise<string> {
  let res: Response;
  let json: unknown;
  try {
    res = await f(fetchUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000) });
    json = await res.json().catch(() => undefined);
  } catch {
    throw new LrsError(0, 'the record holder is not responding; try again shortly');
  }
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (typeof o['auth-token'] === 'string' && res.ok) return o['auth-token'];
  const code = o['error-code'];
  if (code === '1' || code === '2' || code === '3') {
    throw new Cmi5FetchError(code, `the launch token could not be fetched (cmi5 error ${code})`);
  }
  throw new Cmi5FetchError('3', 'the launch token could not be fetched');
}
