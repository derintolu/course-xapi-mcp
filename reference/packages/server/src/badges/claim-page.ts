// SPDX-License-Identifier: Apache-2.0
// The badge claim pages: the list of unclaimed badges with a form each (a wallet DID, or an email with a salt the
// browser generates and shows), the result of a claim, and how to sign in. Every value is escaped by `html`.
import { createHash } from 'node:crypto';
import { html, page } from '../auth/pages.ts';

/** Fills every salt field with 16 random bytes (hex), in the browser, so the server never chooses the salt. */
const SALT_SCRIPT =
  "for(const i of document.querySelectorAll('input[name=salt]')){const b=new Uint8Array(16);crypto.getRandomValues(b);i.value=Array.from(b,(x)=>x.toString(16).padStart(2,'0')).join('');}";
const SCRIPT_HASH = createHash('sha256').update(SALT_SCRIPT).digest('base64');
/** The script as trusted markup: `html` treats literal template parts as trusted, so it goes in as one. */
const SCRIPT = html(Object.assign([`<script>${SALT_SCRIPT}</script>`], { raw: [`<script>${SALT_SCRIPT}</script>`] }));
/** The pages' CSP plus this one script, by hash. */
const CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; form-action 'self'`;

const SIGN_IN_PATH = '/badges/sign-in';

export interface Claimable {
  badgeId: string;
  name: string;
  description: string;
  earnedAt: string;
}

export interface Claimed {
  credentialId: string;
  name: string;
  revoked: boolean;
}

const title = (courseTitle: string) => `Your badges: ${courseTitle}`;

/** The claim page: one form per unclaimed badge, then the badges already claimed. */
export function claimListPage(o: { courseTitle: string; csrf: string; unclaimed: Claimable[]; claimed: Claimed[] }): Response {
  const forms = o.unclaimed.map(
    (b) => html`<form method="post" action="/badges/claim"><h2>${b.name}</h2><p>${b.description}</p><p>Earned ${b.earnedAt}.</p>
<input type="hidden" name="csrf" value="${o.csrf}"><input type="hidden" name="badge" value="${b.badgeId}">
<p>Give either a wallet DID, or an email address. An email is stored only as a salted hash; keep the salt below with it, because you need both to show this badge is yours.</p>
<label>Wallet DID <input type="text" name="did" autocomplete="off" maxlength="2048" placeholder="did:key:..."></label>
<label>Email <input type="text" name="email" autocomplete="email" maxlength="320"></label>
<label>Salt (made in this browser; write it down) <input type="text" name="salt" readonly maxlength="32"></label>
<button type="submit">Claim this badge</button></form>`,
  );
  const claimed = o.claimed.map(
    (c) => html`<li><a href="/badges/credentials/${c.credentialId}">${c.name}</a>${c.revoked ? html` (revoked)` : undefined}</li>`,
  );
  return withScript(
    page(
      title(o.courseTitle),
      html`${forms.length ? forms : html`<p>You have no badges to claim right now.</p>`}${claimed.length ? html`<h2>Claimed</h2><ul>${claimed}</ul>` : undefined}${SCRIPT}`,
    ),
  );
}

/** After a claim: the credential to download, and the salt to keep for an email recipient. */
export function claimedPage(o: { courseTitle: string; name: string; credentialId: string; salt?: string; again: boolean }): Response {
  return page(
    title(o.courseTitle),
    html`<p>${o.again ? 'You had already claimed' : 'You claimed'} <strong>${o.name}</strong>.</p>${
      o.salt ? html`<p>Your salt: <code>${o.salt}</code>. Keep it with your email address.</p>` : undefined
    }<p><a href="/badges/credentials/${o.credentialId}">Download the badge (a signed Open Badges 3.0 credential)</a></p><p><a href="/badges/claim">Your badges</a></p>`,
  );
}

export function claimErrorPage(courseTitle: string, message: string, status: number): Response {
  return page(title(courseTitle), html`<p class="error">${message}</p><p><a href="/badges/claim">Back to your badges</a></p>`, status);
}

/** Where a claim without a browser session is sent. */
export function signInRedirect(): Response {
  return new Response(null, { status: 303, headers: { location: SIGN_IN_PATH, 'cache-control': 'no-store' } });
}

export function signInPage(courseTitle: string): Response {
  return page(
    `Sign in to claim your badges: ${courseTitle}`,
    html`<p>Sign in first: connect your agent to this course and sign in when it asks, in this browser. Then open <a href="/badges/claim">your badges</a> again.</p>`,
  );
}

export { SIGN_IN_PATH };

function withScript(res: Response): Response {
  res.headers.set('content-security-policy', CSP);
  return res;
}
