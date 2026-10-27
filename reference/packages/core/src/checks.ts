// SPDX-License-Identifier: Apache-2.0
// Deterministic checks on submitted text files. Ported from learn-wp-reimagined/src/shared/checks.ts.
// Checks never execute learner code. Regex patterns come only from authored content, but they run on learner text,
// so a pattern with a known catastrophic-backtracking shape is never run, and any other regex runs with a time limit.
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
 * True when a regex pattern has a shape that can backtrack catastrophically on crafted text: a group holding an
 * unbounded quantifier that is itself repeated (`(a+)+`, `(a+){3}`), alternation inside an unboundedly repeated group
 * (`(a|a)+`), or two unbounded quantifiers in a row (`.*.*`). A heuristic: `runChecks` also stops any regex at a time limit.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  interface Level { unbounded: boolean; alternation: boolean; prevUnbounded: boolean }
  const levels: Level[] = [{ unbounded: false, alternation: false, prevUnbounded: false }];
  const top = () => levels[levels.length - 1]!;
  let i = 0;
  /** After an atom ends at `i`: read its quantifier and apply the rules. `group` describes the atom when it is a group. */
  const afterAtom = (group?: Level): boolean => {
    const q = quantifierAt(pattern, i);
    if (q) i += q.len;
    const lvl = top();
    if (group && q && group.unbounded && q.max >= 2) return true;
    if (group && q?.unbounded && group.alternation) return true;
    if (q?.unbounded && lvl.prevUnbounded) return true;
    lvl.prevUnbounded = Boolean(q?.unbounded);
    if (q?.unbounded || group?.unbounded) lvl.unbounded = true;
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
      levels.push({ unbounded: false, alternation: false, prevUnbounded: false });
    } else if (c === ')') {
      i++;
      const group = levels.length > 1 ? levels.pop()! : { unbounded: false, alternation: false, prevUnbounded: false };
      if (afterAtom(group)) return true;
    } else if (c === '|') {
      i++;
      top().alternation = true;
      top().prevUnbounded = false;
    } else {
      i++;
      if (afterAtom()) return true;
    }
  }
  return false;
}

/** How long one regex check may run on learner text before it is stopped and counts as failed. */
export const REGEX_TIME_LIMIT_MS = 100;

const regexContext = createContext({ pattern: '', flags: '', text: '' });

/** Runs one regex test in a VM context with a hard time limit; undefined when it was stopped. */
function timedRegexTest(pattern: string, flags: string | undefined, text: string): boolean | undefined {
  Object.assign(regexContext, { pattern, flags: flags ?? '', text });
  try {
    return runInContext('new RegExp(pattern, flags).test(text)', regexContext, { timeout: REGEX_TIME_LIMIT_MS }) as boolean;
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return undefined;
    throw e;
  } finally {
    Object.assign(regexContext, { pattern: '', flags: '', text: '' });
  }
}

const TOO_SLOW = 'this check took too long on this file and was stopped, so it counts as failed';

/** Whether the check passes; `stopped` when a regex ran out of time. */
function runCheck(check: Check, files: Record<string, string>): { passed: boolean; stopped?: true } {
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
        if (hasNestedQuantifier(check.pattern)) return { passed: false };
        const r = timedRegexTest(check.pattern, check.flags, text);
        return r === undefined ? { passed: false, stopped: true } : { passed: r };
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

export interface CheckResult { index: number; passed: boolean; message: string }

export function runChecks(checks: Check[], files: Record<string, string>): { passed: boolean; results: CheckResult[] } {
  const results = checks.map((check, index) => {
    const r = runCheck(check, files);
    return { index, passed: r.passed, message: r.stopped ? `${check.message} (${TOO_SLOW})` : check.message };
  });
  return { passed: results.every((r) => r.passed), results };
}
