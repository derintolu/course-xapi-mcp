// SPDX-License-Identifier: Apache-2.0
// The course server's issuer record: badges earned (awards), credentials issued at claim time, and the bits of
// the revocation status list. A credential holds only the recipient's DID, or the hash and salt of an email.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULTS, type XapiStatement } from '@course-xapi-mcp/core';
import { createKeyedMutex } from '../custody/mutex.ts';

/** A badge the learner earned, not yet or already claimed. One per learner subject and badge. */
export interface AwardRecord {
  subject: string;
  badgeId: string;
  registration: string;
  earningStatementId: string;
  testedOut: number;
  earnedAt: string;
}

/** A signed credential. One per learner subject and badge. */
export interface CredentialRecord {
  /** The credential's UUID (its id is `urn:uuid:` + this). */
  id: string;
  subject: string;
  badgeId: string;
  earningStatementId: string;
  statusIndex: number;
  issuedAt: string;
  /** The signed OpenBadgeCredential. */
  credential: object;
  /** The `earned` statement written for it. */
  earned: XapiStatement;
  /** True while the official record has not accepted `earned` (options 2 and 3; sent again on the next read). */
  earnedPending: boolean;
  revoked: boolean;
}

export interface IssuerStore {
  awards(subject: string): Promise<AwardRecord[]>;
  /** Adds the award; false (and nothing changes) when the subject already has one for this badge. */
  addAward(a: AwardRecord): Promise<boolean>;
  /** Replaces the subject's award for `a.badgeId` (it must exist). */
  replaceAward(a: AwardRecord): Promise<void>;
  /** Forgets every award of the subject (credentials stay, for their status). */
  deleteAwards(subject: string): Promise<void>;
  credentials(subject: string): Promise<CredentialRecord[]>;
  credential(id: string): Promise<CredentialRecord | undefined>;
  /** Stores `c` unless the subject already has a credential for this badge; returns the one stored. */
  addCredential(c: CredentialRecord): Promise<CredentialRecord>;
  setEarnedPending(id: string, pending: boolean): Promise<void>;
  /** Marks the credential revoked and sets its status bit; false when it already was. */
  revoke(id: string): Promise<boolean>;
  /** A random status list index never handed out before. */
  allocateIndex(): Promise<number>;
  revokedIndexes(): Promise<number[]>;
}

interface IssuerData {
  awards: AwardRecord[];
  credentials: CredentialRecord[];
  /** Every status list index handed out. */
  allocated: number[];
  revoked: number[];
}

const empty = (): IssuerData => ({ awards: [], credentials: [], allocated: [], revoked: [] });

/** The operations on the data, shared by both stores; `tx` gives each one the data to read or change. */
abstract class BaseIssuerStore implements IssuerStore {
  readonly #length: number;

  constructor(length: number) {
    this.#length = length;
  }

  protected abstract tx<T>(write: boolean, fn: (d: IssuerData) => T): Promise<T>;

  awards(subject: string) {
    return this.tx(false, (d) => structuredClone(d.awards.filter((a) => a.subject === subject)));
  }

  addAward(a: AwardRecord) {
    return this.tx(true, (d) => {
      if (d.awards.some((x) => x.subject === a.subject && x.badgeId === a.badgeId)) return false;
      d.awards.push(structuredClone(a));
      return true;
    });
  }

  replaceAward(a: AwardRecord) {
    return this.tx(true, (d) => {
      const i = d.awards.findIndex((x) => x.subject === a.subject && x.badgeId === a.badgeId);
      if (i >= 0) d.awards[i] = structuredClone(a);
    });
  }

  deleteAwards(subject: string) {
    return this.tx(true, (d) => {
      d.awards = d.awards.filter((a) => a.subject !== subject);
    });
  }

  credentials(subject: string) {
    return this.tx(false, (d) => structuredClone(d.credentials.filter((c) => c.subject === subject)));
  }

  credential(id: string) {
    return this.tx(false, (d) => structuredClone(d.credentials.find((c) => c.id === id)));
  }

  addCredential(c: CredentialRecord) {
    return this.tx(true, (d) => {
      const had = d.credentials.find((x) => x.subject === c.subject && x.badgeId === c.badgeId);
      if (had) return structuredClone(had);
      d.credentials.push(structuredClone(c));
      return structuredClone(c);
    });
  }

  setEarnedPending(id: string, pending: boolean) {
    return this.tx(true, (d) => {
      const c = d.credentials.find((x) => x.id === id);
      if (c) c.earnedPending = pending;
    });
  }

  revoke(id: string) {
    return this.tx(true, (d) => {
      const c = d.credentials.find((x) => x.id === id);
      if (!c || c.revoked) return false;
      c.revoked = true;
      if (!d.revoked.includes(c.statusIndex)) d.revoked.push(c.statusIndex);
      return true;
    });
  }

  allocateIndex() {
    return this.tx(true, (d) => {
      if (d.allocated.length >= this.#length) throw new Error('the badge status list is full');
      const used = new Set(d.allocated);
      let i: number;
      do i = randomInt(this.#length);
      while (used.has(i));
      d.allocated.push(i);
      return i;
    });
  }

  revokedIndexes() {
    return this.tx(false, (d) => [...d.revoked]);
  }
}

/** The issuer record in memory: lost on restart, for tests and demos. */
export class MemoryIssuerStore extends BaseIssuerStore {
  readonly #data = empty();

  constructor(length: number = DEFAULTS.statusListLength) {
    super(length);
  }

  protected async tx<T>(_write: boolean, fn: (d: IssuerData) => T): Promise<T> {
    return fn(this.#data);
  }
}

/** The issuer record in a folder (Node only): one JSON file, rewritten through a temporary file and a rename. */
export class DirectoryIssuerStore extends BaseIssuerStore {
  readonly #file: string;
  readonly #dir: string;
  readonly #lock = createKeyedMutex();

  constructor(dir: string, length: number = DEFAULTS.statusListLength) {
    super(length);
    this.#dir = dir;
    this.#file = join(dir, 'issuer.json');
  }

  protected tx<T>(write: boolean, fn: (d: IssuerData) => T): Promise<T> {
    return this.#lock(this.#file, async () => {
      let data: IssuerData;
      try {
        data = JSON.parse(await readFile(this.#file, 'utf8')) as IssuerData;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        data = empty();
      }
      const out = fn(data);
      if (write) {
        await mkdir(this.#dir, { recursive: true });
        const tmp = `${this.#file}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify(data));
        await rename(tmp, this.#file);
      }
      return out;
    });
  }
}
