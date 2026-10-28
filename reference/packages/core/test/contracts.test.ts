// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  CXM_ACTIVITY_TYPES,
  CXM_EXT,
  CXM_VERBS,
  CXM_XML_NS,
  ERROR_HELP_BASE,
  PRACTICE_CATEGORY,
  PRACTICE_HOMEPAGE,
  PROFILE_ID,
  PROFILE_VERSION_IRI,
  SITE,
  TOOL_NAMES,
  activityIds,
} from '../src/constants.ts';
import { actorKey, type LaunchContext } from '../src/custody.ts';
import { ISSUE_CATALOG, makeIssue } from '../src/issues.ts';
import { LAUNCH_RETENTION_MS, MemoryLaunchStore } from '../src/launch-store.ts';
import { StoreError } from '../src/errors.ts';
import * as core from '../src/index.ts';

const allIris = (): string[] => [
  CXM_XML_NS,
  PROFILE_ID,
  PROFILE_VERSION_IRI,
  PRACTICE_CATEGORY,
  PRACTICE_HOMEPAGE,
  ERROR_HELP_BASE,
  ...Object.values(CXM_VERBS),
  ...Object.values(CXM_ACTIVITY_TYPES),
  ...Object.values(CXM_EXT),
];

describe('shared contracts', () => {
  it('puts every cxm IRI under the site', () => {
    for (const v of allIris()) expect(v.startsWith(SITE + '/')).toBe(true);
  });
  it('derives activity ids from the publisher AU id', () => {
    expect(activityIds.au('https://e.org/c/l1')).toBe('https://e.org/c/l1/au');
    expect(activityIds.file('https://e.org/c/l1', 'a b.json')).toBe('https://e.org/c/l1/files/a%20b.json');
  });
  it('has unique issue codes in the reserved ranges, each with a fix', () => {
    for (const [code, e] of Object.entries(ISSUE_CATALOG)) {
      expect(code).toMatch(/^CXM-PKG-(0\d\d|1\d\d|2\d\d)$/);
      expect(e.fix.length).toBeGreaterThan(10);
    }
    const range = (from: number, to: number, sev: string) =>
      Array.from({ length: to - from + 1 }, (_, i) => ['CXM-PKG-' + String(from + i).padStart(3, '0'), sev]);
    const expected = Object.fromEntries([...range(1, 34, 'error'), ['CXM-PKG-100', 'info'], ...range(201, 206, 'warning')]);
    expect(Object.keys(expected)).toHaveLength(41);
    expect(Object.fromEntries(Object.entries(ISSUE_CATALOG).map(([c, e]) => [c, e.severity]))).toEqual(expected);
    expect(makeIssue('CXM-PKG-014', { file: 'cxm/lessons/a.json', pointer: '/bug/explanation' }, 'm').help).toBe(SITE + '/errors/CXM-PKG-014');
  });
  it('lists 16 tools in order', () =>
    expect(TOOL_NAMES).toEqual([
      'get_status',
      'list_paths',
      'start_placement',
      'choose_placement',
      'get_lesson',
      'next_beat',
      'check_code',
      'reveal_bug',
      'submit_checkpoint',
      'choose_branch',
      'end_session',
      'get_record',
      'get_badges',
      'restart_course',
      'resume_practice',
      'delete_practice_record',
    ]));
});

describe('launch contract', () => {
  it('keys an actor by its inverse functional identifier', () => {
    expect(actorKey({ account: { homePage: 'https://lms.example', name: 'u1' } })).toBe('https://lms.example|u1');
    expect(actorKey({ name: 'A', mbox: 'mailto:a@example.org' })).toBe('mailto:a@example.org');
    expect(actorKey({ mbox_sha1sum: 'abc' })).toBe('abc');
    expect(actorKey({ openid: 'https://id.example/a' })).toBe('https://id.example/a');
    expect(actorKey({ mbox: 'mailto:a@example.org', account: { homePage: 'https://h', name: 'n' } })).toBe('https://h|n');
    expect(() => actorKey({ name: 'nobody' })).toThrow();
  });

  const ctx = (launchId: string, o: Partial<LaunchContext> = {}): LaunchContext => ({
    launchId,
    endpoint: 'https://lrs.example/xapi/',
    authToken: 't',
    tokenFetchedAt: '2026-10-27T10:00:00.000Z',
    actor: { account: { homePage: 'https://lms.example', name: 'u1' } },
    registration: 'r1',
    activityId: 'https://e.org/c/l1',
    auId: 'https://e.org/c/l1',
    auKey: 'l1',
    contextTemplate: { contextActivities: {}, extensions: {} },
    launchMode: 'Normal',
    moveOn: 'Completed',
    sessionId: 's-' + launchId,
    initializedAt: '2026-10-27T10:00:00.000Z',
    pairingCode: 'CODE' + launchId.toUpperCase(),
    pairingExpiresAt: '2026-10-27T10:10:00.000Z',
    ...o,
  });

  it('MemoryLaunchStore is exported from the core barrel', () => expect(core.MemoryLaunchStore).toBe(MemoryLaunchStore));

  it('MemoryLaunchStore stores, finds by pairing code and updates copies', async () => {
    const s = new MemoryLaunchStore();
    const a = ctx('a1');
    await s.put(a);
    a.auKey = 'mutated';
    expect((await s.get('a1'))?.auKey).toBe('l1');
    expect((await s.byPairingCode('CODEA1'))?.launchId).toBe('a1');
    expect(await s.byPairingCode('NOPE')).toBeUndefined();
    expect(await s.get('missing')).toBeUndefined();
    await s.update('a1', { lastActivityAt: '2026-10-27T10:05:00.000Z', supersededAt: '2026-10-27T10:06:00.000Z' });
    const got = await s.get('a1');
    expect(got?.lastActivityAt).toBe('2026-10-27T10:05:00.000Z');
    expect(got?.supersededAt).toBe('2026-10-27T10:06:00.000Z');
    got!.auKey = 'mutated';
    expect((await s.get('a1'))?.auKey).toBe('l1');
    await expect(s.update('missing', {})).rejects.toThrow();
  });

  it('MemoryLaunchStore forgets an ended launch a retention window after it ended, and caps how many it holds (R62)', async () => {
    let t = Date.parse('2026-10-27T10:00:00.000Z');
    const iso = (ms: number) => new Date(ms).toISOString();
    const s = new MemoryLaunchStore({ now: () => t, max: 3 });
    await s.put(ctx('ended'));
    await s.update('ended', { terminatedAt: iso(t) });
    await s.put(ctx('superseded'));
    await s.update('superseded', { supersededAt: iso(t + 1000) });
    await s.put(ctx('live'));
    // Just inside the window: kept.
    t += LAUNCH_RETENTION_MS - 1;
    await s.put(ctx('live2')); // at the cap: the oldest ended launch makes way
    expect(await s.get('ended')).toBeUndefined();
    expect(await s.get('superseded')).toBeDefined();
    // After the window: the superseded one is swept on the next put.
    t += 2000;
    await s.put(ctx('live3'));
    expect(await s.get('superseded')).toBeUndefined();
    expect((await s.get('live'))?.launchId).toBe('live');
    // Full of live launches: a new one is refused.
    await expect(s.put(ctx('one-too-many'))).rejects.toThrow(StoreError);
    expect(await s.get('one-too-many')).toBeUndefined();
  });

  it('MemoryLaunchStore returns the newest launch for (endpoint, actor, registration[, AU])', async () => {
    const s = new MemoryLaunchStore();
    const key = 'https://lms.example|u1';
    await s.put(ctx('a1', { initializedAt: '2026-10-27T10:00:00.000Z' }));
    await s.put(ctx('b1', { auKey: 'l2', auId: 'https://e.org/c/l2', initializedAt: '2026-10-27T10:02:00.000Z' }));
    await s.put(ctx('a2', { initializedAt: '2026-10-27T10:01:00.000Z' }));
    await s.put(ctx('x1', { registration: 'r2', initializedAt: '2026-10-27T11:00:00.000Z' }));
    expect((await s.latestFor('https://lrs.example/xapi/', key, 'r1'))?.launchId).toBe('b1');
    expect((await s.latestFor('https://lrs.example/xapi/', key, 'r1', 'l1'))?.launchId).toBe('a2');
    expect(await s.latestFor('https://lrs.example/xapi/', key, 'r1', 'l9')).toBeUndefined();
    expect(await s.latestFor('https://other.example/', key, 'r1')).toBeUndefined();
    expect(await s.latestFor('https://lrs.example/xapi/', 'mailto:x@example.org', 'r1')).toBeUndefined();
  });
});
