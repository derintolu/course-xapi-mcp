// SPDX-License-Identifier: Apache-2.0
// The scripted client of the course server and launch bridge classes. It reaches the server under test only over
// its wire contract: MCP over HTTP, the OAuth 2.1 endpoints and pages the server publishes, the record holder the
// server writes to, and (option 1) a cmi5 LMS simulator that this suite runs itself.
//
// Environment (conformance/README.md): CXM_URL, CXM_CUSTODY, CXM_TOKEN (options 2 and 3), CXM_LRS_URL (option 2),
// CXM_EXPORT_URL (option 3; also read in option 2 when set).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { activityIds, type XapiAgent, type XapiStatement } from '@course-xapi-mcp/core';
import { createLmsSim, createTestLrs, type LmsSim, type TestLrs } from '../lib/index.ts';

export type Custody = 'lms-launched' | 'author-lrs' | 'server-kept' | 'practice';
const CUSTODIES: Custody[] = ['lms-launched', 'author-lrs', 'server-kept', 'practice'];

// ---- environment

const env = (name: string) => process.env[name] || undefined;
export const CUSTODY = env('CXM_CUSTODY') as Custody;
/** The MCP endpoint: the official endpoint in options 1 to 3, the practice endpoint in option 4. */
export const MCP_URL = env('CXM_URL') ?? '';
export const ORIGIN = URL.canParse(MCP_URL) ? new URL(MCP_URL).origin : '';
export const OFFICIAL = CUSTODY !== 'practice';
export const TOKEN = env('CXM_TOKEN');
export const LRS_URL = env('CXM_LRS_URL');
export const EXPORT_URL = env('CXM_EXPORT_URL');
/** The bundled test LRS's default credential. */
const LRS_BASIC = 'Basic ' + btoa('test:test');

/**
 * Checks the operator of a server under test declared as known to fail, from `CXM_KNOWN_GAPS` (a JSON object of
 * check name to reason). A test runs such a check as skipped, with the reason in its name; it never passes it.
 */
const GAPS: Record<string, string> = (() => {
  try {
    return JSON.parse(env('CXM_KNOWN_GAPS') ?? '{}');
  } catch {
    throw new Error('CXM_KNOWN_GAPS must be a JSON object of check name to reason');
  }
})();
export const knownGap = (check: string): string | undefined => GAPS[check];
/** A test name with the known-gap reason appended, for `it.skipIf(knownGap(check))(gapName(check, name), ...)`. */
export const gapName = (check: string, name: string) => (GAPS[check] ? `${name} (known gap, skipped: ${GAPS[check]})` : name);

/** Throws a clear message when the environment does not describe a server under test. Every test file calls it first. */
export function requireEnv(o: { custody?: Custody } = {}): void {
  const need = (v: string | undefined, name: string, why: string) => {
    if (!v) throw new Error(`Set ${name} (${why}); see conformance/README.md.`);
  };
  need(CUSTODY, 'CXM_CUSTODY', 'the custody option of the course the server under test serves');
  if (!CUSTODIES.includes(CUSTODY)) throw new Error(`CXM_CUSTODY must be one of ${CUSTODIES.join(', ')}; got ${CUSTODY}`);
  if (o.custody && CUSTODY !== o.custody) throw new Error(`This class runs against a server whose course custody is ${o.custody} (CXM_CUSTODY=${o.custody}).`);
  need(MCP_URL, 'CXM_URL', 'the MCP endpoint of the server under test');
  if (CUSTODY === 'author-lrs' || CUSTODY === 'server-kept') need(TOKEN, 'CXM_TOKEN', `a bearer token for custody ${CUSTODY}`);
  if (CUSTODY === 'author-lrs') need(LRS_URL, 'CXM_LRS_URL', 'the bundled test LRS the server writes to');
  if (CUSTODY === 'server-kept') need(EXPORT_URL, 'CXM_EXPORT_URL', "the learner's record export");
}

// ---- the conformance course (conformance/fixtures/course)

const FIXTURE = new URL('../fixtures/course/', import.meta.url);
const readJson = (p: string) => JSON.parse(readFileSync(new URL(p, FIXTURE), 'utf8'));
const cmi5 = readFileSync(new URL('cmi5.xml', FIXTURE), 'utf8');

export const COURSE_ID = /<course id="([^"]+)"/.exec(cmi5)![1]!;
export const COURSE_JSON = readJson('cxm/course.json');
export const LESSONS = { intro: readJson('cxm/lessons/intro.json'), types: readJson('cxm/lessons/types.json'), fix: readJson('cxm/lessons/fix.json') };
export type LessonKey = keyof typeof LESSONS;
export const AU_IDS: Record<LessonKey | 'placement', string> = {
  placement: COURSE_ID + '/placement',
  intro: COURSE_ID + '/lessons/intro',
  types: COURSE_ID + '/lessons/types',
  fix: COURSE_ID + '/lessons/fix',
};
export const BLOCK_ID = COURSE_ID + '/paths/basics';
/** Each AU's launch URL from the package, moved onto the origin of CXM_URL. */
const AU_URLS = Object.fromEntries(
  [...cmi5.matchAll(/<au\b[^>]*\bcxm:key="([^"]+)"[^>]*>[\s\S]*?<url>([^<]+)<\/url>/g)].map(([, key, url]) => {
    const u = new URL(url!.replace(/&amp;/g, '&'));
    return [key!, ORIGIN + u.pathname + u.search];
  }),
) as Record<LessonKey | 'placement', string>;

/** The answers the learner gives in the fixture. */
export const FILES = {
  configBug: LESSONS.fix.bug.code as string,
  configFixed: '{\n  "name": "demo",\n  "port": 8080\n}\n',
  configWithTimeout: '{\n  "name": "demo",\n  "port": 8080,\n  "timeout": 30\n}\n',
  /** Looks fixed to a reader, but the timeout is a string. */
  configTimeoutString: '{\n  "name": "demo",\n  "port": 8080,\n  "timeout": "30"\n}\n',
  flagsBug: LESSONS.types.bug.code as string,
  flagsFixed: '{\n  "enabled": true\n}\n',
};

/** Text no result may carry before the bug is caught or revealed (and the reference solution never). */
export function bugSecrets(key: 'types' | 'fix') {
  const bug = LESSONS[key].bug;
  return {
    explanation: bug.explanation as string,
    fixChecks: [JSON.stringify(bug.fixChecks), ...bug.fixChecks.map((c: { message: string }) => c.message)] as string[],
    reference: [JSON.stringify(LESSONS[key].referenceSolution), ...Object.values(LESSONS[key].referenceSolution.files as Record<string, string>), LESSONS[key].referenceSolution.bugFix].flatMap(
      (s) => [s, JSON.stringify(s), /RS-[A-Z]+-\d+/.exec(s)?.[0]].filter((x): x is string => typeof x === 'string'),
    ),
  };
}

// ---- results and the transcript of everything the agent saw

export interface Result {
  tool: string;
  isError: boolean;
  /** structuredContent */
  data: any;
  raw: any;
}

/** Every string inside a value, and inside any string that is itself JSON (a result's text content), unescaped. */
export function plainText(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') {
    out.push(v);
    if (/^\s*[[{]/.test(v)) {
      try {
        plainText(JSON.parse(v), out);
      } catch {
        // not JSON
      }
    }
  } else if (Array.isArray(v)) for (const x of v) plainText(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) plainText([k, x], out);
  return out;
}

/**
 * Every tool result, resource and prompt this module's clients received, in order. `text` is the raw JSON; `plain`
 * holds every string in it unescaped, one per line, for scans.
 */
export const transcript: { conn: number; tool: string; args: unknown; raw: any; text: string; plain: string }[] = [];
const see = (conn: number, tool: string, args: unknown, raw: unknown) => transcript.push({ conn, tool, args, raw, text: JSON.stringify(raw), plain: plainText(raw).join('\n') });
let connections = 0;

/** The learner's own export: get_record and the record export resource. */
export const isExport = (t: { tool: string }) => t.tool === 'get_record' || t.tool === 'resource:course-xapi-mcp://record/export';

export interface Mcp {
  /** This connection's number in the transcript. */
  id: number;
  client: Client;
  call(tool: string, args?: Record<string, unknown>): Promise<Result>;
  tools(): Promise<any[]>;
  close(): Promise<void>;
}

/** Connects the official MCP SDK client. `era: 'legacy'` lets the SDK negotiate a 2025-era revision. */
export async function connect(o: { url?: string; token?: string; era?: 'modern' | 'legacy' } = {}): Promise<Mcp> {
  const url = o.url ?? MCP_URL;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: (u, init) => {
      const headers = new Headers(init?.headers);
      if (o.token) headers.set('authorization', `Bearer ${o.token}`);
      return fetch(u, { ...init, headers });
    },
  });
  const client = new Client({ name: 'cxm-conformance', version: '0.2.0' }, o.era === 'legacy' ? {} : { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(transport);
  let listed: any[] | undefined;
  const tools = async () => (listed ??= (await client.listTools()).tools);
  // Listing first makes the SDK check every structuredContent against the tool's output schema.
  await tools();
  const id = ++connections;
  return {
    id,
    client,
    tools,
    async call(tool, args = {}) {
      const raw: any = await client.callTool({ name: tool, arguments: args });
      see(id, tool, args, raw);
      return { tool, isError: Boolean(raw.isError), data: raw.structuredContent, raw };
    },
    close: () => client.close(),
  };
}

export async function readResource(m: Mcp, uri: string): Promise<string> {
  const r = await m.client.readResource({ uri });
  see(m.id, 'resource:' + uri, {}, r);
  return r.contents.map((c: any) => c.text ?? '').join('');
}

// ---- HTTP: a cookie jar, HTML forms, and node:http around a fetch handler

export function jar() {
  const kept = new Map<string, string>();
  return {
    take(res: Response) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair!.indexOf('=');
        if (i > 0) kept.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
      }
    },
    header: () => [...kept].map(([k, v]) => `${k}=${v}`).join('; '),
    has: (name: string) => kept.has(name),
  };
}
export type Jar = ReturnType<typeof jar>;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unescapeHtml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
  );

export interface Form {
  action: string;
  method: string;
  inputs: { name: string; value: string; type: string }[];
  html: string;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? unescapeHtml(m[1] ?? m[2] ?? m[3] ?? '') : undefined;
}

export function parseForms(html: string, base: string): Form[] {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(([whole, open, body]) => ({
    action: new URL(attr(`<form ${open}>`, 'action') ?? '', base).href,
    method: (attr(`<form ${open}>`, 'method') ?? 'get').toLowerCase(),
    inputs: [...body!.matchAll(/<input\b[^>]*>/gi)].map(([tag]) => ({ name: attr(tag, 'name') ?? '', value: attr(tag, 'value') ?? '', type: (attr(tag, 'type') ?? 'text').toLowerCase() })),
    html: whole,
  }));
}
export const visibleInputs = (f: Form) => f.inputs.filter((i) => i.name && i.type !== 'hidden' && i.type !== 'submit');

/** Serves a fetch handler on 127.0.0.1; `log` sees every request first. */
export async function serve(handler: (req: Request) => Promise<Response>, log?: (req: Request) => void): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((msg, out) => {
    void (async () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(msg.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const method = msg.method ?? 'GET';
      const body = method === 'GET' || method === 'HEAD' ? undefined : (Readable.toWeb(msg) as ReadableStream);
      const req = new Request(`http://${msg.headers.host}${msg.url}`, { method, headers, body, duplex: 'half' } as RequestInit);
      log?.(req.clone());
      const res = await handler(req);
      const cookies = res.headers.getSetCookie();
      for (const [k, v] of res.headers) if (k !== 'set-cookie') out.setHeader(k, v);
      if (cookies.length) out.setHeader('set-cookie', cookies);
      out.writeHead(res.status);
      out.end(Buffer.from(await res.arrayBuffer()));
    })().catch((e: unknown) => {
      if (!out.headersSent) out.writeHead(500);
      out.end(String(e));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---- OAuth 2.1 authorization through the server's own pages, as the learner's browser and the agent

/** Picks the form to submit on a page and the values to type into it; undefined means the page is not understood. */
export type FormFill = (forms: Form[], page: string) => { form: Form; values: Record<string, string> } | undefined;

/** Types `code` into the only visible text field. */
export const typePairingCode =
  (code: string): FormFill =>
  (forms) => {
    const form = forms.find((f) => visibleInputs(f).length === 1);
    return form && { form, values: { [visibleInputs(form)[0]!.name]: code } };
  };

/** Submits the first form that asks for nothing (the "Continue" or "Allow" step). */
export const submitPlainForm: FormFill = (forms) => {
  const form = forms.find((f) => visibleInputs(f).length === 0);
  return form && { form, values: {} };
};

export const REDIRECT_URI = 'http://127.0.0.1:9/cxm-conformance/callback';

/** Every page any authorization flow in this module showed the browser. */
export const browserPages: string[] = [];

export interface Authorized {
  accessToken: string;
  refreshToken?: string;
  /** Every page the browser was shown on the way. */
  pages: string[];
}

/** Protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414) of the official endpoint. */
export async function authMetadata(mcpUrl = MCP_URL) {
  const challenge = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  const www = challenge.headers.get('www-authenticate') ?? '';
  const metaUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1] ?? new URL('/.well-known/oauth-protected-resource' + new URL(mcpUrl).pathname, mcpUrl).href;
  const resource = await (await fetch(metaUrl)).json();
  const issuer = new URL(resource.authorization_servers[0]);
  const as = await (await fetch(new URL('/.well-known/oauth-authorization-server' + (issuer.pathname === '/' ? '' : issuer.pathname), issuer))).json();
  return { status: challenge.status, www, resource, as };
}

/**
 * Runs the authorization code flow with PKCE S256 and dynamic client registration. The browser follows redirects
 * and `<meta http-equiv="refresh">`, and submits the form `fill` picks on each page, until it returns to the agent.
 */
export async function authorize(o: { browser: Jar; fill: FormFill; mcpUrl?: string; clientName?: string }): Promise<Authorized> {
  const mcpUrl = o.mcpUrl ?? MCP_URL;
  const { resource, as } = await authMetadata(mcpUrl);
  const reg = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: o.clientName ?? 'cxm conformance agent', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  if (reg.status !== 201) throw new Error(`client registration answered ${reg.status}: ${await reg.text()}`);
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString('base64url');
  const state = randomUUID();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    resource: resource.resource,
  });
  if (resource.scopes_supported?.length) q.set('scope', resource.scopes_supported.join(' '));

  const pages: string[] = [];
  let next: { url: string; init?: RequestInit } = { url: `${as.authorization_endpoint}?${q}` };
  let code: string | undefined;
  for (let hop = 0; hop < 20 && !code; hop++) {
    const headers = new Headers(next.init?.headers);
    if (o.browser.header()) headers.set('cookie', o.browser.header());
    const res = await fetch(next.url, { ...next.init, headers, redirect: 'manual' });
    o.browser.take(res);
    const back = (to: string) => {
      const u = new URL(to, next.url);
      if (!u.href.startsWith(REDIRECT_URI)) return false;
      if (u.searchParams.get('state') !== state) throw new Error('the authorization response lost the state');
      const err = u.searchParams.get('error');
      if (err) throw new Error(`authorization refused: ${err} ${u.searchParams.get('error_description') ?? ''}`);
      code = u.searchParams.get('code') ?? undefined;
      return true;
    };
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      if (!back(location)) next = { url: new URL(location, next.url).href };
      continue;
    }
    const page = await res.text();
    pages.push(page);
    browserPages.push(page);
    const refresh = /<meta\s+http-equiv="refresh"\s+content="\d+;\s*url=([^"]+)"/i.exec(page);
    if (refresh) {
      const to = unescapeHtml(refresh[1]!);
      if (!back(to)) next = { url: new URL(to, next.url).href };
      continue;
    }
    const pick = o.fill(parseForms(page, next.url), page);
    if (!pick) throw new Error(`the authorization page (${res.status}) has no form this client can fill:\n${page.slice(0, 600)}`);
    const body = new URLSearchParams();
    for (const i of pick.form.inputs) if (i.name && i.type !== 'submit' && !(i.name in pick.values)) body.set(i.name, i.value);
    for (const [k, v] of Object.entries(pick.values)) body.set(k, v);
    next = pick.form.method === 'post' ? { url: pick.form.action, init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body } } : { url: `${pick.form.action}?${body}` };
  }
  if (!code) throw new Error('the browser never returned to the agent with a code');
  const tok = await fetch(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier, resource: resource.resource }),
  });
  if (tok.status !== 200) throw new Error(`the token endpoint answered ${tok.status}: ${await tok.text()}`);
  const t = (await tok.json()) as { access_token: string; refresh_token?: string };
  return { accessToken: t.access_token, refreshToken: t.refresh_token, pages };
}

// ---- record holders

async function lrsAll(base: string, query: Record<string, string> = {}, auth = LRS_BASIC): Promise<XapiStatement[]> {
  const out: XapiStatement[] = [];
  let url: string | undefined = `${base.replace(/\/+$/, '')}/statements?${new URLSearchParams({ ascending: 'true', ...query })}`;
  while (url) {
    const res = await fetch(url, { headers: { authorization: auth, 'x-experience-api-version': '1.0.3' } });
    if (!res.ok) throw new Error(`the LRS answered ${res.status} to GET statements`);
    const page = (await res.json()) as { statements: XapiStatement[]; more?: string };
    out.push(...page.statements);
    url = page.more ? new URL(page.more, base).href : undefined;
  }
  return out;
}

/** The statements of an export payload: a statement array, an xAPI StatementResult, or `{record: {statements}}`. */
export function exportedStatements(body: any): XapiStatement[] | undefined {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.statements)) return body.statements;
  if (Array.isArray(body?.record?.statements)) return body.record.statements;
  return undefined;
}

export async function fetchExport(): Promise<{ status: number; body: any }> {
  const res = await fetch(EXPORT_URL!);
  return { status: res.status, body: res.ok ? await res.json() : await res.text() };
}

// ---- the cmi5 LMS (option 1): the bundled test LRS and LMS simulator, run by this suite

export interface LrsRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | null;
}

/** The actor the LMS launches with: distinctive, so a scan can find it. */
export const LMS_ACTOR: XapiAgent = { objectType: 'Agent', account: { homePage: 'https://lms.example', name: 'lms-account-' + randomUUID().slice(0, 8) } };
export const RETURN_URL = 'https://lms.example/courses/conformance/return';
/** An extension the LMS adds to every launch's contextTemplate; every statement in that session must carry it. */
export const TEMPLATE_EXT = 'https://lms.example/xapi/extensions/tenant';
export const TEMPLATE_VALUE = 'conformance-tenant-7';

export interface Launch {
  auKey: LessonKey | 'placement';
  registration: string;
  sessionId: string;
  /** The LMS token the fetch URL hands out. */
  token: string;
  fetchUrl: string;
  /** The bridge page the browser was shown, its status and the browser that saw it. */
  page: string;
  status: number;
  browser: Jar;
}

export interface Lms {
  lrs: TestLrs;
  sim: LmsSim;
  lrsUrl: string;
  /** Every request the server under test sent to the LMS's LRS (the simulator itself talks to it in-process). */
  requests: LrsRequest[];
  launches: Launch[];
  /** Launches an AU as the LMS would, then opens the launch URL in `browser` (a fresh one by default). */
  launch(auKey: LessonKey | 'placement', o?: { registration?: string; browser?: Jar; launchMode?: 'Normal' | 'Browse' | 'Review' }): Promise<Launch>;
  close(): Promise<void>;
}

/** `authority`: the LMS's LRS records who wrote each statement (the badge class needs it, lib/test-lrs.ts). */
export async function startLms(o: { authority?: boolean } = {}): Promise<Lms> {
  const lrs = createTestLrs({ authority: o.authority });
  const requests: LrsRequest[] = [];
  const served = await serve(lrs.fetch, (req) => {
    const u = new URL(req.url);
    requests.push({ method: req.method, path: u.pathname, query: u.searchParams, authorization: req.headers.get('authorization') });
  });
  const lrsUrl = served.url + '/xapi';
  const sim = createLmsSim({
    lrs,
    lrsUrl,
    courseId: COURSE_ID,
    actor: LMS_ACTOR,
    aus: (['placement', 'intro', 'types', 'fix'] as const).map((k) => ({ auId: AU_IDS[k], url: AU_URLS[k], moveOn: k === 'placement' ? 'NotApplicable' : k === 'types' ? 'Completed' : 'CompletedAndPassed' })),
  });
  const launches: Launch[] = [];
  return {
    lrs,
    sim,
    lrsUrl,
    requests,
    launches,
    async launch(auKey, o = {}) {
      const r = await sim.launch(AU_IDS[auKey], { registration: o.registration, returnURL: RETURN_URL, launchMode: o.launchMode });
      // The LMS adds its own extension to the contextTemplate.
      const key = new URLSearchParams({ activityId: activityIds.au(AU_IDS[auKey]), agent: JSON.stringify(LMS_ACTOR), registration: r.registration, stateId: 'LMS.LaunchData' });
      const stateUrl = `${lrsUrl}/activities/state?${key}`;
      const lmsHeaders = { authorization: LRS_BASIC, 'x-experience-api-version': '1.0.3', 'content-type': 'application/json' };
      const data = await (await lrs.fetch(new Request(stateUrl, { headers: lmsHeaders }))).json();
      data.contextTemplate.extensions[TEMPLATE_EXT] = TEMPLATE_VALUE;
      await lrs.fetch(new Request(stateUrl, { method: 'PUT', headers: lmsHeaders, body: JSON.stringify(data) }));
      const browser = o.browser ?? jar();
      const res = await fetch(r.launchUrl, { headers: browser.header() ? { cookie: browser.header() } : {}, redirect: 'manual' });
      browser.take(res);
      const launch: Launch = { auKey, registration: r.registration, sessionId: r.sessionId, token: r.token, fetchUrl: new URL(r.launchUrl).searchParams.get('fetch')!, page: await res.text(), status: res.status, browser };
      launches.push(launch);
      return launch;
    },
    close: () => served.close(),
  };
}

/** The pairing code shown on a bridge page: six characters from the pairing alphabet. */
export const pairingCodeOf = (page: string) => /(?<![A-Z0-9])([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6})(?![A-Z0-9])/.exec(page.replace(/<[^>]*>/g, ' '))?.[1];

// ---- the learner: one agent connection to the course, in any custody option

export interface Learner {
  custody: Custody;
  /** The MCP endpoint and bearer token this learner's agent uses. */
  url: string;
  token?: string;
  mcp: Mcp;
  /** Calls a tool; on the practice endpoint the practice handle is added where the tool takes one. */
  call(tool: string, args?: Record<string, unknown>): Promise<Result>;
  /** Every statement the record holder keeps for this learner, in the order it took them. */
  record(): Promise<XapiStatement[]>;
  /** The practice handle (practice runs). */
  handle?: string;
  /** Option 1: the LMS and this learner's registration and launches. */
  lms?: Lms;
  registration?: string;
  close(): Promise<void>;
}

const TOOLS_IN_LESSON = new Set(['start_placement', 'next_beat', 'check_code', 'reveal_bug', 'submit_checkpoint', 'end_session']);

/**
 * A learner on the practice endpoint at `url` (default: CXM_URL in option 4). The first `start_placement` mints the
 * practice handle.
 */
export async function practiceLearner(url = MCP_URL): Promise<Learner> {
  const mcp = await connect({ url });
  const takesHandle = new Set((await mcp.tools()).filter((t) => t.inputSchema?.properties?.handle).map((t) => t.name));
  const l: Learner = {
    custody: 'practice',
    url,
    mcp,
    async call(tool, args = {}) {
      const r = await mcp.call(tool, l.handle && takesHandle.has(tool) && !('handle' in args) ? { handle: l.handle, ...args } : args);
      if (tool === 'start_placement' && !l.handle && typeof r.data?.handle === 'string') l.handle = r.data.handle;
      return r;
    },
    async record() {
      if (!l.handle) return [];
      const r = await mcp.call('get_record', { handle: l.handle });
      return r.isError ? [] : (r.data.record.statements as XapiStatement[]);
    },
    close: () => mcp.close(),
  };
  return l;
}

/** The learner behind CXM_TOKEN (options 2 and 3), starting a fresh registration: `restart_course` when one is open. */
async function tokenLearner(): Promise<Learner> {
  const mcp = await connect({ token: TOKEN });
  const restart = await mcp.call('restart_course');
  if (restart.isError && restart.data?.cxm === undefined) throw new Error('restart_course failed: ' + JSON.stringify(restart.data));
  return {
    custody: CUSTODY,
    url: MCP_URL,
    token: TOKEN,
    mcp,
    call: (tool, args) => mcp.call(tool, args),
    async record() {
      if (CUSTODY === 'author-lrs') return lrsAll(LRS_URL!);
      const { status, body } = await fetchExport();
      if (status !== 200) throw new Error(`the record export answered ${status}`);
      return exportedStatements(body) ?? [];
    },
    close: () => mcp.close(),
  };
}

/** Pairs an agent with a launch through the authorization page: the launch browser's cookie, or the typed pairing code. */
export function pair(launch: Launch, how: 'cookie' | 'code' = 'cookie'): Promise<Authorized> {
  return how === 'cookie' ? authorize({ browser: launch.browser, fill: submitPlainForm }) : authorize({ browser: jar(), fill: typePairingCode(pairingCodeOf(launch.page) ?? '') });
}

/**
 * Option 1: the agent connection behind `token`, in `registration`. Calls that answer `return-to-lms` make the LMS
 * launch the lesson they name; a lesson tool that did nothing because of it (step `return-to-lms`) is called again.
 */
export async function tokenOnLaunch(lms: Lms, token: string, registration: string): Promise<Learner> {
  const mcp = await connect({ token });
  return {
    custody: 'lms-launched',
    url: MCP_URL,
    token,
    mcp,
    lms,
    registration,
    async call(tool, args) {
      let r = await mcp.call(tool, args);
      const next = r.data?.next;
      if (next?.type === 'return-to-lms' && next.lessonKey) {
        await lms.launch(next.lessonKey, { registration });
        // A lesson tool that could not run outside the lesson's launch did nothing; it runs again in the new launch.
        if (TOOLS_IN_LESSON.has(tool) && r.data.step === 'return-to-lms') r = await mcp.call(tool, args);
      }
      return r;
    },
    record: async () => lms.lrs.statements().filter((s) => s.context?.registration === registration),
    close: () => mcp.close(),
  };
}

/** Option 1: launches the placement AU in a new registration and pairs an agent with it. */
export async function launchedLearner(lms: Lms, o: { registration?: string; pair?: 'cookie' | 'code' } = {}): Promise<Learner> {
  const registration = o.registration ?? randomUUID();
  const first = await lms.launch('placement', { registration });
  const auth = await pair(first, o.pair);
  return tokenOnLaunch(lms, auth.accessToken, registration);
}

/** A learner on CXM_URL in the custody under test, with a fresh run. Option 1 needs the LMS. */
export async function newLearner(lms?: Lms): Promise<Learner> {
  if (CUSTODY === 'practice') return practiceLearner();
  if (CUSTODY === 'lms-launched') {
    if (!lms) throw new Error('custody lms-launched needs the LMS simulator');
    return launchedLearner(lms);
  }
  return tokenLearner();
}

/** Statements that appeared in the record since `before` was read. */
export async function newSince(l: Learner, before: XapiStatement[]): Promise<XapiStatement[]> {
  const seen = new Set(before.map((s) => s.id));
  return (await l.record()).filter((s) => !seen.has(s.id));
}

// ---- walking the conformance course

export const REPLY = 'A string, because of the quotes.';

export const verbOf = (s: XapiStatement) => s.verb.id.split('/').pop()!;
export const isDefined = (s: XapiStatement) => (s.context?.contextActivities?.category ?? []).some((a) => a.id === 'https://w3id.org/xapi/cmi5/context/categories/cmi5');
export const sessionOf = (s: XapiStatement) => s.context?.extensions?.['https://w3id.org/xapi/cmi5/context/extensions/sessionid'] as string | undefined;

/** Fails with the result when a call did not succeed. */
export function ok(r: Result): Result {
  if (r.isError || r.data?.ok !== true) throw new Error(`${r.tool} failed: ${JSON.stringify(r.data ?? r.raw)}`);
  return r;
}

/** start_placement, then choose_placement at `start` with `skip`. */
export async function place(l: Learner, start: LessonKey = 'intro', skip: LessonKey[] = []): Promise<Result> {
  ok(await l.call('start_placement'));
  return ok(await l.call('choose_placement', { pathKey: 'basics', startLessonKey: start, skip, reason: 'Placement chosen by the conformance client.' }));
}

/** Calls next_beat, answering the last question when one is waiting, until the step is `stop`. */
export async function beatsUntil(l: Learner, stop: (r: Result) => boolean, max = 8): Promise<Result> {
  let reply: string | undefined;
  for (let i = 0; i < max; i++) {
    const r = ok(await l.call('next_beat', reply ? { learner_reply: reply } : {}));
    if (stop(r)) return r;
    reply = r.data.beat?.question ? REPLY : undefined;
  }
  throw new Error('next_beat never reached the expected step');
}

export const stepIs = (step: string) => (r: Result) => r.data.step === step;

/** The intro lesson from its first beat to the chosen branch. */
export async function walkIntro(l: Learner, branch: 'next' | 'ahead' | 'again' = 'next'): Promise<Result> {
  await beatsUntil(l, stepIs('checkpoint'));
  ok(await l.call('submit_checkpoint', { response: 'The first is a number and the second is a string.' }));
  return ok(await l.call('choose_branch', { branch, rationale: 'The answer names number versus string.' }));
}

/** The types lesson: its beat, a wrong fix, the right fix, then the lesson is complete. */
export async function walkTypes(l: Learner): Promise<Result> {
  await beatsUntil(l, stepIs('bug'));
  ok(await l.call('check_code', { file: 'flags.json', content: FILES.flagsBug }));
  ok(await l.call('check_code', { file: 'flags.json', content: FILES.flagsFixed }));
  return ok(await l.call('next_beat'));
}

/** The fix lesson up to its checkpoint: the beat, the bug caught (after `misses` wrong fixes). */
export async function walkFixToCheckpoint(l: Learner, misses = 0): Promise<Result> {
  await beatsUntil(l, stepIs('bug'));
  for (let i = 0; i < misses; i++) ok(await l.call('check_code', { file: 'config.json', content: FILES.configBug }));
  ok(await l.call('check_code', { file: 'config.json', content: FILES.configFixed }));
  return ok(await l.call('next_beat'));
}

/** Submits the fix checkpoint with `file` and chooses `branch`. */
export async function finishFix(l: Learner, file = FILES.configWithTimeout, branch = 'done'): Promise<Result> {
  ok(await l.call('submit_checkpoint', { response: 'timeout is a number because the program compares it.', files: { 'config.json': file } }));
  return ok(await l.call('choose_branch', { branch, rationale: 'The checks pass and the reason is right.' }));
}
