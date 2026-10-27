# Badges

> Draft 0.2. Not stable. Normative where marked.

This document defines the badge issuer conformance class: when a badge is earned and what it says. It refers to Open Badges 3.0 and does not copy it. Open Badges is a standard of 1EdTech Consortium, Inc., acknowledged here as its licence requires. Badge privacy is in security-privacy.md; badge declarations are validated as package requirements (package.md).

## Declaration

Informative summary: `course.json#/badges[]` holds one entry per lesson, path or course, each with the Open Badges Achievement fields, `awardOn` (`au-moveon`, `block-satisfied`, `course-satisfied` or `any-path`) and `countWaived` (default false). `course.json#/badgeIssuer` declares `signer` (`record-holder` or `course-server`) and `claimPage`. <!-- design §11 -->

## When a badge is earned

1. An issuer MUST issue a badge only on its declared cmi5 event: AU `moveOn` met (`au-moveon`), block satisfied (`block-satisfied`), course satisfied (`course-satisfied`), or the first block satisfied (`any-path`). [CXM-BDG-001] <!-- design §11, §6.3 rule 6 -->
2. An issuer MUST issue at most one badge per achievement per registration. [CXM-BDG-002] <!-- design §11 -->
3. A practice run MUST NOT earn a badge. [CXM-BDG-003] <!-- design §11 -->
4. A waived lesson MUST NOT earn a lesson badge unless the badge sets `countWaived`, and MUST count towards path and course satisfaction. [CXM-BDG-004] <!-- design §6.3 rule 5 -->
5. A carried-over lesson MUST NOT earn a lesson badge, even with `countWaived`, and MUST count as not done for a path or course badge. [CXM-BDG-005] <!-- design §6.3 rule 5, reconciliation 6 -->

## Trust

1. An issuer MUST compute the earning event only from statements written by the course server's or the LMS's credentials, never from anything the learner or the agent can write. [CXM-BDG-006] <!-- design §11 -->
2. A course server MUST give an issuer other than itself the distribution package on publish and whenever the content changes. [CXM-BDG-007] <!-- design §11, reconciliation 4 -->

## Credential contents

1. A badge MUST be an OpenBadgeCredential under the W3C Verifiable Credentials Data Model 2.0, with an `eddsa-rdfc-2022` proof over an Ed25519 key and a `did:web` issuer. [CXM-BDG-008] <!-- design §11 -->
2. A badge MUST carry `credentialStatus` as a `BitstringStatusListEntry`. [CXM-BDG-009] <!-- design §11 -->
3. A badge MUST carry exactly one evidence entry, with `id` `urn:uuid:<earning statement id>`, a narrative and `genre` `xAPI statement`; the earning statement is the `satisfied` statement for a block or course, or the defined statement that met `moveOn` for an AU. [CXM-BDG-010] <!-- design §11 -->
4. A badge MUST NOT use custom JSON-LD terms. [CXM-BDG-011] <!-- design §11 -->
5. The criteria narrative MUST say how the learning was assessed: deterministic checks, or the learner's AI agent judging free text against an authored rubric. [CXM-BDG-012] <!-- design §11, §9.4 -->
6. When waived lessons counted towards a path or course badge, the evidence narrative MUST state how many. [CXM-BDG-013] <!-- design §11, owner answer 6 -->

## Claiming

1. `get_badges` MUST return badge metadata and the course's `claimPage`, and MUST NOT return a bearer claim link. [CXM-BDG-014] <!-- design §11, reconciliation 5 -->
2. The claim page MUST identify the learner before the issuer mints a claim link. [CXM-BDG-015] <!-- design §11 -->
3. An MCP tool MUST NOT sign anything, and a signing key MUST NOT be reachable by the agent. [CXM-BDG-016] <!-- design §11 -->

Informative: how the claim page obtains a link from the issuer is not specified.

## After issuing

1. After issuing, the issuer MUST write `earned` (`http://specification.openbadges.org/xapi/verbs/earned`, with the `badgeassertion` result extension holding the credential id) with `context.statement` referring to the earning statement; in options 2 and 3 it goes to the official record. [CXM-BDG-017] <!-- design §10.2, §11 -->

## Who signs

1. In option 1, the LMS side signs if it implements these badge rules; otherwise the course server MUST sign lesson badges only from the defined statements it sent and the LMS accepted, and path and course badges only if it can read the LMS's `satisfied` statement with the session token, naming itself as issuer and the LMS in the criteria. [CXM-BDG-018] <!-- design §11, owner answer 7 -->
2. In option 1, a course server that signs MUST keep its own issuer record holding the `earned` statement and the credential, authoritative for the badges it signed and read by `get_badges` and `get_record`. [CXM-BDG-019] <!-- design §11 BC-32 -->
3. In option 1, if a session for the same registration is open when the badge is issued, the course server MUST also send `earned` to the LMS's LRS inside that session with the cxm profile category, and MUST NOT write to the LMS after a session's `terminated`. [CXM-BDG-020] <!-- design §11 BC-32 -->
4. In option 2, the record holder MUST sign, unless the course declares `badgeIssuer.signer: "course-server"`, in which case the course server signs as in option 3. [CXM-BDG-021] <!-- design §11, reconciliation 5 -->
5. In option 3, the course server MUST sign, from its own store. [CXM-BDG-022] <!-- design §11 -->

## Revocation

1. An issuer MUST revoke by flipping a bit in a signed status list of at least 131 072 entries, at a random index. [CXM-BDG-023] <!-- design §11 -->
2. An issuer MUST revoke a badge when its earning statement is voided and when the record holder erases the learner's statements on request; it MAY revoke for issuer error or misconduct. [CXM-BDG-024] <!-- design §11, owner answer 4 -->
3. Re-issuing after a key rotation MUST keep the credential id with a newer `validFrom`, and old keys MUST stay in the DID document. [CXM-BDG-025] <!-- design §11 -->

Informative: Open Badges 2.0 export, CLR 2.0, VC-JWT and 1EdTech certification are not part of this draft.
