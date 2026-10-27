// SPDX-License-Identifier: Apache-2.0
// Lint warnings (design §12): CXM-PKG-201 to 205. Heuristics; they never make a package invalid.
import { TOOL_NAMES, makeIssue } from '@course-xapi-mcp/core';
import type { Check, IssueCode, ValidationIssue } from '@course-xapi-mcp/core';
import type { CourseDoc, LessonDoc } from './validate.ts';

const JACCARD_LIMIT = 0.8;
const MAX_BEAT_WORDS = 250;

const wordSet = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
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

const AGENT_PHRASES = ['ignore previous', 'ignore all previous', 'disregard', 'system prompt', 'do not tell the learner', "don't tell the learner"];
const TOOL_RE = new RegExp(`\\b(?:${TOOL_NAMES.join('|')})\\b`, 'i');
const URL_RE = /https?:\/\//i;

/** What in `text` addresses the agent out of scope, or undefined. */
function agentAddress(text: string): string | undefined {
  const lower = text.toLowerCase();
  const phrase = AGENT_PHRASES.find((p) => lower.includes(p));
  if (phrase) return `"${phrase}"`;
  const tool = TOOL_RE.exec(text);
  if (tool) return `the tool name "${tool[0]}"`;
  if (URL_RE.test(text)) return 'a URL';
  return undefined;
}

export function lintIssues(course: CourseDoc | undefined, lessons: LessonDoc[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: IssueCode, file: string, pointer: string, message: string) => issues.push(makeIssue(code, { file, pointer: pointer || '/' }, message));

  course?.rules.forEach((rule, i) => {
    const hit = agentAddress(rule);
    if (hit) add('CXM-PKG-204', course.file, `${course.base}/rules/${i}`, `Course rule ${i} contains ${hit}, which addresses the agent beyond teaching this course.`);
  });

  for (const { key, file, base, lesson } of lessons) {
    lesson.beats.forEach((b, i) => {
      const words = b.content.split(/\s+/).filter((w) => w !== '').length;
      if (words > MAX_BEAT_WORDS) add('CXM-PKG-203', file, `${base}/beats/${i}/content`, `Beat "${b.key}" of lesson "${key}" has ${words} words; the limit is ${MAX_BEAT_WORDS}.`);
      const hit = agentAddress(b.content);
      if (hit) add('CXM-PKG-204', file, `${base}/beats/${i}/content`, `Beat "${b.key}" of lesson "${key}" contains ${hit}, which addresses the agent beyond teaching this course.`);
    });

    const branches = lesson.checkpoint?.branches ?? [];
    const sets = branches.map((br) => wordSet(br.when));
    for (let j = 1; j < branches.length; j++) {
      const i = sets.slice(0, j).findIndex((s) => jaccard(s, sets[j]!) >= JACCARD_LIMIT);
      if (i >= 0) add('CXM-PKG-201', file, `${base}/checkpoint/branches/${j}/when`, `The when texts of branches "${branches[i]!.key}" and "${branches[j]!.key}" in lesson "${key}" overlap.`);
    }

    const regexes = (checks: Check[] | undefined, at: string) =>
      (checks ?? []).forEach((c, i) => {
        if (c.type === 'regex' && hasNestedQuantifier(c.pattern)) add('CXM-PKG-202', file, `${base}${at}/${i}/pattern`, `The regex /${c.pattern}/ in lesson "${key}" nests quantifiers and can backtrack catastrophically.`);
      });
    regexes(lesson.checkpoint?.checks as Check[] | undefined, '/checkpoint/checks');
    regexes(lesson.bug?.fixChecks as Check[] | undefined, '/bug/fixChecks');

    if (!lesson.sources || lesson.sources.length === 0) add('CXM-PKG-205', file, `${base}/sources`, `Lesson "${key}" lists no sources.`);
  }
  return issues;
}
