// SPDX-License-Identifier: Apache-2.0
// Server-rendered authorization pages. Every interpolated value goes through `html`, which escapes it.
import { PATHS } from './metadata.ts';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'";

class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

type Value = string | number | Html | undefined | Value[];

function render(v: Value): string {
  if (v === undefined) return '';
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(String(v));
}

/** Tagged template: literal parts are trusted, every value is escaped unless it is already `Html`. */
export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  return new Html(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ''), ''));
}

const STYLE = `body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a;background:#fff}
form{margin:1.5rem 0;padding:1rem;border:1px solid #ccc;border-radius:6px}label{display:block;margin:.5rem 0}
input[type=text],input[type=password]{display:block;width:100%;box-sizing:border-box;padding:.4rem;font-size:1rem}
button{margin-top:.75rem;padding:.4rem 1rem;font-size:1rem}.error{color:#a40000;font-weight:600}`;

export function page(title: string, body: Html, status = 200, headers: Record<string, string> = {}, head?: Html): Response {
  const doc = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}<title>${title}</title><style>${new Html(STYLE)}</style></head><body><h1>${title}</h1>${body}</body></html>`;
  const h = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': CSP,
    'x-frame-options': 'DENY',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  for (const [k, v] of Object.entries(headers)) h.append(k, v);
  return new Response(doc.value, { status, headers: h });
}

export function errorPage(message: string, status = 400): Response {
  return page('Sign-in problem', html`<p class="error">${message}</p><p>Start again from your agent.</p>`, status);
}

const errorLine = (error?: string) => (error ? html`<p class="error" role="alert">${error}</p>` : undefined);
const intro = (clientName: string | undefined, courseTitle: string) =>
  html`<p><strong>${clientName ?? 'An agent'}</strong> wants to connect to the course <strong>${courseTitle}</strong> on your behalf.</p>`;

export function accountsPage(o: { requestId: string; clientName?: string; courseTitle: string; error?: string; status?: number }): Response {
  const fields = (action: string, autocomplete: string) => html`<input type="hidden" name="request_id" value="${o.requestId}"><input type="hidden" name="action" value="${action}">
<label>Username <input type="text" name="username" autocomplete="username" required minlength="3" maxlength="64" pattern="[a-z0-9._\\-]+"></label>
<label>Password <input type="password" name="password" autocomplete="${autocomplete}" required minlength="${action === 'signup' ? 12 : 1}"></label>`;
  return page(
    'Sign in to continue',
    html`${intro(o.clientName, o.courseTitle)}${errorLine(o.error)}
<form method="post" action="${PATHS.login}"><h2>Sign in</h2>${fields('signin', 'current-password')}<button type="submit">Sign in</button></form>
<form method="post" action="${PATHS.login}"><h2>Create an account</h2>${fields('signup', 'new-password')}<p>Usernames use lowercase letters, digits, dot, dash or underscore. Passwords are at least 12 characters.</p><button type="submit">Create account</button></form>`,
    o.status,
  );
}

export function launchPage(o: { requestId: string; clientName?: string; courseTitle: string; withLaunch: boolean; error?: string; status?: number }): Response {
  const body = o.withLaunch
    ? html`<form method="post" action="${PATHS.authorize}"><input type="hidden" name="request_id" value="${o.requestId}"><input type="hidden" name="action" value="continue"><p>This connects your agent to the lesson you just launched from your LMS.</p><button type="submit">Continue</button></form>`
    : html`<form method="post" action="${PATHS.authorize}"><input type="hidden" name="request_id" value="${o.requestId}"><label>Pairing code from the lesson page <input type="text" name="pairing_code" autocomplete="one-time-code" required maxlength="16" autocapitalize="characters"></label><p>Type the code here only, never in the chat with your agent.</p><button type="submit">Connect</button></form>`;
  return page('Connect your lesson', html`${intro(o.clientName, o.courseTitle)}${errorLine(o.error)}${body}`, o.status);
}

/**
 * Sends the browser back to the client after a form POST. A 302 there would be checked against the page's
 * `form-action 'self'`, so this page navigates instead.
 */
export function redirectPage(location: string, headers: Record<string, string> = {}): Response {
  return page('Returning to your agent', html`<p><a href="${location}">Continue to your agent</a> if nothing happens.</p>`, 200, headers, html`<meta http-equiv="refresh" content="0;url=${location}">`);
}
