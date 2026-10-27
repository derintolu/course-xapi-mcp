// SPDX-License-Identifier: Apache-2.0
// Deterministic checks on submitted text files. Ported from learn-wp-reimagined/src/shared/checks.ts.
// Checks never execute learner code. Regex patterns come only from authored content, but they run on learner text,
// so a pattern that can backtrack catastrophically (a quantified group that itself contains a quantifier) is never run.
import type { Check } from './model.ts';

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

/**
 * True when a regex pattern has a group that contains an unbounded quantifier and is itself repeated without bound,
 * such as `(a+)+` or `(\\w*,)*`: the shape that backtracks exponentially on a crafted input.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  /** `*`, `+`, `{n,}` or `{n,m}` at `j`; `?` and `{n}` are bounded. */
  const unbounded = (j: number) => {
    if (pattern[j] === '*' || pattern[j] === '+') return true;
    const m = /^\{(\d+),(\d*)\}/.exec(pattern.slice(j));
    return m !== null && m[2] !== m[1];
  };
  // Per open group: whether an unbounded quantifier appeared inside it.
  const open: boolean[] = [];
  let inside = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      if (unbounded(i + 1)) inside = true;
    } else if (ch === '[') {
      // A character class is one atom; quantifier characters inside it are literals.
      i++;
      if (pattern[i] === '^') i++;
      if (pattern[i] === ']') i++;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      if (unbounded(i + 1)) inside = true;
    } else if (ch === '(') {
      open.push(inside);
      inside = false;
    } else if (ch === ')') {
      const repeated = unbounded(i + 1);
      if (inside && repeated) return true;
      inside = (open.pop() ?? false) || inside || repeated;
    } else if (unbounded(i + 1) && ch !== '*' && ch !== '+' && ch !== '?' && ch !== '}') {
      inside = true;
    }
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
        // Refused rather than run: the validator warns about such patterns (CXM-PKG-202).
        if (hasNestedQuantifier(check.pattern)) return false;
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
