// SPDX-License-Identifier: Apache-2.0
// Runs the course server class (one profile per custody option) and the launch bridge class against the reference
// server, in-process: `npm run conformance:reference`. For each option it starts the reference app on a loopback port
// with the conformance course, obtains a bearer token through the app's own sign-in pages (options 2 and 3), and runs
// the classes in a vitest child process with the CXM_* environment the suite reads (conformance/README.md).
// This is the only conformance file that may import the reference server.
import { spawn } from 'node:child_process';
import { createAppFromConfig, loadConfig, loadCourse, type App } from '../reference/packages/server/src/index.ts';
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
      const lrs = createTestLrs();
      const lrsUrl = (await lrs.listen()) + '/xapi';
      closers.push(() => lrs.close());
      const idp = await startFakeIdp();
      closers.push(() => idp.close());
      Object.assign(vars, { CXM_LRS_ENDPOINT: lrsUrl, CXM_LRS_KEY: 'test', CXM_LRS_SECRET: 'test', CXM_OIDC_ISSUER: idp.issuer, CXM_OIDC_CLIENT_ID: idp.clientId, CXM_OIDC_CLIENT_SECRET: idp.clientSecret });
      env.CXM_LRS_URL = lrsUrl;
      // Option 2 has no launch to fall back on: the author's LRS operator gives the deletion link.
      vars.CXM_RECORD_HOLDER_URL = lrsUrl.replace(/\/xapi$/, '') + '/account/delete';
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

// `npm run conformance:reference -- server-kept` runs one profile.
const only = process.argv.slice(2);
const results: { custody: Custody; code: number }[] = [];
for (const p of PROFILES.filter((x) => !only.length || only.includes(x.custody))) results.push({ custody: p.custody, code: await runProfile(p.custody, p.classes) });
console.log('\n== summary');
for (const r of results) console.log(`  ${r.custody.padEnd(13)} ${r.code === 0 ? 'PASS' : 'FAIL'}`);
process.exit(results.every((r) => r.code === 0) ? 0 : 1);
