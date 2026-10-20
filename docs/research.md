# Research notes

Checked on 2026-10-19 against live sources. Everything below that affects a design decision has a URL. Where sources disagreed, both readings are given.

## 1. Model Context Protocol

### Current specification: 2026-07-28

The latest revision is **2026-07-28** (https://modelcontextprotocol.io/specification/latest, schema at https://github.com/modelcontextprotocol/specification/blob/main/schema/2026-07-28/schema.ts). It is a large change from 2025-11-25 (changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog):

- **MCP is now stateless.** The `initialize` / `notifications/initialized` handshake is gone. Every request carries its protocol version and client capabilities in `_meta` (`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`). Servers MUST implement `server/discover`.
- **No protocol sessions.** `Mcp-Session-Id` is removed. The changelog says: "Servers that need cross-call state use explicit, server-minted handles passed as ordinary tool arguments" (SEP-2567). This is exactly the shape a learning server needs: a learner/record handle passed to each tool.
- **Server-to-client requests** (sampling, elicitation, roots) are replaced by Multi Round-Trip Requests: the server returns `resultType: "input_required"` and the client retries. Sampling, Roots and Logging are **deprecated**.
- Every result carries `resultType`. List results carry `ttlMs` and `cacheScope`. `tools/list` SHOULD be in a deterministic order.
- `inputSchema`/`outputSchema` may use any JSON Schema 2020-12 keyword, and `structuredContent` may be any JSON value.

### Streamable HTTP in 2026-07-28

From https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http:

- One MCP endpoint that accepts POST. Each JSON-RPC request is its own POST; the reply is a JSON object or a request-scoped SSE stream. The GET stream is removed (servers answer GET/DELETE with 405).
- Clients MUST send `MCP-Protocol-Version`, `Mcp-Method` and (for `tools/call`, `resources/read`, `prompts/get`) `Mcp-Name` headers; servers MUST reject header/body mismatches with `-32020 HeaderMismatch`.
- "Servers **MUST** validate the `Origin` header on all incoming connections to prevent DNS rebinding attacks. If the `Origin` header is present and invalid, servers **MUST** respond with HTTP 403." Local servers SHOULD bind to 127.0.0.1.
- Backward compatibility: a modern server receiving 2025-era traffic can serve it as the older revision. Claude, ChatGPT and most IDE clients in the field were built against 2025-06-18 / 2025-11-25, so a public course server must accept both eras.

### Authorization

Authorization is optional. The transport page says servers "SHOULD implement proper authentication", and the authorization pages define OAuth 2.1 for servers that need it. This revision deprecates Dynamic Client Registration in favour of Client ID Metadata Documents. A public course whose content is public can run with no auth, as long as anything learner-specific is protected some other way (here: an unguessable record handle).

### TypeScript SDK

Checked with `npm view` on 2026-10-19:

| Package | Version | Notes |
| --- | --- | --- |
| `@modelcontextprotocol/server` | **2.3.1** (2026-10-05) | v2 stable line, implements 2026-07-28. Apache-2.0. Depends on `zod ^4.2`. |
| `@modelcontextprotocol/client` | 2.3.1 | v2 client, `Client` + `StreamableHTTPClientTransport`. |
| `@modelcontextprotocol/node` | 2.1.1 | `toNodeHandler`, localhost Host/Origin validation. |
| `@modelcontextprotocol/sdk` | 1.32.1 | v1 line, still maintained, MIT. |
| `@modelcontextprotocol/inspector` | 2.11.0 | has a CLI mode. |

The server README says: "This is v2 of the MCP TypeScript SDK, the stable release line, implementing the 2026-07-28 MCP spec. It replaces the single `@modelcontextprotocol/sdk` package from v1." (https://ts.sdk.modelcontextprotocol.io/v2/)

Useful v2 facts (https://ts.sdk.modelcontextprotocol.io/v2/serving/http, https://ts.sdk.modelcontextprotocol.io/v2/servers/tools, and the package's `.d.mts` files):

- `createMcpHandler(factory, options)` returns `{ fetch, close, ... }`, where `fetch` is `(Request) => Promise<Response>`. It is web-standard, so it runs on Workers, Deno, Bun and (through `toNodeHandler`) Node. The factory runs once per request; there is no instance state.
- Its `legacy` option defaults to `'stateless'`: 2025-era (initialize-based) requests are served statelessly from the same factory, and GET/DELETE get 405. So one handler serves both eras.
- The handler does **not** check Host or Origin itself. `hostHeaderValidationResponse` and `originValidationResponse` are exported to put in front of it.
- `new McpServer(info, { instructions })` sets server instructions. `registerTool(name, { title, description, inputSchema: z.object(...), outputSchema, annotations }, handler)`; the SDK validates `structuredContent` against `outputSchema`.

**Decision (Claude, pending Derin's review):** build on `@modelcontextprotocol/server@2.3.1` (v2), not the v1 `sdk` package. It matches the current spec, is web-standard, and still serves older clients.

## 2. Clients that connect to remote MCP servers

### Claude custom connectors

https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp (page said "Updated over 2 weeks ago"):

- Available on Claude, Cowork and Claude Desktop for **Free, Pro, Max, Team and Enterprise**. Free users get one custom connector. (An older copy of the article, and https://support.anthropic.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers, list only paid plans and say "beta"; the current page is the newer one.)
- Add via Customize > Connectors > Add custom connector, enter a name and URL. Authentication can be "No sign in" (authless), OAuth, or a fixed request header.
- Connections come **from Anthropic's cloud**, so the server must be publicly reachable. Local servers are not reachable from claude.ai.
- The page documents tools; it does not say resources or prompts are surfaced. Design must not depend on resources or prompts being read by Claude.ai.
- The article warns about prompt injection and notes that in Research mode Claude can invoke connector tools without approval.

### ChatGPT developer mode

OpenAI's own developer-mode guide URL returned 404 during this check (https://developers.openai.com/api/docs/guides/developer-mode), so these points come from launch coverage and third-party guides:

- Developer mode launched as a beta in late 2025 with full MCP client support, SSE or streaming HTTP, and OAuth or no auth (https://the-decoder.com/openai-has-launched-developer-mode-for-chatgpt-with-full-access-to-model-context-protocol, https://www.infoq.com/news/2025/10/chat-gpt-mcp).
- Remote public HTTPS endpoints only; enabled under Settings > Apps/Connectors > Advanced > Developer mode, then "Create app" (https://designrevision.com/blog/add-mcp-server-to-chatgpt, https://hjarni.com/blog/how-to-use-mcp-with-chatgpt).
- **Sources disagree on plans.** Some say Plus and Pro get full read/write tools; Boomi's guide (https://help.boomi.com/docs/Atomsphere/Platform/Connect_chatgpt_setup) says Plus/Pro get read-only custom connectors and write actions need Business, Enterprise or Edu. Write actions ask the user to confirm.

Consequence for design: tools that only record learning progress should carry honest annotations. A learner on a read-only plan could still read content and run checks if the record tools are marked as writes and refused. This is an open question to test on a real account.

### Claude Code, Cursor and other MCP clients

These connect to HTTP MCP servers directly, including localhost, and have local file access. They can keep the learner's record as a file in the project folder and pass it to `link_record`.

## 3. xAPI

### 2.0 (IEEE 9274.1.1-2023) versus 1.0.3

- xAPI became IEEE 9274.1.1-2023 on 2023-10-10 (https://adlnet.gov/news/2023/11/22/xAPI-Officially-Becomes-a-Published-IEEE-Standard). ADL calls it xAPI 2.0. The 1.0.3 repo (https://github.com/adlnet/xAPI-Spec) is archived in favour of the IEEE text.
- I read the standard's text from a public mirror of the IEEE repository (https://github.com/madebyraygun/xapi-base-standard-documentation, file "9274.1.1 xAPI Base Standard for Content.md"). Relevant LRP rules:
  - "An LRP _should not_ provide a version for the Statement. If an LRP sets the Statement version, it _shall_ set it to 2.0.0." (A 1.0.x LRS rejects `2.0.0`, so omitting it is the portable choice.)
  - "A Timestamp _shall_ be formatted to UTC", RFC 3339, "at least millisecond precision". `Date.prototype.toISOString()` satisfies this.
  - "A Learning Record Provider _shall not_ use a future time for a timestamp."
  - "An LRP _shall_ _not_ add additional properties to Statements."
  - "The Learning Record Provider _should_ ensure that every value in the contextActivities Object is an array."
  - New in 2.0: `context.contextAgents` and `context.contextGroups` (objects with `objectType: "contextAgent"`, `agent`, `relevantTypes`). A 1.0.3 LRS will reject them, so this project does not use them.
  - Statements are immutable and should not be deleted. Requests carry `X-Experience-API-Version`.
  - Language-map keys must be valid RFC 5646 tags; the standard prefers the shortest correct tag (`en` rather than guessing `en-US`).
- The ADL 1.0.3-to-2.0 change summaries (https://adlnet.gov/news/2021/10/20/IEEE-to-Standardize-xAPI-v2.0-as-an-International-Standard) mention context agents/groups, forbidden extra properties, UTC timestamps, and many SHOULDs becoming MUSTs.

**Decision (Claude, pending Derin's review):** emit statements that satisfy xAPI 2.0 and are also valid 1.0.3: no `version`, no `contextAgents`/`contextGroups`, UTC millisecond timestamps, arrays in `contextActivities`, no extra properties. This carries over the seed project's reviewed decision (`learn-wp-reimagined/docs/record-format.md`).

### xAPI Profiles

The Profiles spec (https://github.com/adlnet/xapi-profiles/blob/master/xapi-profiles-structure.md):

- A profile is JSON-LD with `@context: "https://w3id.org/xapi/profiles/context"`, `type: "Profile"`, `conformsTo: "https://w3id.org/xapi/profiles#1.0"`, `id`, `prefLabel`, `definition`, `author`, `versions`. Concepts are `Verb`, `ActivityType`, `ContextExtension`, `ResultExtension`, `ActivityExtension` and others, each with `id`, `type`, `inScheme`, `prefLabel`, `definition`.
- Statement templates (`StatementTemplate`) set `verb`, `objectActivityType`, `contextParentActivityType` and so on, plus JSONPath `rules` with `presence`/`any`/`all`/`none`. Patterns describe statement sequences.
- §5: statements that conform to a profile's templates "SHOULD include the most up-to-date conformant Profile version as a category context activity with id equal to the version's `id`", and then MUST conform.
- Extension concepts may include `inlineSchema` (JSON Schema draft-07). Result extensions only go in `result`, context extensions only in `context`.
- Profile IRIs are conventionally hosted under `https://w3id.org/` permanent identifiers.

### cmi5

https://github.com/AICC/CMI-5_Spec_Current/blob/quartz/cmi5_spec.md: cmi5 is an xAPI profile for an **LMS launching** assignable units. The LMS passes `endpoint`, `fetch` (one-time auth token), `actor`, `registration` and `activityId`, and keeps launch data in the State API. Defined verbs: launched, initialized, completed, passed, failed, terminated (ADL IRIs), and abandoned, waived, satisfied (`https://w3id.org/xapi/adl/verbs/...`). cmi5-defined statements carry the category `https://w3id.org/xapi/cmi5/context/categories/cmi5`.

**Decision (Claude, pending Derin's review):** do not claim cmi5 conformance. There is no LMS launch in this model; the agent is the runtime and the learner's record is the store. The profile reuses the same ADL verbs as cmi5 for passed, failed and completed, so a future cmi5 bridge (an LMS launching a "connect your agent" AU) stays possible. Listed as an open question.

### Verb vocabulary

The ADL verbs `http://adlnet.gov/expapi/verbs/{experienced,answered,passed,failed,completed}` are the most widely used learning verbs (https://xapi.com/blog/deep-dive-verb/, and the Open edX xAPI ADR at https://docs.openedx.org/projects/openedx-proposals/en/latest/_sources/architectural-decisions/oep-0026/xapi-realtime-events.rst). The xAPI registry (xapi.vocab.pub) did not load in this session, so I did not confirm any verb beyond those and the cmi5 list above. Custom verbs (branched, placed, found) are defined in this project's own profile instead of borrowing near-matches.

## 4. Prior art and positioning

| Project | What it does | How this project differs |
| --- | --- | --- |
| **LearnMCP-xAPI** (https://github.com/DavidLMS/learnmcp-xapi, MIT) | MCP server that lets an agent **record and retrieve** xAPI statements in an LRS (SQLite, Ralph, Veracity plugins). Actor is one configured `ACTOR_UUID`. No course content, no branching, no pedagogy rules; its README says it "does not replace thoughtful pedagogical design". | This project is the other half: authored content, server-validated branching, deterministic checks and teaching rules, with xAPI as a consequence of the learning rather than something the agent decides to log. The agent never writes statements directly. |
| **Veracity LRS MCP** (https://veracity.it/model_control_protocol_mcp_artificial_intelligence_with_learning_record_store_lrs) | Lets an AI client **query** an existing LRS for reports. | Analytics over a store; not tutoring. Complementary: a learner could send their exported record to such an LRS. |
| **MCP tutors** (moarshy mcp-tutor https://lobehub.com/mcp/moarshy-mcp-tutor, argotdev tutor-mcp-ts https://github.com/argotdev/tutor-mcp-ts, TutorX-MCP https://huggingface.co/spaces/RedRepter/TutorX-MCP) | Index docs or local course files and offer tutoring prompts (one has a Socratic prompt), quizzes and summaries. | No authored branching that the server enforces, no deterministic pass/fail, no standards-based learner-owned record. |
| **ChatGPT Study Mode** and **Claude Learning mode** (https://www.maginative.com/article/openai-launches-study-mode-for-chatgpt/, https://www.tomsguide.com/ai/claudes-new-learning-modes-take-on-chatgpts-study-mode-heres-what-they-do) | Vendor-specific Socratic modes, July and August 2025. | These show that agents can teach this way, but the behaviour belongs to the vendor. Here the teaching rules travel with the content, so the same course teaches the same way in any agent. |
| **cmi5 / LMS + LRS** | LMS launches content and stores statements. | Here there is no LMS. The learner's agent is the runtime, and the record is local-first and portable. |
| **GrassBlade "tracking AI interactions"** (https://www.nextsoftwaresolutions.com/tracking-ai-interaction/) | Vendor guidance on turning AI chats into xAPI. | Records chat activity; does not define a teaching contract. |

Honest positioning: none of the parts is new by itself (MCP servers, xAPI, Socratic tutoring, authored branching). What I could not find anywhere is the combination as a **contract**: a course published as a remote MCP server, an agent-neutral rules file the server sends, branching the server validates, deterministic checks the agent cannot overrule, planted bugs the server keeps secret from the agent, and an xAPI profile for all of it in a record the learner owns. That combination is the original part, and it is what `RULES.md` and the profile pin down.
