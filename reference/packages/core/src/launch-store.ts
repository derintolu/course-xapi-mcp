// SPDX-License-Identifier: Apache-2.0
// In-memory LaunchStore for the launch bridge (option 1) and tests. Launches are lost on restart.
import { actorKey, type LaunchContext, type LaunchStore } from './custody.ts';
import { StoreError } from './errors.ts';

export class MemoryLaunchStore implements LaunchStore {
  readonly #launches = new Map<string, LaunchContext>();

  async put(c: LaunchContext): Promise<void> {
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
