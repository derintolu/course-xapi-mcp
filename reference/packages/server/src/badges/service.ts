// SPDX-License-Identifier: Apache-2.0
// Open Badges 3.0 issuing by the course server (design §11): when it signs (badgeIssuer.signer "course-server", or
// custody server-kept). `onAwards` only records that a badge was earned; the learner claims it on the claim page,
// which binds the recipient, signs the credential and writes `earned`. Reads of the official record also find
// voided earning statements (revoking their credentials) and, in option 1, the LMS's `satisfied` statements.
import { join } from 'node:path';
import {
  ADL_VERBS,
  DEFAULTS,
  RULES_VERSION,
  actorKey,
  type Award,
  type AuthServer,
  type BadgeDecl,
  type BadgeSummary,
  type CourseModel,
  type Custody,
  type LaunchContext,
  type LaunchStore,
  type LearnerRef,
  type LearnerState,
  type SatisfactionEvent,
  type XapiAgent,
  type XapiStatement,
} from '@course-xapi-mcp/core';
import { buildEarned } from '@course-xapi-mcp/core/xapi';
import {
  awardsFor,
  buildCredential,
  createStatusList,
  didDocument,
  didWeb,
  generateKey,
  signCredential,
  statusListCredential,
  type Assessed,
  type Recipient,
  type SigningKey,
} from '@course-xapi-mcp/badges';
import { withLearnerLock } from '../custody/mutex.ts';
import type { AppBadges, BadgeParts } from '../app.ts';
import { DirectoryIssuerStore, MemoryIssuerStore, type AwardRecord, type CredentialRecord, type IssuerStore } from './issuer-store.ts';
import { CLAIM_PATH, STATUS_LIST_PATH, createBadgeRoutes } from './routes.ts';

const VOIDED = 'http://adlnet.gov/expapi/verbs/voided';
/** Added to the criteria in option 1, where the LMS holds the record the badge was earned in. */
const LMS_CRITERIA = "The learner's LMS launched each lesson and holds the official record; this course server issued the badge from the statements that LMS accepted.";
const NOT_EARNED = 'That badge is not earned yet, or its record is not readable right now.';

/** The authority the LRS recorded on a statement, in a form that compares by value; undefined when it has none. */
function authorityKey(s: XapiStatement): string | undefined {
  const authority = (s as XapiStatement & { authority?: unknown }).authority;
  if (authority === undefined || authority === null) return undefined;
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)])) : v;
  return JSON.stringify(sorted(authority));
}

/** The issuer record `get_record` appends in option 1: the `earned` statements and the credential ids. */
export interface IssuerRecordView {
  statements: XapiStatement[];
  credentials: string[];
}

export type BadgeIssuer = AppBadges & { records(l: LearnerRef): Promise<IssuerRecordView> };

export interface BadgeServiceOptions {
  course: CourseModel;
  /** The server's origin; the issuer is its did:web. */
  publicUrl: string;
  issuerName: string;
  /** Ed25519 Multikey whose controller is `didWeb(publicUrl)`. */
  key: SigningKey;
  store: IssuerStore;
  /** The official record holder (the course's custody). */
  custody: Custody;
  auth: AuthServer;
  /** Option 1: the bridge's launches, to find an open session for the registration. */
  launches?: LaunchStore;
  /** ISO 8601 clock and id source, for tests. */
  now?: () => string;
  uuid?: () => string;
}

/** True when this course server signs the course's badges (design §11, "Who signs"). */
export function badgeIssuing(course: CourseModel): boolean {
  if (course.custody === 'practice' || course.badges.length === 0) return false;
  return course.badgeIssuer?.signer === 'course-server' || course.custody === 'server-kept';
}

/** What the official record says right now, as far as badges are concerned; undefined when it cannot be read. */
interface Reading {
  statements: XapiStatement[];
  /** Ids of statements the record holder accepted (in the record, or on its delivery receipt) and that are not voided. */
  present: Set<string>;
}

/** The lessons a badge's evidence covers: how they were assessed. */
function assessedFor(course: CourseModel, badge: BadgeDecl): Assessed {
  const live = Object.values(course.paths).filter((p) => p.status === 'live');
  const keys =
    badge.awardOn === 'au-moveon' ? [badge.for!] : badge.awardOn === 'block-satisfied' ? (course.paths[badge.for!]?.lessons ?? []) : live.flatMap((p) => p.lessons);
  const lessons = keys.map((k) => course.lessons[k]).filter((l) => l !== undefined);
  const rubric = lessons.some((l) => l.checkpoint);
  const checks = lessons.some((l) => l.bug || (l.checkpoint?.checks?.length ?? 0) > 0);
  return rubric && checks ? 'mixed' : rubric ? 'agent-rubric' : 'checks';
}

export function createBadgeService(o: BadgeServiceOptions): BadgeIssuer {
  const { course, custody, store, key } = o;
  const option = custody.option;
  if (option === 'practice') throw new TypeError('practice runs cannot earn badges');
  if (option === 'lms-launched' && !o.launches) throw new TypeError('option 1 badges need the launch store');
  const publicUrl = new URL(o.publicUrl).origin;
  const did = didWeb(publicUrl);
  if (key.controller !== did || !key.id.startsWith(did + '#')) throw new TypeError(`the badge key must belong to ${did}`);
  const now = o.now ?? (() => new Date().toISOString());
  const uuid = o.uuid ?? (() => crypto.randomUUID());
  const listUrl = publicUrl + STATUS_LIST_PATH;
  const badges = new Map(course.badges.map((b) => [b.id, b]));
  const doc = didDocument(did, [{ id: key.id, publicKeyMultibase: key.publicKeyMultibase }]);
  let signedList: { revoked: number; credential: Promise<object> } | undefined;

  /** Option 2 keeps the record under the author LRS's actor for the subject. */
  async function actorOf(l: LearnerRef): Promise<XapiAgent> {
    const actorFor = (custody as Custody & { actorFor?: (subject: string) => Promise<XapiAgent> }).actorFor;
    return actorFor ? actorFor(l.subject) : l.actor;
  }

  /** The learner's credentials, the live one per badge and every one (revoked included). */
  async function credentialsOf(subject: string) {
    const all = await store.credentials(subject);
    return { all, live: new Map(all.filter((c) => !c.revoked).map((c) => [c.badgeId, c])) };
  }

  async function revokeWhere(subject: string, pick: (c: CredentialRecord) => boolean): Promise<number> {
    let n = 0;
    for (const c of await store.credentials(subject)) if (pick(c) && (await store.revoke(c.id))) n++;
    return n;
  }

  /**
   * Option 1: path and course badges from the `satisfied` statements the LMS wrote for this registration. Only the
   * LMS's own count (CXM-BDG-006): the authority the LRS recorded on a `satisfied` must be the one on the LMS's
   * `launched` statements. Statements without an authority give no way to tell who wrote them, so they never count.
   */
  async function fromLmsSatisfied(l: LearnerRef, statements: XapiStatement[]): Promise<void> {
    const events: SatisfactionEvent[] = [];
    const blocks = Object.values(course.paths).filter((p) => p.status === 'live' && p.blockId);
    const lmsAuthorities = new Set(statements.filter((s) => s.verb.id === ADL_VERBS.launched).flatMap((s) => authorityKey(s) ?? []));
    // Oldest first: an any-path badge takes the first block satisfied.
    const ordered = [...statements].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (const s of ordered) {
      if (s.verb.id !== ADL_VERBS.satisfied) continue;
      const by = authorityKey(s);
      if (by === undefined || !lmsAuthorities.has(by)) continue;
      const block = blocks.find((p) => p.blockId === s.object.id);
      if (block) events.push({ type: 'block', pathKey: block.key, statementId: s.id });
      else if (s.object.id === course.id) events.push({ type: 'course', statementId: s.id });
    }
    if (events.length === 0) return;
    let state: LearnerState | undefined;
    try {
      state = (await custody.load(l)).state;
    } catch {
      return;
    }
    if (!state) return;
    const held = new Set((await store.awards(l.subject)).map((a) => a.badgeId));
    for (const a of awardsFor(course, { ...state, awards: [] }, events)) {
      if (badges.get(a.badgeId)?.awardOn === 'au-moveon' || held.has(a.badgeId)) continue;
      // Read from the LMS's own statements: confirmed at once.
      await store.addAward({ subject: l.subject, ...a, earnedAt: now(), confirmed: true });
    }
  }

  /**
   * Reads the official record: revokes credentials whose earning statement was voided, sends `earned` statements
   * the record has not accepted yet (options 2 and 3) and, in option 1, finds path and course badges.
   */
  async function read(l: LearnerRef): Promise<Reading | undefined> {
    let statements: XapiStatement[];
    let receipt: string[];
    try {
      const r = await custody.record(l);
      statements = r.statements;
      receipt = (r.receipt ?? []).map((x) => x.id);
    } catch {
      return undefined;
    }
    const voided = new Set(
      statements.filter((s) => s.verb.id === VOIDED && (s.object as { objectType?: string }).objectType === 'StatementRef').map((s) => s.object.id),
    );
    if (voided.size > 0) {
      await revokeWhere(l.subject, (c) => voided.has(c.earningStatementId));
      for (const a of await store.awards(l.subject)) if (voided.has(a.earningStatementId)) await store.setConfirmed(l.subject, a.badgeId, a.earningStatementId, false);
    }
    const present = new Set([...statements.map((s) => s.id), ...receipt].filter((id) => !voided.has(id)));
    if (option === 'lms-launched') await fromLmsSatisfied(l, statements);
    else {
      for (const c of await store.credentials(l.subject)) {
        if (!c.earnedPending || c.revoked) continue;
        try {
          await custody.deliver(l, [c.earned]);
          await store.setEarnedPending(c.id, false);
        } catch {
          // Sent again on the next read.
        }
      }
    }
    return { statements, present };
  }

  /**
   * Awards the learner holds now: claimed and live, or unclaimed and confirmed. An award is confirmed once the record
   * holder is seen to have accepted its earning statement, and stays so without a live read (option 1: the issuer
   * record keeps it when the LMS token no longer reads), until the statement is found voided.
   */
  async function held(l: LearnerRef) {
    const reading = await read(l);
    const { all, live } = await credentialsOf(l.subject);
    const awards = await store.awards(l.subject);
    for (const a of awards) {
      if (a.confirmed || !reading?.present.has(a.earningStatementId)) continue;
      await store.setConfirmed(l.subject, a.badgeId, a.earningStatementId, true);
      a.confirmed = true;
    }
    // A revoked credential's earning (voided) is never claimed again for that badge; a new earning is. Two badges can
    // share an earning statement (a block's satisfied earns its block-satisfied and any-path badges).
    const spentKey = (badgeId: string, statementId: string) => `${badgeId}\n${statementId}`;
    const spent = new Set(all.map((c) => spentKey(c.badgeId, c.earningStatementId)));
    const unclaimed = awards.filter((a) => !live.has(a.badgeId) && !spent.has(spentKey(a.badgeId, a.earningStatementId)) && a.confirmed);
    return { reading, awards, all, live, unclaimed };
  }

  /** Option 1: the newest launch for the registration, when its session is still open. */
  async function openSession(l: LearnerRef, registration: string): Promise<LaunchContext | undefined> {
    const mine = l.launchId === undefined ? undefined : await o.launches!.get(l.launchId);
    if (!mine) return undefined;
    const c = await o.launches!.latestFor(mine.endpoint, actorKey(mine.actor), registration);
    if (!c || c.terminatedAt !== undefined || c.supersededAt !== undefined) return undefined;
    const at = Date.parse(now());
    if (at - Date.parse(c.tokenFetchedAt) >= DEFAULTS.lmsSessionMaxMs) return undefined;
    if (at - Date.parse(c.lastActivityAt ?? c.initializedAt) >= DEFAULTS.sessionIdleMs) return undefined;
    return c;
  }

  /** Signs and stores the credential, then writes `earned`; `fresh` is false when another claim stored one first. */
  async function issue(l: LearnerRef, a: AwardRecord, badge: BadgeDecl, recipient: Recipient, reading: Reading | undefined): Promise<{ stored: CredentialRecord; fresh: boolean }> {
    const open = option === 'lms-launched' ? await openSession(l, a.registration) : undefined;
    const id = uuid();
    const credentialId = 'urn:uuid:' + id;
    const statusIndex = await store.allocateIndex();
    const issuedAt = now();
    const shown = option === 'lms-launched' ? { ...badge, criteria: { narrative: `${badge.criteria.narrative} ${LMS_CRITERIA}` } } : badge;
    const earning = reading?.statements.find((s) => s.id === a.earningStatementId);
    const unsigned = buildCredential({
      badge: shown,
      issuer: { id: did, name: o.issuerName },
      recipient,
      award: { badgeId: a.badgeId, registration: a.registration, earningStatementId: a.earningStatementId, testedOut: a.testedOut },
      credentialId,
      validFrom: issuedAt,
      status: { id: `${listUrl}#${statusIndex}`, type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: String(statusIndex), statusListCredential: listUrl },
      assessed: assessedFor(course, badge),
      ...(earning?.result?.score ? { score: earning.result.score } : {}),
    });
    const credential = await signCredential(unsigned, key);
    const actor = open ? open.actor : await actorOf(l);
    const earned = buildEarned(
      {
        actor,
        registration: a.registration,
        courseId: course.id,
        language: course.language,
        rulesVersion: RULES_VERSION,
        custody: option,
        practice: false,
        // The cmi5 session (and its contextTemplate) only inside an open LMS session in option 1; otherwise `earned`
        // is the issuer's statement and belongs to no AU session (R50).
        ...(open ? { sessionId: open.sessionId, contextTemplate: open.contextTemplate } : {}),
      },
      { id: badge.id, name: badge.name },
      credentialId,
      a.earningStatementId,
      { id: uuid(), timestamp: issuedAt },
    );
    const stored = await store.addCredential({
      id,
      subject: l.subject,
      badgeId: a.badgeId,
      earningStatementId: a.earningStatementId,
      statusIndex,
      issuedAt,
      credential,
      earned,
      // Option 1 keeps `earned` in the issuer record; options 2 and 3 write it to the official record.
      earnedPending: option !== 'lms-launched',
      revoked: false,
    });
    if (stored.id !== id) return { stored, fresh: false };
    if (option !== 'lms-launched') {
      try {
        await custody.deliver(l, [earned]);
        await store.setEarnedPending(id, false);
      } catch {
        // Sent again on the next read of the record.
      }
    } else if (open) {
      try {
        await custody.deliver({ ...l, launchId: open.launchId, actor: open.actor }, [earned]);
      } catch {
        // The issuer record holds it; the LMS copy is only for its reports.
      }
    }
    return { stored, fresh: true };
  }

  const routes = createBadgeRoutes({
    courseTitle: course.title,
    auth: o.auth,
    didDocument: () => structuredClone(doc),
    async statusList() {
      const revoked = await store.revokedIndexes();
      // Revocation only ever adds bits, so the count says whether the signed copy is current.
      if (signedList?.revoked !== revoked.length) {
        const list = createStatusList(DEFAULTS.statusListLength);
        for (const i of revoked) list.revoke(i);
        const credential = signCredential(statusListCredential({ listUrl, issuer: did, list, validFrom: now() }), key);
        signedList = { revoked: revoked.length, credential };
        credential.catch(() => {
          if (signedList?.credential === credential) signedList = undefined;
        });
      }
      return signedList.credential;
    },
    async overview(l) {
      const h = await held(l);
      return {
        unclaimed: h.unclaimed.map((a) => ({ badgeId: a.badgeId, name: badges.get(a.badgeId)?.name ?? a.badgeId, description: badges.get(a.badgeId)?.description ?? '', earnedAt: a.earnedAt })),
        claimed: h.all.map((c) => ({ credentialId: c.id, name: badges.get(c.badgeId)?.name ?? c.badgeId, revoked: c.revoked })),
      };
    },
    claim(l, badgeId, recipient) {
      // Under the learner's lock: one claim at a time, and no tool call writing to the record meanwhile.
      return withLearnerLock(l.subject, async () => {
        const badge = badges.get(badgeId);
        if (!badge) return { error: NOT_EARNED };
        const h = await held(l);
        const had = h.live.get(badgeId);
        if (had) return { credentialId: had.id, name: badge.name, again: true };
        const a = h.unclaimed.find((x) => x.badgeId === badgeId);
        if (!a) return { error: NOT_EARNED };
        const { stored, fresh } = await issue(l, a, badge, recipient, h.reading);
        return { credentialId: stored.id, name: badge.name, again: !fresh };
      });
    },
    credential: (id) => store.credential(id),
  });

  return {
    claimPage: publicUrl + CLAIM_PATH,
    routes,

    async summaries(l) {
      const h = await held(l);
      const out: BadgeSummary[] = [];
      for (const a of h.awards) {
        const claimed = h.live.has(a.badgeId);
        if (!claimed && !h.unclaimed.includes(a)) continue;
        out.push({ badgeId: a.badgeId, name: badges.get(a.badgeId)?.name ?? a.badgeId, earnedAt: a.earnedAt, claimed });
      }
      return out;
    },

    /** Records eligibility only. Idempotent per learner and badge: it runs before the state is saved, and is retried with it. */
    async onAwards(l, awards: Award[]) {
      if (l.kind !== 'official') return;
      const { live } = await credentialsOf(l.subject);
      const had = new Map((await store.awards(l.subject)).map((a) => [a.badgeId, a]));
      for (const a of awards) {
        if (!badges.has(a.badgeId) || live.has(a.badgeId)) continue;
        const record: AwardRecord = { subject: l.subject, badgeId: a.badgeId, registration: a.registration, earningStatementId: a.earningStatementId, testedOut: a.testedOut, earnedAt: now() };
        const prev = had.get(a.badgeId);
        if (!prev) await store.addAward(record);
        // A retry after a lost save carries a new earning statement: the unclaimed award follows the one saved last.
        else if (prev.earningStatementId !== a.earningStatementId || prev.registration !== a.registration) await store.replaceAward(record);
      }
    },

    /**
     * The record holder accepted these statements (R52: in option 1, "the LMS accepted the delivery"): confirms the
     * learner's awards they earned, so those badges stay listed without a later read. Runs inside the tool call's
     * learner lock and takes no lock itself.
     */
    async onDelivered(l, statementIds) {
      if (l.kind !== 'official') return;
      const ids = new Set(statementIds);
      for (const a of await store.awards(l.subject)) if (!a.confirmed && ids.has(a.earningStatementId)) await store.setConfirmed(l.subject, a.badgeId, a.earningStatementId, true);
    },

    async revokeLearner(subject) {
      // Called inside the record erase's learner lock: it must not take the lock itself. Only the status bits stay.
      return store.eraseLearner(subject);
    },

    async records(l) {
      const all = await store.credentials(l.subject);
      return { statements: all.map((c) => c.earned), credentials: all.map((c) => 'urn:uuid:' + c.id) };
    },
  };
}

/** The badge service the reference binary runs, from the configuration; undefined when the course server does not sign. */
export async function badgesFromConfig(p: BadgeParts, warn: (message: string) => void = (m) => console.warn(`course-xapi-mcp: ${m}`)): Promise<BadgeIssuer | undefined> {
  if (!badgeIssuing(p.course) || !p.auth) return undefined;
  const did = didWeb(p.publicUrl);
  let key: SigningKey;
  if (p.config.badgeKey) {
    const { publicKeyMultibase, secretKeyMultibase } = p.config.badgeKey;
    key = { id: `${did}#${publicKeyMultibase}`, controller: did, publicKeyMultibase, secretKeyMultibase };
  } else {
    key = await generateKey(did);
    warn('CXM_BADGE_KEY is not set: generated a badge signing key for this process only, so badges issued before a restart stop verifying.');
  }
  const now = p.now;
  return createBadgeService({
    course: p.course,
    publicUrl: p.publicUrl,
    issuerName: p.config.badgeIssuerName ?? p.course.badgeIssuer?.name ?? p.course.title,
    key,
    store: p.config.dataDir ? new DirectoryIssuerStore(join(p.config.dataDir, 'issuer')) : new MemoryIssuerStore(),
    custody: p.custody,
    auth: p.auth,
    launches: p.launches,
    ...(now ? { now: () => new Date(now()).toISOString() } : {}),
  });
}
