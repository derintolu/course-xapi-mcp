// SPDX-License-Identifier: Apache-2.0
// The badge issuer's HTTP routes: `GET /.well-known/did.json`, `GET /badges/status/1`, `GET|POST /badges/claim`,
// `GET /badges/sign-in` and `GET /badges/credentials/<uuid>` (only to its owner's browser session).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthServer, LearnerRef } from '@course-xapi-mcp/core';
import { readCapped } from '../auth/clients.ts';
import type { Recipient } from '@course-xapi-mcp/badges';
import { SIGN_IN_PATH, claimErrorPage, claimListPage, claimedPage, signInPage, signInRedirect, type Claimable, type Claimed } from './claim-page.ts';
import type { CredentialRecord } from './issuer-store.ts';

export const STATUS_LIST_PATH = '/badges/status/1';
export const CLAIM_PATH = '/badges/claim';
const DID_PATH = '/.well-known/did.json';
const CREDENTIAL = /^\/badges\/credentials\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const SALT = /^[0-9a-f]{32}$/;

/** What the routes need from the badge service. */
export interface BadgeRouteDeps {
  courseTitle: string;
  auth: AuthServer;
  didDocument(): object;
  /** The signed status list credential. */
  statusList(): Promise<object>;
  overview(l: LearnerRef): Promise<{ unclaimed: Claimable[]; claimed: Claimed[] }>;
  claim(l: LearnerRef, badgeId: string, recipient: Recipient): Promise<{ credentialId: string; name: string; again: boolean } | { error: string }>;
  credential(id: string): Promise<CredentialRecord | undefined>;
}

function sessionId(req: Request): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'cxm_sid') return part.slice(i + 1).trim();
  }
  return undefined;
}

const methodNotAllowed = (allow: string) => new Response(null, { status: 405, headers: { allow } });

/** The recipient a claim form names: exactly one of a wallet DID, or an email with the browser's salt. */
function recipientOf(form: URLSearchParams): Recipient | { error: string } {
  const did = (form.get('did') ?? '').trim();
  const email = (form.get('email') ?? '').trim();
  const salt = (form.get('salt') ?? '').trim();
  if (did && email) return { error: 'Give either a wallet DID or an email address, not both.' };
  if (did) return did.length <= 2048 && DID.test(did) ? { did } : { error: 'That is not a DID (it starts with "did:").' };
  if (!email) return { error: 'Give a wallet DID or an email address: a badge is never issued without a recipient.' };
  if (email.length > 320 || !EMAIL.test(email)) return { error: 'That is not an email address.' };
  if (!SALT.test(salt)) return { error: 'The salt is missing: this page makes it in your browser, so allow its script and try again.' };
  return { email, salt };
}

export function createBadgeRoutes(d: BadgeRouteDeps): (req: Request) => Promise<Response | undefined> {
  // Binds each claim form to one browser session; the secret lives as long as this process.
  const csrfSecret = randomBytes(32);
  const csrfFor = (sid: string) => createHmac('sha256', csrfSecret).update('badge-claim\n' + sid).digest('base64url');
  const csrfOk = (sid: string, given: string | null) => {
    if (!given) return false;
    const want = Buffer.from(csrfFor(sid));
    const got = Buffer.from(given);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  async function signedIn(req: Request): Promise<{ sid: string; learner: LearnerRef } | undefined> {
    const sid = sessionId(req);
    const learner = sid ? await d.auth.browserLearner(req) : undefined;
    return sid && learner ? { sid, learner } : undefined;
  }

  async function claimPost(req: Request, sid: string, l: LearnerRef): Promise<Response> {
    const text = (req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded') ? await readCapped(req.body) : undefined;
    const form = new URLSearchParams(text ?? '');
    if (!csrfOk(sid, form.get('csrf'))) return claimErrorPage(d.courseTitle, 'This form has expired. Open your badges again and try again.', 403);
    const recipient = recipientOf(form);
    if ('error' in recipient) return claimErrorPage(d.courseTitle, recipient.error, 400);
    const r = await d.claim(l, form.get('badge') ?? '', recipient);
    if ('error' in r) return claimErrorPage(d.courseTitle, r.error, 400);
    return claimedPage({ courseTitle: d.courseTitle, name: r.name, credentialId: r.credentialId, again: r.again, ...('salt' in recipient && !r.again ? { salt: recipient.salt } : {}) });
  }

  return async (req) => {
    const path = new URL(req.url).pathname;
    if (path === DID_PATH) {
      if (req.method !== 'GET') return methodNotAllowed('GET');
      return Response.json(d.didDocument(), { headers: { 'cache-control': 'public, max-age=300' } });
    }
    if (path === STATUS_LIST_PATH) {
      if (req.method !== 'GET') return methodNotAllowed('GET');
      return Response.json(await d.statusList(), { headers: { 'cache-control': 'no-cache' } });
    }
    if (path === SIGN_IN_PATH) {
      if (req.method !== 'GET') return methodNotAllowed('GET');
      return signInPage(d.courseTitle);
    }
    if (path === CLAIM_PATH) {
      if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed('GET, POST');
      const s = await signedIn(req);
      if (!s) return signInRedirect();
      if (req.method === 'POST') return claimPost(req, s.sid, s.learner);
      const { unclaimed, claimed } = await d.overview(s.learner);
      return claimListPage({ courseTitle: d.courseTitle, csrf: csrfFor(s.sid), unclaimed, claimed });
    }
    const m = CREDENTIAL.exec(path);
    if (!m) return undefined;
    if (req.method !== 'GET') return methodNotAllowed('GET');
    const s = await signedIn(req);
    if (!s) return Response.json({ error: 'sign in first, in this browser' }, { status: 401, headers: { 'cache-control': 'no-store' } });
    const c = await d.credential(m[1]!);
    if (!c || c.subject !== s.learner.subject) return Response.json({ error: 'no such badge' }, { status: 404, headers: { 'cache-control': 'no-store' } });
    return new Response(JSON.stringify(c.credential, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="badge.json"',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  };
}
