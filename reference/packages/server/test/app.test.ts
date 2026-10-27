// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CustodyOption, XapiStatement } from '@course-xapi-mcp/core';
import { checkCmi5Order } from '@course-xapi-mcp/core/xapi';
import { createLmsSim, createTestLrs } from '@course-xapi-mcp/conformance';
import type { JWK } from 'jose';
import {
  ConfigError,
  MemoryServerStore,
  createApp,
  createAppFromConfig,
  createAuthServer,
  createPracticeCustody,
  createServerKeptCustody,
  loadConfig,
  type App,
  type AppBadges,
  type AppConfig,
  type ServerStore,
} from '../src/index.ts';
import { startFakeIdp, type FakeIdp } from './fake-idp.ts';
import { loadExample, teachExample } from './helpers.ts';

const PUBLIC = 'http://127.0.0.1:8787';
const HOST = '127.0.0.1:8787';
const REDIRECT = 'http://127.0.0.1:33418/callback';
const LRS_URL = 'http://127.0.0.1:9/xapi';
const LRS_CREDENTIALS = { key: 'lrs-key-app', secret: 'lrs-secret-app' };

let idp: FakeIdp;
beforeAll(async () => {
  idp = await startFakeIdp();
});
afterAll(() => idp.close());

let apps: App[] = [];
let clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
  clients = [];
});

const ENV = {
  CXM_PUBLIC_URL: PUBLIC,
  CXM_LRS_ENDPOINT: 'http://lrs.test/xapi',
  CXM_LRS_KEY: LRS_CREDENTIALS.key,
  CXM_LRS_SECRET: LRS_CREDENTIALS.secret,
};

function config(env: Record<string, string | undefined> = {}): AppConfig {
  const c = loadConfig({ ...ENV, CXM_OIDC_ISSUER: idp.issuer, CXM_OIDC_CLIENT_ID: idp.clientId, CXM_OIDC_CLIENT_SECRET: idp.clientSecret, ...env });
  if ('errors' in c) throw new Error(c.errors.join('\n'));
  return c;
}

async function appFor(custody: CustodyOption, o: Parameters<typeof createAppFromConfig>[1] = {}) {
  const course = { ...(await loadExample()), custody, ...(custody === 'lms-launched' ? { allowPractice: false } : {}) };
  const app = await createAppFromConfig(config(), { course, ...o });
  apps.push(app);
  return app;
}

/** A browser-ish cookie jar for one learner. */
function jar() {
  const kept = new Map<string, string>();
  return {
    take(res: Response) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair!.indexOf('=');
        kept.set(pair!.slice(0, i), pair!.slice(i + 1));
      }
    },
    header: () => [...kept].map(([k, v]) => `${k}=${v}`).join('; '),
    get: (name: string) => kept.get(name),
  };
}
type Jar = ReturnType<typeof jar>;

/** A request to the app as the Node adapter would build it, with the Host header and the browser's cookies. */
function req(path: string, init: RequestInit & { cookies?: Jar } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('host', HOST);
  if (init.cookies) headers.set('cookie', init.cookies.header());
  return new Request(new URL(path, PUBLIC), { ...init, headers });
}
/** A form posted from one of the server's own pages: they send no referrer, so the browser sends `Origin: null`. */
const formPost = (path: string, body: Record<string, string>, cookies: Jar) =>
  req(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' }, body: new URLSearchParams(body), cookies });

const requestId = (page: string) => /name="request_id" value="([^"]+)"/.exec(page)![1]!;
const csrfOf = (page: string) => /name="csrf" value="([^"]+)"/.exec(page)?.[1];
const codeFrom = (page: string) => {
  const m = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(page);
  if (!m) throw new Error('no redirect in page: ' + page.slice(0, 400));
  return new URL(m[1]!.replaceAll('&amp;', '&')).searchParams.get('code')!;
};

/** The agent registers and opens the authorize page in the learner's browser; `finish` trades the code for a token. */
async function startSignIn(app: App, browser: Jar) {
  const reg = await app.fetch(req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'App test agent' }) }));
  expect(reg.status).toBe(201);
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', resource: PUBLIC + '/mcp', scope: 'cxm:learn' });
  const page = await app.fetch(req('/oauth/authorize?' + query, { cookies: browser }));
  expect(page.status).toBe(200);
  browser.take(page);
  const finish = async (signedIn: Response) => {
    browser.take(signedIn);
    const code = codeFrom(await signedIn.text());
    const tok = await app.fetch(req('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: PUBLIC + '/mcp' }) }));
    expect(tok.status).toBe(200);
    return ((await tok.json()) as { access_token: string }).access_token;
  };
  return { id: requestId(await page.text()), finish };
}

/** Option 3: signs up through the accounts page; returns the access token. */
async function signUp(app: App, browser: Jar, username = 'ada.l') {
  const s = await startSignIn(app, browser);
  return s.finish(await app.fetch(formPost('/oauth/login', { request_id: s.id, action: 'signup', username, password: 'correct horse battery' }, browser)));
}

/** An SDK client over the app's fetch handler (no network), as the agent with this bearer token. */
async function mcp(app: App, path: '/mcp' | '/mcp/practice', token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(PUBLIC + path), {
    fetch: (url, init) => {
      const r = req(String(url), init as RequestInit);
      if (token) r.headers.set('authorization', `Bearer ${token}`);
      return app.fetch(r);
    },
  });
  const client = new Client({ name: 'app-test-client', version: '0.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(transport);
  clients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), data: r.structuredContent as any, raw: r };
  };
}

describe('configuration', () => {
  it('reads the defaults', () => {
    const c = loadConfig({});
    if ('errors' in c) throw new Error(c.errors.join());
    expect(c).toMatchObject({ publicUrl: 'http://127.0.0.1:8787', port: 8787, allowedOrigins: [], retention: 'Records are kept until you delete them.' });
    expect(c.packagePath).toMatch(/examples\/json-basics$/);
    expect(c.signingKey).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    expect(c.warnings.join()).toMatch(/CXM_SIGNING_KEY/);
    expect(c.dataDir).toBeUndefined();
  });

  it('names each missing LRS variable for custody author-lrs, and the missing OIDC variables', async () => {
    const r = loadConfig({ CXM_LRS_ENDPOINT: 'https://lrs.example/xapi', CXM_LRS_KEY: 'k' }, { custody: 'author-lrs' });
    expect('errors' in r && r.errors).toEqual([
      'CXM_LRS_SECRET is required for custody author-lrs',
      'CXM_OIDC_ISSUER is required for custody author-lrs',
      'CXM_OIDC_CLIENT_ID is required for custody author-lrs',
    ]);
    const c = loadConfig({ CXM_OIDC_ISSUER: idp.issuer, CXM_OIDC_CLIENT_ID: idp.clientId });
    if ('errors' in c) throw new Error(c.errors.join());
    const course = { ...(await loadExample()), custody: 'author-lrs' as const };
    const err = await createAppFromConfig(c, { course }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.errors).toEqual(['CXM_LRS_ENDPOINT', 'CXM_LRS_KEY', 'CXM_LRS_SECRET'].map((n) => `${n} is required for custody author-lrs`));
  });

  it('does not echo credentials from a malformed URL', () => {
    const r = loadConfig({ CXM_PUBLIC_URL: 'https://admin:hunter2@course.example/x', CXM_LRS_ENDPOINT: 'ftp://key:s3cret@lrs.example/xapi' });
    expect('errors' in r && r.errors).toHaveLength(2);
    expect(JSON.stringify(r)).not.toMatch(/hunter2|s3cret|admin|key:/);
  });

  it('refuses bad values', () => {
    const r = loadConfig({ PORT: 'eighty', CXM_PUBLIC_URL: 'https://course.example/sub', CXM_SIGNING_KEY: '{"kty":"RSA"}', CXM_LRS_VERSION: '1.0', CXM_ALLOWED_ORIGINS: 'nope' });
    expect('errors' in r && r.errors.map((e) => e.split(' ')[0])).toEqual(['PORT', 'CXM_PUBLIC_URL', 'CXM_LRS_VERSION', 'CXM_SIGNING_KEY', 'CXM_ALLOWED_ORIGINS']);
  });
});

describe('composition', () => {
  it.each(['lms-launched', 'author-lrs', 'server-kept', 'practice'] as const)('custody %s starts from config with the example', async (custody) => {
    const app = await appFor(custody);
    const meta = await app.fetch(req('/.well-known/oauth-protected-resource/mcp'));
    if (custody === 'practice') {
      expect(meta.status).toBe(404);
    } else {
      expect(meta.status).toBe(200);
      expect(await meta.json()).toMatchObject({ resource: PUBLIC + '/mcp', authorization_servers: [PUBLIC] });
      // The official endpoint wants a token.
      expect((await app.fetch(req('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401);
    }
    const about = (await (await app.fetch(req('/'))).json()) as Record<string, unknown>;
    expect(about).toMatchObject({ custody, course: { title: app.course.title } });
    expect((await app.fetch(req('/no-such-page'))).status).toBe(404);
    expect((await app.fetch(req('/cmi5/launch?au=placement'))).status).toBe(custody === 'lms-launched' ? 400 : 404);
  });

  it('refuses a foreign Origin everywhere, Origin null on the MCP endpoints, and a foreign Host on a loopback bind', async () => {
    const app = await appFor('server-kept');
    const evil = { origin: 'https://evil.example' };
    expect((await app.fetch(req('/', { headers: evil }))).status).toBe(403);
    expect((await app.fetch(req('/mcp/practice', { method: 'POST', headers: evil, body: '{}' }))).status).toBe(403);
    for (const path of ['/mcp', '/mcp/practice']) expect((await app.fetch(req(path, { method: 'POST', headers: { origin: 'null' }, body: '{}' }))).status).toBe(403);
    expect((await app.fetch(req('/', { headers: { origin: PUBLIC } }))).status).toBe(200);
    const rebound = new Request(PUBLIC + '/', { headers: { host: 'attacker.example:8787' } });
    expect((await app.fetch(rebound)).status).toBe(403);
    const allowed = await createAppFromConfig(config({ CXM_ALLOWED_ORIGINS: 'https://inspector.example' }), { course: app.course });
    apps.push(allowed);
    expect((await allowed.fetch(req('/', { headers: { origin: 'https://inspector.example' } }))).status).toBe(200);
  });

  it("the bin's GET / reports the course and both MCP URLs", async () => {
    const bin = await startBin();
    try {
      await vi.waitFor(() => expect(bin.stderr()).toMatch(/CXM_SIGNING_KEY is not set/));
      expect(bin.stderr()).not.toMatch(/held in memory/);
      const about = await (await fetch(bin.base + '/')).json();
      expect(about).toMatchObject({
        course: { id: 'https://course-xapi-mcp.sqwrlz.com/examples/json-basics', title: expect.any(String) },
        custody: 'server-kept',
        official: true,
        mcp: bin.base + '/mcp',
        practice: bin.base + '/mcp/practice',
      });
    } finally {
      bin.stop();
    }
  });

  it('the bin refuses absolute-form and //host request targets, so the bridge never takes them for loopback', async () => {
    const bin = await startBin();
    try {
      const host = `127.0.0.1:${bin.port}`;
      for (const target of [`http://127.0.0.1:9/cmi5/launch?au=placement`, `//127.0.0.1:9/cmi5/launch?au=placement`]) {
        expect(await rawGet(bin.port, target, host)).toMatch(/^HTTP\/1\.1 400 [\s\S]*Bad request target/);
      }
      // An origin-form target is served as usual.
      expect(await rawGet(bin.port, '/', host)).toMatch(/^HTTP\/1\.1 200 /);
    } finally {
      bin.stop();
    }
  });

  it('the bin warns that accounts are held in memory when CXM_DATA_DIR is set with custody server-kept', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cxm-data-'));
    const bin = await startBin({ CXM_DATA_DIR: dir });
    try {
      await vi.waitFor(() => expect(bin.stderr()).toMatch(/CXM_DATA_DIR .*accounts, clients and refresh tokens are held in memory.*cannot be reached/));
    } finally {
      bin.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Starts the reference binary on a free loopback port, with no CXM_* variables but `env`. */
async function startBin(env: Record<string, string> = {}) {
  const port = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CXM_')));
  const bin = new URL('../src/bin.ts', import.meta.url).pathname;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', bin], { env: { ...clean, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d) => String(d).includes(`(pid ${child.pid})`) && resolve());
      child.on('exit', (code) => reject(new Error(`bin exited ${code}: ${err}`)));
    });
  } catch (e) {
    child.kill('SIGTERM');
    throw e;
  }
  return { port, base: `http://127.0.0.1:${port}`, stderr: () => err, stop: () => child.kill('SIGTERM') };
}

/** Sends one raw HTTP/1.1 GET with exactly this request target, and returns the response text. */
function rawGet(port: number, target: string, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    const sock = connect(port, '127.0.0.1', () => sock.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    sock.on('data', (d) => (out += d));
    sock.on('end', () => resolve(out));
    sock.on('error', reject);
  });
}

describe('record pages', () => {
  it('/record/export.json without a browser session is 401', async () => {
    for (const custody of ['server-kept', 'author-lrs'] as const) {
      const app = await appFor(custody);
      expect((await app.fetch(req('/record/export.json'))).status).toBe(401);
      expect((await app.fetch(req('/record'))).status).toBe(401);
    }
    const practice = await appFor('practice');
    expect((await practice.fetch(req('/record'))).status).toBe(404);
  });

  it('serves the retention policy in option 3, but not in option 2', async () => {
    const kept = await appFor('server-kept');
    const policy = await kept.fetch(req('/record/policy'));
    expect(policy.status).toBe(200);
    expect(await policy.text()).toContain('Records are kept until you delete them.');
    expect((await (await appFor('author-lrs')).fetch(req('/record/policy'))).status).toBe(404);
  });

  it('the option-3 delete form refuses a missing or wrong CSRF token', async () => {
    const app = await appFor('server-kept');
    const browser = jar();
    const token = await signUp(app, browser);
    const call = await mcp(app, '/mcp', token);
    await call('start_placement');
    await call('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New to JSON.' });
    const view = await app.fetch(req('/record', { cookies: browser }));
    expect(view.status).toBe(200);
    expect(csrfOf(await view.text())).toBeTruthy();
    for (const body of [{ action: 'delete' }, { action: 'delete', csrf: 'forged' }] as Record<string, string>[]) {
      expect((await app.fetch(formPost('/record', body, browser))).status).toBe(403);
    }
    const exported = (await (await app.fetch(req('/record/export.json', { cookies: browser }))).json()) as { record: { statements: unknown[] } };
    expect(exported.record.statements.length).toBeGreaterThan(0);
  });
});

describe('record erase and tool calls', () => {
  it('an erase waits for a tool call in flight, so neither state nor statements are left behind', async () => {
    const course = await loadExample();
    const inner = new MemoryServerStore();
    let slow = false;
    let entered!: () => void;
    const inAppend = new Promise<void>((r) => (entered = r));
    // The tool call's deliver stalls after the call has saved its state; an erase must not slip in there.
    const store: ServerStore = {
      getState: (s) => inner.getState(s),
      putState: (s, st, e) => inner.putState(s, st, e),
      append: async (s, st) => {
        if (slow) {
          entered();
          await new Promise((r) => setTimeout(r, 50));
        }
        return inner.append(s, st);
      },
      statements: (s) => inner.statements(s),
      deleteLearner: (s) => inner.deleteLearner(s),
    };
    const signingKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as JWK;
    const revoked: string[] = [];
    const app = createApp({
      course,
      publicUrl: PUBLIC,
      custody: createServerKeptCustody({ store, publicUrl: PUBLIC, courseTitle: course.title }),
      practice: createPracticeCustody({ courseId: course.id }),
      auth: createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'accounts' }),
      serverStore: store,
      badges: { claimPage: PUBLIC + '/badges/claim', summaries: async () => [], onAwards: async () => {}, routes: async () => undefined, revokeLearner: async (s) => (revoked.push(s), 0) },
    });
    apps.push(app);
    const browser = jar();
    const call = await mcp(app, '/mcp', await signUp(app, browser));
    await call('start_placement');
    await call('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New to JSON.' });
    const csrf = csrfOf(await (await app.fetch(req('/record', { cookies: browser }))).text())!;

    slow = true;
    const inFlight = call('next_beat');
    await inAppend;
    const erased = await app.fetch(formPost('/record', { action: 'delete', csrf }, browser));
    expect(erased.status).toBe(200);
    await inFlight;
    expect(revoked).toHaveLength(1);
    expect(await inner.getState(revoked[0]!)).toBeUndefined();
    expect(await inner.statements(revoked[0]!)).toEqual([]);
  });
});

describe('end to end', () => {
  it('option 3: sign-up through the auth pages, a whole course over MCP, export in cmi5 order, then delete (revoking badges)', async () => {
    const revoked: string[] = [];
    const badges: AppBadges = {
      claimPage: PUBLIC + '/badges/claim',
      summaries: async () => [],
      onAwards: async () => {},
      routes: async (r) => (new URL(r.url).pathname === '/badges/claim' ? new Response('claim page') : undefined),
      revokeLearner: async (subject) => (revoked.push(subject), 1),
    };
    const app = await appFor('server-kept', { badges: () => badges });
    expect(await (await app.fetch(req('/badges/claim'))).text()).toBe('claim page');
    const browser = jar();
    const token = await signUp(app, browser);
    const call = await mcp(app, '/mcp', token);
    expect((await call('get_status')).data).toMatchObject({ custody: 'server-kept', official: true });
    expect((await call('start_placement')).isError).toBe(false);
    await teachExample(call);
    expect((await call('get_status')).data.ok).toBe(true);

    const res = await app.fetch(req('/record/export.json', { cookies: browser }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment/);
    const statements = ((await res.json()) as { record: { statements: XapiStatement[] } }).record.statements;
    const verbs = statements.map((s) => s.verb.id.split('/').pop());
    expect(verbs).toEqual(expect.arrayContaining(['passed', 'satisfied']));
    expect(checkCmi5Order(statements)).toEqual([]);

    const view = await (await app.fetch(req('/record', { cookies: browser }))).text();
    const deleted = await app.fetch(formPost('/record', { action: 'delete', csrf: csrfOf(view)! }, browser));
    expect(deleted.status).toBe(200);
    expect(revoked).toHaveLength(1);
    const after = (await (await app.fetch(req('/record/export.json', { cookies: browser }))).json()) as { record: { statements: unknown[] } };
    expect(after.record.statements).toEqual([]);
    expect((await call('get_status')).data.ok).toBe(true);
  });

  it('option 1: a simulator launch, the pairing code, MCP calls; the statements land in the LMS in cmi5 order', async () => {
    const lrs = createTestLrs();
    const lrsFetch = ((input: RequestInfo | URL, init?: RequestInit) => lrs.fetch(new Request(input, init))) as typeof fetch;
    const course = { ...(await loadExample()), custody: 'lms-launched' as const, allowPractice: false };
    const auOf = (key: string) => (key === 'placement' ? course.placement : course.lessons[key]!);
    const sim = createLmsSim({
      lrs,
      lrsUrl: LRS_URL,
      courseId: course.id,
      aus: ['placement', 'what-is-json', 'fix-the-config'].map((k) => ({ auId: auOf(k).auId, url: auOf(k).url, moveOn: k === 'placement' ? ('NotApplicable' as const) : ('CompletedAndPassed' as const) })),
    });
    // A second ahead of the simulator's own stamps, so statements stay ordered however slow the run.
    const now = () => Date.now() + 1000;
    const app = await createAppFromConfig(config(), { course, lrsFetch, now });
    apps.push(app);

    /** The LMS opens the lesson; the learner reads the pairing code and types it on the sign-in page. */
    const pairedSession = async (key: string, registration?: string) => {
      const l = await sim.launch(auOf(key).auId, { returnURL: 'https://lms.example/course', registration });
      const launched = await app.fetch(req(new URL(l.launchUrl).pathname + new URL(l.launchUrl).search));
      expect(launched.status).toBe(200);
      const code = /class="code">([A-Z0-9]{6})</.exec(await launched.text())![1]!;
      // The agent's browser is another one: no launch cookie, so the pairing code it is.
      const browser = jar();
      const s = await startSignIn(app, browser);
      const token = await s.finish(await app.fetch(formPost('/oauth/authorize', { request_id: s.id, pairing_code: code }, browser)));
      return { ...l, call: await mcp(app, '/mcp', token) };
    };

    const placement = await pairedSession('placement');
    expect((await placement.call('get_status')).data).toMatchObject({ custody: 'lms-launched', official: true });
    await placement.call('start_placement');
    const placed = await placement.call('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New to JSON.' });
    expect(placed.data).toMatchObject({ ok: true, next: { type: 'return-to-lms', lessonKey: 'what-is-json' }, returnURL: 'https://lms.example/course' });

    const lesson = await pairedSession('what-is-json', placement.registration);
    expect((await lesson.call('next_beat')).data.step).toBe('beat');
    await lesson.call('next_beat', { learner_reply: '"42" is a string.' });
    expect((await lesson.call('end_session')).isError).toBe(false);

    const statements = lrs.statements();
    const verbs = statements.map((s) => s.verb.id.split('/').pop());
    expect(verbs.filter((v) => v === 'initialized')).toHaveLength(2);
    expect(verbs.filter((v) => v === 'terminated')).toHaveLength(2);
    expect(statements.every((s) => s.context?.registration === placement.registration)).toBe(true);
    expect(sim.problems()).toEqual([]);
  });
});
