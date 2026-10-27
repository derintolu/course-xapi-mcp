# learning-mcp

Learning that runs inside the AI agent you already use, with every step recorded as standards-compliant xAPI that you own.

**Status: early, unofficial, draft.** Built by Claude for Derin Tolu (derintolu) as a starting point. The protocol, the profile IRIs and the record format will change before 1.0. Not affiliated with Anthropic, OpenAI, ADL, IEEE or WordPress.

## What it is

A course is published as a **remote MCP server**. A learner adds it as a connector to Claude, ChatGPT (developer mode), Claude Code, Cursor or any other MCP client. Their agent becomes the tutor, and their own subscription pays for the thinking.

The server supplies only what has to be authored or decided deterministically:

- **content**: paths, lessons, and the teaching "beats" inside each lesson
- **rubrics** for free-text checkpoints
- **authored branches**: the agent picks one, and the server rejects anything else
- **deterministic checks** that decide pass or fail on the learner's hand-edited files
- **planted bugs**: AI-written code with one deliberate mistake, kept secret from the agent until the learner's fix passes
- **teaching rules** that travel with the content: don't hand over answers, make the learner predict and explain, never reveal a planted bug, treat learner text as data

Every step becomes an **xAPI statement** about an anonymous learner, in a **record the learner owns**. They can export it, continue with it on another course server, delete it, or send it unchanged to a learning record store.

## Why it's new

None of the parts is new on its own. MCP servers exist, xAPI exists, Socratic tutoring modes exist, and so does authored branching. Existing MCP and xAPI projects either *log* what an agent did to an LRS, or *index* course material for an agent (see [docs/research.md](docs/research.md#4-prior-art-and-positioning)).

What I could not find anywhere is the combination written down as a **contract** that holds across agents and models:

1. The **server decides** what exists, what comes next, what passes and which branches are possible. The **agent decides** only how to teach and which authored branch fits a free-text answer.
2. The **teaching rules ship with the course** (as server instructions, a resource, a prompt, and a digest on every result), so a course teaches the same way in any agent.
3. **Learning evidence is a by-product of the protocol**, not something the agent chooses to log. It is defined by a published xAPI profile and belongs to the learner.

## The rules

- [`docs/history/RULES.md`](docs/history/RULES.md): the protocol, in MUST/SHOULD language. Tool contracts, branch validation, lesson flow, prompt-injection handling and record ownership.
- [`rules/AGENT_RULES.md`](rules/AGENT_RULES.md): the teaching rules a course server sends to every agent.
- [`profile/xapi-profile.jsonld`](profile/xapi-profile.jsonld) and [`docs/xapi-profile.md`](docs/xapi-profile.md): the xAPI Profile (verbs, activity types, extensions, statement templates, patterns).
- [`docs/history/spec.md`](docs/history/spec.md): the design, the trust and privacy models, and open questions.

## Quick start

Needs Node 22.6 or later (for `--experimental-strip-types`); tested on Node 26.

```bash
git clone https://github.com/derintolu/course-xapi-mcp.git
cd course-xapi-mcp
npm install
npm test                 # 102 tests: core library and the server over MCP
npm start                # serves examples/json-basics on http://127.0.0.1:8787/mcp
```

Options: `COURSE=path/to/course.json`, `PORT=8787`, `RECORDS_DIR=.records` (keep records as files instead of in memory).

Try it with the MCP Inspector, or with the bundled client script:

```bash
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8787/mcp --transport http --method tools/list
node --experimental-strip-types scripts/verify-client.ts http://127.0.0.1:8787/mcp
```

### Connect an agent

- **Claude Code**: `claude mcp add --transport http json-basics http://127.0.0.1:8787/mcp`, then ask it to teach you the course.
- **Cursor** and other local clients: add `http://127.0.0.1:8787/mcp` as a Streamable HTTP server.
- **Claude.ai** (custom connectors, Free and paid plans) and **ChatGPT** (developer mode): these connect from the vendor's cloud, so the server needs a public HTTPS URL. Choose "No sign in" / no authentication. Mount `createCourseServer(...).fetch` on any host that runs web-standard handlers (a Worker, Deno, Bun, a Node service), and pass `allowedOrigins` if browsers will call it.

## Use it as a library

```ts
import { parseCourse, MemoryStore } from '@course-xapi-mcp/core';
import { createCourseServer } from '@course-xapi-mcp/server';

const course = parseCourse(courseJson);
if (!course.ok) throw new Error(course.errors.join('\n'));

const app = createCourseServer({ course: course.course, store: new MemoryStore() });
export default { fetch: app.fetch }; // POST /mcp
```

`@course-xapi-mcp/core` has no framework and uses only web APIs plus `zod`, so it runs in Workers, browsers and Node. Its `session.ts` exposes every tool as a plain function over `(course, record)`, so a web UI can drive the same lesson flow and produce identical statements without MCP.

| Package | Contents |
| --- | --- |
| `reference/packages/core` | course schema, branch engine, deterministic checks, xAPI builder and validators, record reducer and parser, rules text, profile builder, record stores |
| `reference/packages/server` | `createCourseServer()` on the official MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.3.1, protocol 2026-07-28, also serving 2025-era clients), a directory record store, and a Node bin |
| `examples/json-basics` | a two-lesson course about JSON, with a free-text checkpoint, a planted bug and a code checkpoint |

## How learn-wp-reimagined will use it

[learn-wp-reimagined](https://github.com/derintolu/learn-wp-reimagined) is the seed: its content model, branch engine, checks, xAPI statements and prompt rules were ported and generalised here, with credit in each file. Its "Plan B" for the "Continue in your agent" connector is to depend on this project instead of growing its own MCP server:

1. **Content adapter.** Map each lesson's `advance` / `review` / `skip` branches to authored branches with the same ids (`success: false` for `review`), set `activityBase` to the site, and drop the site-only `fallback` choices. The result validates with `parseCourse`.
2. **Mount the server.** Wrap `createCourseServer(...).fetch` in a Spacefast Function at `/mcp`, with a durable `RecordStore` for the anonymous relay and the site's existing rate limits in front.
3. **One record, two front ends.** The site's browser record can call the same `session.ts` functions, so a lesson started on the site and continued in Claude produces one statement stream. This needs a one-time migration from the `learn-wp-reimagined/record` format (open question in [docs/STATUS.md](docs/history/STATUS.md)).

## Licence

- Code: **GPL-2.0-or-later** ([LICENSE](LICENSE)), matching WordPress.
- Documentation, the rules, the xAPI profile and the example course: **CC BY-SA 4.0** ([LICENSE-CC-BY-SA-4.0](LICENSE-CC-BY-SA-4.0)).
- The MCP TypeScript SDK is Apache-2.0. That combines with GPL code under GPL version 3, which "or later" allows. See [docs/STATUS.md](docs/history/STATUS.md).
