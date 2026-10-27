// SPDX-License-Identifier: Apache-2.0
// cmi5 statement order (cmi5 §9.3, §9.7), checked over a set of statements from one or more registrations.
import { ADL_VERBS, CMI5 } from '../constants.ts';
import { LMS_VERBS } from './templates.ts';
import type { DefinedVerb, XapiStatement } from './types.ts';

/** One order problem. `rule` is the cmi5 section, then the `@cmi5/requirements` id where one exists, space-separated. */
export interface Cmi5Problem {
  rule: string;
  statementId: string;
  message: string;
}

const DEFINED_BY_IRI = new Map<string, DefinedVerb>(
  (['launched', 'initialized', 'completed', 'passed', 'failed', 'terminated', 'waived', 'satisfied', 'abandoned'] as const).map((v) => [ADL_VERBS[v], v]),
);

interface Item {
  s: XapiStatement;
  index: number;
  time: number;
  /** The cmi5 defined verb, when the statement carries the cmi5 category. */
  defined?: DefinedVerb;
}

function definedVerb(s: XapiStatement): DefinedVerb | undefined {
  const cmi5 = s.context?.contextActivities?.category?.some((a) => a.id === CMI5.categoryCmi5);
  return cmi5 ? DEFINED_BY_IRI.get(s.verb?.id) : undefined;
}

function groupBy(items: Item[], key: (i: Item) => string | undefined): Map<string, Item[]> {
  const m = new Map<string, Item[]>();
  for (const i of items) {
    const k = key(i);
    if (k === undefined) continue;
    const list = m.get(k);
    if (list) list.push(i);
    else m.set(k, [i]);
  }
  return m;
}

/**
 * Returns the cmi5 order problems in `statements`; empty means none. Order is by `timestamp` (cmi5 §9.3); statements
 * with equal timestamps keep their array order and are themselves a problem within a session, because their order is
 * then ambiguous to an LMS.
 */
export function checkCmi5Order(statements: XapiStatement[]): Cmi5Problem[] {
  const items: Item[] = statements
    .map((s, index) => ({ s, index, time: Date.parse(s.timestamp), defined: definedVerb(s) }))
    .sort((a, b) => a.time - b.time || a.index - b.index);
  const found: { at: number; p: Cmi5Problem }[] = [];
  const problem = (i: Item, rule: string, message: string) => found.push({ at: items.indexOf(i), p: { rule, statementId: i.s.id, message } });

  const sessions = groupBy(items, (i) => {
    const id = i.s.context?.extensions?.[CMI5.extSessionId];
    return typeof id === 'string' ? `${i.s.context.registration}|${id}` : undefined;
  });
  for (const list of sessions.values()) {
    let prev: Item | undefined;
    let initialized = false;
    let ended: DefinedVerb | undefined;
    const used = new Set<DefinedVerb>();
    for (const i of list) {
      const v = i.defined;
      if (prev && i.time === prev.time) problem(i, '9.7', `statement has the same timestamp as ${prev.s.id} in the same session, so their order is ambiguous; give each statement in a step a later timestamp`);
      prev = i;

      if (ended && v !== 'satisfied') {
        if (ended === 'terminated') problem(i, '9.3.8 9.3.8.0-2', 'statement comes after "terminated" in the same session; "terminated" must be the last statement');
        else problem(i, '9.3.6 9.3.6.0-2', 'statement comes after "abandoned" in the same session');
      }
      if (v === 'launched' && initialized) problem(i, '9.3.2 9.3.2.0-1', '"launched" comes after "initialized"; "initialized" must follow "launched"');
      const lms = v !== undefined && LMS_VERBS.includes(v);
      if (!lms && v !== 'initialized' && !initialized) problem(i, '9.3.2 9.3.2.0-2', 'statement comes before "initialized"; "initialized" must be the first statement of an AU session');

      if (v !== undefined && v !== 'satisfied') {
        if (used.has(v)) problem(i, '9.3 9.3.0.0-2', `defined verb "${v}" is used twice in one session`);
        else if ((v === 'passed' || v === 'failed') && (used.has('passed') || used.has('failed'))) {
          problem(i, '9.3 9.3.0.0-3', 'a session has both a defined "passed" and a defined "failed"');
        }
        used.add(v);
      }
      if (v === 'initialized') initialized = true;
      if ((v === 'terminated' || v === 'abandoned') && !ended) ended = v;
    }
  }

  const perAu = groupBy(
    items.filter((i) => i.defined === 'completed' || i.defined === 'passed' || i.defined === 'failed'),
    (i) => `${i.s.context?.registration}|${i.s.object?.id}`,
  );
  for (const list of perAu.values()) {
    let completed = false;
    let passed = false;
    for (const i of list) {
      if (i.defined === 'completed') {
        if (completed) problem(i, '9.3.3 9.3.0.0-6', 'a second defined "completed" for this AU in the registration');
        completed = true;
      } else if (i.defined === 'passed') {
        if (passed) problem(i, '9.3.4 9.3.0.0-7', 'a second defined "passed" for this AU in the registration');
        passed = true;
      } else if (passed) {
        problem(i, '9.3.5 9.3.0.0-8', 'a defined "failed" follows a defined "passed" for this AU in the registration');
      }
    }
  }

  return found.sort((a, b) => a.at - b.at).map((f) => f.p);
}
