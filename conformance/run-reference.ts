// SPDX-License-Identifier: Apache-2.0
// Runs the course server class (one profile per custody option), the launch bridge class and the badge issuer class
// against the reference server, in-process: `npm run conformance:reference`. For each option it starts the reference
// app on a loopback port with the conformance course, obtains a bearer token through the app's own sign-in pages
// (options 2 and 3), and runs the classes in a vitest child process with the CXM_* environment the suite reads
// (conformance/README.md). This is the only conformance file that may import the reference server.
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createAppFromConfig, loadConfig, loadCourse, type App } from '../reference/packages/server/src/index.ts';
import { badgesFromConfig } from '../reference/packages/server/src/badges/service.ts';
import { startFakeIdp } from '../reference/packages/server/test/fake-idp.ts';
import { createTestLrs } from './lib/index.ts';
import { authorize, jar, serve, type Custody, type FormFill } from './server/client.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const FIXTURE = ROOT + 'conformance/fixtures/course';
const VITEST = ROOT + 'node_modules/vitest/vitest.mjs';
/**
 * Checks the reference is known to fail (conformance/README.md, CXM_KNOWN_GAPS), each with the reason; they run as
 * skipped tests named with the reason. None are open now; add an entry here, with its reason, for a gap that opens.
 */
const KNOWN_GAPS: Partial<Record<Custody, Record<string, string>>> = {};
const PROFILES: { custody: Custody; classes: string[] }[] = [
  { custody: 'practice', classes: ['conformance/server'] },
  { custody: 'server-kept', classes: ['conformance/server'] },
  { custody: 'author-lrs', classes: ['conformance/server'] },
  { custody: 'lms-launched', classes: ['conformance/server', 'conformance/bridge'] },
];
/** The badge issuer class runs in every option; in option 4 it checks that practice earns nothing. */
const BADGE_PROFILES: Custody[] = ['practice', 'server-kept', 'author-lrs', 'lms-launched'];
/** Badge checks the reference is known to fail, with the reason. None are open now; add an entry for a gap that opens. */
const BADGE_KNOWN_GAPS: Partial<Record<Custody, Record<string, string>>> = {};

/** The accounts page (option 3): the "Create an account" form. */
const signUp: FormFill = (forms) => {
  const form = forms.find((f) => f.inputs.some((i) => i.name === 'action' && i.value === 'signup'));
  return form && { form, values: { username: `conformance.${Date.now().toString(36)}`, password: 'conformance passphrase 0.2' } };
};
/** The consent page after the identity provider (option 2): "Allow". */
const allow: FormFill = (forms) => {
  const form = forms.find((f) => f.inputs.some((i) => i.name === 'action' && i.value === 'allow'));
  return form && { form, values: {} };
};

/** A loopback port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function runVitest(files: string[], env: Record<string, string>): Promise<number> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CXM_')));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITEST, 'run', '--config', 'conformance/vitest.config.ts', '--reporter=verbose', ...files], { cwd: ROOT, env: { ...inherited, ...env }, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function runProfile(custody: Custody, classes: string[]): Promise<number> {
  const closers: (() => Promise<unknown>)[] = [];
  try {
    let app: App | undefined;
    const http = await serve((req) => app!.fetch(req));
    closers.push(() => http.close());
    const port = new URL(http.url).port;
    const vars: Record<string, string> = { CXM_PUBLIC_URL: http.url, PORT: port, CXM_PACKAGE: FIXTURE };
    const env: Record<string, string> = { CXM_URL: http.url + '/mcp', CXM_CUSTODY: custody, CXM_KNOWN_GAPS: JSON.stringify(KNOWN_GAPS[custody] ?? {}) };

    if (custody === 'author-lrs') {
      // It records an authority on every statement, as an LRS does, so CXM-SEC-004 can check none reaches the agent.
      const lrs = createTestLrs({ authority: true });
      const lrsUrl = (await lrs.listen()) + '/xapi';
      closers.push(() => lrs.close());
      const idp = await startFakeIdp();
      closers.push(() => idp.close());
      Object.assign(vars, { CXM_LRS_ENDPOINT: lrsUrl, CXM_LRS_KEY: 'test', CXM_LRS_SECRET: 'test', CXM_OIDC_ISSUER: idp.issuer, CXM_OIDC_CLIENT_ID: idp.clientId, CXM_OIDC_CLIENT_SECRET: idp.clientSecret });
      env.CXM_LRS_URL = lrsUrl;
      // Option 2 has no launch to fall back on: the author's LRS operator gives the record and deletion links.
      const lrsOrigin = lrsUrl.replace(/\/xapi$/, '');
      vars.CXM_RECORD_HOLDER_URL = lrsOrigin + '/account/record';
      vars.CXM_RECORD_DELETE_URL = lrsOrigin + '/account/delete';
    }
    const config = loadConfig(vars);
    if ('errors' in config) throw new Error(config.errors.join('\n'));
    const base = await loadCourse(FIXTURE);
    const built = await createAppFromConfig(config, { course: { ...base, custody, allowPractice: custody !== 'practice' } });
    app = built;
    closers.unshift(() => built.close());

    if (custody === 'server-kept' || custody === 'author-lrs') {
      const browser = jar();
      const { accessToken } = await authorize({ browser, fill: custody === 'server-kept' ? signUp : allow, mcpUrl: env.CXM_URL });
      env.CXM_TOKEN = accessToken;
      // The export page needs the browser's session; this loopback relay opens it with that session.
      const relay = await serve(() => fetch(http.url + '/record/export.json', { headers: { cookie: browser.header() } }));
      closers.push(() => relay.close());
      env.CXM_EXPORT_URL = relay.url + '/record/export.json';
    }

    console.log(`\n== course-xapi-mcp conformance: reference server, custody ${custody} (${classes.join(', ')})\n`);
    return await runVitest(classes, env);
  } finally {
    for (const close of closers) await close().catch(() => undefined);
  }
}

/**
 * The badge issuer class: the conformance course with the badges of `badges/fixtures/badges.json`, served by the
 * reference with its badge issuer on. CXM_ISSUER_URL is the app's origin; in options 2 and 3 CXM_BROWSER_URL is a
 * loopback relay that forwards every request to the app with the signed-in browser's session (the claim page, the
 * credentials and the deletion link). Option 2's test LRS records authorities and accepts a second credential,
 * `learner` / `learner`, that the server does not use.
 */
async function runBadgeProfile(custody: Custody): Promise<number> {
  const closers: (() => Promise<unknown>)[] = [];
  const pkg = mkdtempSync(join(tmpdir(), 'cxm-badge-course-'));
  closers.push(async () => rmSync(pkg, { recursive: true, force: true }));
  try {
    cpSync(FIXTURE, pkg, { recursive: true });
    const courseJson = join(pkg, 'cxm/course.json');
    const declared = JSON.parse(readFileSync(ROOT + 'conformance/badges/fixtures/badges.json', 'utf8'));
    writeFileSync(courseJson, JSON.stringify({ ...JSON.parse(readFileSync(courseJson, 'utf8')), ...declared }, null, 2));

    let app: App | undefined;
    const http = await serve((req) => app!.fetch(req));
    closers.push(() => http.close());
    const vars: Record<string, string> = { CXM_PUBLIC_URL: http.url, PORT: new URL(http.url).port, CXM_PACKAGE: pkg };
    const env: Record<string, string> = { CXM_URL: http.url + '/mcp', CXM_CUSTODY: custody, CXM_ISSUER_URL: http.url, CXM_KNOWN_GAPS: JSON.stringify(BADGE_KNOWN_GAPS[custody] ?? {}) };
    if (custody === 'lms-launched') {
      // Path and course badges need the LMS on CXM_LMS_ORIGINS: the suite's LMS listens on a port chosen here.
      const port = await freePort();
      env.CXM_LMS_PORT = String(port);
      vars.CXM_LMS_ORIGINS = `http://127.0.0.1:${port}`;
    }
    if (custody === 'author-lrs') {
      const lrs = createTestLrs({ credentials: [{ key: 'test', secret: 'test' }, { key: 'learner', secret: 'learner' }], authority: true });
      const lrsUrl = (await lrs.listen()) + '/xapi';
      closers.push(() => lrs.close());
      const idp = await startFakeIdp();
      closers.push(() => idp.close());
      Object.assign(vars, { CXM_LRS_ENDPOINT: lrsUrl, CXM_LRS_KEY: 'test', CXM_LRS_SECRET: 'test', CXM_OIDC_ISSUER: idp.issuer, CXM_OIDC_CLIENT_ID: idp.clientId, CXM_OIDC_CLIENT_SECRET: idp.clientSecret });
      env.CXM_LRS_URL = lrsUrl;
    }
    const config = loadConfig(vars);
    if ('errors' in config) throw new Error(config.errors.join('\n'));
    const base = await loadCourse(pkg);
    const built = await createAppFromConfig(config, {
      course: { ...base, custody, allowPractice: custody !== 'practice' },
      // A signing key for this run only; the warning about it is expected here.
      badges: (parts) => badgesFromConfig(parts, () => undefined),
    });
    app = built;
    closers.unshift(() => built.close());

    if (custody === 'server-kept' || custody === 'author-lrs') {
      const browser = jar();
      const { accessToken } = await authorize({ browser, fill: custody === 'server-kept' ? signUp : allow, mcpUrl: env.CXM_URL });
      env.CXM_TOKEN = accessToken;
      const exported = await serve(() => fetch(http.url + '/record/export.json', { headers: { cookie: browser.header() } }));
      closers.push(() => exported.close());
      env.CXM_EXPORT_URL = exported.url + '/record/export.json';
      // The signed-in browser, for the claim page and the deletion link: the suite's own cookies plus the session.
      const relay = await serve(async (req) => {
        const u = new URL(req.url);
        const headers = new Headers(req.headers);
        headers.delete('host');
        headers.set('cookie', [req.headers.get('cookie'), browser.header()].filter(Boolean).join('; '));
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
        return fetch(http.url + u.pathname + u.search, { method: req.method, headers, body, redirect: 'manual' });
      });
      closers.push(() => relay.close());
      env.CXM_BROWSER_URL = relay.url;
    }

    console.log(`\n== course-xapi-mcp conformance: reference server, custody ${custody} (conformance/badges)\n`);
    return await runVitest(['conformance/badges'], env);
  } finally {
    for (const close of closers) await close().catch(() => undefined);
  }
}

// `npm run conformance:reference -- server-kept` runs that option's profiles; `-- badges` the badge issuer class
// alone, `-- badges:server-kept` one of its profiles.
const only = process.argv.slice(2);
const pick = (name: string, custody: Custody) => !only.length || only.includes(custody) || only.includes(name) || (name.startsWith('badges:') && only.includes('badges'));
const results: { name: string; code: number }[] = [];
for (const p of PROFILES.filter((x) => pick(x.custody, x.custody))) results.push({ name: p.custody, code: await runProfile(p.custody, p.classes) });
for (const custody of BADGE_PROFILES.filter((c) => pick('badges:' + c, c))) results.push({ name: 'badges:' + custody, code: await runBadgeProfile(custody) });
console.log('\n== summary');
for (const r of results) console.log(`  ${r.name.padEnd(22)} ${r.code === 0 ? 'PASS' : 'FAIL'}`);
process.exit(results.every((r) => r.code === 0) ? 0 : 1);
