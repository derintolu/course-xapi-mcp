// SPDX-License-Identifier: Apache-2.0
// Deterministic checks on submitted text files. Ported from learn-wp-reimagined/src/shared/checks.ts.
// Checks never execute learner code. Regex patterns come only from authored content, but they run on learner text,
// so a pattern with the nested-quantifier shape is never run, and every other regex runs with a time limit and a
// per-call budget.
import { createContext, runInContext } from 'node:vm';
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

interface Quantifier {
  len: number;
  unbounded: boolean;
  max: number;
}

/** The quantifier at `j` (`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`, each optionally lazy), or undefined. */
function quantifierAt(pattern: string, j: number): Quantifier | undefined {
  const lazy = (len: number) => (pattern[j + len] === '?' ? len + 1 : len);
  const c = pattern[j];
  if (c === '*' || c === '+') return { len: lazy(1), unbounded: true, max: Infinity };
  if (c === '?') return { len: lazy(1), unbounded: false, max: 1 };
  const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(j));
  if (!m) return undefined;
  const max = m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3]);
  return { len: lazy(m[0].length), unbounded: max === Infinity, max };
}

/**
 * True when a regex pattern has a group holding an unbounded quantifier that is itself repeated, without bound or at
 * least twice (`(a+)+`, `(\\w*,)*`, `(a+){3}`): the classic shape that backtracks exponentially on crafted text.
 * A heuristic: `runChecks` also stops every other regex at a time limit.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  // Per open group: whether an unbounded quantifier appeared inside it.
  const levels: boolean[] = [false];
  let i = 0;
  /** After an atom ends at `i`: read its quantifier. `group` is set when the atom is a group: whether it holds an unbounded quantifier. */
  const afterAtom = (group?: boolean): boolean => {
    const q = quantifierAt(pattern, i);
    if (q) i += q.len;
    if (group && q && q.max >= 2) return true;
    if (q?.unbounded || group) levels[levels.length - 1] = true;
    return false;
  };
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '\\') {
      i += 2;
      if (afterAtom()) return true;
    } else if (c === '[') {
      // A character class is one atom; quantifier characters inside it are literals.
      i++;
      if (pattern[i] === '^') i++;
      if (pattern[i] === ']') i++;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i++;
      if (afterAtom()) return true;
    } else if (c === '(') {
      i++;
      if (pattern[i] === '?') {
        i++;
        if (pattern[i] === '<' && pattern[i + 1] !== '=' && pattern[i + 1] !== '!') i = pattern.indexOf('>', i) + 1 || pattern.length;
        else i += pattern[i] === '<' ? 2 : 1;
      }
      levels.push(false);
    } else if (c === ')') {
      i++;
      const group = levels.length > 1 ? levels.pop()! : false;
      if (afterAtom(group)) return true;
    } else {
      i++;
      if (afterAtom()) return true;
    }
  }
  return false;
}

/** How long one regex check may run on learner text before it is stopped and counts as failed. */
export const REGEX_TIME_LIMIT_MS = 100;
/** How long all the regex checks of one `runChecks` call may run together. */
export const REGEX_BUDGET_MS = 1000;

const regexContext = createContext({ pattern: '', flags: '', text: '' });

/** Runs one regex test in a VM context with a hard time limit; undefined when it was stopped. */
function timedRegexTest(pattern: string, flags: string | undefined, text: string, timeout: number): boolean | undefined {
  Object.assign(regexContext, { pattern, flags: flags ?? '', text });
  try {
    return runInContext('new RegExp(pattern, flags).test(text)', regexContext, { timeout }) as boolean;
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return undefined;
    throw e;
  } finally {
    Object.assign(regexContext, { pattern: '', flags: '', text: '' });
  }
}

const WHY = {
  stopped: 'this check took too long on this file and was stopped, so it counts as failed',
  refused: 'this check\'s pattern can take too long on any learner text, so the server does not run it and it counts as failed',
  budget: 'the checks on this submission ran out of time before this one, so it counts as failed',
} as const;

type Outcome = { passed: boolean; why?: keyof typeof WHY };

/** Whether the check passes, and why it failed when the server did not run it to the end. `budget` is the regex time left. */
function runCheck(check: Check, files: Record<string, string>, budget: { left: number }): Outcome {
  if (!has(files, check.file)) return { passed: false };
  const text = files[check.file]!;
  try {
    switch (check.type) {
      case 'contains':
        return { passed: text.includes(check.value) };
      case 'notContains':
        return { passed: !text.includes(check.value) };
      case 'regex': {
        // Refused rather than run: the validator warns about such patterns (CXM-PKG-202).
        if (hasNestedQuantifier(check.pattern)) return { passed: false, why: 'refused' };
        if (budget.left <= 0) return { passed: false, why: 'budget' };
        const start = performance.now();
        const r = timedRegexTest(check.pattern, check.flags, text, Math.max(1, Math.min(REGEX_TIME_LIMIT_MS, Math.ceil(budget.left))));
        budget.left -= performance.now() - start;
        return r === undefined ? { passed: false, why: 'stopped' } : { passed: r };
      }
      case 'json': {
        const r = resolvePointer(JSON.parse(text), check.pointer);
        return { passed: r.found && deepEqual(r.value, check.equals) };
      }
    }
  } catch {
    return { passed: false };
  }
}

/** A quantifier at `i`: its length and whether it is unbounded (`*`, `+`, `{n,}`). A lazy `?` suffix is included. */
function quantifierAt(p: string, i: number): { len: number; unbounded: boolean } | undefined {
  let len: number;
  let unbounded: boolean;
  const c = p[i];
  if (c === '*' || c === '+') [len, unbounded] = [1, true];
  else if (c === '?') return { len: 1, unbounded: false };
  else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
    if (!m) return undefined;
    [len, unbounded] = [m[0].length, m[2] !== undefined && m[3] === ''];
  } else return undefined;
  if (p[i + len] === '?') len++;
  return { len, unbounded };
}

/**
 * True when a group holding an unbounded quantifier (`+`, `*`, `{n,}`, at any depth) is itself
 * quantified with an unbounded quantifier, for example `(a+)+` or `(?:x|y*){2,}`.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  const groups: boolean[] = [];
  let i = 0;
  // After an atom: read its quantifier; `inner` says whether the atom already holds an unbounded quantifier.
  const afterAtom = (inner: boolean): boolean => {
    const q = quantifierAt(pattern, i);
    if (q) i += q.len;
    if (q?.unbounded && inner) return true;
    if ((q?.unbounded || inner) && groups.length > 0) groups[groups.length - 1] = true;
    return false;
  };
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '\\') {
      i += 2;
      if (afterAtom(false)) return true;
    } else if (c === '[') {
      i++;
      if (pattern[i] === '^') i++;
      if (pattern[i] === ']') i++;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i++;
      if (afterAtom(false)) return true;
    } else if (c === '(') {
      groups.push(false);
      i++;
      if (pattern[i] === '?') {
        i++;
        if (pattern[i] === '<' && pattern[i + 1] !== '=' && pattern[i + 1] !== '!') i = pattern.indexOf('>', i) + 1 || pattern.length;
        else i += pattern[i] === '<' ? 2 : 1;
      }
    } else if (c === ')') {
      const inner = groups.pop() ?? false;
      i++;
      if (afterAtom(inner)) return true;
    } else {
      i++;
      if (c !== '|' && c !== '^' && c !== '$' && afterAtom(false)) return true;
    }
  }
  return false;
}

export interface CheckResult { index: number; passed: boolean; message: string }

export function runChecks(checks: Check[], files: Record<string, string>): { passed: boolean; results: CheckResult[] } {
  const budget = { left: REGEX_BUDGET_MS };
  const results = checks.map((check, index) => {
    const r = runCheck(check, files, budget);
    return { index, passed: r.passed, message: r.why ? `${check.message} (${WHY[r.why]})` : check.message };
  });
  return { passed: results.every((r) => r.passed), results };
}
