// SPDX-License-Identifier: Apache-2.0
// What the authorization server keeps: clients, pending authorization requests, codes, refresh tokens,
// browser sessions, accounts and spent pairing codes. Codes, refresh tokens and session ids are stored by
// their SHA-256 hash, never in the clear.

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
  /** Wrong pairing codes typed for this request (launch-paired mode). */
  wrongCodes: number;
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

  putRequest(r: AuthRequest): Promise<void>;
  getRequest(id: string): Promise<AuthRequest | undefined>;
  deleteRequest(id: string): Promise<void>;

  putCode(hash: string, c: CodeRecord): Promise<void>;
  /** Marks the code used and returns it; `used` is true when it had already been redeemed. Undefined when unknown. */
  redeemCode(hash: string): Promise<{ code: CodeRecord; used: boolean } | undefined>;
  setCodeFamily(hash: string, familyId: string): Promise<void>;

  putRefresh(hash: string, r: RefreshRecord): Promise<void>;
  /** Marks the token rotated and returns it; `used` is true when it had already been rotated. Undefined when unknown or revoked. */
  rotateRefresh(hash: string): Promise<{ token: RefreshRecord; used: boolean } | undefined>;
  revokeFamily(familyId: string): Promise<void>;

  putSession(hash: string, s: SessionRecord): Promise<void>;
  getSession(hash: string): Promise<SessionRecord | undefined>;

  /** False when the username is taken. */
  createAccount(a: AccountRecord): Promise<boolean>;
  getAccount(username: string): Promise<AccountRecord | undefined>;
  addSignInFailure(username: string, at: number): Promise<void>;
  signInFailuresSince(username: string, since: number): Promise<number>;

  /** True the first time it is called for a launch, false after. */
  spendPairingCode(launchId: string): Promise<boolean>;
}

/** In-memory AuthStore. Everything is lost on restart. */
export class MemoryAuthStore implements AuthStore {
  readonly #clients = new Map<string, ClientRecord>();
  readonly #requests = new Map<string, AuthRequest>();
  readonly #codes = new Map<string, CodeRecord & { used: boolean }>();
  readonly #refresh = new Map<string, RefreshRecord & { used: boolean }>();
  readonly #revokedFamilies = new Set<string>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #accounts = new Map<string, AccountRecord>();
  readonly #failures = new Map<string, number[]>();
  readonly #spentPairing = new Set<string>();

  async putClient(c: ClientRecord) {
    this.#clients.set(c.clientId, structuredClone(c));
  }
  async getClient(clientId: string) {
    const c = this.#clients.get(clientId);
    return c && structuredClone(c);
  }

  async putRequest(r: AuthRequest) {
    this.#requests.set(r.id, structuredClone(r));
  }
  async getRequest(id: string) {
    const r = this.#requests.get(id);
    return r && structuredClone(r);
  }
  async deleteRequest(id: string) {
    this.#requests.delete(id);
  }

  async putCode(hash: string, c: CodeRecord) {
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

  async putRefresh(hash: string, r: RefreshRecord) {
    this.#refresh.set(hash, { ...structuredClone(r), used: false });
  }
  async rotateRefresh(hash: string) {
    const r = this.#refresh.get(hash);
    if (!r || this.#revokedFamilies.has(r.familyId)) return undefined;
    const used = r.used;
    r.used = true;
    const { used: _, ...token } = structuredClone(r);
    return { token, used };
  }
  async revokeFamily(familyId: string) {
    this.#revokedFamilies.add(familyId);
    for (const [k, r] of this.#refresh) if (r.familyId === familyId) this.#refresh.delete(k);
  }

  async putSession(hash: string, s: SessionRecord) {
    this.#sessions.set(hash, structuredClone(s));
  }
  async getSession(hash: string) {
    const s = this.#sessions.get(hash);
    return s && structuredClone(s);
  }

  async createAccount(a: AccountRecord) {
    if (this.#accounts.has(a.username)) return false;
    this.#accounts.set(a.username, structuredClone(a));
    return true;
  }
  async getAccount(username: string) {
    const a = this.#accounts.get(username);
    return a && structuredClone(a);
  }
  async addSignInFailure(username: string, at: number) {
    const list = this.#failures.get(username) ?? [];
    list.push(at);
    this.#failures.set(username, list);
  }
  async signInFailuresSince(username: string, since: number) {
    const list = (this.#failures.get(username) ?? []).filter((at) => at >= since);
    this.#failures.set(username, list);
    return list.length;
  }

  async spendPairingCode(launchId: string) {
    if (this.#spentPairing.has(launchId)) return false;
    this.#spentPairing.add(launchId);
    return true;
  }
}
