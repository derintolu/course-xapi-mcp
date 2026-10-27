// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Award } from '@course-xapi-mcp/core';
import { buildCredential, createStatusList } from '../src/index.ts';
import { badge } from './fixtures.ts';

const ACCOUNT_NAME = 'learner-account-7f3a';
const award: Award = { badgeId: 'https://course.example/badges/a', registration: '11111111-1111-4111-8111-111111111111', earningStatementId: '22222222-2222-4222-8222-222222222222', testedOut: 0 };
const list = createStatusList();
const status = list.entry('https://course.example/status/1', list.allocate());

function build(o: { testedOut?: number; assessed?: 'checks' | 'agent-rubric' | 'mixed'; recipient?: { did: string } | { email: string; salt: string } } = {}) {
  return buildCredential({
    badge: badge({ id: award.badgeId, awardOn: 'block-satisfied', for: 'a' }),
    issuer: { id: 'did:web:course.example', name: 'Course Server' },
    recipient: o.recipient ?? { did: 'did:example:wallet' },
    award: { ...award, testedOut: o.testedOut ?? 0 },
    credentialId: 'urn:uuid:33333333-3333-4333-8333-333333333333',
    validFrom: '2026-10-27T00:00:00Z',
    status,
    assessed: o.assessed ?? 'checks',
  }) as Record<string, any>;
}

function* values(v: unknown): Generator<unknown> {
  yield v;
  if (v && typeof v === 'object') for (const x of Object.values(v)) yield* values(x);
}

describe('buildCredential', () => {
  it('is an OpenBadgeCredential under VCDM 2.0 with a BitstringStatusListEntry', () => {
    const c = build();
    expect(c['@context']).toEqual(['https://www.w3.org/ns/credentials/v2', 'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json']);
    expect(c.type).toEqual(['VerifiableCredential', 'OpenBadgeCredential']);
    expect(c.credentialSubject.type).toEqual(['AchievementSubject']);
    expect(c.credentialSubject.id).toBe('did:example:wallet');
    expect(c.credentialSubject.achievement.id).toBe(award.badgeId);
    expect(c.credentialStatus).toEqual(status);
    expect(c.credentialStatus.type).toBe('BitstringStatusListEntry');
  });

  it('never carries the xAPI account name, statements or a score', () => {
    for (const recipient of [{ did: 'did:example:wallet' }, { email: 'a@example.com', salt: 'c2FsdHNhbHRzYWx0c2FsdA' }]) {
      const c = build({ recipient });
      for (const v of values(c)) expect(v).not.toBe(ACCOUNT_NAME);
      const text = JSON.stringify(c);
      expect(text).not.toContain(ACCOUNT_NAME);
      expect(text).not.toMatch(/"(actor|verb|statement|score|result)"/);
    }
  });

  it('has exactly one evidence entry, pointing at the earning statement', () => {
    const c = build();
    expect(c.evidence).toHaveLength(1);
    expect(c.evidence[0]).toMatchObject({ id: 'urn:uuid:' + award.earningStatementId, type: ['Evidence'], genre: 'xAPI statement' });
  });

  it('names how learning was assessed and how many lessons were tested out', () => {
    expect(build({ assessed: 'checks' }).evidence[0].narrative).toContain('deterministic checks');
    expect(build({ assessed: 'agent-rubric' }).evidence[0].narrative).toContain("the learner's AI agent judging against an authored rubric");
    const mixed = build({ assessed: 'mixed' }).evidence[0].narrative;
    expect(mixed).toContain('deterministic checks');
    expect(mixed).toContain("the learner's AI agent judging against an authored rubric");
    expect(build({ testedOut: 2 }).evidence[0].narrative).toContain('2 lessons were tested out.');
    expect(build({ testedOut: 0 }).evidence[0].narrative).not.toContain('tested out');
  });

  it('binds an email recipient by a salted hash that recomputes from the salt', () => {
    const salt = 'c2FsdHNhbHRzYWx0c2FsdA';
    const c = build({ recipient: { email: 'learner@example.com', salt } });
    expect(c.credentialSubject.id).toBeUndefined();
    const [idObj] = c.credentialSubject.identifier;
    expect(idObj).toMatchObject({ type: 'IdentityObject', identityType: 'emailAddress', hashed: true, salt });
    const expected = 'sha256$' + createHash('sha256').update('learner@example.com' + salt).digest('hex');
    expect(idObj.identityHash).toBe(expected);
    expect(JSON.stringify(c)).not.toContain('learner@example.com');
  });
});
