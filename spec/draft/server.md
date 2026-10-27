# Course server

> Draft 0.2. Not stable. Normative where marked.

This document defines the MCP surface of the course server conformance class: the extension declaration, tools, resources, prompts, sequencing and branch validation. Custody-specific behaviour is in custody.md, cmi5 sessions and the bridge in cmi5-binding.md, and secrecy and injection handling in security-privacy.md.

## Extension declaration

1. A server MUST advertise the extension `com.sqwrlz/course-xapi-mcp` in `capabilities.extensions` of its `server/discover` response, with a settings object holding `version`, `course`, `custody`, `official`, `allowPractice`, `badges`, `rulesVersion` and `authoring`. [CXM-SRV-001] <!-- design §9.1 -->
2. A server MUST NOT require the client to declare the extension; a client that does not know it still gets a working course through plain tools and text. [CXM-SRV-002] <!-- design §9.1 -->
3. A server MUST NOT rely on an MCP session: identity comes per request from the authorization token (custody options 1 to 3) or the practice handle argument (option 4). [CXM-SRV-003] <!-- design §9.1 -->
4. A server SHOULD keep serving clients of earlier MCP protocol revisions statelessly. [CXM-SRV-004] <!-- design §9.1 -->

Informative: the cmi5 session (cmi5-binding.md) is the server's own concept and is never an MCP session.

## Results

1. Every tool MUST return `structuredContent` matching its published output schema, plus the same content as text. [CXM-SRV-005] <!-- design §9.2 -->
2. Every result MUST carry `rules` (version, digest and the URI of the full rules text) and `cxm` (custody, official, the practice label if any, and the current lesson and step). [CXM-SRV-006] <!-- design §9.2 -->

## Tools

| Tool | Kind | Purpose |
| --- | --- | --- |
| `get_status` | read | Custody, who holds the record and how to view, export or delete it, the current position and the next actions |
| `list_paths` | read | The live and coming-soon paths |
| `start_placement` | write | Opens the placement AU session |
| `choose_placement` | write | Validates and records the placement |
| `get_lesson` | read | The current lesson, without secrets |
| `next_beat` | write | Moves to the next beat |
| `check_code` | write | Runs the deterministic checks |
| `reveal_bug` | write | Reveals a planted bug after the allowed failed attempts |
| `submit_checkpoint` | write | Submits the learner's checkpoint answer |
| `choose_branch` | write | Chooses an allowed branch |
| `end_session` | write | Ends the AU session |
| `get_record` | read | Views and exports the record (custody.md) |
| `get_badges` | read | Earned badge metadata and the claim page (badges.md) |
| `restart_course` | write | Starts the course again under a new registration |
| `resume_practice` | write | Continues an exported practice copy (custody.md) |
| `delete_practice_record` | write | Deletes a practice record |

1. A server MUST offer the tools in this table under these names; `get_badges` only in custody options 1 to 3, and `resume_practice` and `delete_practice_record` only for practice runs. [CXM-SRV-007] <!-- design §9.2 -->
2. A server MAY add tools, but MUST NOT give them names starting `cxm_`, which are reserved for this specification, and an added tool MUST NOT write the record by any route other than the statement rules. [CXM-SRV-008] <!-- design §5.4, §9.2, BC-24 -->
3. After a beat with a question, `next_beat` MUST refuse to advance without a `learner_reply`. [CXM-SRV-009] <!-- design §9.2 -->
4. `reveal_bug` MUST be refused until `revealAfter` failed fix attempts (default 3) have been made, and always when the author set `revealAfter: null`; when allowed it records `revealed`, the bug does not count as caught, and the lesson can still pass. [CXM-SRV-010] <!-- design §9.2, BC-23 -->
5. `end_session` MUST terminate the current AU session with its duration. [CXM-SRV-011] <!-- design §9.2 -->
6. `restart_course` MUST start a new registration in custody options 2 and 3 and a fresh practice run in option 4, leaving the old registration and earned badges unchanged; in option 1 it MUST tell the learner to ask their LMS instead. [CXM-SRV-012] <!-- design §9.2 -->

## Rules, resources and prompts

1. A server MUST deliver the agent rules (agent-rules.md, with the course's own rules appended after them) in its server instructions, as the resource `course-xapi-mcp://rules/agent`, through the `tutor` prompt, and as the digest in every result. [CXM-SRV-013] <!-- design §9.2, BC-25 -->
2. A server SHOULD also offer the rules as the skill `skill://course-xapi-mcp-tutor/SKILL.md`. [CXM-SRV-014] <!-- design §9.2, BC-25 -->
3. A server MUST offer the resource `course-xapi-mcp://course` as a safe outline of the course and MUST NOT serve the raw package through it. [CXM-SRV-015] <!-- design §9.2 -->
4. A server MUST offer the resource `course-xapi-mcp://record/export` with the export payload. [CXM-SRV-016] <!-- design §9.2 -->
5. Wherever a package is served over HTTP, it MUST carry an ETag that changes whenever its content does. [CXM-SRV-017] <!-- design §6.2 -->

## Sequencing and branch validation

The author decides what exists, its order and what is secret. The agent decides how to explain and which allowed branch fits a free-text answer. The server decides whether code passes, which branches are possible, and whether a statement exists and what it says. <!-- design §9.3 -->

1. A server MUST serve steps in the authored order. [CXM-SRV-018] <!-- design §9.3 -->
2. Whether code passes MUST be decided only by the server's deterministic checks, and that result is final. [CXM-SRV-019] <!-- design §9.3 -->
3. After a failed check, a server MUST allow only `success: false` branches. [CXM-SRV-020] <!-- design §9.3 -->
4. A server MUST refuse an invented, foreign or early branch choice and MUST write no statement for it. [CXM-SRV-021] <!-- design §9.3, §13 -->
5. A server MUST record the agent's rationale for a branch choice. [CXM-SRV-022] <!-- design §9.3 -->
6. A server MUST validate a placement against the authored placement options. [CXM-SRV-023] <!-- design §9.3 -->
7. Statements MUST be built only by the server, from validated events. [CXM-SRV-024] <!-- design §9.3 -->
