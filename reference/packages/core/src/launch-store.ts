// SPDX-License-Identifier: Apache-2.0
// In-memory LaunchStore for the launch bridge (option 1) and tests. Launches are lost on restart.
import { actorKey, type LaunchContext, type LaunchStore } from './custody.ts';
import { StoreError } from './errors.ts';

/** An ended (terminated or superseded) launch is kept this long, so its record and badges stay reachable a while. */
export const LAUNCH_RETENTION_MS = 24 * 3600_000;
/** Launches held at once; at the cap the oldest ended one makes way, and with none ended a new launch is refused. */
export const MAX_LAUNCHES = 100_000;

const endedAt = (c: LaunchContext) => {
  const at = c.terminatedAt ?? c.supersededAt;
  return at === undefined ? undefined : Date.parse(at);
};

export class MemoryLaunchStore implements LaunchStore {
  readonly #launches = new Map<string, LaunchContext>();
  readonly #now: () => number;
  readonly #max: number;

  /** `now`: milliseconds since the epoch (default `Date.now`); `max`: default MAX_LAUNCHES. */
  constructor(o: { now?: () => number; max?: number } = {}) {
    this.#now = o.now ?? Date.now;
    this.#max = o.max ?? MAX_LAUNCHES;
  }

  async put(c: LaunchContext): Promise<void> {
    const now = this.#now();
    for (const [id, x] of this.#launches) {
      const at = endedAt(x);
      if (at !== undefined && at + LAUNCH_RETENTION_MS <= now) this.#launches.delete(id);
    }
    if (!this.#launches.has(c.launchId) && this.#launches.size >= this.#max) {
      let oldest: [string, number] | undefined;
      for (const [id, x] of this.#launches) {
        const at = endedAt(x);
        if (at !== undefined && (!oldest || at < oldest[1])) oldest = [id, at];
      }
      if (!oldest) throw new StoreError('too many lessons are open on this course right now; try again later');
      this.#launches.delete(oldest[0]);
    }
    this.#launches.set(c.launchId, structuredClone(c));
  }

  async get(launchId: string): Promise<LaunchContext | undefined> {
    const c = this.#launches.get(launchId);
    return c && structuredClone(c);
  }

  async byPairingCode(code: string): Promise<LaunchContext | undefined> {
    for (const c of this.#launches.values()) if (c.pairingCode === code) return structuredClone(c);
    return undefined;
  }

  async latestFor(endpoint: string, key: string, registration: string, auKey?: string): Promise<LaunchContext | undefined> {
    let latest: LaunchContext | undefined;
    for (const c of this.#launches.values()) {
      if (c.endpoint !== endpoint || c.registration !== registration || actorKey(c.actor) !== key) continue;
      if (auKey !== undefined && c.auKey !== auKey) continue;
      if (!latest || c.initializedAt >= latest.initializedAt) latest = c;
    }
    return latest && structuredClone(latest);
  }

  async update(launchId: string, patch: Partial<LaunchContext>): Promise<void> {
    const c = this.#launches.get(launchId);
    if (!c) throw new StoreError('unknown launch ' + launchId);
    this.#launches.set(launchId, structuredClone({ ...c, ...patch, launchId }));
  }
}
