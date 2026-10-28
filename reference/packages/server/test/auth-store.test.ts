// SPDX-License-Identifier: Apache-2.0
// The AuthStore contract, run against the memory store and the directory store, then what only the directory
// store promises: what survives a restart, file modes, no raw secrets, atomic writes and erase.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirectoryAuthStore, highestSeq } from '../src/auth/directory-store.ts';
import { CapacityError, MemoryAuthStore, type AuthRequest, type AuthStore, type MemoryAuthStoreOptions } from '../src/auth/stores.ts';

const T0 = Date.parse('2026-10-27T10:00:00Z');
const DAY = 86_400_000;
let t = T0;
const now = () => t;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const request = (id: string, expiresAt = t + 600_000): AuthRequest => ({ id, clientId: 'c', redirectUri: 'http://127.0.0.1:1/cb', codeChallenge: 'x', expiresAt, browser: 'b' });
const refresh = (subject: string, familyId: string, expiresAt = t + 30 * DAY) => ({ subject, clientId: 'c', familyId, expiresAt });
const account = (id: string, username: string) => ({ id, username, salt: 'c2FsdA==', hash: 'aGFzaA==' });

let dirs: string[] = [];
beforeEach(() => {
  t = T0;
});
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), 'cxm-auth-'));
  dirs.push(d);
  return d;
}

type Make = (o?: Omit<MemoryAuthStoreOptions, 'now'>) => Promise<AuthStore>;
const kinds: [string, Make][] = [
  ['MemoryAuthStore', async (o) => new MemoryAuthStore({ now, ...o })],
  ['DirectoryAuthStore', async (o) => DirectoryAuthStore.open(join(await tempDir(), 'auth'), { now, ...o })],
];

describe.each(kinds)('AuthStore contract: %s', (_name, make) => {
  it('keeps clients, and over the cap forgets the oldest registration first', async () => {
    const s = await make({ maxClients: 2 });
    await s.putClient({ clientId: 'a', redirectUris: ['http://127.0.0.1:1/cb'], issuedAt: 1 });
    await s.putClient({ clientId: 'b', redirectUris: ['http://127.0.0.1:1/cb'], issuedAt: 2 });
    // Registering again moves a client to the back of the line.
    await s.putClient({ clientId: 'a', clientName: 'A again', redirectUris: ['http://127.0.0.1:1/cb'], issuedAt: 3 });
    await s.putClient({ clientId: 'c', redirectUris: ['http://127.0.0.1:1/cb'], issuedAt: 4 });
    expect(await s.getClient('b')).toBeUndefined();
    expect(await s.getClient('a')).toMatchObject({ clientName: 'A again', issuedAt: 3 });
    expect(await s.getClient('c')).toBeDefined();
  });

  it('caps pending requests, sweeps expired ones, and hands a request to exactly one taker', async () => {
    const s = await make({ maxRequests: 1 });
    await s.putRequest(request('r1', t + 1000));
    await expect(s.putRequest(request('r2'))).rejects.toBeInstanceOf(CapacityError);
    // Updating the pending request itself is never refused.
    await s.putRequest({ ...request('r1', t + 1000), federatedSubject: 'idp-sub' });
    expect(await s.getRequest('r1')).toMatchObject({ federatedSubject: 'idp-sub' });
    const taken = await Promise.all([s.takeRequest('r1'), s.takeRequest('r1')]);
    expect(taken.filter(Boolean)).toHaveLength(1);
    await s.putRequest(request('r3', t + 1000));
    t += 2000;
    await s.putRequest(request('r4'));
    expect(await s.getRequest('r3')).toBeUndefined();
    await s.deleteRequest('r4');
    expect(await s.getRequest('r4')).toBeUndefined();
  });

  it('marks codes used, records their family, and sweeps them after the replay grace', async () => {
    const s = await make();
    await s.putCode('code', { subject: 's', clientId: 'c', redirectUri: 'u', codeChallenge: 'x', expiresAt: t + 60_000 });
    expect(await s.redeemCode('code')).toMatchObject({ used: false });
    await s.setCodeFamily('code', 'fam');
    expect(await s.redeemCode('code')).toMatchObject({ used: true, code: { familyId: 'fam' } });
    expect(await s.redeemCode('unknown')).toBeUndefined();
    t += 60_000 + 600_000;
    await s.putCode('other', { subject: 's', clientId: 'c', redirectUri: 'u', codeChallenge: 'x', expiresAt: t + 60_000 });
    expect(await s.redeemCode('code')).toBeUndefined();
  });

  it('rotates a refresh token once, revokes its family for good, and sweeps expired tokens', async () => {
    const s = await make();
    await s.putRefresh('h1', refresh('s', 'fam'));
    const [a, b] = await Promise.all([s.rotateRefresh('h1'), s.rotateRefresh('h1')]);
    expect([a?.used, b?.used].sort()).toEqual([false, true]);
    await s.putRefresh('h2', refresh('s', 'fam'));
    await s.revokeFamily('fam', 's');
    expect(await s.rotateRefresh('h1')).toBeUndefined();
    expect(await s.rotateRefresh('h2')).toBeUndefined();
    // A token of the revoked family put afterwards (a rotation that was in flight) is never usable.
    await s.putRefresh('h3', refresh('s', 'fam'));
    expect(await s.rotateRefresh('h3')).toBeUndefined();
    await s.putRefresh('old', refresh('s', 'other', t + 1000));
    t += 2000;
    await s.putRefresh('new', refresh('s', 'other'));
    expect(await s.rotateRefresh('old')).toBeUndefined();
    expect(await s.rotateRefresh('new')).toMatchObject({ used: false, token: { subject: 's', familyId: 'other' } });
  });

  it('putRefresh says whether it kept the token: not for a revoked family, nor (when asked) for a subject with no account', async () => {
    const s = await make();
    await s.createAccount(account('sub-1', 'ada.l'));
    expect(await s.putRefresh('kept', refresh('sub-1', 'fam'), { requireAccount: true })).toBe(true);
    expect(await s.putRefresh('nobody', refresh('sub-x', 'fam-x'), { requireAccount: true })).toBe(false);
    expect(await s.rotateRefresh('nobody')).toBeUndefined();
    expect(await s.putRefresh('any', refresh('sub-x', 'fam-x'))).toBe(true);
    await s.revokeFamily('fam', 'sub-1');
    expect(await s.putRefresh('late', refresh('sub-1', 'fam'), { requireAccount: true })).toBe(false);
  });

  it('keeps sessions until they expire', async () => {
    const s = await make();
    await s.putSession('sid', { subject: 's', expiresAt: t + 1000 });
    expect(await s.getSession('sid')).toEqual({ subject: 's', expiresAt: t + 1000 });
    t += 2000;
    await s.putSession('sid2', { subject: 's', expiresAt: t + 1000 });
    expect(await s.getSession('sid')).toBeUndefined();
  });

  it('creates an account once per username, of concurrent sign-ups exactly one, and knows its subject', async () => {
    const s = await make();
    const made = await Promise.all([s.createAccount(account('sub-1', 'ada.l')), s.createAccount(account('sub-2', 'ada.l'))]);
    expect(made.filter(Boolean)).toHaveLength(1);
    const kept = await s.getAccount('ada.l');
    expect(kept).toMatchObject({ username: 'ada.l', salt: 'c2FsdA==', hash: 'aGFzaA==' });
    expect(await s.hasAccount(kept!.id)).toBe(true);
    expect(await s.hasAccount('nobody')).toBe(false);
    expect(await s.getAccount('grace.h')).toBeUndefined();
  });

  it('counts, releases and clears attempts, and spends a pairing code once', async () => {
    const s = await make();
    expect(await s.reserveAttempt('k', t, t - 1000, 2)).toBe(true);
    expect(await s.reserveAttempt('k', t + 1, t - 1000, 2)).toBe(true);
    expect(await s.reserveAttempt('k', t + 2, t - 1000, 2)).toBe(false);
    await s.releaseAttempt('k', t + 1);
    expect(await s.reserveAttempt('k', t + 3, t - 1000, 2)).toBe(true);
    await s.clearAttempts('k');
    expect(await s.reserveAttempt('k', t + 4, t - 1000, 1)).toBe(true);
    expect(await s.spendPairingCode('launch')).toBe(true);
    expect(await s.spendPairingCode('launch')).toBe(false);
  });

  it("eraseLearner forgets the learner's account, refresh tokens, revoked families, codes and sessions, and nobody else's", async () => {
    const s = await make();
    await s.createAccount(account('sub-ada', 'ada.l'));
    await s.createAccount(account('sub-grace', 'grace.h'));
    for (const who of ['ada', 'grace']) {
      await s.putRefresh(`r-${who}`, refresh(`sub-${who}`, `fam-${who}`));
      await s.putRefresh(`gone-${who}`, refresh(`sub-${who}`, `revoked-${who}`));
      await s.revokeFamily(`revoked-${who}`, `sub-${who}`);
      await s.putSession(`sid-${who}`, { subject: `sub-${who}`, expiresAt: t + 1000 });
      await s.putCode(`code-${who}`, { subject: `sub-${who}`, clientId: 'c', redirectUri: 'u', codeChallenge: 'x', expiresAt: t + 60_000 });
    }
    await s.eraseLearner('sub-ada');
    expect(await s.getAccount('ada.l')).toBeUndefined();
    expect(await s.hasAccount('sub-ada')).toBe(false);
    expect(await s.rotateRefresh('r-ada')).toBeUndefined();
    expect(await s.getSession('sid-ada')).toBeUndefined();
    expect(await s.redeemCode('code-ada')).toBeUndefined();
    expect(await s.getAccount('grace.h')).toMatchObject({ id: 'sub-grace' });
    expect(await s.rotateRefresh('r-grace')).toMatchObject({ used: false });
    expect(await s.getSession('sid-grace')).toBeDefined();
    expect(await s.redeemCode('code-grace')).toMatchObject({ used: false });
    // The username is free again; signing up with it makes a new learner.
    expect(await s.createAccount(account('sub-ada-2', 'ada.l'))).toBe(true);
  });
});

/** Every file under `dir`, with its mode and contents. */
async function files(dir: string): Promise<{ path: string; mode: number; text: string }[]> {
  const out: { path: string; mode: number; text: string }[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    out.push({ path, mode: (await stat(path)).mode & 0o777, text: await readFile(path, 'utf8') });
  }
  return out;
}

async function subdirModes(dir: string): Promise<number[]> {
  const modes = [(await stat(dir)).mode & 0o777];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isDirectory()) modes.push((await stat(join(e.parentPath, e.name))).mode & 0o777);
  }
  return modes;
}

describe('DirectoryAuthStore', () => {
  it('keeps accounts, clients (in registration order), refresh tokens and revoked families across a restart, and nothing short-lived', async () => {
    const dir = join(await tempDir(), 'auth');
    const s = await DirectoryAuthStore.open(dir, { now, maxClients: 2 });
    await s.createAccount(account('sub-1', 'ada.l'));
    await s.putClient({ clientId: 'old', redirectUris: ['http://127.0.0.1:1/cb'], issuedAt: 1 });
    await s.putClient({ clientId: 'new', clientName: 'Agent', redirectUris: ['http://127.0.0.1:1/cb'], issuedAt: 2 });
    await s.putRefresh('fresh', refresh('sub-1', 'fam'));
    await s.putRefresh('rotated', refresh('sub-1', 'fam'));
    await s.rotateRefresh('rotated');
    await s.putRefresh('stolen', refresh('sub-1', 'bad'));
    await s.revokeFamily('bad', 'sub-1');
    await s.putRequest(request('req'));
    await s.putCode('code', { subject: 'sub-1', clientId: 'c', redirectUri: 'u', codeChallenge: 'x', expiresAt: t + 60_000 });
    await s.putSession('sid', { subject: 'sub-1', expiresAt: t + 1000 });

    const again = await DirectoryAuthStore.open(dir, { now, maxClients: 2 });
    expect(await again.getAccount('ada.l')).toEqual(account('sub-1', 'ada.l'));
    expect(await again.hasAccount('sub-1')).toBe(true);
    expect(await again.getClient('new')).toEqual({ clientId: 'new', clientName: 'Agent', redirectUris: ['http://127.0.0.1:1/cb'], issuedAt: 2 });
    expect(await again.rotateRefresh('rotated')).toMatchObject({ used: true });
    expect(await again.rotateRefresh('fresh')).toMatchObject({ used: false, token: { subject: 'sub-1', familyId: 'fam' } });
    expect(await again.rotateRefresh('stolen')).toBeUndefined();
    await again.putRefresh('late', refresh('sub-1', 'bad'));
    expect(await again.rotateRefresh('late')).toBeUndefined();
    expect(await again.getRequest('req')).toBeUndefined();
    expect(await again.redeemCode('code')).toBeUndefined();
    expect(await again.getSession('sid')).toBeUndefined();
    // The oldest registration is still the first to go after the restart.
    await again.putClient({ clientId: 'third', redirectUris: ['http://127.0.0.1:1/cb'], issuedAt: 3 });
    expect(await again.getClient('old')).toBeUndefined();
    expect(await again.getClient('new')).toBeDefined();
  });

  it('writes files 0600 in folders 0700, names nothing by a username or token, and stores no username', async () => {
    const dir = join(await tempDir(), 'auth');
    const s = await DirectoryAuthStore.open(dir, { now });
    await s.createAccount(account('sub-1', 'ada.lovelace'));
    await s.putClient({ clientId: 'client-xyz', redirectUris: ['http://127.0.0.1:1/cb'], issuedAt: 1 });
    await s.putRefresh('token-hash', refresh('sub-1', 'fam'));
    await s.revokeFamily('other-fam', 'sub-1');
    const all = await files(dir);
    expect(all.length).toBe(4);
    for (const f of all) {
      expect(f.mode).toBe(0o600);
      expect(f.path.slice(dir.length + 1)).toMatch(/^(accounts|clients|refresh|revoked)\/[0-9a-f]{64}\.json$/);
      expect(f.text).not.toContain('ada.lovelace');
    }
    for (const mode of await subdirModes(dir)) expect(mode).toBe(0o700);
  });

  it('concurrent writes of one entry leave on disk what the store holds, and no temporary file', async () => {
    const dir = join(await tempDir(), 'auth');
    const s = await DirectoryAuthStore.open(dir, { now });
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.putClient({ clientId: 'a', clientName: `v${i}`, redirectUris: ['http://127.0.0.1:1/cb'], issuedAt: i })));
    const held = await s.getClient('a');
    await Promise.all([s.putRefresh('h', refresh('sub-1', 'fam')), s.createAccount(account('sub-1', 'ada.l'))]);
    await Promise.all([s.rotateRefresh('h'), s.rotateRefresh('h'), s.putClient({ clientId: 'b', redirectUris: ['http://127.0.0.1:1/cb'], issuedAt: 1 })]);
    const again = await DirectoryAuthStore.open(dir, { now });
    expect(await again.getClient('a')).toEqual(held);
    expect(await again.rotateRefresh('h')).toMatchObject({ used: true });
    expect((await files(dir)).filter((f) => f.path.endsWith('.tmp'))).toEqual([]);
  });

  it('finds the last write of a table of any size (a refresh table can pass 100 000 files)', () => {
    const entries = Array.from({ length: 300_000 }, (_, i) => ({ seq: (i * 7919) % 300_000 }));
    expect(highestSeq(0, entries)).toBe(299_999);
    expect(highestSeq(400_000, entries)).toBe(400_000);
    expect(highestSeq(5, [])).toBe(5);
  });

  it('expired refresh tokens and revoked families are dropped from disk', async () => {
    const dir = join(await tempDir(), 'auth');
    const s = await DirectoryAuthStore.open(dir, { now });
    await s.putRefresh('short', refresh('sub-1', 'fam', t + 1000));
    await s.revokeFamily('bad', 'sub-1');
    t += 31 * DAY;
    await s.putRefresh('next', refresh('sub-1', 'fam2'));
    await s.revokeFamily('bad2', 'sub-1');
    const left = (await files(dir)).map((f) => f.text);
    expect(left).toHaveLength(2);
    expect(left.join('\n')).not.toMatch(/"short"|"bad"/);
    // Expired entries written by an earlier run are dropped when the store opens.
    t += 31 * DAY;
    await DirectoryAuthStore.open(dir, { now });
    expect(await files(dir)).toEqual([]);
  });

  it('a write that fails leaves no partial or temporary file, and the store does not claim what is not on disk', async () => {
    const dir = join(await tempDir(), 'auth');
    const s = await DirectoryAuthStore.open(dir, { now });
    // The account's file name is taken by a folder, so the final rename fails after the temporary file was written.
    await mkdir(join(dir, 'accounts', sha256(sha256('ada.l')) + '.json'));
    await expect(s.createAccount(account('sub-1', 'ada.l'))).rejects.toThrow();
    expect(await s.getAccount('ada.l')).toBeUndefined();
    expect(await s.hasAccount('sub-1')).toBe(false);
    expect((await readdir(join(dir, 'accounts'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    await rm(join(dir, 'accounts', sha256(sha256('ada.l')) + '.json'), { recursive: true });
    expect(await s.createAccount(account('sub-1', 'ada.l'))).toBe(true);
  });

  it('ignores and removes a temporary file a crash left behind', async () => {
    const dir = join(await tempDir(), 'auth');
    const s = await DirectoryAuthStore.open(dir, { now });
    await s.createAccount(account('sub-1', 'ada.l'));
    const stale = join(dir, 'accounts', sha256(sha256('grace.h')) + '.json.0b1c.tmp');
    await writeFile(stale, '{"key":"half');
    const again = await DirectoryAuthStore.open(dir, { now });
    expect(await again.getAccount('ada.l')).toBeDefined();
    expect(await again.getAccount('grace.h')).toBeUndefined();
    expect(await readdir(join(dir, 'accounts'))).toHaveLength(1);
  });

  it('after eraseLearner nothing of the learner is left on disk, before or after a restart', async () => {
    const dir = join(await tempDir(), 'auth');
    const s = await DirectoryAuthStore.open(dir, { now });
    await s.createAccount(account('sub-ada', 'ada.l'));
    await s.putRefresh('ada-token', refresh('sub-ada', 'fam-ada'));
    await s.putRefresh('ada-revoked', refresh('sub-ada', 'fam-ada-2'));
    await s.revokeFamily('fam-ada-2', 'sub-ada');
    await s.createAccount(account('sub-grace', 'grace.h'));
    await s.putRefresh('grace-token', refresh('sub-grace', 'fam-grace'));
    const traces = ['sub-ada', sha256('ada.l'), 'ada-token', 'fam-ada'];
    expect((await files(dir)).map((f) => f.text).join('\n')).toContain('sub-ada');
    await s.eraseLearner('sub-ada');
    const left = await files(dir);
    expect(left).toHaveLength(2);
    for (const f of left) for (const trace of traces) expect(f.text).not.toContain(trace);
    const again = await DirectoryAuthStore.open(dir, { now });
    expect(await again.getAccount('ada.l')).toBeUndefined();
    expect(await again.getAccount('grace.h')).toBeDefined();
    expect(await again.rotateRefresh('grace-token')).toMatchObject({ used: false });
  });
});
