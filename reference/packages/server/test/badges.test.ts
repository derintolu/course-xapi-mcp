// SPDX-License-Identifier: Apache-2.0
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { OB_XAPI, type BadgeDecl, type CourseModel, type Custody, type LearnerRef, type XapiStatement } from '@course-xapi-mcp/core';
import { didWeb, generateKey, verifyCredential, type SigningKey } from '@course-xapi-mcp/badges';
import { createLmsSim, createTestLrs } from '@course-xapi-mcp/conformance';
import type { JWK } from 'jose';
import {
  MemoryServerStore,
  createApp,
  createAppFromConfig,
  createAuthServer,
  createPracticeCustody,
  createServerKeptCustody,
  loadConfig,
  type App,
  type AppConfig,
  type ServerStore,
} from '../src/index.ts';
import { badgesFromConfig, createBadgeService } from '../src/badges/service.ts';
import { DirectoryIssuerStore, MemoryIssuerStore, type IssuerStore } from '../src/badges/issuer-store.ts';
import { FIXED, WITH_TIMEOUT, loadExample, teachExample } from './helpers.ts';

const PUBLIC = 'http://127.0.0.1:8787';
const HOST = '127.0.0.1:8787';
const DID = didWeb(PUBLIC);
const REDIRECT = 'http://127.0.0.1:33418/callback';
const LRS_URL = 'http://127.0.0.1:9/xapi';
const LESSON_BADGE = 'https://course-xapi-mcp.sqwrlz.com/examples/json-basics/badges/fix-the-config';
const PATH_BADGE = 'https://course-xapi-mcp.sqwrlz.com/examples/json-basics/badges/json';
/** A second lesson badge the option-1 tests add, so one badge is claimed after its session ended and one while open. */
const FIRST_LESSON_BADGE = 'https://course-xapi-mcp.sqwrlz.com/examples/json-basics/badges/what-is-json';
const SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

let apps: App[] = [];
let clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
  clients = [];
});

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
  };
}
type Jar = ReturnType<typeof jar>;

function req(path: string, init: RequestInit & { cookies?: Jar } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('host', HOST);
  if (init.cookies) headers.set('cookie', init.cookies.header());
  return new Request(new URL(path, PUBLIC), { ...init, headers });
}
const formPost = (path: string, body: Record<string, string>, cookies?: Jar) =>
  req(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' }, body: new URLSearchParams(body), cookies });

const csrfOf = (page: string) => /name="csrf" value="([^"]+)"/.exec(page)?.[1];
const claimable = (page: string) => [...page.matchAll(/name="badge" value="([^"]+)"/g)].map((m) => m[1]!.replaceAll('&#39;', "'"));
const credentialLinks = (page: string) => [...page.matchAll(/href="\/badges\/credentials\/([0-9a-f-]{36})"/g)].map((m) => m[1]!);

async function startSignIn(app: App, browser: Jar) {
  const reg = await app.fetch(req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Badge test agent' }) }));
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: PUBLIC + '/mcp', scope: 'cxm:learn' });
  const page = await app.fetch(req('/oauth/authorize?' + query, { cookies: browser }));
  browser.take(page);
  const id = /name="request_id" value="([^"]+)"/.exec(await page.text())![1]!;
  const finish = async (signedIn: Response) => {
    browser.take(signedIn);
    const m = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(await signedIn.text())!;
    const code = new URL(m[1]!.replaceAll('&amp;', '&')).searchParams.get('code')!;
    const tok = await app.fetch(req('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: PUBLIC + '/mcp' }) }));
    return ((await tok.json()) as { access_token: string }).access_token;
  };
  return { id, finish };
}

async function signUp(app: App, browser: Jar, username = 'ada.l') {
  const s = await startSignIn(app, browser);
  return s.finish(await app.fetch(formPost('/oauth/login', { request_id: s.id, action: 'signup', username, password: 'correct horse battery' }, browser)));
}

async function mcp(app: App, path: '/mcp' | '/mcp/practice', token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(PUBLIC + path), {
    fetch: (url, init) => {
      const r = req(String(url), init as RequestInit);
      if (token) r.headers.set('authorization', `Bearer ${token}`);
      return app.fetch(r);
    },
  });
  const client = new Client({ name: 'badge-test-client', version: '0.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(transport);
  clients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), data: r.structuredContent as any, raw: r };
  };
}

/** Option 3 with the badge service, built part by part so the test can reach the stores. */
async function optionThree(o: { course?: CourseModel; wrap?: (c: Custody) => Custody; issuer?: IssuerStore; key?: SigningKey } = {}) {
  const course = o.course ?? (await loadExample());
  const inner = new MemoryServerStore();
  const subjects = new Set<string>();
  const serverStore: ServerStore = {
    getState: (s) => inner.getState(s),
    putState: (s, st, e) => (subjects.add(s), inner.putState(s, st, e)),
    append: (s, st) => inner.append(s, st),
    statements: (s) => inner.statements(s),
    deleteLearner: (s) => inner.deleteLearner(s),
  };
  const custody = (o.wrap ?? ((c) => c))(createServerKeptCustody({ store: serverStore, publicUrl: PUBLIC, courseTitle: course.title }));
  const signingKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as JWK;
  const auth = createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'accounts' });
  const issuer = o.issuer ?? new MemoryIssuerStore();
  const key = o.key ?? (await generateKey(DID));
  const badges = createBadgeService({ course, publicUrl: PUBLIC, issuerName: 'JSON basics', key, store: issuer, custody, auth });
  const app = createApp({ course, publicUrl: PUBLIC, custody, practice: createPracticeCustody({ courseId: course.id }), auth, serverStore, badges });
  apps.push(app);
  const browser = jar();
  const token = await signUp(app, browser);
  const call = await mcp(app, '/mcp', token);
  return { app, course, browser, call, issuer, badges, inner, subjects, key };
}

/** Teaches the whole json path in option 3 (placement first). */
async function finishCourse(call: Awaited<ReturnType<typeof mcp>>) {
  expect((await call('start_placement')).isError).toBe(false);
  await teachExample(call);
}

async function claimPage(app: App, browser: Jar) {
  const res = await app.fetch(req('/badges/claim', { cookies: browser }));
  expect(res.status).toBe(200);
  return res.text();
}

/** Claims `badge` on the claim page and returns the result page. */
async function claim(app: App, browser: Jar, badge: string, recipient: Record<string, string>) {
  const csrf = csrfOf(await claimPage(app, browser))!;
  return app.fetch(formPost('/badges/claim', { csrf, badge, ...recipient }, browser));
}

async function credential(app: App, browser: Jar, id: string) {
  const res = await app.fetch(req('/badges/credentials/' + id, { cookies: browser }));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

async function didDocs(app: App) {
  const res = await app.fetch(req('/.well-known/did.json'));
  expect(res.status).toBe(200);
  return { [DID]: (await res.json()) as object };
}

/** Whether the status list published at /badges/status/1 has bit `i` set, after checking its signature. */
async function revokedBit(app: App, i: number): Promise<boolean> {
  const list = (await (await app.fetch(req('/badges/status/1'))).json()) as Record<string, any>;
  expect(await verifyCredential(list, await didDocs(app))).toEqual({ verified: true, errors: [] });
  expect(list.type).toEqual(['VerifiableCredential', 'BitstringStatusListCredential']);
  const bits = gunzipSync(Buffer.from((list.credentialSubject.encodedList as string).slice(1), 'base64url'));
  expect(bits.length * 8).toBe(131_072);
  return (bits[i >> 3]! & (0x80 >> (i & 7))) !== 0;
}

async function exported(app: App, browser: Jar): Promise<XapiStatement[]> {
  return ((await (await app.fetch(req('/record/export.json', { cookies: browser }))).json()) as { record: { statements: XapiStatement[] } }).record.statements;
}

function* values(v: unknown): Generator<unknown> {
  yield v;
  if (v && typeof v === 'object') for (const x of Object.values(v)) yield* values(x);
}

describe('badges in option 3 (server-kept)', () => {
  it('finishing fix-the-config makes get_badges list the lesson badge as unclaimed', async () => {
    const { call } = await optionThree();
    expect((await call('get_badges')).data).toMatchObject({ ok: true, badges: [], claimPage: PUBLIC + '/badges/claim' });
    await finishCourse(call);
    const { data } = await call('get_badges');
    expect(data.claimPage).toBe(PUBLIC + '/badges/claim');
    expect(data.badges).toEqual(
      expect.arrayContaining([
        { badgeId: LESSON_BADGE, name: 'Fix the config', earnedAt: expect.any(String), claimed: false },
        { badgeId: PATH_BADGE, name: 'Read and write JSON', earnedAt: expect.any(String), claimed: false },
      ]),
    );
  });

  it('claiming with an email issues a credential that verifies against /.well-known/did.json, with no account name, and writes earned to the record', async () => {
    const { app, browser, call, subjects } = await optionThree();
    await finishCourse(call);
    const page = await claimPage(app, browser);
    expect(claimable(page).sort()).toEqual([LESSON_BADGE, PATH_BADGE].sort());
    // The salt is made in the browser: the page carries the script and a CSP that allows only it.
    expect(page).toMatch(/name="salt"/);
    expect(page).toMatch(/crypto\.getRandomValues/);

    const done = await claim(app, browser, LESSON_BADGE, { email: 'ada@example.com', salt: SALT });
    expect(done.status).toBe(200);
    const text = await done.text();
    expect(text).toContain(SALT);
    const [id] = credentialLinks(text);
    const vc = await credential(app, browser, id!);
    expect(await verifyCredential(vc, await didDocs(app))).toEqual({ verified: true, errors: [] });
    expect(vc.issuer).toMatchObject({ id: DID, name: 'JSON basics' });
    expect(vc.id).toBe('urn:uuid:' + id);
    const [identity] = vc.credentialSubject.identifier;
    expect(identity).toMatchObject({ identityType: 'emailAddress', hashed: true, salt: SALT, identityHash: 'sha256$' + createHash('sha256').update('ada@example.com' + SALT).digest('hex') });

    // No xAPI account name (the subject), registration or email anywhere in the credential.
    const [subject] = [...subjects];
    const statements = await exported(app, browser);
    const registration = statements[0]!.context!.registration!;
    for (const v of values(vc)) for (const secret of [subject, registration, 'ada@example.com', 'ada.l']) expect(v).not.toBe(secret);
    const json = JSON.stringify(vc);
    for (const secret of [subject!, registration, 'ada@example.com', 'ada.l']) expect(json).not.toContain(secret);

    // earned, pointing at the earning statement (the evidence) and at the credential.
    const earning = vc.evidence[0].id.replace('urn:uuid:', '');
    expect(statements.some((s) => s.id === earning && s.verb.id.endsWith('/passed'))).toBe(true);
    const earned = statements.filter((s) => s.verb.id === OB_XAPI.earned);
    expect(earned).toHaveLength(1);
    expect(earned[0]!.context!.statement).toEqual({ objectType: 'StatementRef', id: earning });
    expect(earned[0]!.result!.extensions![OB_XAPI.badgeAssertion]).toEqual({ '@id': vc.id });
    expect(earned[0]!.object.id).toBe(LESSON_BADGE);
    expect(earned[0]!.context!.registration).toBe(registration);

    const listed = (await call('get_badges')).data.badges as { badgeId: string; claimed: boolean }[];
    expect(listed.find((b) => b.badgeId === LESSON_BADGE)!.claimed).toBe(true);
    expect(claimable(await claimPage(app, browser))).toEqual([PATH_BADGE]);
  });

  it('claiming twice issues one credential', async () => {
    const { app, browser, call, issuer, subjects } = await optionThree();
    await finishCourse(call);
    const csrf = csrfOf(await claimPage(app, browser))!;
    // Two submissions of the same form, at the same time and once more afterwards.
    const [a, b] = await Promise.all([
      app.fetch(formPost('/badges/claim', { csrf, badge: LESSON_BADGE, did: 'did:example:wallet-1' }, browser)),
      app.fetch(formPost('/badges/claim', { csrf, badge: LESSON_BADGE, did: 'did:example:wallet-2' }, browser)),
    ]);
    const c = await app.fetch(formPost('/badges/claim', { csrf, badge: LESSON_BADGE, email: 'ada@example.com', salt: SALT }, browser));
    const ids = new Set([...credentialLinks(await a.text()), ...credentialLinks(await b.text()), ...credentialLinks(await c.text())]);
    expect(ids.size).toBe(1);
    const [subject] = [...subjects];
    expect((await issuer.credentials(subject!)).length).toBe(1);
    expect((await exported(app, browser)).filter((s) => s.verb.id === OB_XAPI.earned)).toHaveLength(1);
  });

  it('a credential is served only to its owner, a DID recipient gets credentialSubject.id, and bad input is refused', async () => {
    const { app, browser, call } = await optionThree();
    await finishCourse(call);
    expect((await claim(app, browser, LESSON_BADGE, { did: 'not a did' })).status).toBe(400);
    expect((await claim(app, browser, LESSON_BADGE, { email: 'ada@example.com', salt: 'short' })).status).toBe(400);
    expect((await claim(app, browser, LESSON_BADGE, { email: 'ada@example.com', salt: SALT, did: 'did:example:x' })).status).toBe(400);
    expect((await claim(app, browser, 'https://example.org/not-earned', { did: 'did:example:x' })).status).toBe(400);
    const forged = await app.fetch(formPost('/badges/claim', { csrf: 'forged', badge: LESSON_BADGE, did: 'did:example:x' }, browser));
    expect(forged.status).toBe(403);

    const [id] = credentialLinks(await (await claim(app, browser, LESSON_BADGE, { did: 'did:example:wallet' })).text());
    expect((await credential(app, browser, id!)).credentialSubject.id).toBe('did:example:wallet');
    // Another learner's browser, and no browser session at all.
    const other = jar();
    await signUp(app, other, 'grace.h');
    expect((await app.fetch(req('/badges/credentials/' + id, { cookies: other }))).status).toBe(404);
    expect((await app.fetch(req('/badges/credentials/' + id))).status).toBe(401);
    expect((await app.fetch(req('/badges/credentials/not-a-uuid', { cookies: browser }))).status).toBe(404);
  });

  it('deleting the record revokes every credential (status bit set) and forgets unclaimed awards', async () => {
    const { app, browser, call } = await optionThree();
    await finishCourse(call);
    const [id] = credentialLinks(await (await claim(app, browser, LESSON_BADGE, { email: 'ada@example.com', salt: SALT })).text());
    const vc = await credential(app, browser, id!);
    const index = Number(vc.credentialStatus.statusListIndex);
    expect(vc.credentialStatus).toMatchObject({ type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListCredential: PUBLIC + '/badges/status/1' });
    expect(await revokedBit(app, index)).toBe(false);

    const view = await (await app.fetch(req('/record', { cookies: browser }))).text();
    expect((await app.fetch(formPost('/record', { action: 'delete', csrf: csrfOf(view)! }, browser))).status).toBe(200);
    expect(await revokedBit(app, index)).toBe(true);
    expect((await call('get_badges')).data.badges).toEqual([]);
    expect(claimable(await claimPage(app, browser))).toEqual([]);
  });

  it('a voided earning statement found on read revokes the credential', async () => {
    const { app, browser, call, inner, subjects } = await optionThree();
    await finishCourse(call);
    const [id] = credentialLinks(await (await claim(app, browser, LESSON_BADGE, { did: 'did:example:wallet' })).text());
    const vc = await credential(app, browser, id!);
    const index = Number(vc.credentialStatus.statusListIndex);
    const earning = vc.evidence[0].id.replace('urn:uuid:', '');
    const [subject] = [...subjects];
    const actor = (await inner.statements(subject!))[0]!.actor;
    await inner.append(subject!, [
      { id: '0b5e0b5e-0000-4000-8000-000000000001', actor, verb: { id: 'http://adlnet.gov/expapi/verbs/voided', display: { 'en-US': 'voided' } }, object: { objectType: 'StatementRef', id: earning } as never, context: {} as never, timestamp: new Date().toISOString() },
    ]);
    expect(await revokedBit(app, index)).toBe(false);
    const listed = (await call('get_badges')).data.badges as { badgeId: string }[];
    expect(listed.map((b) => b.badgeId)).not.toContain(LESSON_BADGE);
    expect(await revokedBit(app, index)).toBe(true);
  });

  it('a score appears in the credential only when the badge sets includeScore', async () => {
    const base = await loadExample();
    const course = { ...base, badges: base.badges.map((b) => (b.id === LESSON_BADGE ? { ...b, includeScore: true } : b)) };
    // The example's statements carry no score; this record holder adds one to every passed statement.
    const scored = (c: Custody): Custody => ({
      ...c,
      option: c.option,
      official: c.official,
      record: async (l) => {
        const r = await c.record(l);
        return { ...r, statements: r.statements.map((s) => (s.verb.id.endsWith('/passed') ? { ...s, result: { ...s.result, score: { scaled: 0.85 } } } : s)) };
      },
    });
    const { app, browser, call } = await optionThree({ course, wrap: scored });
    await finishCourse(call);
    const [withScore] = credentialLinks(await (await claim(app, browser, LESSON_BADGE, { did: 'did:example:wallet' })).text());
    const [without] = credentialLinks(await (await claim(app, browser, PATH_BADGE, { did: 'did:example:wallet' })).text());
    const a = await credential(app, browser, withScore!);
    expect(a.credentialSubject.result).toEqual([{ type: ['Result'], resultDescription: LESSON_BADGE + '#score', value: '0.85' }]);
    expect(await verifyCredential(a, await didDocs(app))).toEqual({ verified: true, errors: [] });
    expect(JSON.stringify(await credential(app, browser, without!))).not.toMatch(/"(result|resultDescription|score)"/);
  });

  it('claim without a browser session redirects to sign-in', async () => {
    const { app } = await optionThree();
    for (const r of [req('/badges/claim'), formPost('/badges/claim', { csrf: 'x', badge: LESSON_BADGE, did: 'did:example:x' })]) {
      const res = await app.fetch(r);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/badges/sign-in');
    }
    const signIn = await app.fetch(req('/badges/sign-in'));
    expect(signIn.status).toBe(200);
    expect(await signIn.text()).toMatch(/[Ss]ign in/);
  });

  it('publishes the DID document and refuses other methods on the public routes', async () => {
    const { app, key } = await optionThree();
    const doc = (await (await app.fetch(req('/.well-known/did.json'))).json()) as Record<string, any>;
    expect(doc).toMatchObject({ id: DID, assertionMethod: [key.id], verificationMethod: [{ id: key.id, type: 'Multikey', controller: DID, publicKeyMultibase: key.publicKeyMultibase }] });
    expect(JSON.stringify(doc)).not.toContain(key.secretKeyMultibase);
    expect((await app.fetch(req('/.well-known/did.json', { method: 'POST', body: '{}' }))).status).toBe(405);
    expect((await app.fetch(req('/badges/status/1', { method: 'DELETE' }))).status).toBe(405);
    expect((await app.fetch(req('/badges/status/2'))).status).toBe(404);
  });
});

describe('practice never earns badges', () => {
  it('get_badges is refused on the practice endpoint and a practice run records no award', async () => {
    const { app, issuer, browser } = await optionThree();
    const practice = await mcp(app, '/mcp/practice');
    const started = await practice('start_placement');
    const handle = started.data.handle as string;
    await teachExample(practice, { handle });
    const badges = await practice('get_badges');
    expect(badges.isError).toBe(true);
    expect(badges.data.error).toMatch(/practice runs cannot earn badges/);
    expect(await issuer.awards('practice:' + handle)).toEqual([]);
    expect(claimable(await claimPage(app, browser))).toEqual([]);
  });
});

describe('onAwards', () => {
  it('is idempotent per learner and badge: a retried award after a lost save never mints a second credential', async () => {
    const { app, browser, call, badges, issuer, subjects } = await optionThree();
    await finishCourse(call);
    const [subject] = [...subjects];
    const l: LearnerRef = { kind: 'official', subject: subject!, actor: { objectType: 'Agent', account: { homePage: 'x', name: subject! } } };
    const before = await issuer.awards(subject!);
    const award = before.find((a) => a.badgeId === LESSON_BADGE)!;
    // The same award again (a retry): nothing changes.
    await badges.onAwards(l, [{ badgeId: LESSON_BADGE, registration: award.registration, earningStatementId: award.earningStatementId, testedOut: 0 }]);
    expect(await issuer.awards(subject!)).toEqual(before);
    const [id] = credentialLinks(await (await claim(app, browser, LESSON_BADGE, { did: 'did:example:wallet' })).text());
    // After the claim, another award for the badge changes nothing either.
    await badges.onAwards(l, [{ badgeId: LESSON_BADGE, registration: award.registration, earningStatementId: '99999999-9999-4999-8999-999999999999', testedOut: 0 }]);
    expect((await issuer.awards(subject!)).find((a) => a.badgeId === LESSON_BADGE)!.earningStatementId).toBe(award.earningStatementId);
    expect((await issuer.credentials(subject!)).map((c) => c.id)).toEqual([id]);
  });

  it('an unclaimed award follows the retry, so its evidence is the statement that was saved', async () => {
    const issuer = new MemoryIssuerStore();
    const course = await loadExample();
    const custody = createServerKeptCustody({ store: new MemoryServerStore(), publicUrl: PUBLIC, courseTitle: course.title });
    const signingKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as JWK;
    const badges = createBadgeService({ course, publicUrl: PUBLIC, issuerName: 'x', key: await generateKey(DID), store: issuer, custody, auth: createAuthServer({ publicUrl: PUBLIC, course, signingKey, mode: 'accounts' }) });
    const l: LearnerRef = { kind: 'official', subject: 's1', actor: { objectType: 'Agent', account: { homePage: 'x', name: 's1' } } };
    await badges.onAwards(l, [{ badgeId: LESSON_BADGE, registration: 'r1', earningStatementId: 'e1', testedOut: 0 }]);
    await badges.onAwards(l, [{ badgeId: LESSON_BADGE, registration: 'r1', earningStatementId: 'e2', testedOut: 0 }]);
    const awards = await issuer.awards('s1');
    expect(awards).toHaveLength(1);
    expect(awards[0]).toMatchObject({ badgeId: LESSON_BADGE, earningStatementId: 'e2' });
  });
});

describe('issuer store', () => {
  it('the directory store keeps awards, credentials and status bits across instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cxm-issuer-'));
    try {
      const a = new DirectoryIssuerStore(dir);
      expect(await a.addAward({ subject: 's', badgeId: 'b', registration: 'r', earningStatementId: 'e', testedOut: 0, earnedAt: '2026-10-27T00:00:00.000Z' })).toBe(true);
      expect(await a.addAward({ subject: 's', badgeId: 'b', registration: 'r', earningStatementId: 'e', testedOut: 0, earnedAt: '2026-10-27T00:00:00.000Z' })).toBe(false);
      const i = await a.allocateIndex();
      const stored = await a.addCredential({ id: '11111111-1111-4111-8111-111111111111', subject: 's', badgeId: 'b', statusIndex: i, issuedAt: '2026-10-27T00:00:00.000Z', earningStatementId: 'e', credential: { x: 1 }, earned: { id: 'x' } as never, earnedPending: true, revoked: false });
      expect(stored.id).toBe('11111111-1111-4111-8111-111111111111');
      // One credential per learner and badge: a second is not stored, the first is returned.
      const again = await a.addCredential({ ...stored, id: '22222222-2222-4222-8222-222222222222' });
      expect(again.id).toBe(stored.id);
      expect(await a.revoke(stored.id)).toBe(true);
      expect(await a.revoke(stored.id)).toBe(false);

      const b = new DirectoryIssuerStore(dir);
      expect(await b.awards('s')).toHaveLength(1);
      expect(await b.credential(stored.id)).toMatchObject({ subject: 's', revoked: true, statusIndex: i });
      expect(await b.revokedIndexes()).toEqual([i]);
      expect(await b.allocateIndex()).not.toBe(i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('configuration', () => {
  const env = (extra: Record<string, string> = {}) => {
    const c = loadConfig({ CXM_PUBLIC_URL: PUBLIC, ...extra });
    if ('errors' in c) throw new Error(c.errors.join('\n'));
    return c;
  };

  it('reads CXM_BADGE_KEY as an Ed25519 Multikey and refuses anything else', async () => {
    const key = await generateKey(DID);
    const c = env({ CXM_BADGE_KEY: JSON.stringify({ publicKeyMultibase: key.publicKeyMultibase, secretKeyMultibase: key.secretKeyMultibase }) });
    expect(c.badgeKey).toEqual({ publicKeyMultibase: key.publicKeyMultibase, secretKeyMultibase: key.secretKeyMultibase });
    for (const bad of ['not json', '{"publicKeyMultibase":"z6Mk"}', '[]']) {
      const r = loadConfig({ CXM_BADGE_KEY: bad });
      expect('errors' in r && r.errors.join()).toMatch(/CXM_BADGE_KEY/);
      expect(JSON.stringify(r)).not.toContain(key.secretKeyMultibase);
    }
  });

  it('builds the service from the configuration only when the course server issues', async () => {
    const key = await generateKey(DID);
    const config: AppConfig = env({ CXM_BADGE_KEY: JSON.stringify({ publicKeyMultibase: key.publicKeyMultibase, secretKeyMultibase: key.secretKeyMultibase }), CXM_BADGE_ISSUER_NAME: 'Example Academy' });
    const warnings: string[] = [];
    const app = await createAppFromConfig(config, { course: await loadExample(), badges: (p) => badgesFromConfig(p, (w) => warnings.push(w)) });
    apps.push(app);
    expect(((await (await app.fetch(req('/.well-known/did.json'))).json()) as { assertionMethod: string[] }).assertionMethod).toEqual([`${DID}#${key.publicKeyMultibase}`]);
    expect(warnings).toEqual([]);

    // A generated key, with a warning, when CXM_BADGE_KEY is unset.
    const generated = await createAppFromConfig(env(), { course: await loadExample(), badges: (p) => badgesFromConfig(p, (w) => warnings.push(w)) });
    apps.push(generated);
    expect((await generated.fetch(req('/.well-known/did.json'))).status).toBe(200);
    expect(warnings.join()).toMatch(/CXM_BADGE_KEY is not set/);

    // Practice custody, and a record holder that signs its own badges: no badge routes.
    const base = await loadExample();
    for (const course of [{ ...base, custody: 'practice' as const, allowPractice: false }, { ...base, custody: 'lms-launched' as const, allowPractice: false, badgeIssuer: { ...base.badgeIssuer!, signer: 'record-holder' as const } }]) {
      const off = await createAppFromConfig(config, { course, badges: (p) => badgesFromConfig(p) });
      apps.push(off);
      expect((await off.fetch(req('/.well-known/did.json'))).status).toBe(404);
    }
  });
});

describe('badges in option 1 (lms-launched)', () => {
  const firstBadge = (base: BadgeDecl): BadgeDecl => ({ ...base, id: FIRST_LESSON_BADGE, name: 'What JSON is', for: 'what-is-json' });

  async function optionOne() {
    const lrs = createTestLrs();
    const lrsFetch = ((input: RequestInfo | URL, init?: RequestInit) => lrs.fetch(new Request(input, init))) as typeof fetch;
    const base = await loadExample();
    const course: CourseModel = { ...base, custody: 'lms-launched', allowPractice: false, badges: [...base.badges, firstBadge(base.badges[0]!)] };
    const auOf = (key: string) => (key === 'placement' ? course.placement : course.lessons[key]!);
    const sim = createLmsSim({
      lrs,
      lrsUrl: LRS_URL,
      courseId: course.id,
      aus: ['placement', 'what-is-json', 'fix-the-config'].map((k) => ({ auId: auOf(k).auId, url: auOf(k).url, moveOn: k === 'placement' ? ('NotApplicable' as const) : ('CompletedAndPassed' as const) })),
    });
    // A second ahead of the simulator's own stamps, so statements stay ordered however slow the run.
    const now = () => Date.now() + 1000;
    const issuer = new MemoryIssuerStore();
    const key = await generateKey(DID);
    const c = loadConfig({ CXM_PUBLIC_URL: PUBLIC });
    if ('errors' in c) throw new Error(c.errors.join());
    const app = await createAppFromConfig(c, {
      course,
      lrsFetch,
      now,
      badges: (p) => createBadgeService({ course: p.course, publicUrl: p.publicUrl, issuerName: 'JSON basics', key, store: issuer, custody: p.custody, auth: p.auth!, launches: p.launches, now: () => new Date(now()).toISOString() }),
    });
    apps.push(app);

    const session = async (lesson: string, registration?: string) => {
      const l = await sim.launch(auOf(lesson).auId, { returnURL: 'https://lms.example/course', registration });
      const launched = await app.fetch(req(new URL(l.launchUrl).pathname + new URL(l.launchUrl).search));
      expect(launched.status).toBe(200);
      const code = /class="code">([A-Z0-9]{6})</.exec(await launched.text())![1]!;
      const browser = jar();
      const s = await startSignIn(app, browser);
      const token = await s.finish(await app.fetch(formPost('/oauth/authorize', { request_id: s.id, pairing_code: code }, browser)));
      return { ...l, browser, call: await mcp(app, '/mcp', token) };
    };
    return { app, lrs, sim, issuer, session, course };
  }

  /** Placement, then what-is-json in its own launch; returns the lesson launch (session ended) and the registration. */
  async function firstLesson(o: Awaited<ReturnType<typeof optionOne>>) {
    const placement = await o.session('placement');
    await placement.call('start_placement');
    await placement.call('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New to JSON.' });
    const lesson = await o.session('what-is-json', placement.registration);
    const step = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await lesson.call(name, args);
      if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.data)}`);
      return r;
    };
    await step('next_beat');
    await step('next_beat', { learner_reply: '"42" is a string.' });
    await step('next_beat', { learner_reply: 'No: the trailing comma is an error.' });
    await step('submit_checkpoint', { response: 'One is a number, one is a string; a server may reject the string.' });
    await step('choose_branch', { branch: 'ready', rationale: 'Names both types and a reason.' });
    await lesson.call('end_session');
    return { lesson, registration: placement.registration };
  }

  /** Launches fix-the-config; `whileOpen` runs after its first step, then the lesson is finished (its session ends). */
  async function secondLesson(o: Awaited<ReturnType<typeof optionOne>>, registration: string, whileOpen?: (lesson: Awaited<ReturnType<typeof o.session>>) => Promise<void>) {
    const lesson = await o.session('fix-the-config', registration);
    const step = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await lesson.call(name, args);
      if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.data)}`);
      return r;
    };
    await step('next_beat');
    await whileOpen?.(lesson);
    await step('next_beat', { learner_reply: 'A string, so a program may treat it as true.' });
    await step('check_code', { file: 'config.json', content: FIXED });
    await step('next_beat');
    await step('submit_checkpoint', { response: 'A number, because the program compares it.', files: { 'config.json': WITH_TIMEOUT } });
    await step('choose_branch', { branch: 'done', rationale: 'Checks pass and the reason is right.' });
    return lesson;
  }

  const earnedIn = (statements: XapiStatement[]) => statements.filter((s) => s.verb.id === OB_XAPI.earned);
  const ids = (list: { badgeId: string }[]) => list.map((b) => b.badgeId).sort();

  it('issues lesson badges from statements the LMS accepted, but no path badge without a readable satisfied', async () => {
    const o = await optionOne();
    const { registration } = await firstLesson(o);
    const lesson = await secondLesson(o, registration);
    expect(ids((await lesson.call('get_badges')).data.badges)).toEqual([FIRST_LESSON_BADGE, LESSON_BADGE].sort());
    expect(claimable(await claimPage(o.app, lesson.browser)).sort()).toEqual([FIRST_LESSON_BADGE, LESSON_BADGE].sort());

    // The LMS records the block as satisfied: now the path badge is earned, with that statement as evidence.
    const satisfied: XapiStatement = {
      id: '5a715f1e-0000-4000-8000-000000000001',
      actor: o.lrs.statements()[0]!.actor,
      verb: { id: 'https://w3id.org/xapi/adl/verbs/satisfied', display: { 'en-US': 'satisfied' } },
      object: { objectType: 'Activity', id: o.course.paths.json!.blockId!, definition: { type: 'https://w3id.org/xapi/cmi5/activitytype/block' } } as never,
      context: { registration, contextActivities: { grouping: [{ objectType: 'Activity', id: o.course.id }], category: [{ objectType: 'Activity', id: 'https://w3id.org/xapi/cmi5/context/categories/cmi5' }] }, extensions: { 'https://w3id.org/xapi/cmi5/context/extensions/sessionid': lesson.sessionId } },
      timestamp: new Date(Date.now() + 5000).toISOString(),
    };
    const posted = await o.lrs.fetch(new Request(LRS_URL + '/statements', { method: 'POST', headers: { authorization: 'Basic ' + btoa('test:test'), 'x-experience-api-version': '1.0.3', 'content-type': 'application/json' }, body: JSON.stringify(satisfied) }));
    expect(posted.status).toBe(200);
    expect(ids((await lesson.call('get_badges')).data.badges)).toEqual([FIRST_LESSON_BADGE, LESSON_BADGE, PATH_BADGE].sort());
    const [id] = credentialLinks(await (await claim(o.app, lesson.browser, PATH_BADGE, { did: 'did:example:wallet' })).text());
    const vc = await credential(o.app, lesson.browser, id!);
    expect(vc.evidence[0].id).toBe('urn:uuid:' + satisfied.id);
    expect(vc.credentialSubject.achievement.criteria.narrative).toMatch(/LMS/);
    expect(await verifyCredential(vc, await didDocs(o.app))).toEqual({ verified: true, errors: [] });
  });

  it('writes earned to the LMS only while a session for the registration is open, and keeps it in the issuer record either way', async () => {
    const o = await optionOne();
    const { lesson: first, registration } = await firstLesson(o);
    // No session is open after what-is-json ended: nothing goes to the LMS.
    expect(earnedIn(o.lrs.statements())).toEqual([]);

    // The learner has launched the next lesson: a claim now also goes to the LMS, inside that session, with the
    // cxm profile category.
    let firstId: string | undefined;
    const second = await secondLesson(o, registration, async (open) => {
      [firstId] = credentialLinks(await (await claim(o.app, first.browser, FIRST_LESSON_BADGE, { email: 'ada@example.com', salt: SALT })).text());
      const inLms = earnedIn(o.lrs.statements());
      expect(inLms).toHaveLength(1);
      expect(inLms[0]!.result!.extensions![OB_XAPI.badgeAssertion]).toEqual({ '@id': 'urn:uuid:' + firstId });
      expect(inLms[0]!.context!.registration).toBe(registration);
      expect(inLms[0]!.context!.extensions!['https://w3id.org/xapi/cmi5/context/extensions/sessionid']).toBe(open.sessionId);
      expect(inLms[0]!.context!.contextActivities!.category!.map((a) => a.id)).toContain('https://course-xapi-mcp.sqwrlz.com/xapi/v0.2');
    });
    await second.call('end_session');

    // fix-the-config's session has ended (terminated): its badge goes to the issuer record only.
    const before = o.lrs.statements().length;
    const [secondId] = credentialLinks(await (await claim(o.app, second.browser, LESSON_BADGE, { did: 'did:example:wallet' })).text());
    expect(secondId).toBeTruthy();
    expect(o.lrs.statements().length).toBe(before);
    expect(earnedIn(o.lrs.statements())).toHaveLength(1);
    expect(o.sim.problems()).toEqual([]);

    // get_record appends the issuer record: both earned statements and both credential ids.
    const record = (await second.call('get_record')).data;
    expect(record.issuerRecord.credentials.sort()).toEqual(['urn:uuid:' + firstId, 'urn:uuid:' + secondId].sort());
    expect(earnedIn(record.issuerRecord.statements)).toHaveLength(2);
  });
});
