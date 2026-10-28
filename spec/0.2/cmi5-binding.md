# cmi5 binding

> Draft 0.2. Not stable. Normative where marked.

This document binds a course server to cmi5: AU sessions, the rules that reconcile branching and placement with `moveOn`, the LMS role the server takes in custody options 2 and 3, and the launch bridge conformance class for option 1. Every rule keeps statements cmi5-legal in every custody option.

## AU sessions

1. A server MUST run one AU session per lesson visit: it starts at the first tool call on that lesson and ends with `terminated` when the lesson resolves, when the learner moves to another lesson, when the agent calls `end_session`, or after inactivity. [CXM-BRG-001] <!-- design §6.3 rule 1, BC-11 -->

Informative: 30 minutes is a suitable inactivity timeout.

## Checkpoint outcomes

1. A `success: false` branch MUST record the allowed `failed` on the checkpoint activity and MUST leave the AU session open for a retry. [CXM-BRG-002] <!-- design §6.3 rule 2, BC-12 -->
2. A server MUST send a defined `failed` on the AU only when the author set `maxAttempts` and the attempts ran out, and MUST then end the session with `terminated`. [CXM-BRG-003] <!-- design §6.3 rule 2 -->
3. A defined `failed` MUST NOT follow a defined `passed` in the same registration. [CXM-BRG-004] <!-- design §6.3 rule 2 -->
4. A server MUST send `completed` only after the last beat and after any planted bug is caught or revealed, and `passed` only when a `success: true` branch is chosen; each at most once per registration. [CXM-BRG-005] <!-- design §6.3 rule 3 -->

Informative: a later session on the same lesson in the same registration starts a fresh set of attempts and may still send a defined `passed`. An LMS, or a plugin applying results back, treats a lesson as done only when the AU's `moveOn` is met, never on `completed` alone.

## Review instead of redo

1. A branch to a lesson already satisfied in this registration (passed, completed without a checkpoint, or waived) MUST run as a review walk-through inside the current session: beats only, allowed statements only with the target lesson as parent, then back to the branching lesson's checkpoint. [CXM-BRG-006] <!-- design §6.3 rule 4, BC-13 -->
2. A branch to the same, unpassed lesson MUST restart its beats in the same session. [CXM-BRG-007] <!-- design §6.3 rule 4 -->

## Skips and waivers

1. In options 2 and 3, a lesson skipped by placement or jumped over by a `success: true` branch MUST be `waived` with reason `Tested Out`. [CXM-BRG-008] <!-- design §6.3 rule 5 -->
2. In option 1, a server MUST NOT waive; it MUST record the allowed `placed` or `branched` with a `waive-recommended` result extension listing the AU ids, which an LMS MAY act on. [CXM-BRG-009] <!-- design §6.3 rule 5, cmi5 C1 -->
3. A lesson carried over from an earlier record version MUST be waived with reason `Administrative` and the `carried-over` result extension. [CXM-BRG-010] <!-- design §6.3 rule 5, reconciliation 6 -->

Informative: in option 1 a plain LMS leaves recommended waivers unsatisfied, and the block stays unsatisfied until an administrator acts. A package has one block per path; course `satisfied` keeps its strict cmi5 meaning (every path done).

## LMS role in options 2 and 3

1. A server MUST be its own MCP authorization server (OAuth 2.1); in option 2 it federates login to the author's identity provider over OIDC, and in option 3 it signs learners in against its own accounts. [CXM-BRG-011] <!-- design §8.1 -->
2. Unless the LRS assigns an actor, the actor MUST be `account {homePage: <course IRI base>, name: <identity provider subject>}`. [CXM-BRG-012] <!-- design §8.1 -->
3. A server MUST mint the registration, keep it in the record holder, and reuse it on return until `restart_course` mints a new one. [CXM-BRG-013] <!-- design §8.1 -->
4. The AU activityId MUST be `{au@id}/au`. [CXM-BRG-014] <!-- design §6.1, §8.1 -->
5. A server MUST generate sessionids, and MUST send `launched` (launchMode `Normal`) before `initialized`; review walk-throughs get no `launched` of their own. [CXM-BRG-015] <!-- design §8.1 -->
6. A server MUST issue `waived` and `satisfied` in the LMS role. [CXM-BRG-016] <!-- design §8.1 -->
7. A server MUST NOT claim cmi5 LMS conformance; it claims cmi5-shaped records. [CXM-BRG-017] <!-- design §8.1 -->

## Practice

1. In option 4, a server MUST NOT require authorization and MUST mint a practice actor and handle on `start_placement`. [CXM-BRG-018] <!-- design §8.1 -->

## Launch bridge

The launch bridge is the conformance class for option 1. The AU `url` in the package is the course server's https bridge, launched by the LMS with `launchMethod="OwnWindow"`. <!-- design §8.2 -->

1. On launch, the bridge MUST parse the launch parameters and POST to `fetch` once, server-side. [CXM-BRG-019] <!-- design §8.2 step 2 -->
2. The bridge MUST read and honour `LMS.LaunchData` and `cmi5LearnerPreferences`, and every statement MUST carry the launch's `contextTemplate`. [CXM-BRG-020] <!-- design §8.2 step 2, §13 -->
3. The bridge MUST store the launch context against a launch id and send `initialized` straight away. [CXM-BRG-021] <!-- design §8.2 step 2, BC-21 -->
4. The LMS token MUST NOT reach the browser or the agent. [CXM-BRG-022] <!-- design §8.2 step 2 -->
5. The bridge page MUST tell the learner to continue in their agent and show the course's MCP URL. [CXM-BRG-023] <!-- design §8.2 step 3 -->
6. The server's authorization page MUST bind the grant to the launch through the bridge's cookie when present, and otherwise through a six-character pairing code from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, single use, valid for 10 minutes and typed into the authorization page. [CXM-BRG-024] <!-- design §8.2 step 4, BC-22 -->
7. The grant MUST bind to (LMS endpoint, actor, registration), and later launches in the same registration MUST attach to the same agent connection. [CXM-BRG-025] <!-- design §8.2 step 5 -->
8. When the next lesson is a different AU, the result MUST tell the agent to send the learner back to the LMS (`returnURL`) to launch it. [CXM-BRG-026] <!-- design §8.2 step 5 -->
9. A server MUST send `terminated` with `duration` before the LMS token is likely to expire. [CXM-BRG-027] <!-- design §8.2 step 6 -->
10. On a relaunch, the newest launch MUST be the live one, and calls on a stale launch MUST report that the lesson was relaunched elsewhere. [CXM-BRG-028] <!-- design §8.2 step 6 -->
11. The actor MUST be the one the LMS supplied, with no dual write and no anonymous copy. [CXM-BRG-029] <!-- design §8.2 step 7 -->

Informative: hosts without MCP authorization support cannot use options 1 to 3; they can use practice if the course allows it.
