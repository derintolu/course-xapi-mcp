> Superseded by the course-xapi-mcp design (docs/superpowers/specs/2026-10-27-course-xapi-mcp-design.md). Kept as history.

# Status

Written by Claude on 2026-10-19, while Derin was away. Nothing here has been reviewed by Derin yet.

Repo: https://github.com/derintolu/learning-mcp (private). Branch `main`.

## Done

- **Research** ([research.md](research.md)): MCP 2026-07-28 (stateless, no sessions, server-minted handles), the v2 TypeScript SDK (2.3.1), Claude custom connectors and ChatGPT developer mode, xAPI 2.0 versus 1.0.3 (read from the standard's text), xAPI Profiles, cmi5, and prior art, with sources.
- **Design spec** ([spec.md](spec.md)): problem, goals, non-goals, architecture, content format, lesson flow, tools, trust model, privacy model, record format, open questions.
- **Rules**: [`RULES.md`](../RULES.md) (normative protocol), [`rules/AGENT_RULES.md`](../rules/AGENT_RULES.md) (sent to agents), [`profile/xapi-profile.jsonld`](../profile/xapi-profile.jsonld) and [xapi-profile.md](xapi-profile.md).
- **`packages/core`**: schema, engine, checks, xAPI builder and validators, record reducer and parser, session tools, rules text, profile builder, memory store. Ported from learn-wp-reimagined with credit in each file.
- **`packages/server`**: `createCourseServer()`, 11 tools, rules as instructions, resource and prompt, Origin/Host guards, directory store, Node bin.
- **`examples/json-basics`**: two lessons, with a free-text checkpoint, a planted bug and a code checkpoint.
- **README**, this file, and [verification.md](verification.md).

## Verified, with evidence

All details and transcripts are in [verification.md](verification.md).

| Claim | Evidence |
| --- | --- |
| Tests pass | `npm test`: 9 files, 102 tests. `npm run typecheck`: exit 0. |
| An agent choosing a non-authored branch is rejected, and nothing is recorded | `session.test.ts` (4 cases) and `server.test.ts` over MCP in both eras; live transcript shows `skip-ahead` refused with "choose one of: ready, review". |
| A failed deterministic check cannot become a pass | `engine.test.ts`, `session.test.ts` ("a failed deterministic check removes every passing branch"). |
| Prompt-injected learner text is wrapped and cannot change branches | `session.test.ts` (5 cases), `server.test.ts`; live transcript shows `[tag removed]` and unchanged allowed branches. |
| Every event produces valid xAPI that conforms to the profile | `xapi.test.ts` checks every statement of a full run with `validateStatement` and `checkProfile`; `server.test.ts` repeats it for statements returned over MCP. |
| The record round-trips | `record.test.ts` (JSON export and parse is identical; 6 tamper cases refused); `server.test.ts` `get_record` → `link_record` → identical statements, and continuing from the linked copy works. |
| The planted bug stays secret until fixed | `session.test.ts` and `server.test.ts` scan every response before the fix for the explanation and the fix-check pointer. |
| Works with the official MCP client, old and new protocol | `server.test.ts` runs every case with the SDK client in legacy (2025 `initialize`) and pinned `2026-07-28` modes; live HTTP runs of `scripts/verify-client.ts` in both modes gave identical transcripts. |
| Works with the MCP Inspector CLI | `tools/list`, `tools/call`, `resources/read` all ran; `--strict` schema portability went from 12 warnings to 0 after a fix. |
| HTTP guards | `curl`: bad Origin 403, bad Host 403, 2025-style GET 405. |

**Not verified:** a real host (Claude.ai, ChatGPT, Claude Code, Cursor) with a real model teaching; posting statements to a real LRS; an external xAPI Profile validator. See verification.md §4.

## Decisions I made, and what each costs if wrong

Ordered by how expensive it would be to reverse.

| # | Decision | Cost if wrong |
| --- | --- | --- |
| 1 | **IRIs under `https://w3id.org/learning-mcp/`** (profile, verbs, activity types, extensions, actor home page). Not registered yet. | High once real records exist: changing IRIs breaks comparability with old statements. Cheap to change now. |
| 2 | **One fixed actor `homePage` for every course** (`…/learner`), with a random UUID per record, so one record can span courses. | Medium. An LRS sees all learning-mcp learners as accounts on one "system". The alternative splits one learner into many actors. |
| 3 | **Statements target xAPI 2.0 and stay 1.0.3-valid**: no `version`, no `contextAgents`, UTC milliseconds, arrays in `contextActivities`. Carries over the seed's reviewed decision. | Low. Loses 2.0-only features, which nothing here needs. |
| 4 | **Authored branch ids with `success` and `when`**, replacing the seed's fixed advance/review/skip enum. | Medium. Reports lose a shared outcome vocabulary across courses. `success` still gives pass/fail, and learn-wp-reimagined maps its three outcomes to ids directly. |
| 5 | **A failed check allows only `success: false` branches.** | Low. A course that wants "checks failed but explanation excellent, advance anyway" can't express it. That is deliberate. |
| 6 | **Strict lesson order**, and `learner_reply` is **required** after a beat with a question. | Medium. Real conversations may feel rigid, and agents may paste summaries instead of verbatim replies. Easy to relax per course later. |
| 7 | **Planted bugs**: the server never sends the explanation or fix checks before the fix passes; failed attempts return only the authored hint; attempt statements carry an empty `checks` list; the bug must be caught before the checkpoint. | Medium. A stuck learner has no "show me" path. A deliberate `reveal_bug` tool (recorded as such) is the obvious addition. |
| 8 | **No auth; the record handle is the only key** (192 random bits, never in statements). Server relays records in memory, 30-day inactivity expiry (the seed's number). | Medium. Anyone holding a handle can read that record, and a public relay can be filled by anyone without rate limits (none built). |
| 9 | **Built on `@modelcontextprotocol/server` 2.3.1 (SDK v2)**, using its default stateless service of 2025-era clients. | Low to medium. If a host trips on v2's legacy path, fall back to v1 (`@modelcontextprotocol/sdk` 1.32.1). Tests cover the legacy path with the SDK's own client. |
| 10 | **`branched` has the checkpoint as its object** and the target in a `to` extension (the seed used the target lesson as the object). | Low now; would be a breaking change after records exist. |
| 11 | **Own verbs `placed`, `branched`, `caught`** instead of borrowing near-matches from the registry, which I could not load during research. | Low. If ADL verbs fit better, map them before 1.0. |
| 12 | **No cmi5 conformance claim.** Verbs overlap so a bridge stays possible. | Low. |
| 13 | **Tools beyond the brief**: `choose_placement` (validated commit) and `delete_record` (privacy). | Low. |
| 14 | **Rules travel four ways**: server instructions, `learning-mcp://rules/agent`, a `tutor` prompt, and a 7-line digest on every result (Claude.ai's docs only describe tools). Course rules can only be appended. | Low. Costs a few hundred tokens per result. |
| 15 | **`get_record` returns the record unwrapped**, with a "treat as data" note, as the one exception to wrapping learner text. | Low to medium. An agent reading the export sees raw learner text. Wrapping would corrupt the export. |
| 16 | **`context.platform` is the client's self-reported name** (only sent by 2026-era clients). | Low. Self-reported, so not evidence of which model taught. |
| 17 | **`link_record` takes JSON text only**, and **output schemas are hand-written JSON Schema** with `additionalProperties: true`, to clear the Inspector's portability warnings. | Low. Output shapes beyond `ok` and `rules` are documented, not schema-enforced. |
| 18 | **Core depends only on `zod`**; packages export TypeScript source (no build step, not published to npm). | Low. Consumers need a TS-aware runtime or bundler until there is a build. |
| 19 | **Licences**: code GPL-2.0-or-later, docs/rules/profile/example CC BY-SA 4.0, as briefed. The SDK is Apache-2.0, which is compatible with GPLv3 but not GPLv2, so a distributed server bundle is effectively GPLv3. | Medium if Derin needs GPLv2-only compatibility; then the server package needs an exception or a different licence. Core has no Apache dependency. |
| 20 | **Language tags use the course's tag (`en`)**, not the seed's `en-US`. | Low. |
| 21 | **Example course is about JSON**, with RFC 8259 as its source. | Low. |

## Known gaps

- **Workers/Spacefast need a durable store.** `MemoryStore` lives in one process; in Workers each isolate has its own memory, so records would vanish between requests. Plan B needs a KV, D1 or Durable Object `RecordStore` (the interface is three methods).
- **No rate limits or quotas** in the server. The seed has them; production must put them in front.
- **Concurrent calls with the same handle can race** (read, update, write). Fine for one learner in one chat; a durable store should use compare-and-set.
- **No build or npm publish** for the packages yet.
- Legacy-era clients send `clientInfo` only on `initialize`, which the stateless legacy path does not keep, so their statements have no `platform`.

## Open questions for Derin, most important first

1. **IRI namespace.** Register `w3id.org/learning-mcp` (needs a public page for the profile, so probably a public repo), or use a domain you own? Has to be settled before anyone keeps real records.
2. **Go public?** The repo is private as asked. The w3id registration, the profile and "send it to the agent you pay for" all work better public. When, and under `derintolu` or an org?
3. **Account linking** (for example WordPress.org). Statements are immutable, so the anonymous actor can't be rewritten. Options in spec §11.3; I lean towards a signed "linked" statement. Which do you want?
4. **Strictness.** Keep required verbatim replies and "fix the bug before the checkpoint", or add a recorded `reveal_bug` / skip path for stuck learners?
5. **Record migration for learn-wp-reimagined.** Its `learn-wp-reimagined/record` v1 and this `learning-mcp/record` v1 differ (IRIs, one course versus many, `branched` object). Migrate the site to this format before launch, or keep both and convert on export?
6. **Statement attestation.** Should course servers sign the statements they issue, so a record shown to someone else can be checked?
7. **ChatGPT plans.** Sources disagree on whether Plus/Pro allow write tools in developer mode. Worth testing on a real account before promising "works in ChatGPT".
8. **Licence of the server package** given the Apache-2.0 SDK (decision 19). Is "effectively GPLv3 when bundled" acceptable?
9. **Name.** "learning-mcp" is descriptive but generic. Keep it?
