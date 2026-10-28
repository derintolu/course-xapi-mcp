// SPDX-License-Identifier: Apache-2.0
// The authorization server's store in a folder (Node only), for CXM_DATA_DIR: accounts, registered clients,
// refresh tokens and revoked token families survive a restart, so a learner can sign in again to reach or delete a
// server-kept record. Pending requests, codes, sessions, sign-in attempts and spent pairing codes stay in memory.
//
// Layout, under the folder given (`<CXM_DATA_DIR>/auth`, mode 0700):
//   accounts/  clients/  refresh/  revoked/   one file per entry, mode 0600, named by the SHA-256 of its key,
// holding `{ key, seq, value }`. Account keys are the SHA-256 of the username (the username is not stored);
// refresh token keys are the SHA-256 of the token; nothing raw that a client presents is written.
// Every file is written to a temporary file in the same folder, synced, then renamed over the old one.
// One process per folder: the locks here serialise writes inside this process only.
import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createKeyedMutex } from '../custody/mutex.ts';
import { privateDir, syncDir, writeFileAtomic } from '../private-files.ts';
import { MemoryAuthStore, type DurableTable, type MemoryAuthStoreOptions } from './stores.ts';

const TABLES: DurableTable[] = ['accounts', 'clients', 'refresh', 'revoked'];
const ENTRY = /^[0-9a-f]{64}\.json$/;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface EntryFile {
  key: string;
  /** Write order, so clients come back in registration order. */
  seq: number;
  value: unknown;
}

/** The highest `seq` of `entries`, or `start` when that is higher. */
export function highestSeq(start: number, entries: { seq: number }[]): number {
  // A loop, not Math.max(...entries): spreading one argument per file overflows the stack past about 100 000 files.
  let high = start;
  for (const e of entries) if (e.seq > high) high = e.seq;
  return high;
}

/**
 * An AuthStore whose accounts, clients, refresh tokens and revoked families are kept in a folder. It holds the same
 * tables in memory as MemoryAuthStore (so sweeps, caps and the atomic checks are exactly its), loads them when it
 * opens, and writes every change through before the call returns.
 */
export class DirectoryAuthStore extends MemoryAuthStore {
  readonly #dir: string;
  readonly #lock = createKeyedMutex();
  #seq = 0;

  private constructor(dir: string, o: MemoryAuthStoreOptions) {
    super(o);
    this.#dir = dir;
  }

  /** Opens (creating it if needed) the store in `dir`. Expired entries and temporary files a crash left are removed. */
  static async open(dir: string, o: MemoryAuthStoreOptions = {}): Promise<DirectoryAuthStore> {
    const store = new DirectoryAuthStore(dir, o);
    await privateDir(dir);
    for (const table of TABLES) {
      const folder = join(dir, table);
      await privateDir(folder);
      const entries: EntryFile[] = [];
      for (const name of await readdir(folder)) {
        if (name.endsWith('.tmp')) await rm(join(folder, name), { force: true });
        if (!ENTRY.test(name)) continue;
        const entry = JSON.parse(await readFile(join(folder, name), 'utf8')) as EntryFile;
        if (sha256(entry.key) + '.json' !== name) throw new Error(`auth store: ${table}/${name} does not hold the entry its name says`);
        entries.push(entry);
      }
      entries.sort((a, b) => a.seq - b.seq);
      for (const e of entries) store.restore(table, e.key, e.value);
      store.#seq = highestSeq(store.#seq, entries);
    }
    await store.restored();
    return store;
  }

  protected override async changed(table: DurableTable, key: string, current: () => unknown) {
    const file = join(this.#dir, table, sha256(key) + '.json');
    const seq = ++this.#seq;
    // One write at a time per file, each writing what the entry holds when it runs, so the last one wins.
    await this.#lock(file, async () => {
      const value = current();
      if (value === undefined) {
        await rm(file, { force: true });
        await syncDir(dirname(file));
      } else {
        await writeFileAtomic(file, JSON.stringify({ key, seq, value } satisfies EntryFile));
      }
    });
  }
}
