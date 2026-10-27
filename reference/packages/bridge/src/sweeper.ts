// SPDX-License-Identifier: Apache-2.0
import type { Bridge } from './bridge.ts';

/** Runs `bridge.sweep()` every `intervalMs` (one sweep at a time) and returns a function that stops it. */
export function startSweeper(bridge: Pick<Bridge, 'sweep'>, intervalMs = 60_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    bridge
      .sweep()
      .catch(() => {})
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
