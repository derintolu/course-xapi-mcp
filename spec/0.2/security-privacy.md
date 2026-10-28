# Security and privacy

> Draft 0.2. Not stable. Normative where marked.

This document covers prompt injection, credentials, planted-bug secrecy and badge privacy. They apply to every course server, launch bridge and badge issuer.

## Prompt injection

1. A server MUST wrap learner text in `<learner_input>` and neutralise any wrapper tags inside it. [CXM-SEC-001] <!-- design §9.4 -->
2. A server MUST NOT use learner text as a pattern, a path or a branch input. [CXM-SEC-002] <!-- design §9.4 -->
3. A server MUST return only authored content, check results, wrapped learner text and the record. [CXM-SEC-003] <!-- design §9.4 -->

Informative: course text is untrusted for the agent too. Author rules can only be appended to the core rules and stay within how to teach the course (package.md, Content). Hosts treat a skill as untrusted.

## Credentials

1. An LRS or LMS credential, token, actor account name or registration MUST NOT appear in a result the agent sees, except the learner's own actor and registration inside their export. [CXM-SEC-004] <!-- design §9.4 -->

## Known limits

1. The record MUST keep agent-written text (`rationale`, placement reason) apart from learner-written text. [CXM-SEC-005] <!-- design §9.4 -->

Informative: an agent can fabricate learner replies, so badge criteria say when free-text checkpoints are judged by the learner's agent (badges.md). Hosts without OAuth can use practice only.

## Planted-bug secrecy

1. A server MUST NOT send a planted bug's explanation, location or fix checks to the agent before the learner's fix passes (`caught`) or the author-allowed `reveal_bug` succeeds (`revealed`), and MUST NOT send the reference solution at all. [CXM-SEC-006] <!-- design §6.2, §9.5 -->
2. Fix-attempt statements MUST carry an empty `checks` list. [CXM-SEC-007] <!-- design §9.5 -->

Informative: secret fields are also left out of the distribution package (package.md).

## Badge privacy

1. A badge MUST NOT carry the xAPI actor id, hashed or plain. [CXM-SEC-008] <!-- design §11 -->
2. A badge MUST NOT embed statements, and MUST carry scores only if the author opts in. [CXM-SEC-009] <!-- design §11 -->
3. Recipient binding MUST happen at claim time, to a wallet DID or to an email hashed with a random 16-byte salt, and the issuer MUST store only the hash and salt. [CXM-SEC-010] <!-- design §11 -->
4. A badge MUST NOT be issued without a recipient. [CXM-SEC-011] <!-- design §11 -->
