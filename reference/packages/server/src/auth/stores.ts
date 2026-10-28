// SPDX-License-Identifier: Apache-2.0
// What the authorization server keeps: clients, pending authorization requests, codes, refresh tokens,
// browser sessions, accounts and spent pairing codes. Codes, refresh tokens and session ids are stored by
// their SHA-256 hash, never in the clear.
import { createHash } from 'node:crypto';
import { DEFAULTS } from '@course-xapi-mcp/core';

export interface ClientRecord {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  issuedAt: number;
}

/** A validated authorization request waiting for the learner to sign in. */
export interface AuthRequest {
  id: string;
  clientId: string;
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  expiresAt: number;
  /** SHA-256 of the `cxm_areq` browser cookie the request was opened with; later steps must carry it. */
  browser: string;
  /** Federated mode: the identity provider's subject, waiting for the learner's consent. */
  federatedSubject?: string;
}

/** Who a code, refresh token or session belongs to. */
export interface Grant {
  subject: string;
  launchId?: string;
}

export interface CodeRecord extends Grant {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
  /** The refresh token family issued when the code was redeemed; replaying the code revokes it. */
  familyId?: string;
}

export interface RefreshRecord extends Grant {
  clientId: string;
  familyId: string;
  expiresAt: number;
}

export interface SessionRecord extends Grant {
  expiresAt: number;
}

export interface AccountRecord {
  /** The learner's subject: random, never the username. */
  id: string;
  username: string;
  salt: string;
  hash: string;
}

export interface AuthStore {
  putClient(c: ClientRecord): Promise<void>;
  getClient(clientId: string): Promise<ClientRecord | undefined>;

  /** Throws CapacityError when too many requests are pending to take a new one. */
  putRequest(r: AuthRequest): Promise<void>;
  getRequest(id: string): Promise<AuthRequest | undefined>;
  deleteRequest(id: string): Promise<void>;
  /** Atomically removes and returns the request: of concurrent callers, exactly one gets it. */
  takeRequest(id: string): Promise<AuthRequest | undefined>;

  putCode(hash: string, c: CodeRecord): Promise<void>;
  /** Marks the code used and returns it; `used` is true when it had already been redeemed. Undefined when unknown. */
  redeemCode(hash: string): Promise<{ code: CodeRecord; used: boolean } | undefined>;
  setCodeFamily(hash: string, familyId: string): Promise<void>;

  /**
   * Keeps the token and returns true. Returns false and keeps nothing when its family is revoked, or when
   * `requireAccount` is set and the subject has no account (it was erased while the token was being issued).
   */
  putRefresh(hash: string, r: RefreshRecord, o?: { requireAccount?: boolean }): Promise<boolean>;
  /** Marks the token rotated and returns it; `used` is true when it had already been rotated. Undefined when unknown or revoked. */
  rotateRefresh(hash: string): Promise<{ token: RefreshRecord; used: boolean } | undefined>;
  /** Drops the family's refresh tokens and refuses any later one of it; `subject` is whose family it is. */
  revokeFamily(familyId: string, subject: string): Promise<void>;

  putSession(hash: string, s: SessionRecord): Promise<void>;
  getSession(hash: string): Promise<SessionRecord | undefined>;

  /** False when the username is taken. */
  createAccount(a: AccountRecord): Promise<boolean>;
  getAccount(username: string): Promise<AccountRecord | undefined>;
  /** True while an account with this subject exists. */
  hasAccount(subject: string): Promise<boolean>;
  /**
   * Atomically: if fewer than `max` attempts for `key` are recorded at or after `since`, records one at `at`
   * and returns true; otherwise records nothing and returns false.
   */
  reserveAttempt(key: string, at: number, since: number, max: number): Promise<boolean>;
  /** Removes one attempt recorded for `key` at `at` (an attempt that turned out to succeed). */
  releaseAttempt(key: string, at: number): Promise<void>;
  /** Forgets every attempt recorded for `key`. */
  clearAttempts(key: string): Promise<void>;

  /** True the first time it is called for a launch, false after. */
  spendPairingCode(launchId: string): Promise<boolean>;

  /**
   * The learner's record was erased: forgets their account, refresh tokens, revoked families, codes and browser
   * sessions. Takes no learner lock (the caller holds it).
   */
  eraseLearner(subject: string): Promise<void>;
}

/** The store is full right now: answered as "try again later" (HTTP 503), never by dropping someone else's entry. */
export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapacityError';
  }
}

/** Pending authorization requests held at once (each lives 10 min); over it, `putRequest` throws CapacityError. */
export const MAX_PENDING_REQUESTS = 10_000;
/** Dynamically registered clients held at once; over it, the oldest registration is forgotten (it can register again). */
export const MAX_REGISTERED_CLIENTS = 10_000;
/** An expired authorization code is kept this much longer, so a late replay is still recognised and revokes its tokens. */
export const CODE_REPLAY_GRACE_MS = 600_000;
/** A revoked family is remembered as long as a token of it could live (no token of it is kept after the revocation). */
const REVOKED_FAMILY_TTL_MS = DEFAULTS.refreshTokenTtlS * 1000;

/** The parts of an AuthStore that a durable store keeps across restarts; the rest is short-lived and stays in memory. */
export type DurableTable = 'clients' | 'refresh' | 'revoked' | 'accounts';

/** An account as kept: by the SHA-256 of its username, which is not stored. */
export type StoredAccount = Omit<AccountRecord, 'username'>;
/** A revoked refresh token family: whose it was, and until when a token of it could still turn up. */
export interface RevokedFamily {
  subject: string;
  expiresAt: number;
}

const usernameKey = (username: string) => createHash('sha256').update(username).digest('hex');

export interface MemoryAuthStoreOptions {
  /** Milliseconds since the epoch, for sweeping expired entries. Default `Date.now`. */
  now?: () => number;
  /** Default MAX_PENDING_REQUESTS. */
  maxRequests?: number;
  /** Default MAX_REGISTERED_CLIENTS. */
  maxClients?: number;
}

/** Drops the entries `expired` says are past their time. */
function sweep<V>(map: Map<string, V>, expired: (v: V) => boolean) {
  for (const [k, v] of map) if (expired(v)) map.delete(k);
}

/**
 * In-memory AuthStore. Everything is lost on restart. Expired requests, codes, refresh tokens, revoked families and
 * sessions are swept whenever a new one is put, and pending requests and registered clients are capped, so
 * unauthenticated traffic cannot grow it without bound.
 *
 * Every change to a durable table is reported to `changed`, which does nothing here; a durable store overrides it
 * to write the entry through, so it shares these semantics exactly.
 */
export class MemoryAuthStore implements AuthStore {
  readonly #clients = new Map<string, ClientRecord>();
  readonly #requests = new Map<string, AuthRequest>();
  readonly #codes = new Map<string, CodeRecord & { used: boolean }>();
  readonly #refresh = new Map<string, RefreshRecord & { used: boolean }>();
  readonly #revoked = new Map<string, RevokedFamily>();
  readonly #sessions = new Map<string, SessionRecord>();
  /** By the SHA-256 of the username. */
  readonly #accounts = new Map<string, StoredAccount>();
  /** Subject to the key of its account. */
  readonly #subjects = new Map<string, string>();
  readonly #attempts = new Map<string, number[]>();
  readonly #spentPairing = new Set<string>();
  readonly #now: () => number;
  readonly #maxRequests: number;
  readonly #maxClients: number;

  constructor(o: MemoryAuthStoreOptions = {}) {
    this.#now = o.now ?? Date.now;
    this.#maxRequests = o.maxRequests ?? MAX_PENDING_REQUESTS;
    this.#maxClients = o.maxClients ?? MAX_REGISTERED_CLIENTS;
  }

  /**
   * An entry of a durable table was set or deleted; `current` reads what it holds now (undefined once deleted), so a
   * write that runs late writes the latest. A rejection means the change is not kept. Nothing to do in memory.
   */
  protected async changed(_table: DurableTable, _key: string, _current: () => unknown): Promise<void> {}

  /** Puts an entry read back from durable storage (clients in registration order), before the store is used. */
  protected restore(table: DurableTable, key: string, value: unknown) {
    if (table === 'clients') this.#clients.set(key, value as ClientRecord);
    else if (table === 'refresh') this.#refresh.set(key, value as RefreshRecord & { used: boolean });
    else if (table === 'revoked') this.#revoked.set(key, value as RevokedFamily);
    else {
      this.#accounts.set(key, value as StoredAccount);
      this.#subjects.set((value as StoredAccount).id, key);
    }
  }

  /** After `restore`: drops what expired meanwhile, and tokens of a family revoked before they could be dropped. */
  protected async restored() {
    const now = this.#now();
    const revoked = [...this.#revoked].filter(([, f]) => f.expiresAt <= now).map(([k]) => k);
    for (const k of revoked) this.#revoked.delete(k);
    const refresh = [...this.#refresh].filter(([, r]) => r.expiresAt <= now || this.#revoked.has(r.familyId)).map(([k]) => k);
    for (const k of refresh) this.#refresh.delete(k);
    await this.#deleted('refresh', refresh);
    await this.#deleted('revoked', revoked);
  }

  /** Reports a deletion of each key in `keys`, one after the other. */
  async #deleted(table: DurableTable, keys: string[]) {
    for (const k of keys) await this.changed(table, k, () => undefined);
  }

  async putClient(c: ClientRecord) {
    const evicted: string[] = [];
    this.#clients.delete(c.clientId);
    // Oldest registration first (a Map keeps insertion order).
    while (this.#clients.size >= this.#maxClients) {
      const oldest = this.#clients.keys().next().value!;
      this.#clients.delete(oldest);
      evicted.push(oldest);
    }
    const kept = structuredClone(c);
    this.#clients.set(c.clientId, kept);
    try {
      await this.changed('clients', c.clientId, () => this.#clients.get(c.clientId));
    } catch (e) {
      if (this.#clients.get(c.clientId) === kept) this.#clients.delete(c.clientId);
      throw e;
    }
    await this.#deleted('clients', evicted);
  }
  async getClient(clientId: string) {
    const c = this.#clients.get(clientId);
    return c && structuredClone(c);
  }

  async putRequest(r: AuthRequest) {
    const now = this.#now();
    sweep(this.#requests, (x) => x.expiresAt <= now);
    if (!this.#requests.has(r.id) && this.#requests.size >= this.#maxRequests) throw new CapacityError('too many sign-ins are in progress');
    this.#requests.set(r.id, structuredClone(r));
  }
  async getRequest(id: string) {
    const r = this.#requests.get(id);
    return r && structuredClone(r);
  }
  async deleteRequest(id: string) {
    this.#requests.delete(id);
  }
  async takeRequest(id: string) {
    const r = this.#requests.get(id);
    this.#requests.delete(id);
    return r;
  }

  async putCode(hash: string, c: CodeRecord) {
    const now = this.#now();
    sweep(this.#codes, (x) => x.expiresAt + CODE_REPLAY_GRACE_MS <= now);
    this.#codes.set(hash, { ...structuredClone(c), used: false });
  }
  async redeemCode(hash: string) {
    const c = this.#codes.get(hash);
    if (!c) return undefined;
    const used = c.used;
    c.used = true;
    const { used: _, ...code } = structuredClone(c);
    return { code, used };
  }
  async setCodeFamily(hash: string, familyId: string) {
    const c = this.#codes.get(hash);
    if (c) c.familyId = familyId;
  }

  async putRefresh(hash: string, r: RefreshRecord, o: { requireAccount?: boolean } = {}) {
    const now = this.#now();
    const expired = [...this.#refresh].filter(([, x]) => x.expiresAt <= now).map(([k]) => k);
    for (const k of expired) this.#refresh.delete(k);
    // Checked in the same step as the token is added, so an erase either comes first (and the token is refused)
    // or finds the token and deletes it.
    const keep = !this.#revoked.has(r.familyId) && (!o.requireAccount || this.#subjects.has(r.subject));
    if (keep) {
      const kept = { ...structuredClone(r), used: false };
      this.#refresh.set(hash, kept);
      try {
        await this.changed('refresh', hash, () => this.#refresh.get(hash));
      } catch (e) {
        if (this.#refresh.get(hash) === kept) this.#refresh.delete(hash);
        throw e;
      }
    }
    await this.#deleted('refresh', expired);
    return keep;
  }
  async rotateRefresh(hash: string) {
    const r = this.#refresh.get(hash);
    if (!r || this.#revoked.has(r.familyId)) return undefined;
    const used = r.used;
    r.used = true;
    const { used: _, ...token } = structuredClone(r);
    if (!used) await this.changed('refresh', hash, () => this.#refresh.get(hash));
    return { token, used };
  }
  async revokeFamily(familyId: string, subject: string) {
    const now = this.#now();
    const expired = [...this.#revoked].filter(([, f]) => f.expiresAt <= now).map(([k]) => k);
    for (const k of expired) this.#revoked.delete(k);
    this.#revoked.set(familyId, { subject, expiresAt: now + REVOKED_FAMILY_TTL_MS });
    const dropped = [...this.#refresh].filter(([, r]) => r.familyId === familyId).map(([k]) => k);
    for (const k of dropped) this.#refresh.delete(k);
    // The revocation is kept before its tokens are deleted, so a crash in between leaves none of them usable.
    await this.changed('revoked', familyId, () => this.#revoked.get(familyId));
    await this.#deleted('refresh', dropped);
    await this.#deleted('revoked', expired);
  }

  async putSession(hash: string, s: SessionRecord) {
    const now = this.#now();
    sweep(this.#sessions, (x) => x.expiresAt <= now);
    this.#sessions.set(hash, structuredClone(s));
  }
  async getSession(hash: string) {
    const s = this.#sessions.get(hash);
    return s && structuredClone(s);
  }

  async createAccount(a: AccountRecord) {
    const key = usernameKey(a.username);
    if (this.#accounts.has(key)) return false;
    const { username: _, ...kept } = structuredClone(a);
    this.#accounts.set(key, kept);
    this.#subjects.set(a.id, key);
    try {
      await this.changed('accounts', key, () => this.#accounts.get(key));
    } catch (e) {
      if (this.#accounts.get(key) === kept) {
        this.#accounts.delete(key);
        this.#subjects.delete(a.id);
      }
      throw e;
    }
    return true;
  }
  async getAccount(username: string) {
    const a = this.#accounts.get(usernameKey(username));
    return a && { ...structuredClone(a), username };
  }
  async hasAccount(subject: string) {
    return this.#subjects.has(subject);
  }
  async reserveAttempt(key: string, at: number, since: number, max: number) {
    const list = (this.#attempts.get(key) ?? []).filter((t) => t >= since);
    const ok = list.length < max;
    if (ok) list.push(at);
    if (list.length) this.#attempts.set(key, list);
    else this.#attempts.delete(key);
    return ok;
  }
  async releaseAttempt(key: string, at: number) {
    const list = this.#attempts.get(key);
    const i = list?.indexOf(at) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
  }

  async clearAttempts(key: string) {
    this.#attempts.delete(key);
  }

  async spendPairingCode(launchId: string) {
    if (this.#spentPairing.has(launchId)) return false;
    this.#spentPairing.add(launchId);
    return true;
  }

  async eraseLearner(subject: string) {
    const ofLearner = <V extends { subject: string }>(map: Map<string, V>) => {
      const keys = [...map].filter(([, v]) => v.subject === subject).map(([k]) => k);
      for (const k of keys) map.delete(k);
      return keys;
    };
    ofLearner(this.#codes);
    ofLearner(this.#sessions);
    const refresh = ofLearner(this.#refresh);
    const revoked = ofLearner(this.#revoked);
    const account = this.#subjects.get(subject);
    this.#subjects.delete(subject);
    if (account) this.#accounts.delete(account);
    // The account's file last: if a delete fails part way, the account is gone from this process but still on disk,
    // so after a restart the learner can sign in and delete again.
    await this.#deleted('refresh', refresh);
    await this.#deleted('revoked', revoked);
    if (account) await this.#deleted('accounts', [account]);
  }
}
