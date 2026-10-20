// Where records live between tool calls. The handle is a bearer secret; it never appears in statements.
import type { LearningRecord } from './record.ts';

export interface RecordStore {
  get(handle: string): Promise<LearningRecord | undefined>;
  put(handle: string, record: LearningRecord): Promise<void>;
  delete(handle: string): Promise<boolean>;
}

const HANDLE = /^lr_[A-Za-z0-9_-]{32}$/;

/** A new record handle: "lr_" plus 192 random bits, base64url. */
export function newHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `lr_${b64}`;
}

export const isHandle = (h: unknown): h is string => typeof h === 'string' && HANDLE.test(h);

/** In-memory store with an inactivity expiry. Fine for one process; use a durable store in production. */
export class MemoryStore implements RecordStore {
  private items = new Map<string, { record: LearningRecord; touched: number }>();
  private ttlMs: number;
  private now: () => number;
  constructor(ttlMs = 30 * 24 * 60 * 60 * 1000, now = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  async get(handle: string) {
    const it = this.items.get(handle);
    if (!it) return undefined;
    if (this.now() - it.touched > this.ttlMs) {
      this.items.delete(handle);
      return undefined;
    }
    it.touched = this.now();
    return structuredClone(it.record);
  }

  async put(handle: string, record: LearningRecord) {
    this.items.set(handle, { record: structuredClone(record), touched: this.now() });
  }

  async delete(handle: string) {
    return this.items.delete(handle);
  }
}
