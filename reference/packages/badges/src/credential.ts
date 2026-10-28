// SPDX-License-Identifier: Apache-2.0
// The unsigned OpenBadgeCredential (OB 3.0 on VC Data Model 2.0), design §11.
// It never carries the xAPI actor or statements, and carries a score only with `includeScore` and a score.
import { createHash } from 'node:crypto';
import type { Award, BadgeDecl, XapiScore } from '@course-xapi-mcp/core';
import { CONTEXTS } from './document-loader.ts';
import type { StatusEntry } from './status-list.ts';

export type Assessed = 'checks' | 'agent-rubric' | 'mixed';
export type Recipient = { did: string } | { email: string; salt: string };

const ASSESSED: Record<Assessed, string> = {
  checks: 'deterministic checks',
  'agent-rubric': "the learner's AI agent judging against an authored rubric",
  mixed: "deterministic checks and the learner's AI agent judging against an authored rubric",
};

export function evidenceNarrative(assessed: Assessed, testedOut: number): string {
  let text = `Earned on the cmi5 event recorded in the earning xAPI statement. Learning was assessed by ${ASSESSED[assessed]}.`;
  if (testedOut > 0) text += testedOut === 1 ? ' 1 lesson was tested out.' : ` ${testedOut} lessons were tested out.`;
  return text;
}

export function buildCredential(o: {
  badge: BadgeDecl;
  issuer: { id: string; name: string };
  recipient: Recipient;
  award: Award;
  credentialId: string;
  validFrom: string;
  status: StatusEntry;
  assessed: Assessed;
  /** The earning statement's score; it appears only when the badge sets `includeScore`. */
  score?: XapiScore;
}): object {
  const b = o.badge;
  const scored = b.includeScore ? scoreOf(b.id, o.score) : undefined;
  const achievement = {
    id: b.id,
    type: ['Achievement'],
    name: b.name,
    description: b.description,
    // The criteria say how the learning was assessed, whatever the author wrote (CXM-BDG-012).
    criteria: { narrative: `${b.criteria.narrative} Learning was assessed by ${ASSESSED[o.assessed]}.` },
    achievementType: b.achievementType,
    ...(b.image ? { image: { id: b.image, type: 'Image' } } : {}),
    ...(b.alignment?.length ? { alignment: b.alignment.map((a) => ({ type: ['Alignment'], ...a })) } : {}),
    ...(scored ? { resultDescription: [scored.description] } : {}),
  };
  const subject =
    'did' in o.recipient
      ? { id: o.recipient.did }
      : {
          identifier: [
            {
              type: 'IdentityObject',
              identityType: 'emailAddress',
              hashed: true,
              identityHash: 'sha256$' + createHash('sha256').update(o.recipient.email + o.recipient.salt).digest('hex'),
              salt: o.recipient.salt,
            },
          ],
        };
  return {
    '@context': [CONTEXTS.credentialsV2, CONTEXTS.obV3],
    id: o.credentialId,
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
    name: b.name,
    issuer: { id: o.issuer.id, type: ['Profile'], name: o.issuer.name },
    validFrom: o.validFrom,
    credentialSubject: { type: ['AchievementSubject'], ...subject, achievement, ...(scored ? { result: [scored.result] } : {}) },
    evidence: [
      {
        id: 'urn:uuid:' + o.award.earningStatementId,
        type: ['Evidence'],
        genre: 'xAPI statement',
        narrative: evidenceNarrative(o.assessed, o.award.testedOut),
      },
    ],
    credentialStatus: o.status,
  };
}

/** An OB 3.0 ResultDescription and Result for an xAPI score: the raw score with its range, else the scaled one. */
function scoreOf(badgeId: string, score: XapiScore | undefined) {
  const id = badgeId + '#score';
  const raw = score?.raw;
  const scaled = score?.scaled;
  if (raw === undefined && scaled === undefined) return undefined;
  const description =
    raw !== undefined
      ? {
          id,
          type: ['ResultDescription'],
          name: 'Score',
          resultType: 'RawScore',
          ...(score!.min !== undefined ? { valueMin: String(score!.min) } : {}),
          ...(score!.max !== undefined ? { valueMax: String(score!.max) } : {}),
        }
      : { id, type: ['ResultDescription'], name: 'Score', resultType: 'ScaledScore' };
  return { description, result: { type: ['Result'], resultDescription: id, value: String(raw ?? scaled) } };
}
