// SPDX-License-Identifier: Apache-2.0
// Deterministic checks on submitted text files. Ported from learn-wp-reimagined/src/shared/checks.ts.
// Checks never execute learner code. Regex patterns come only from authored content.
import type { Check } from './schema.ts';

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function resolvePointer(doc: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === '') return { found: true, value: doc };
  if (!pointer.startsWith('/')) return { found: false };
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= cur.length) return { found: false };
      cur = cur[Number(key)];
    } else if (cur !== null && typeof cur === 'object' && has(cur, key)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => has(b, k) && deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}

function runCheck(check: Check, files: Record<string, string>): boolean {
  if (!has(files, check.file)) return false;
  const text = files[check.file];
  try {
    switch (check.type) {
      case 'contains':
        return text.includes(check.value);
      case 'notContains':
        return !text.includes(check.value);
      case 'regex':
        return new RegExp(check.pattern, check.flags).test(text);
      case 'json': {
        const r = resolvePointer(JSON.parse(text), check.pointer);
        return r.found && deepEqual(r.value, check.equals);
      }
    }
  } catch {
    return false;
  }
}

export interface CheckResult { index: number; passed: boolean; message: string }

export function runChecks(checks: Check[], files: Record<string, string>): { passed: boolean; results: CheckResult[] } {
  const results = checks.map((check, index) => ({ index, passed: runCheck(check, files), message: check.message }));
  return { passed: results.every((r) => r.passed), results };
}
