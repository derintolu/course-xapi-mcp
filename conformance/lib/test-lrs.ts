// SPDX-License-Identifier: Apache-2.0
// An in-memory xAPI LRS for tests, written as web-standard fetch handlers; `listen` wraps them in node:http.
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { actorKey } from '@course-xapi-mcp/core';
import { validateStatement } from '@course-xapi-mcp/core/xapi';
import type { XapiAgent, XapiStatement } from '@course-xapi-mcp/core';

export type XapiVersion = '1.0.3' | '2.0.0';

export interface TestLrsOptions {
  /** The xAPI versions the LRS accepts in `X-Experience-API-Version`. Default both. A `1.0.x` header counts as 1.0.3. */
  versions?: XapiVersion[];
  /** Basic credentials the LRS accepts. Default one pair, `test` / `test`. */
  credentials?: { key: string; secret: string }[];
}

export interface TestLrs {
  fetch(req: Request): Promise<Response>;
  /** Serves `fetch` on 127.0.0.1 and returns the base URL. */
  listen(port?: number): Promise<string>;
  close(): Promise<void>;
  /** Stored statements in the order they were accepted. */
  statements(): XapiStatement[];
  /** Accepts `Authorization: Basic <token>` with this exact token. */
  addToken(token: string): void;
  /** Answers the next `n` requests (any route) with `status` and no body. */
  failNext(n: number, status: number): void;
  /** Serves a cmi5 fetch URL at `<base>/cmi5/fetch/<id>`: the first POST returns `token` and makes it a valid credential, later POSTs return error-code 1. */
  registerFetch(id: string, token: string): void;
  /** Clears statements, documents, tokens, fetch registrations and queued failures. Credentials and versions stay. */
  reset(): void;
}

interface Doc {
  body: string;
  contentType: string;
  etag: string;
}

const PAGE_MAX = 100;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const text = (status: number, message: string) => new Response(message, { status, headers: { 'content-type': 'text/plain' } });

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const etagOf = (body: string) => `"${createHash('sha1').update(body).digest('hex')}"`;
const unquote = (s: string) => s.trim().replace(/^W\//, '').replace(/^"|"$/g, '');

export function createTestLrs(o: TestLrsOptions = {}): TestLrs {
  const versions = o.versions ?? ['1.0.3', '2.0.0'];
  const credentials = o.credentials ?? [{ key: 'test', secret: 'test' }];
  const basic = new Set(credentials.map((c) => btoa(`${c.key}:${c.secret}`)));
  let tokens = new Set<string>();
  let fetches = new Map<string, { token: string; used: boolean }>();
  let stored: XapiStatement[] = [];
  let byId = new Map<string, XapiStatement>();
  let docs = new Map<string, Doc>();
  let failures: { n: number; status: number } | undefined;
  let server: Server | undefined;

  function authorized(req: Request): boolean {
    const m = /^Basic\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
    return !!m && (tokens.has(m[1]) || basic.has(m[1]));
  }

  function versionOk(req: Request): boolean {
    const v = req.headers.get('x-experience-api-version');
    if (!v) return false;
    return versions.includes(/^1\.0(\.\d+)?$/.test(v) ? '1.0.3' : (v as XapiVersion));
  }

  async function serveFetch(req: Request, id: string): Promise<Response> {
    const reg = fetches.get(id);
    if (!reg) return text(404, 'unknown fetch url');
    if (req.method !== 'POST') return text(405, 'POST only');
    if (reg.used) return json({ 'error-code': '1', 'error-text': 'already in use' });
    reg.used = true;
    tokens.add(reg.token);
    return json({ 'auth-token': reg.token });
  }

  // Statements

  function filtered(q: URLSearchParams): XapiStatement[] {
    let list = [...stored];
    const agent = q.get('agent');
    if (agent) {
      let key: string;
      try {
        key = actorKey(JSON.parse(agent) as XapiAgent);
      } catch {
        return [];
      }
      list = list.filter((s) => {
        try {
          return actorKey(s.actor) === key;
        } catch {
          return false;
        }
      });
    }
    const verb = q.get('verb');
    if (verb) list = list.filter((s) => s.verb.id === verb);
    const activity = q.get('activity');
    if (activity) list = list.filter((s) => s.object.id === activity);
    const registration = q.get('registration');
    if (registration) list = list.filter((s) => s.context?.registration === registration);
    return q.get('ascending') === 'true' ? list : list.reverse();
  }

  function page(url: URL, q: URLSearchParams, offset: number): Response {
    const list = filtered(q);
    const asked = Number(q.get('limit') ?? 0);
    const limit = asked > 0 ? Math.min(asked, PAGE_MAX) : PAGE_MAX;
    const slice = list.slice(offset, offset + limit);
    const more = offset + limit < list.length ? `${url.pathname}?more=${Buffer.from(JSON.stringify({ q: q.toString(), offset: offset + limit })).toString('base64url')}` : '';
    return json({ statements: slice, more });
  }

  function getStatements(url: URL): Response {
    const q = url.searchParams;
    const more = q.get('more');
    if (more) {
      try {
        const m = JSON.parse(Buffer.from(more, 'base64url').toString()) as { q: string; offset: number };
        return page(url, new URLSearchParams(m.q), m.offset);
      } catch {
        return text(400, 'bad "more" token');
      }
    }
    const id = q.get('statementId');
    if (id) {
      const s = byId.get(id);
      return s ? json(s) : text(404, 'no such statement');
    }
    return page(url, q, 0);
  }

  function accept(list: unknown[]): Response | string[] {
    const ids: string[] = [];
    const fresh = new Map<string, XapiStatement>();
    for (const raw of list) {
      const s = raw as XapiStatement;
      if (s && typeof s === 'object' && !Array.isArray(s) && s.id === undefined) s.id = randomUUID();
      const problems = validateStatement(s);
      if (problems.length) return text(400, `invalid statement: ${problems.join('; ')}`);
      const had = byId.get(s.id) ?? fresh.get(s.id);
      if (had && canonical(had) !== canonical(s)) return text(409, `statement ${s.id} exists with different content`);
      if (!had) fresh.set(s.id, s);
      ids.push(s.id);
    }
    for (const [id, s] of fresh) {
      stored.push(s);
      byId.set(id, s);
    }
    return ids;
  }

  async function statements(req: Request, url: URL): Promise<Response> {
    if (req.method === 'GET') return getStatements(url);
    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return text(400, 'body is not JSON');
    }
    if (req.method === 'PUT') {
      const id = url.searchParams.get('statementId');
      if (!id) return text(400, 'statementId is required');
      if (!body || typeof body !== 'object' || Array.isArray(body)) return text(400, 'body must be one statement');
      const s = body as XapiStatement;
      if (s.id !== undefined && s.id !== id) return text(400, 'statement id does not match statementId');
      s.id = id;
      const r = accept([s]);
      return Array.isArray(r) ? new Response(null, { status: 204 }) : r;
    }
    if (req.method === 'POST') {
      const r = accept(Array.isArray(body) ? body : [body]);
      return Array.isArray(r) ? json(r) : r;
    }
    return text(405, 'method not allowed');
  }

  // Documents: activities/state and agents/profile

  function docKey(kind: 'state' | 'profile', q: URLSearchParams): { key: string; prefix: string; id: string | null } | Response {
    const agent = q.get('agent');
    if (!agent) return text(400, 'agent is required');
    let who: string;
    try {
      who = actorKey(JSON.parse(agent) as XapiAgent);
    } catch {
      return text(400, 'agent is not a valid Agent');
    }
    const scope = kind === 'state' ? [q.get('activityId'), who, q.get('registration') ?? ''] : [who];
    if (kind === 'state' && !q.get('activityId')) return text(400, 'activityId is required');
    const id = q.get(kind === 'state' ? 'stateId' : 'profileId');
    const prefix = JSON.stringify([kind, ...scope]);
    return { key: JSON.stringify([kind, ...scope, id]), prefix: prefix.slice(0, -1) + ',', id };
  }

  async function documents(kind: 'state' | 'profile', req: Request, url: URL): Promise<Response> {
    const k = docKey(kind, url.searchParams);
    if (k instanceof Response) return k;
    const existing = docs.get(k.key);
    const idName = kind === 'state' ? 'stateId' : 'profileId';
    const preconditions = (): Response | undefined => {
      const ifMatch = req.headers.get('if-match');
      const ifNone = req.headers.get('if-none-match');
      if (ifMatch && ifMatch.trim() !== '*' && (!existing || unquote(ifMatch) !== unquote(existing.etag))) return text(412, 'If-Match does not match');
      if (ifMatch && ifMatch.trim() === '*' && !existing) return text(412, 'If-Match: * on a missing document');
      if (ifNone && ifNone.trim() === '*' && existing) return text(412, 'If-None-Match: * on an existing document');
      return undefined;
    };

    if (req.method === 'GET') {
      if (k.id === null) {
        const ids = [...docs.keys()].filter((key) => key.startsWith(k.prefix)).map((key) => (JSON.parse(key) as string[]).at(-1));
        return json(ids);
      }
      return existing ? new Response(existing.body, { status: 200, headers: { 'content-type': existing.contentType, etag: existing.etag } }) : text(404, 'no such document');
    }
    if (req.method === 'PUT') {
      if (k.id === null) return text(400, `${idName} is required`);
      const failed = preconditions();
      if (failed) return failed;
      const body = await req.text();
      const doc = { body, contentType: req.headers.get('content-type') ?? 'application/octet-stream', etag: etagOf(body) };
      docs.set(k.key, doc);
      return new Response(null, { status: 204, headers: { etag: doc.etag } });
    }
    if (req.method === 'DELETE') {
      if (k.id === null) {
        if (kind === 'profile') return text(400, 'profileId is required');
        for (const key of [...docs.keys()]) if (key.startsWith(k.prefix)) docs.delete(key);
        return new Response(null, { status: 204 });
      }
      const failed = preconditions();
      if (failed) return failed;
      docs.delete(k.key);
      return new Response(null, { status: 204 });
    }
    return text(405, 'method not allowed');
  }

  async function handle(req: Request): Promise<Response> {
    if (failures && failures.n > 0) {
      failures.n--;
      return new Response(null, { status: failures.status });
    }
    const url = new URL(req.url);
    const fetchId = /\/cmi5\/fetch\/([^/]+)\/?$/.exec(url.pathname);
    if (fetchId) return serveFetch(req, decodeURIComponent(fetchId[1]));

    if (!authorized(req)) return new Response('credentials required', { status: 401, headers: { 'www-authenticate': 'Basic realm="test-lrs"' } });
    if (!versionOk(req)) return text(400, `X-Experience-API-Version must be one of ${versions.join(', ')}`);
    const headers = { 'x-experience-api-version': versions.includes('2.0.0') && req.headers.get('x-experience-api-version') === '2.0.0' ? '2.0.0' : '1.0.3' };
    const route = /\/(about|statements|activities\/state|agents\/profile)\/?$/.exec(url.pathname)?.[1];
    let res: Response;
    switch (route) {
      case 'about':
        res = req.method === 'GET' ? json({ version: versions }) : text(405, 'method not allowed');
        break;
      case 'statements':
        res = await statements(req, url);
        break;
      case 'activities/state':
        res = await documents('state', req, url);
        break;
      case 'agents/profile':
        res = await documents('profile', req, url);
        break;
      default:
        res = text(404, 'not found');
    }
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  }

  async function toRequest(msg: IncomingMessage, base: string): Promise<Request> {
    const headers = new Headers();
    for (const [k, v] of Object.entries(msg.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const method = msg.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD') return new Request(base + (msg.url ?? '/'), { method, headers });
    const chunks: Buffer[] = [];
    for await (const c of msg) chunks.push(c as Buffer);
    return new Request(base + (msg.url ?? '/'), { method, headers, body: Buffer.concat(chunks) });
  }

  return {
    fetch: handle,
    async listen(port = 0) {
      if (server) throw new Error('already listening');
      const s = createServer((msg, out) => {
        void (async () => {
          const res = await handle(await toRequest(msg, `http://${msg.headers.host ?? '127.0.0.1'}`));
          out.writeHead(res.status, Object.fromEntries(res.headers));
          out.end(Buffer.from(await res.arrayBuffer()));
        })().catch((e: unknown) => {
          out.writeHead(500).end(String(e));
        });
      });
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(port, '127.0.0.1', resolve);
      });
      server = s;
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    },
    async close() {
      const s = server;
      server = undefined;
      if (!s) return;
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    },
    statements: () => [...stored],
    addToken: (t) => void tokens.add(t),
    failNext: (n, status) => void (failures = { n, status }),
    registerFetch: (id, token) => void fetches.set(id, { token, used: false }),
    reset() {
      stored = [];
      byId = new Map();
      docs = new Map();
      tokens = new Set();
      fetches = new Map();
      failures = undefined;
    },
  };
}
