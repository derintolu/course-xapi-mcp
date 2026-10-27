// SPDX-License-Identifier: Apache-2.0
// In-process mutual exclusion by key. It serialises calls inside one server process only; it is not a
// lock between processes.

/** A keyed mutex: calls for one key run one after the other, in arrival order; other keys are not held up. */
export function createKeyedMutex() {
  const tails = new Map<string, Promise<unknown>>();
  return async function lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(() => fn());
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

const learnerMutex = createKeyedMutex();

/** Runs `fn` while no other call for this learner subject runs in this process. */
export function withLearnerLock<T>(subject: string, fn: () => Promise<T>): Promise<T> {
  return learnerMutex(subject, fn);
}
