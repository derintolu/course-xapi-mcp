// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { buildAllowed, buildDefined, checkCmi5Order, type Cmi5Problem, type XapiStatement } from '../src/xapi/index.ts';
import { AU, AU_REF, COURSE, clock, ctx } from './xapi-fixtures.ts';

/** The cmi5 section each problem cites (the first token of `rule`). */
const rules = (ps: Cmi5Problem[]) => ps.map((p) => p.rule.split(' ')[0]);
const au = { au: AU_REF };
const beat = { id: AU + '/beats/intro', kind: 'beat' as const, name: 'Intro' };
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

function session(sessionId: string, next = clock()) {
  const c = ctx({ sessionId });
  return {
    launched: () => buildDefined(c, 'launched', au, next()),
    init: () => buildDefined(c, 'initialized', au, next()),
    beat: () => buildAllowed(c, 'experienced', beat, AU_REF, next()),
    completed: () => buildDefined(c, 'completed', au, { ...next(), duration: 'PT1M' }),
    passed: () => buildDefined(c, 'passed', au, { ...next(), duration: 'PT1M' }),
    failed: () => buildDefined(c, 'failed', au, { ...next(), duration: 'PT1M' }),
    term: () => buildDefined(c, 'terminated', au, { ...next(), duration: 'PT2M' }),
    satisfied: () => buildDefined(c, 'satisfied', { blockId: COURSE + '/paths/json' }, next()),
  };
}

describe('checkCmi5Order', () => {
  it('accepts initialized, allowed..., completed, passed, terminated', () => {
    const a = session(S1);
    const goodSession = [a.launched(), a.init(), a.beat(), a.beat(), a.completed(), a.passed(), a.term(), a.satisfied()];
    expect(checkCmi5Order(goodSession)).toEqual([]);
  });

  it('orders by timestamp, not by array position', () => {
    const a = session(S1);
    const list = [a.init(), a.beat(), a.completed(), a.term()];
    expect(checkCmi5Order([...list].reverse())).toEqual([]);
  });

  it('flags failed after passed in a registration', () => {
    const next = clock();
    const a = session(S1, next);
    const b = session(S2, next);
    const [init, passed, term] = [a.init(), a.passed(), a.term()];
    const [init2, failed, term2] = [b.init(), b.failed(), b.term()];
    const ps = checkCmi5Order([init, passed, term, init2, failed, term2]);
    expect(rules(ps)).toContain('9.3.5');
    expect(ps.find((p) => p.rule.startsWith('9.3.5'))!.statementId).toBe(failed.id);
  });

  it('accepts a defined passed in a later session after a defined failed', () => {
    const next = clock();
    const a = session(S1, next);
    const b = session(S2, next);
    expect(checkCmi5Order([a.init(), a.failed(), a.term(), b.init(), b.passed(), b.term()])).toEqual([]);
  });

  it('flags equal timestamps within a session', () => {
    const a = session(S1);
    const init = a.init();
    const beat1 = { ...a.beat(), timestamp: init.timestamp };
    const ps = checkCmi5Order([init, beat1, a.term()]);
    expect(rules(ps)).toContain('9.7');
    expect(ps.find((p) => p.rule.startsWith('9.7'))!.statementId).toBe(beat1.id);
  });

  it('flags any statement after terminated in the same session', () => {
    const a = session(S1);
    const late = [a.init(), a.term(), a.beat()];
    const ps = checkCmi5Order(late);
    expect(rules(ps)).toContain('9.3.8');
    expect(ps[0]!.statementId).toBe(late[2]!.id);
  });

  it('flags a statement before initialized', () => {
    const a = session(S1);
    expect(rules(checkCmi5Order([a.beat(), a.init(), a.term()]))).toContain('9.3.2');
  });

  it('flags launched after initialized', () => {
    const a = session(S1);
    const init = a.init();
    const launched = a.launched();
    const ps = checkCmi5Order([init, launched, a.term()]);
    expect(ps).toEqual([expect.objectContaining({ rule: '9.3.2 9.3.2.0-1', statementId: launched.id })]);
  });

  it('flags a duplicated defined verb and both passed and failed in one session', () => {
    const a = session(S1);
    const ps = checkCmi5Order([a.init(), a.completed(), a.completed(), a.failed(), a.passed(), a.term()]);
    const msgs = ps.map((p) => p.rule);
    expect(msgs).toContain('9.3 9.3.0.0-2');
    expect(msgs).toContain('9.3 9.3.0.0-3');
  });

  it('flags a second completed or passed for the AU in the registration', () => {
    const next = clock();
    const a = session(S1, next);
    const b = session(S2, next);
    const ps = checkCmi5Order([a.init(), a.completed(), a.passed(), a.term(), b.init(), b.completed(), b.passed(), b.term()]);
    expect(rules(ps)).toEqual(expect.arrayContaining(['9.3.3', '9.3.4']));
  });

  it('keeps registrations apart', () => {
    const next = clock();
    const a = session(S1, next);
    const first = [a.init(), a.passed(), a.term()];
    const c = ctx({ sessionId: S2, registration: '33333333-3333-4333-8333-333333333333' });
    const second: XapiStatement[] = [
      buildDefined(c, 'initialized', au, next()),
      buildDefined(c, 'failed', au, { ...next(), duration: 'PT1S' }),
      buildDefined(c, 'terminated', au, { ...next(), duration: 'PT1S' }),
    ];
    expect(checkCmi5Order([...first, ...second])).toEqual([]);
  });

  it('cites a cmi5 section and gives a message for each problem', () => {
    const a = session(S1);
    for (const p of checkCmi5Order([a.beat(), a.init(), a.term(), a.beat()])) {
      expect(p.rule).toMatch(/^9\.\d/);
      expect(p.message.length).toBeGreaterThan(0);
    }
  });
});
