// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { PRACTICE_CATEGORY, PRACTICE_HOMEPAGE, PRACTICE_LABEL } from '../src/constants.ts';
import {
  PRACTICE_FORMAT,
  PRACTICE_VERSION,
  isPracticeHandle,
  newPracticeHandle,
  parsePracticeRecord,
  type PracticeRecord,
} from '../src/practice-record.ts';
import type { LearnerState } from '../src/state.ts';
import { buildAllowed, buildDefined, type XapiStatement } from '../src/xapi/index.ts';
import { AU, AU_REF, COURSE, REG, clock, ctx } from './xapi-fixtures.ts';

const ACTOR = { objectType: 'Agent' as const, account: { homePage: PRACTICE_HOMEPAGE, name: 'p-0001' } };
const pctx = (over = {}) => ctx({ actor: ACTOR, custody: 'practice', practice: true, ...over });

function state(): LearnerState {
  return {
    v: 1,
    courseVersion: '1.0.0',
    registration: REG,
    createdAt: '2026-10-27T12:00:00.000Z',
    updatedAt: '2026-10-27T12:00:00.000Z',
    au: {},
    satisfied: { blocks: [], course: false },
    files: {},
    outbox: [],
    awards: [],
  };
}

function record(statements?: XapiStatement[]): PracticeRecord {
  const t = clock();
  return {
    format: PRACTICE_FORMAT,
    version: PRACTICE_VERSION,
    official: false,
    label: PRACTICE_LABEL,
    courseId: COURSE,
    actor: ACTOR,
    createdAt: '2026-10-27T12:00:00.000Z',
    updatedAt: '2026-10-27T12:00:00.000Z',
    state: state(),
    statements: statements ?? [
      buildDefined(pctx(), 'initialized', { au: AU_REF }, t()),
      buildAllowed(pctx(), 'experienced', { id: AU + '/beats/intro', kind: 'beat', name: 'Intro' }, AU_REF, t()),
    ],
  };
}

const NOT_PRACTICE = 'this is not a course-xapi-mcp practice copy';

describe('practice record', () => {
  it('round-trips through JSON', () => {
    const rec = record();
    const p = parsePracticeRecord(JSON.parse(JSON.stringify(rec)), COURSE);
    expect(p).toEqual({ ok: true, record: rec });
  });

  it('refuses a learning-mcp record', () => {
    const legacy = { format: 'learning-mcp/record', version: 1, handle: 'lr_x', statements: [] };
    expect(parsePracticeRecord(legacy, COURSE)).toEqual({ ok: false, error: NOT_PRACTICE });
  });

  it('refuses things that are not records at all', () => {
    for (const raw of [null, 'text', 42, [], {}]) expect(parsePracticeRecord(raw, COURSE)).toEqual({ ok: false, error: NOT_PRACTICE });
  });

  it('refuses a copy that claims to be official', () => {
    const p = parsePracticeRecord({ ...record(), official: true }, COURSE);
    expect(p.ok).toBe(false);
  });

  it('refuses a newer version', () => {
    const p = parsePracticeRecord({ ...record(), version: PRACTICE_VERSION + 1 }, COURSE);
    expect(p).toEqual({ ok: false, error: expect.stringContaining('newer version') });
  });

  it('refuses a copy for another course', () => {
    const p = parsePracticeRecord(record(), COURSE + '-other');
    expect(p).toEqual({ ok: false, error: expect.stringContaining('another course') });
  });

  it('refuses a copy with one statement missing the practice category', () => {
    const rec = record();
    const s = rec.statements[1]!;
    s.context.contextActivities!.category = s.context.contextActivities!.category!.filter((a) => a.id !== PRACTICE_CATEGORY);
    const p = parsePracticeRecord(rec, COURSE);
    expect(p).toEqual({ ok: false, error: `statement ${s.id} does not carry the practice category ${PRACTICE_CATEGORY}` });
  });

  it('refuses a copy with a statement by a foreign actor', () => {
    const t = clock('2026-10-27T13:00:00.000Z');
    const foreign = { objectType: 'Agent' as const, account: { homePage: PRACTICE_HOMEPAGE, name: 'someone-else' } };
    const rec = record([buildDefined(pctx(), 'initialized', { au: AU_REF }, t()), buildDefined(pctx({ actor: foreign }), 'completed', { au: AU_REF }, { ...t(), duration: 'PT1M' })]);
    const p = parsePracticeRecord(rec, COURSE);
    expect(p).toEqual({ ok: false, error: `statement ${rec.statements[1]!.id} has an actor other than this practice copy's actor` });
  });

  it('refuses a record whose own actor is not a practice actor', () => {
    const rec = { ...record([]), actor: { objectType: 'Agent', account: { homePage: COURSE, name: 'learner-1' } } };
    expect(parsePracticeRecord(rec, COURSE)).toEqual({ ok: false, error: expect.stringContaining(PRACTICE_HOMEPAGE) });
  });

  it('refuses an invalid statement and one that breaks the profile', () => {
    const bad = record();
    (bad.statements[0] as any).id = 'not-a-uuid';
    expect(parsePracticeRecord(bad, COURSE)).toEqual({ ok: false, error: expect.stringContaining('id must be a UUID') });

    const off = record();
    delete (off.statements[0]!.context.extensions as any)['https://w3id.org/xapi/cmi5/context/extensions/sessionid'];
    expect(parsePracticeRecord(off, COURSE)).toEqual({ ok: false, error: expect.stringContaining('sessionid') });
  });

  it('refuses a bad statement in state.outbox', () => {
    const rec = record();
    const t = clock('2026-10-27T14:00:00.000Z');
    const pending = buildAllowed(pctx(), 'experienced', { id: AU + '/beats/next', kind: 'beat', name: 'Next' }, AU_REF, t());
    pending.context.contextActivities!.category = pending.context.contextActivities!.category!.filter((a) => a.id !== PRACTICE_CATEGORY);
    rec.state.outbox = [pending];
    expect(parsePracticeRecord(rec, COURSE)).toEqual({ ok: false, error: `statement ${pending.id} does not carry the practice category ${PRACTICE_CATEGORY}` });
  });

  it('refuses a malformed state', () => {
    const rec = { ...record(), state: { v: 2 } };
    expect(parsePracticeRecord(rec, COURSE)).toEqual({ ok: false, error: expect.stringContaining('state') });
  });
});

describe('practice handles', () => {
  it('are cxp_ plus 32 base64url characters and unique', () => {
    const hs = new Set(Array.from({ length: 200 }, newPracticeHandle));
    expect(hs.size).toBe(200);
    for (const h of hs) {
      expect(h).toMatch(/^cxp_[A-Za-z0-9_-]{32}$/);
      expect(isPracticeHandle(h)).toBe(true);
    }
  });

  it('isPracticeHandle refuses other shapes', () => {
    for (const h of [undefined, 1, '', 'lr_' + 'a'.repeat(32), 'cxp_' + 'a'.repeat(31), 'cxp_' + 'a'.repeat(32) + '='])
      expect(isPracticeHandle(h)).toBe(false);
  });
});
