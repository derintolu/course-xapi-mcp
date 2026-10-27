# course-xapi-mcp: design

Date: 2026-10-27
Status: design for review by Derin (owner), revised the same day after the owner's round-2 answers and the cross-design reconciliation. Not the spec text and not a task plan. Nothing here is committed.
Replaces: the design in `docs/spec.md` (2026-10-19) and the protocol in `RULES.md` v0.1, which stay as history.

How to read this:

- **Owner decision** means it comes from the owner's decisions of 2026-10-27 and is binding. Quotes are the owner's words.
- **Owner answer n** means the owner's round-2 answers of 2026-10-27 (numbered as given). They are binding and supersede the earlier decisions where they differ.
- **Builder's call (BC-n)** means I decided it. Each one gives a reason and what it costs if it's wrong. The owner can overrule any of them. Every builder's call is provisional until the owner approves this document (builder's call, reconciliation 15).
- **Builder's call (reconciliation n)** means a ruling from the cross-design reconciliation of 2026-10-27, which settles contradictions between this design, the Learning Ledger plugin design and the prototype design. These are builder's calls too, not owner decisions, and are equally provisional.
- MUST, SHOULD and MAY (RFC 2119/8174) appear only where I'm stating what the eventual spec will require.
- Research is cited, not repeated:
  - [CMI5] `scratchpad/cmi5-fit.md`
  - [PRIOR] `scratchpad/standards-prior-art.md`
  - [OB] `scratchpad/open-badges.md`

  All three are under `/private/tmp/claude-501/-Users-cedarstone-Projects-learn-wp-reimagined/5376001d-2862-4ef6-85e3-26e5bd4cbe50/scratchpad/`. Move them into the repo's `docs/research/` before that folder goes away (see §15).

---

## 1. Intent

In the owner's words, course-xapi-mcp is "an open spec to create an MCP server for any course so course creators can create courses that people can do within their own LLM account."

A learner adds a course to the agent they already pay for: Claude, ChatGPT, Cursor, Claude Code or any MCP client. That agent becomes the tutor. The course server provides what has to be authored or decided deterministically:

- content
- rubrics
- authored branches
- deterministic checks
- planted bugs
- teaching rules

Every step is recorded as xAPI in a record the learner cannot alter.

Three things make this a standard rather than a product:

1. **It sits on standards people already run.** A course is a valid cmi5 package (owner decision). The record is xAPI. Badges are Open Badges 3.0. MCP carries the conversation and is used as a proper MCP extension. An LMS that knows cmi5 can import, launch and track a course-xapi-mcp course without knowing anything about us ([CMI5] §6.3, "What this means for existing cmi5 LMSs").
2. **It doesn't care how a course is authored or hosted.** It is "like xAPI": "courses can be built many different ways… it can take many shapes" (owner). The spec defines the package, the server's behaviour and the record. It does not define an authoring tool, a hosting platform or a language.
3. **The official record belongs to whoever the author trusts to hold it.** That is normally the LMS or an LRS, "so the learner cannot alter the record themself" (owner). The learner-owned record in learning-mcp was only "for ease of operation" (owner). It survives as the unofficial practice option.

What changed from learning-mcp, in one paragraph:

- The course moves from a private JSON bundle to a cmi5 package with a namespaced extension.
- The server becomes a cmi5 AU. When no LMS launched it, it also plays the LMS role.
- The learner-held record and `link_record` are replaced by four custody options that the author chooses between.
- The xAPI profile moves to `https://course-xapi-mcp.sqwrlz.com/` and becomes cmi5-shaped.
- Badges are added.
- Everything becomes Apache-2.0.

## 2. Audiences

| Audience | What they need from this | Where it lives |
| --- | --- | --- |
| **Course authors**, mostly non-coders who will ask their own AI to convert an existing course | An authoring guide their agent can follow step by step, and a validator whose errors say exactly what to fix | `docs/authoring/` (informative), the validator, and the authoring skill (§12) |
| **Implementers** of course servers, bridges, LRSs and badge issuers, in any language | Normative text, language-neutral schemas, requirement IDs and a black-box conformance suite | `spec/`, `schema/`, `profile/`, `conformance/` |
| **Learners** | To learn inside their own agent, to know where their record is kept and that it is official (or that it isn't), to view and export it, and to claim badges | Behaviour the server must provide, and the agent rules |
| **LMS and LRS operators**, including Learning Ledger (our WordPress LRS plugin) | To import the package, launch it, receive conformant statements, issue badges and know what they are responsible for | The cmi5 binding, the custody rules and the badge rules |

## 3. Goals, non-goals, anti-goals

**Goals**

- G1. Any MCP client that supports remote Streamable HTTP servers can teach any conformant course with no vendor-specific code.
- G2. A course is a valid cmi5 package that a cmi5 LMS imports unchanged ([CMI5] §1.3: the LMS may ignore the extension, and the course must still be usable).
- G3. The server decides what exists, what comes next and what passes. The agent decides how to teach and which authored branch fits a free-text answer (§9.3).
- G4. The author picks one of four record-custody options. In options 1 to 3 the official record is held where the learner and the learner's agent can read it but never write it.
- G5. Statements are cmi5-conformant and conform to a published xAPI profile whose IRIs resolve.
- G6. Badges are Open Badges 3.0 credentials that a third party can verify without trusting the learner.
- G7. Someone who has never seen our code can implement the spec from its text, schemas and conformance suite.
- G8. A course author's AI can produce a valid course from an existing one using only the authoring guide and the validator.

**Non-goals**

- An LMS, an authoring UI or a hosted service. Those are separate products. Learning Ledger, our WordPress LRS plugin, is a separate piece with its own design.
- Running learner code. Checks are deterministic tests over submitted text, as today.
- Calling a model on the course owner's account. The server never calls a model (kept from `RULES.md` §1.4).
- Claiming cmi5 *LMS* conformance for a course server.
- Proving who typed an answer. The record is evidence of a tutored session, not an exam credential.
- Multi-language courses, OB 2.0 and CLR 2.0 transcripts in 1.0 ([OB] §7.2 puts these later).

**Anti-goals.** Each of these counts as failure even if everything technically works.

| Failure | What prevents it |
| --- | --- |
| An agent can fake progress: skip the teaching, invent a branch, turn a failed check into a pass, or write statements | The server builds every statement from validated tool calls (§9.3). There is no tool that accepts statements or a record. Steps are served in order. Only authored branches are accepted. Deterministic checks are final. The remaining weak point is fabricated free-text replies, which no server can detect. It is bounded and disclosed in §9.4 and in badge criteria (§11). |
| A course only works in one vendor's agent | Everything the course needs travels as plain tools, results and text. Rules are sent five ways (§9.2). Conformance is tested with a plain MCP client, never with one host's features. |
| The learner can alter the official record | The official record is held by an LMS, an LRS or the server (options 1 to 3). Credentials for it never reach the agent or the browser. `link_record` is removed (§7.3). |
| A spec only our code can implement | Schemas are XSD, JSON Schema and JSON-LD. Requirements have IDs and black-box tests. Nothing normative names our packages. 1.0 needs two independent server implementations (§5.5). |
| Practice looks official | Option 4 statements carry a practice category, results are labelled, and badges are impossible in it (§7). |
| A badge leaks the learner's whole record | The xAPI actor never appears in a badge. Evidence is a statement UUID (§11). |

## 4. The system in one picture

```
 learner ── own agent (any MCP client) ── MCP 2026-07-28, extension com.sqwrlz/course-xapi-mcp ───┐
                                                                                                  │
   cmi5 LMS ── launch ──> launch bridge (https, on the course server) ──┐                         │
   (option 1 only)                                                      v                         v
                                                          COURSE SERVER: always the cmi5 AU;
                                                          in options 2 and 3 also the LMS role
                                                          (registration, launched, waived, satisfied)
                                                                         │ statements
            ┌────────────────────────────────────────┬───────────────────┴───────────┬────────────────────┐
            v                                        v                               v                    v
   1. LMS's LRS (official)              2. author's LRS (official)          3. server's own store  4. practice copy
   badges: the course server            badges: signed by the LRS           badges: signed by       (unofficial,
   signs unless the LMS can (§11)       (or the course server, §11)         the course server        no badges)
```

The course server reads the course package. An author can run one server per course or a multi-course host. That is a deployment choice; the spec describes one course per MCP endpoint (BC-1. Why: it keeps tool names and rules unambiguous, which matters because hosts show tools per server. Cost if wrong: a multi-course host needs one endpoint path per course, which is cheap).

## 5. What is normative, and how the standard is run

### 5.1 Three layers

| Layer | Contents | Status |
| --- | --- | --- |
| **Normative (the spec)** | `spec/<version>/*.md` prose; `schema/<version>/` (cmi5 extension XSD, lesson and course JSON Schemas, tool input/output JSON Schemas); `profile/` (xAPI profile JSON-LD); the agent rules text for that version | Only these define conformance. Where the schema and the prose disagree, the schema wins (the MCP rule, [PRIOR] §3). |
| **Informative** | `docs/` (rationale, decision log, authoring guide, implementations list, research), `examples/` | Every file says "not part of the specification" in its header. |
| **Reference implementation** | `reference/` (TypeScript: core, server, bridge, validator, practice relay) | Apache-2.0. Has no special standing: it must pass the same conformance suite as anyone else. |

`conformance/` is its own layer. Its requirement files are normative (requirement IDs map one to one onto the MUSTs). Its test code is informative tooling.

### 5.2 Repo structure and rename

The repo is renamed on GitHub from `derintolu/learning-mcp` to `derintolu/course-xapi-mcp`; GitHub redirects the old URL. The local folder and package names follow. npm scope: `@course-xapi-mcp/*` (BC-2. Why: the scope matches the name and is free to register. Cost if wrong: a later npm rename, which is cheap before anything is published).

```
course-xapi-mcp/
  README.md  GOVERNANCE.md  CONTRIBUTING.md  SECURITY.md  CODE_OF_CONDUCT.md  AI_POLICY.md  LICENSE  NOTICE
  spec/
    draft/                       edited in place
    0.2/  1.0/ ...               released snapshots, never edited (errata go to the next patch)
      index.md                   conformance classes, terms, BCP 14 boilerplate
      package.md                 the cmi5 course package and the cxm extension
      server.md                  MCP extension, tools, resources, prompts, sequencing, branch validation
      custody.md                 the four record options
      cmi5-binding.md            AU role, LMS role, bridge, sessions
      badges.md                  OB 3.0 rules (references OB 3.0, never copies it)
      security-privacy.md
      agent-rules.md             the rules text servers must send
  schema/<version>/              cxm.xsd, course.schema.json, lesson.schema.json, tools/*.schema.json
  profile/                       xapi-profile.jsonld, CHANGELOG.md
  conformance/
    requirements/<version>.yaml  one ID per MUST, e.g. CXM-SRV-031
    package/  server/  bridge/  badges/
  extensions/registry.md         registered third-party extension prefixes
  proposals/                     CXP-NNNN-title.md
  docs/                          informative: decisions.md, rationale.md, implementations.md, authoring/, research/
  examples/                      json-basics (converted), plus one converted cmi5 course
  reference/                     packages/core, server, bridge, validator
  site/                          source for https://course-xapi-mcp.sqwrlz.com/
```

BC-3: the spec, the conformance suite and the reference implementation stay in one repo, in separate top-level directories. Why: there is one owner, the overhead of several repos is real, and the separation that neutrality needs is the directory boundary plus a suite that runs against any URL. Cost if wrong: splitting later is a `git filter-repo`, and the IRIs don't change because they live on sqwrlz.com, not on GitHub.

### 5.3 Versioning

- **Spec: semver `MAJOR.MINOR.PATCH`** (BC-4. Why: authors keep course packages for years, and "package declares specVersion 1.2" is easier to explain than MCP's dates [PRIOR] §3. Cost if wrong: low, because the version string is only declarative.)
  - A patch is a clarification only.
  - A minor adds features without breaking existing packages or servers.
  - A major breaks them.
  - Pre-1.0 drafts are `0.x`, and a minor bump may break.
- A package declares `specVersion`. A server MUST refuse a package whose major version it doesn't support, and SHOULD warn on a newer minor.
- The **MCP extension identifier** stays `com.sqwrlz/course-xapi-mcp` for every 1.x release. The settings object carries `version`. A 2.0 that breaks clients gets `com.sqwrlz/course-xapi-mcp-v2`, as SEP-2133 says ([PRIOR] §3, MCP extensions).
- The **xAPI profile** version tracks the spec minor (`…/xapi/v1.0`, `…/xapi/v1.1`). Concepts are deprecated, never deleted, per the xAPI Profiles spec.
- The **agent rules** version equals the spec version that defines them.
- The **cmi5 base** is Quartz. When IEEE P9274.3.1 is published, it gets one planned revision ([CMI5] §0). The `cxm` namespace is frozen at 1.0 and does not wait for P9274.3.1 (BC-5. Why: P9274.3.1 has had an open PAR since 2023 with no ballot. Cost if wrong: a `course/v2` namespace and a converter.)

### 5.4 Extension mechanism (third parties extending course-xapi-mcp)

- **Package:** foreign namespaced elements and attributes are allowed wherever cmi5 allows `##other` ([CMI5] §1.3). A server MUST ignore extensions it doesn't know, and a validator reports them as info, not error. In the JSON files, extra keys are allowed only under `extensions`, keyed by an IRI or a reversed-domain name.
- **Tools:** a server MAY add tools. Names that start `cxm_` are reserved for the spec. Added tools MUST NOT write the official record by any route other than the statement rules in §10.
- **xAPI:** third parties use their own IRIs. Statements still carry the cxm category only if they conform to the cxm templates.
- **Registry:** `extensions/registry.md`, one entry per PR, following OpenAPI's registry model ([PRIOR] §3). Registration is optional and needs no approval beyond "the name isn't taken".

### 5.5 Governance

Owner answer 15 settles the editor and the hand-over; the rest is BC-6. It starts as a single-editor project run in the open, with these properties:

- **Editor (owner answer 15).** Derin is the sole editor until a second independent implementation exists, and the editor merges.
- **Decisions in public.** Every normative change goes through a proposal (`proposals/CXP-NNNN`) or a decision-log entry (`docs/decisions.md`, the ext-skills model in [PRIOR] §3).
- **Conformance before merge.** A proposal that adds a MUST has to come with a conformance test.
- **Personal membership.** Contributors take part as people, not as companies, keep their own copyright and sign off under the DCO. There are no reserved seats.
- **Exit criterion for 1.0.** Two independent course-server implementations must pass the suite. Learning Ledger, our WordPress LRS plugin, counts as an independent LRS/badge implementation, but not as a second server.
- **Hand-over trigger (owner answer 15).** Once a second independent implementation exists, seek a neutral home: IEEE LTSC or an MCP interest group ([PRIOR] §1a, §3).

Why (BC-6, for the process rules): this is the lightest structure that still lets outsiders trust the process, and MCP and ext-skills show it works at small scale. Cost if wrong: it can look like one person's project until a second implementer exists, which only a second implementer fixes.

## 6. The course format on cmi5

### 6.1 Package shape

A course package is a ZIP with `cmi5.xml` at the root (cmi5 §14.1), plus a `cxm/` folder:

```
cmi5.xml                      XSD-valid cmi5; holds structure, ids, titles, descriptions, moveOn, AU urls
cxm/course.json               course-level extension data
cxm/lessons/<key>.json        one file per lesson AU
cxm/files/<key>/...           starter files, planted-bug code (optional; may be inline in the lesson JSON)
```

BC-7: structure lives only in `cmi5.xml`, and content lives only in JSON referenced from small `cxm:` elements. Nothing is written twice: no titles or lesson lists in JSON, and no beats in XML. Why:

- cmi5.xml is required anyway.
- Authors' AIs write JSON against a JSON Schema more reliably than nested XML.
- One source per fact means the two files can't drift.

Cost if wrong: authors edit two file types. The reference validator offers `cxm init` and `cxm add-lesson` to scaffold both, and an informative single-file "course.json to package" converter for authors who prefer it.

The XML extension namespace is `https://course-xapi-mcp.sqwrlz.com/course/v1`, prefix `cxm`, with an XSD at that address and a human-readable spec, as cmi5 §13.1.5 asks. Extension elements sit only at the tail positions the cmi5 XSD allows ([CMI5] §1.3). The import line uses the real cmi5 namespace, not the one in ADL's example.

```xml
<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd"
                 xmlns:cxm="https://course-xapi-mcp.sqwrlz.com/course/v1">
  <course id="https://example.org/courses/json-basics">
    <title><langstring lang="en">JSON basics</langstring></title>
    <description><langstring lang="en">…</langstring></description>
    <cxm:course src="cxm/course.json" specVersion="1.0" mcp="https://json-basics.example.org/mcp"/>
  </course>
  <au id="https://example.org/courses/json-basics/placement" cxm:key="placement" cxm:role="placement"
      moveOn="NotApplicable" launchMethod="OwnWindow">
    <title>…</title><description>…</description>
    <url>https://json-basics.example.org/cmi5/launch?au=placement</url>
  </au>
  <block id="https://example.org/courses/json-basics/paths/json" cxm:key="json">
    <title>…</title><description>…</description>
    <au id="https://example.org/courses/json-basics/lessons/what-is-json" cxm:key="what-is-json"
        moveOn="CompletedAndPassed" launchMethod="OwnWindow"
        activityType="http://adlnet.gov/expapi/activities/lesson">
      <title>…</title><description>…</description>
      <url>https://json-basics.example.org/cmi5/launch?au=what-is-json</url>
      <cxm:lesson src="cxm/lessons/what-is-json.json"/>
    </au>
    <cxm:path src="cxm/course.json#/paths/json"/>
  </block>
</courseStructure>
```

`cxm:key` is a short local id (`[a-z0-9-]{1,64}`), used by branches and placement to refer to lessons and paths. The cmi5 `id` IRIs remain the publisher ids. Authors converting an existing cmi5 course keep their own IRIs and just add keys (BC-8. Why: it doesn't force an IRI pattern on existing courses. Cost if wrong: none really; it costs one attribute per AU.) New courses put block and AU ids under the course's own IRI base, as in the example, and every implementation uses the activity id scheme in §8.1 (`{au@id}/au`); an implementation that keeps its own lesson slugs keeps them inside that scheme (builder's call, reconciliation 7).

### 6.2 Mapping

This builds on [CMI5] §6.1 and records the resolved choices.

| Concept | cmi5 | cxm extension |
| --- | --- | --- |
| Course | `<course>` | `course.json`: version, language, licence, rules, placement guide, custody, badges, practice allowed |
| Path | `<block>`, one per live path | `course.json#/paths/<key>`: tagline, placement hints. Coming-soon paths are listed in `course.json` only and left out of cmi5.xml, because an empty or unreachable block would block course satisfaction (BC-9; cost if wrong: an LMS can't show "coming soon", which is cosmetic). |
| Lesson | `<au>`, one per lesson. moveOn is `CompletedAndPassed` with a checkpoint and `Completed` without one. No masteryScore. | `lessons/<key>.json`: minutes, sources, starter files, beats, bug, checkpoint |
| Placement | its own course-level `<au>`, role placement, `moveOn="NotApplicable"`, first in order ([CMI5] R3) | the placement guide in `course.json` |
| Beat | none; runtime is cmi5-allowed `experienced`/`answered` | `beats[]` {key, goal, content, question?} |
| Checkpoint | none; its outcome drives the AU's defined `passed` | `checkpoint` {key, kind, question, rubric, checks?, branches, maxAttempts?} |
| Branch | none | `branches[]` {key, when, success, to: lesson key or null, message} |
| Rubric | none | text, served to the agent at submission |
| Check | none | contains, notContains, regex or json pointer, as today |
| Planted bug | none | `bug` {key, file, code, hint?, revealAfter?, explanation (secret), fixChecks (secret)} |
| Reference solution | none | `referenceSolution` (secret; validator only, §12) |
| Teaching rules | none (`launchParameters` is unsuitable; the LMS may rewrite it) | `course.json#/rules`, appended to the core rules |
| launchMode | Normal, Browse, Review | An LMS launch in Review means a walk-through with no checkpoint outcome; Browse means overview only. The server never issues a Review launch itself: its own review walk-throughs (§6.3 rule 4) stay inside the current session. |

**Secrets.** Fields marked secret in the schema are the bug explanation, the fix checks and reference solutions. A server MUST NOT send them to the agent before the condition in §9.5. Because an LMS gets the package and may expose it, the validator produces two artefacts:

- an **authoring package**: complete, kept by the author and loaded by the server
- a **distribution package**: secret fields removed, given to LMSs

Both are valid cmi5, and both validate. This ZIP, in these two flavours, is the only interchange format between course servers, LMSs, LRSs and LMS plugins: the authoring package is the full flavour and the distribution package the public one with secrets stripped. Wherever a package is served over HTTP it carries an ETag that changes whenever its content does, so an importer can re-import idempotently (builder's call, reconciliation 2). A server MUST load only the authoring package (BC-10. Why: cmi5 gives LMSs no duty to keep extensions private, or even to keep them at all ([CMI5] §1.3). Cost if wrong: authors keep track of two zips. The validator names them `*-authoring.zip` and `*-lms.zip`.)

### 6.3 Branching and placement versus moveOn (conflict C2, resolved)

The conflicts are listed in [CMI5] §6.2 C2. The resolution has six rules. Each one keeps statements cmi5-legal in every custody option.

1. **One AU session per lesson visit.** A session starts at the first tool call on that lesson. It ends with `terminated` when the lesson resolves, when the learner moves to another lesson, when the agent calls `end_session`, or after inactivity. The inactivity timeout is 30 minutes in the reference (BC-11. Why: MCP 2026-07-28 has no session of its own, so the server has to define one, and 30 minutes is shorter than typical LMS token lifetimes. Cost if wrong: extra sessions in reports, which is cosmetic.)
2. **Checkpoint retries are allowed statements, not defined `failed`.** A `success: false` branch records the allowed `failed` on the checkpoint activity. The AU session stays open, so the learner can retry without a relaunch. A defined `failed` on the AU is sent only if the author set `maxAttempts` and it ran out (BC-12. Why: a defined `failed` on every retry would force a new session for each attempt, and in option 1 a new LMS launch, while cmi5 lets an AU send passed or failed by its own criteria ([CMI5] §4.1). Cost if wrong: an LMS sees no failure until the course ends or the learner passes, so failure rates have to come from allowed statements.) A defined `failed` MUST NOT follow a defined `passed` in the same registration. After `maxAttempts` is spent and the defined `failed` is sent, the server ends that session with `terminated`. A later session on the same lesson in the same registration starts a fresh set of attempts and may still send a defined `passed`, which cmi5 allows after `failed`. In option 1 that later session is a new LMS launch. A learner who wants to start the whole course again uses `restart_course` (§9.2), which starts a new registration (builder's call, reconciliation 13).
3. **`completed` means the material was experienced.** It is sent after the last beat and after the planted bug is caught or revealed. `passed` is sent when a `success: true` branch is chosen. Each is sent at most once per registration ([CMI5] §6.2, "Smaller conflicts"). An LMS, or an LMS plugin applying results back, treats a lesson as done only when the AU's moveOn is met, computed from the course structure, never on `completed` alone (builder's call, reconciliation 7).
4. **Review instead of redo.** A branch whose target is a lesson already satisfied in this registration (passed, completed for a no-checkpoint lesson, or waived) runs as a review walk-through:
   - It happens inside the current lesson's session.
   - It records allowed statements only, with the target lesson as parent.
   - It covers beats only.
   - It then returns the learner to the branching lesson's checkpoint.

   A branch to the same, unpassed lesson restarts its beats in the same session. This changes how learning-mcp behaves: today the cursor moves to the target and the learner works forward from it (BC-13. Why: re-running a passed lesson's checkpoint would need a second defined `passed`, which cmi5 forbids. In option 1 it would also need an LMS relaunch. Cost if wrong: authors who wanted "redo lesson 1 including its checkpoint" have to author a dedicated review lesson instead.)
5. **Skips become `waived` with reason "Tested Out".** This covers lessons skipped by placement and lessons jumped over by a success branch whose target is further ahead.
   - In options 2 and 3, the server issues the waivers in its LMS role.
   - In option 1, only the LMS may waive ([CMI5] C1). The server records allowed `placed`/`branched` with a `waive-recommended` result extension listing the AU ids. An LMS that understands it MAY waive them. A plain LMS leaves them unsatisfied, and the block stays unsatisfied until an admin acts. The spec states this limit plainly to LMS operators.
   - Waived lessons earn no lesson badge unless the author sets `countWaived` ([OB] §4.2). They do count towards path and course satisfaction, as cmi5 says. `countWaived` and `awardOn` (§11, including `any-path`) are the whole of the waiver rules for badges, and every badge issuer implements all of them (builder's call, reconciliation 6).
   - **Carried-over lessons.** A lesson carried over from an earlier record version (for example, progress kept when a learner moves to a new course version) is waived with reason `Administrative` and the `carried-over` result extension (§10.1). It never counts towards a badge: it earns no lesson badge even with `countWaived`, and an issuer deciding a path or course badge treats it as not done (builder's call, reconciliation 6).
   - Branch targets MUST be in the same path, so block satisfaction stays meaningful (BC-14; cost if wrong: a cross-path "switch tracks" branch isn't possible, so placement has to do it).
6. **Several paths: one block per path, in one package** ([CMI5] C2-a). Block `satisfied` is the main signal, and path badges are the main badges. Course `satisfied` keeps its strict cmi5 meaning (every path done). A course badge can instead be declared `awardOn: "any-path"`. That is a badge rule defined by this standard; it doesn't change what `satisfied` means (BC-15. Why: one package keeps placement across paths inside one registration. Package-per-path (C2-b) would make placement "which course to enrol in". Cost if wrong: an LMS dashboard shows multi-path courses as "not complete" for learners who finished their path. The spec tells authors to prefer one path per course when LMS dashboards matter.) An LMS that models each path as its own course maps them back onto this one package: the LMS's grouping of path courses is the cmi5 `<course>`, each path course a `<block>` and each lesson an `<au>`. Course satisfied maps to that grouping, and block satisfied to the path course's completion. Learning Ledger's Sensei integration does this with a "program" that groups one Sensei course per path (builder's call, reconciliation 1).

## 7. Record custody

### 7.1 The four options (owner decision)

The course declares one option in `course.json#/custody`. The server tells the agent which one applies, in the `cxm` block of every result and through `get_status`. The agent tells the learner at the start.

| # | Option | Official record held by | Actor assigned by | Badges | Signed by |
| --- | --- | --- | --- | --- | --- |
| 1 | `lms-launched` | the launching LMS's LRS, via the cmi5 launch | the LMS (cmi5 §9.2) | yes | the LMS side if it implements the badge rules; otherwise the course server, from what the LMS accepted (owner answer 7, §11) |
| 2 | `author-lrs` | an LRS the author names, for example Learning Ledger | the LRS if it assigns one; otherwise the course server, from the subject of the author's identity provider (§8.1) | yes | the LRS (the record holder); or the course server, if the course declares it (§11) |
| 3 | `server-kept` | the course server's own store | the course server, through its own MCP authorization | yes | the course server |
| 4 | `practice` | nobody: no official record | the server mints an anonymous practice actor | no | none |

Rules for every option (owner decision, made normative):

- R1. The course declares exactly one option, and the server reports it to the agent before the first recorded step.
- R2. The learner's agent can never write or replace the official record. No tool accepts statements, records, actor ids or registrations from the agent.
- R3. In options 1 to 3, the learner can always view and export their record (§7.2 says how per option).
- R4. Badges link only to the earning statement (§11).
- R5. Option 4 is clearly labelled. Every result carries `official: false` and the label text. Every statement carries the practice category IRI. The agent rules require the agent to say so.

Further rules from me:

- BC-16: a course in option 1, 2 or 3 MAY also set `allowPractice: true`. A learner who can't or won't be recorded officially, or who connects directly to an `lms-launched` course without a launch, then gets a practice run. Practice never turns into official. Why: it lets people try a course before enrolling. Cost if wrong: confusion between the two, which R5's labels address.
- BC-17: in options 1 and 2, every statement goes to the official record in real time, both cmi5 defined and allowed, including the learner's free-text answers. This resolves [CMI5] C4 as option C4-1, extended by the owner's custody decision. Enrolling under a declared custody option counts as consent, and owner answer 3 confirms that free-text answers are kept in the official record. There is no queue-and-confirm. Why: the official record is the evidence behind the badges, and confirming each send breaks cmi5 session timing. Cost if wrong: free-text answers sit in an LMS the learner may not trust, and the author can't make it more private. A later minor version could add `responses: "omit"`.
- In options 2 and 3, the course server is the only writer of learner statements for its course and the only minter of its registrations. Anything else that tracks the same learners (an LMS plugin reporting on-site learning, for example) MUST NOT write statements for a course a course server drives, and MUST NOT re-emit statements for changes it applied from the record (builder's call, reconciliation 3).
- BC-18: in options 1 to 3, deleting the official record is the record holder's process (its account page, its privacy policy), not a tool. Why: deletion is also an alteration, which R2 forbids to the agent. Cost if wrong: learners have one more place to go. The server's `get_status` gives them the link.

### 7.2 What each option requires of a server

| | 1 `lms-launched` | 2 `author-lrs` | 3 `server-kept` | 4 `practice` |
| --- | --- | --- | --- | --- |
| cmi5 role | AU only, behind the bridge (§8.2) | AU + LMS role | AU + LMS role | AU-shaped statements, with LMS-role statements labelled practice |
| Authenticate learner | MCP authorization by the course server, paired to the launch (§8.2) | MCP authorization by the course server, federated to the author's identity provider over OIDC (§8.1) | MCP authorization by the course server against its own accounts | none; a practice handle |
| Where statements go | LMS `endpoint`, with the session token | author's LRS, with server credentials | own store | returned to the learner only; MAY be relayed under a handle for 30 days |
| Working state (cursor, pending checkpoint, files) | xAPI State API in the LMS's LRS | State API in the author's LRS | own store | the practice relay, or none |
| View and export | `get_record` returns what the token can read for this registration, plus a receipt of every statement this server sent (ids and summaries), plus the LMS link | `get_record` and an HTTPS export page, read from the LRS | `get_record` and an HTTPS export page | `get_record` returns the practice copy |
| Must offer | the bridge; termination before token expiry | an LRS client; registration minting and storage (in the LRS's State API) | an xAPI-statement export format; deletion and retention policy; badge signing | labels; `resume_practice`; `delete_practice_record` |

In options 1 and 2 the server can be stateless, because the LRS holds everything. That is what the owner's "the server needn't store anything" was after, and it now holds without giving the learner the pen (BC-19. Why: State API documents are in cmi5's required LRS feature set ([CMI5] §2.1). Cost if wrong: one extra LRS round trip per tool call. A cache is allowed, but the LRS is authoritative.)

The option 1 export is limited by whatever the LMS lets the AU token read. The spec requires the receipt so the learner always has something, and tells LMS operators that R3 is theirs to honour (BC-20; cost if wrong: in option 1 a learner may only see a receipt, not the full record, until their LMS offers export).

### 7.3 What replaces `link_record`

- `link_record` is removed. In options 1 to 3, resuming works by identity: the authenticated learner's registration and State document. Nobody has anything to import.
- In option 4, `resume_practice` takes an exported practice copy. It validates the copy as `link_record` did ([`RULES.md`] §5.3) and continues it as practice. It MUST refuse anything that isn't a practice copy, and it can never produce an official statement.
- The record handle survives only as the practice handle (192 random bits, never in statements).
- `delete_record` becomes `delete_practice_record`.

## 8. Launch and roles

### 8.1 Standalone (options 2, 3, 4): the agent connects directly (conflict C1, option A)

The learner adds the course's MCP URL to their agent.

- **Options 2 and 3.** The host runs MCP authorization (OAuth 2.1), which yields the learner's identity. The course server is always its own MCP authorization server; owner answer 5 approves building ours, and it touches no existing SSO configuration. In option 2 it federates login to the author's identity provider over OIDC. The xAPI actor is `account {homePage: <course IRI base>, name: <IdP subject>}`, unless the LRS assigns one. In option 3 the server signs learners in against its own accounts (builder's call, reconciliation 13). The server then acts as the LMS for that learner:
  - It mints the registration, keeps it in the record holder, and reuses it on return, until the learner calls `restart_course`, which mints a new one.
  - It generates the AU activityId as `{au@id}/au`, which is never equal to the publisher id and is stable across registrations ([CMI5] R2).
  - It generates sessionids.
  - It issues `launched` (launchMode Normal) before `initialized`. Review walk-throughs (§6.3 rule 4) stay inside the current session and get no `launched` of their own (builder's call, reconciliation 13).
  - It issues `waived` and `satisfied`.
- **Option 4.** No authorization. The server mints a practice actor and handle on `start_placement`.

The server claims "cmi5-shaped records" in options 2 and 3, never cmi5 LMS conformance ([CMI5] R2).

### 8.2 LMS-launched (option 1): the bridge (conflict C1, option B)

1. The AU `url` in the package is the course server's https bridge. The LMS launches it in a window (`launchMethod="OwnWindow"`).
2. Server-side, the bridge:
   - parses the launch parameters
   - POSTs to `fetch`
   - reads `LMS.LaunchData` and `cmi5LearnerPreferences`
   - stores the launch context (endpoint, token, actor, registration, activityId, contextTemplate, launchMode, moveOn, returnURL) against a launch id
   - sends `initialized` straight away

   The token never goes to the browser or the agent (BC-21. Why: `initialized` has to follow `launched` "within a reasonable period" ([CMI5] §3.3). Waiting for the agent could take minutes. Cost if wrong: sessions where the learner never connects show initialized-then-terminated, which is honest.)
3. The bridge page says "Continue in your agent", shows the course's MCP URL, and explains how to add it.
4. **Pairing.** When the agent's host runs MCP authorization, the server's authorization page runs in the learner's browser. If the bridge's cookie is present, the grant is bound to the launch. If not (the host opened another browser), the authorization page asks for the six-character pairing code the bridge page showed. The code is single use, expires after 10 minutes, and is typed into the authorization page, never into the chat (BC-22. Why: it works when the cookie is missing and keeps codes out of transcripts. Cost if wrong: one extra step for some learners.)
5. **The grant binds to (LMS endpoint, actor, registration).** Later launches of other lessons in the same registration attach to the same agent connection automatically. When a lesson ends and the next lesson is a different AU, the server's result tells the agent to send the learner back to the LMS (`returnURL`) to launch it. That is one click per lesson in option 1; it's the cost of real LMS tracking.
6. **Session end.** The server sends `terminated` with `duration` before the LMS token is likely to expire. A relaunch abandons an earlier session (cmi5 §9.3.6); the server treats the newest launch as live and reports "this lesson was relaunched elsewhere" on stale calls.
7. **Actor (conflict C3, option 1).** The actor is whatever the LMS supplied. There is no dual write and no anonymous copy. The decisions note that account linking is "largely superseded: the LMS/LRS assigns the actor", and the custody decision removes the learner-held copy that C3 options 2 and 3 existed for.
8. **Consent (conflict C4).** See BC-17.

Hosts without MCP authorization support can't do options 1 to 3. They can still do practice if the course allows it. This is a known limit, listed in §9.4.

## 9. The MCP surface

### 9.1 Extension declaration

- The server advertises `com.sqwrlz/course-xapi-mcp` in `capabilities.extensions` of its `server/discover` response, with this settings object:

  ```json
  { "version": "1.0", "course": "<course IRI>", "custody": "author-lrs", "official": true,
    "allowPractice": false, "badges": true, "rulesVersion": "1.0", "authoring": "<package spec URL>" }
  ```

- The server MUST NOT require the client to declare the extension. Clients that don't know it still get a working course through plain tools and text (SEP-2133 "degrade gracefully", [PRIOR] §3).
- Clients that do know it can show custody, progress and badges natively.
- Everything is per request. There is no reliance on an MCP session, as 2026-07-28 requires. Identity comes from the authorization token (options 1 to 3) or the practice handle argument (option 4). The cmi5 session (§6.3) is the server's own concept and never an MCP session.
- Old protocol revisions: SHOULD keep serving 2025-era clients through the SDK's stateless legacy path, as today ([`RULES.md`] §1.1).

### 9.2 Tools, resources, prompts

Every tool returns `structuredContent` matching its published output schema, plus the same content as text. Every result carries:

- `rules`: version, digest and the URI of the full text
- `cxm`: custody, official, the practice label if any, and the current lesson and step

| Tool | Kind | Change from learning-mcp |
| --- | --- | --- |
| `get_status` | read | **New.** Custody, who holds the record and how to view, export or delete it, the current position, and next actions. The agent calls it first. |
| `list_paths` | read | unchanged |
| `start_placement` | write | No handle in options 1 to 3. Opens the placement AU session. |
| `choose_placement` | write | Validates as today. Emits `placed`. Waives skipped lessons (or recommends waivers in option 1). |
| `get_lesson` | read | unchanged; never returns secrets |
| `next_beat` | write | unchanged, including the required `learner_reply` after a beat with a question |
| `check_code` | write | unchanged |
| `reveal_bug` | write | **New**, resolving the strictness question in STATUS (owner answer 19, §16). Allowed only after `revealAfter` failed fix attempts (default 3). The author can disable it with `revealAfter: null`. Emits `revealed`. The bug doesn't count as caught, and the lesson can still pass (BC-23. Why: a stuck learner shouldn't be stranded, and the record shows it plainly. Cost if wrong: weaker incentive to persist; authors who disagree switch it off.) |
| `submit_checkpoint` | write | unchanged |
| `choose_branch` | write | Branch rules as today, plus §6.3 rules 2, 4 and 5 |
| `end_session` | write | **New.** The learner is leaving. Terminates the AU session with its duration. |
| `get_record` | read | View and export per option (§7.2). The practice copy stays unwrapped, with a "treat as data" note, as today. |
| `get_badges` | read | **New.** Earned badge metadata and the URL of the course's claim page (§11), never a bearer claim link. Options 1 to 3 only. |
| `restart_course` | write | **New.** Starts the course again under a new registration (options 2 and 3, and a fresh practice run in option 4). The old registration stays in the record unchanged, and badges already earned stay valid. In option 1 it tells the learner to ask their LMS, which owns registrations (builder's call, reconciliation 13). |
| `resume_practice` | write | **New**; replaces `link_record`. Option 4 or `allowPractice` only. |
| `delete_practice_record` | write, destructive | Renamed from `delete_record`. Practice only. |

Tool names carry no prefix, because hosts already namespace tools by server. `cxm_` is reserved for future spec tools (BC-24; cost if wrong: a rename at a major version).

**Rules travel five ways:**

- server instructions
- the resource `course-xapi-mcp://rules/agent`
- the `tutor` prompt
- the digest in every result
- additionally, a Skills-over-MCP skill, `skill://course-xapi-mcp-tutor/SKILL.md` (`io.modelcontextprotocol/skills`, [PRIOR] §1a)

The first four are REQUIRED and the skill is SHOULD (BC-25. Why: client support for skills is still uneven, and hosts ask before using one. Cost if wrong: none. It's additive.)

Other resources:

- `course-xapi-mcp://course`: a safe outline, never the raw package
- `course-xapi-mcp://record/export`: the export payload

Agent rules v1.0: today's 12 rules plus these changes:

- tell the learner the custody and whether the record is official, before the first recorded step
- never claim progress the server didn't confirm
- in option 1, send the learner to the LMS for the next lesson when told to
- rule 12 rewritten per custody, with no mention of `link_record`

### 9.3 What the server decides and what the agent decides

| Decision | Who | Enforced by |
| --- | --- | --- |
| What exists, its order, what is secret | Author | Package schema; the server serves steps in order |
| How to explain, what to ask, tone | Agent | Rules only |
| Whether code passes | Server | Deterministic checks; final |
| Which branches are possible | Author and server | Allowed-branch computation; a failed check leaves only `success: false` branches |
| Which allowed branch fits a free-text answer | Agent, against the rubric | Server rejects anything else; the rationale is recorded |
| Placement path, start and skips | Agent, within authored options | Placement validation |
| Whether a statement exists and what it says | Server | Statements are built only by the server, from validated events |
| Session boundaries, waivers, satisfaction | Server in the LMS role (options 2 and 3); LMS (option 1) | cmi5 rules |
| Where the record lives | Author (custody) | Declared in the package and reported in every result |
| Whether a badge is issued | Record holder or signer | Badge rules (§11) |

### 9.4 Prompt injection and known limits

Kept from `RULES.md` §8:

- learner text is wrapped in `<learner_input>`, with any wrapper tags inside it neutralised
- learner text is never used as a pattern, path or branch input
- the server returns only authored content, check results, wrapped learner text and the record

New:

- **Course text is untrusted for the agent too.** Courses converted by an AI from third-party material can carry instructions aimed at the agent. Author rules can only be appended and MUST stay within "how to teach this course". The validator warns on content or rules that address the agent outside that scope, for example "ignore previous instructions", tool names, "do not tell the learner", or URLs to fetch. Hosts treat a skill as untrusted anyway.
- **Credentials.** No LRS or LMS credential, token, actor account name or registration is ever placed in a result the agent sees, except the learner's own actor and registration inside their export.

Known limits, stated in the spec:

- An agent can fabricate learner replies. The record shows agent-written text (`rationale`, placement reason) apart from learner-written text, and badge criteria must say that free-text checkpoints are judged by the learner's agent (§11).
- Hosts without OAuth can only do practice.
- ChatGPT plan support for write tools is still untested (STATUS question 7). It is a test to run before claiming "works in ChatGPT", not a design question; owner answer 21 sets how it runs (§16).

### 9.5 Planted-bug secrecy

- A server MUST NOT send the explanation, location or fix checks before one of these:
  - the learner's fix passes (`caught`)
  - the author-allowed `reveal_bug` after `revealAfter` failed attempts (`revealed`)
- Fix-attempt statements carry an empty `checks` list, as today.
- Secrets are left out of the distribution package (§6.2).
- The conformance suite scans every response before either of those events for the explanation text and the fix-check values (§13).

## 10. The xAPI profile

### 10.1 IRIs

Everything permanent sits under `https://course-xapi-mcp.sqwrlz.com/` (owner decision). The unregistered `w3id.org/learning-mcp` IRIs are dropped; no real records use them.

| What | IRI |
| --- | --- |
| Profile | `/xapi` |
| Profile version (the category on allowed statements) | `/xapi/v1.0` (drafts `/xapi/v0.2`, …) |
| Practice category (every practice statement) | `/xapi/practice` |
| Verbs | `/xapi/verbs/{placed,branched,caught,revealed}` |
| Activity types | `/xapi/activity-types/{path,beat,checkpoint,file,planted-bug}` |
| Extensions | `/xapi/extensions/{branch,to,rationale,checks,start-lesson,skipped,waive-recommended,carried-over,attempt,rules-version,custody}` |
| Practice actor home page | `/practice-learner` |
| Package XML namespace and XSD | `/course/v1`, `/course/v1/cxm.xsd` |
| JSON Schemas | `/schema/1.0/*.schema.json` |
| Spec | `/spec/1.0/`, `/spec/draft/` |

Hosting:

- static files
- JSON-LD served with `Access-Control-Allow-Origin: *`
- 303 content negotiation for profile IRIs, following ADL's practice ([PRIOR] §4)

The domain has to stay renewed for as long as any record cites it (owner decision). BC-26: every IRI resolves before the first official record is written, and the site build fails if any IRI listed in the profile returns anything other than 200 or 303. Why: dead IRIs are a broken promise in every statement. Cost if wrong: none.

### 10.2 Verbs

| Verb | IRI | Kind | Issued by |
| --- | --- | --- | --- |
| launched, initialized, completed, passed, failed, terminated | cmi5 / ADL IRIs ([CMI5] §3.2) | cmi5 defined | `launched`: LMS role. The others: AU. |
| waived, satisfied, abandoned | cmi5 / ADL IRIs | cmi5 defined | LMS role (the server in options 2 and 3) |
| experienced, answered | ADL | allowed | AU |
| passed, failed on a file or checkpoint activity | ADL | allowed | AU |
| placed, branched, caught | `/xapi/verbs/…` | allowed | AU |
| revealed | `/xapi/verbs/revealed` (new) | allowed | AU |
| earned | `http://specification.openbadges.org/xapi/verbs/earned`, with the `badgeassertion` result extension, reused from the ADL-hosted Open Badges profile ([OB] §4.1) | not cmi5; written after issuance | badge issuer; where it goes per option is in §11 |

`earned` uses the existing IRI so that LRS reports already recognise it (BC-27; cost if wrong: that profile is OB 2.0-era, but only its verb and extension IRIs are used, with an OB 3.0 credential id as the value).

### 10.3 Statement templates

The profile has one template per (verb, object type) pair.

**All templates** require:

- the cmi5 contextTemplate content (the publisher-id grouping and the `sessionid` extension)
- `registration`
- `rules-version`
- the `custody` context extension

They exclude `version`, `mbox`, `name`, `contextAgents` and `contextGroups`, and keep statements valid under both xAPI 1.0.3 and 2.0 (kept from `RULES.md` §6.2).

**Defined templates** require:

- the cmi5 category
- the AU activityId as the object
- the moveOn category when the result has success or completion
- `duration` on completed, passed, failed and terminated

**Allowed templates** require the cxm profile version category and never the cmi5 category ([CMI5] R4).

Patterns: per AU session it is `initialized`, then allowed statements, then the defined outcome statements, then `terminated`. Patterns stay informative. The conformance suite checks order directly.

### 10.4 What changes from the learning-mcp profile (v0.1)

- IRIs move to sqwrlz.com.
- The fixed actor home page goes, except for practice.
- cmi5 defined statements are added. Lesson `completed`/`passed` move from `/lessons/{id}` to the AU activityId and gain `duration` and the moveOn category.
- `completed` is re-timed to "material experienced" (§6.3 rule 3). Lesson pass is the defined `passed`.
- Path `completed` is replaced by `satisfied` on the block.
- `placed` happens inside the placement AU session.
- Failed checkpoint attempts are allowed statements with an `attempt` result extension.
- New: `revealed`, `waive-recommended`, `carried-over`, `custody`, the practice category, `earned`.
- `branched` keeps the checkpoint as its object.
- `platform` stays as the client's self-reported name.

## 11. Open Badges 3.0

The standard defines when a badge is earned and what it says. It refers to OB 3.0 and does not copy it, because the 1EdTech licence forbids derivative documents ([OB] §1.5; owner decision). It acknowledges 1EdTech as the licence requires.

- **Declaration.** `course.json#/badges[]`, one entry per lesson, path or course. Each entry has:
  - the Achievement fields (`id` under the author's domain, `name`, `description`, `criteria.narrative`, `image`, `achievementType`, optional `alignment`)
  - `awardOn`: `au-moveon`, `block-satisfied`, `course-satisfied` or `any-path`
  - `countWaived` (default false)

  The course also declares, once, `course.json#/badgeIssuer`: `signer` (`record-holder` or `course-server`) and `claimPage`, the URL of the course's claim page.
- **When.** Only on the declared cmi5 event: AU moveOn met, block satisfied or course satisfied (owner decision). `any-path` means the first block satisfied (§6.3 rule 6). A learner gets one badge per achievement per registration. Practice never earns a badge. Waived and carried-over lessons follow §6.3 rule 5.
- **Trust.** The issuer MUST compute the event only from statements written by the server's or LMS's credentials, never from anything the learner or agent can write ([OB] §0.2). An issuer other than the course server needs the course structure to do this; the course server gives it the distribution package on publish and whenever the content changes (informative: Learning Ledger imports it through its `courses/write` scope; builder's call, reconciliation 4).
- **Contents.**
  - an OpenBadgeCredential under VC Data Model 2.0, proof `eddsa-rdfc-2022`, Ed25519, a `did:web` issuer
  - `credentialStatus` as a BitstringStatusListEntry
  - evidence: exactly one entry, `id: urn:uuid:<earning statement id>`, a narrative and `genre: "xAPI statement"`
  - no custom JSON-LD terms

  ([OB] §0, §2.1, §4.3.) The earning statement is the `satisfied` statement for blocks and courses, or the defined statement that met moveOn for an AU.
- **Honest criteria.** The criteria narrative MUST say how the learning was assessed: deterministic checks, or the learner's AI agent judging against an authored rubric. When waived (tested-out) lessons counted towards a path or course badge, the badge's evidence narrative MUST state how many (owner answer 6; builder's call, reconciliation 6).
- **Privacy.**
  - Never put the xAPI actor id in a badge, hashed or plain.
  - Never embed statements.
  - Scores appear only if the author opts in.
  - Recipient binding happens at claim time: a wallet DID, or a hashed email with a random 16-byte salt chosen by the learner. Only the hash and salt are stored.
  - No badge is issued without a recipient.

  ([OB] §6.)
- **Claiming.** Normatively, the standard defines only the `earned` statement and the claim-page URL (builder's call, reconciliation 5). `get_badges` returns badge metadata and the course's `claimPage`, never a bearer link. The claim page identifies the learner first and only then has the issuer mint a claim link. No MCP tool signs anything, and no key goes near the agent. How the claim page gets a link from the issuer is informative. In Learning Ledger's API, the issuer mints one link per request, bound to actor and badge: single use, valid 15 minutes, and minting a new one invalidates the previous one (scope `badges/claim-links`).
- **After issuing.** The issuer writes `earned` with `context.statement` referring to the earning statement. In options 2 and 3 it goes to the official record. Option 1 is in BC-32 below.
- **Who signs.**

  | Option | Signer |
  | --- | --- |
  | 1 | the LMS/LRS side if it implements the badge rules. Otherwise the course server (owner answer 7): it signs lesson badges (`au-moveon`) from the defined statements it sent and the LMS accepted, and path and course badges only if it can read the LMS's `satisfied` statement with the session token. The badge's issuer is the course server, and the criteria name the LMS. |
  | 2 | the LRS (the record holder). An LRS that can't issue OB 3.0 leaves it to the course server, signing as in option 3; the course declares this with `badgeIssuer.signer: "course-server"` (builder's call, reconciliation 5) |
  | 3 | the course server, from its own store |
  | 4 | nobody |

- **`earned` in option 1** (BC-32). When the course server signs in option 1, it can't rely on writing to the LMS's LRS: the AU token expires, and cmi5 forbids AU statements after `terminated`. So the course server keeps its own issuer record, which holds the `earned` statement and the credential and is authoritative for the badges it signed; `get_badges` and `get_record` read from it. If a session for the same registration is open when the badge is issued (the learner has launched a later lesson), the server also sends `earned` to the LMS's LRS inside that session, with the cxm profile category. It never writes to the LMS after a session's `terminated`. Why: the badge has to stay verifiable whatever the LMS's token allows, and an LMS copy is useful only where cmi5 permits one. Cost if wrong: an LMS's reports may miss `earned` for badges claimed between launches.
- **Revocation.**
  - The issuer revokes by flipping a bit in a signed status list of at least 131,072 entries, with random indexes ([OB] §2.3).
  - It MUST revoke when the earning statement is voided, and when the record holder erases the learner's statements on request (owner answer 4).
  - It MAY revoke for issuer error or misconduct.
  - Re-issuing after a key rotation keeps the credential id with a newer `validFrom`, and old keys stay in the DID document ([OB] §2.2).
- **Not in 1.0:** OB 2.0 export, CLR 2.0, VC-JWT (a later MAY), 1EdTech certification. The free validator at vc.1ed.tech is used in conformance (§13).

## 12. Agent-friendly authoring

Course authors mostly don't code. They will ask their own AI to convert a course (owner decision). The spec has to work when the reader is an agent.

**The authoring guide** (`docs/authoring/`, informative; also shipped as a skill, `skill://course-xapi-mcp-author/SKILL.md`, from the validator's MCP server) provides:

- A procedure in numbered steps:
  1. inventory the source course
  2. choose the custody option (with a decision table)
  3. map units to paths and lessons
  4. write beats (one idea each, a question where the learner should predict)
  5. write checkpoints, with a rubric and branches whose `when` texts don't overlap
  6. add deterministic checks
  7. add a planted bug and its fix checks
  8. write a reference solution
  9. write the placement guide
  10. declare badges
  11. validate
  12. package
- For every field: the rule, a good example, a bad example, and why it matters.
- A section on what never to do:
  - put answers in beats
  - write instructions to the agent in content
  - reveal a bug in its hint
  - author a branch that skips the checkpoint
- Two worked conversions: the JSON example course, and a plain cmi5 course with HTML AUs.
- Guidance on how to work through validator errors one at a time.

**The validator** (`cxm validate`: a CLI, a library, and an MCP server exposing `validate_package`, `explain_error` and `scaffold`; the reference is Apache-2.0):

- Checks against the cmi5 XSD, the cxm XSD and the JSON Schemas, plus cross-references:
  - every `cxm:key` is unique and resolves
  - branch targets are in the same path
  - every live path has at least one AU
  - moveOn matches whether the lesson has a checkpoint
  - no secret fields in a distribution package
- Behavioural checks against the reference solution: every check fails on the starter files and passes on the solution. Every fix check fails on the bug code and passes on the fixed code. Every branch can be reached.
- Lint warnings for:
  - overlapping branch `when` texts (a heuristic)
  - regexes with catastrophic backtracking
  - beats longer than about 250 words
  - out-of-scope agent instructions (§9.4)
  - missing sources
- Output is deterministic JSON. Each error has a stable `code` (for example `CXM-PKG-014`), a `severity`, a location (an XPath into cmi5.xml or a JSON Pointer into a named file), a one-sentence `message` and a concrete `fix`. All errors are reported in one pass. Each code links to a page on the spec site.
- It builds both the authoring and the distribution packages.

BC-28: the validator's error codes are part of the conformance package suite (normative IDs), and the validator itself is informative tooling. Why: other validators can then emit the same codes, and an author's AI can look up any code. Cost if wrong: renaming codes counts as a minor version change.

## 13. Conformance

Conformance classes and what the suite checks. Requirement IDs are in `conformance/requirements/<version>.yaml`, and each MUST maps to a test or a documented exclusion (MCP's SEP-2484 traceability model, [PRIOR] §3).

| Class | How it's tested | Checks |
| --- | --- | --- |
| **Course package** | `cxm validate` against a corpus of good and bad packages | everything in §12; every bad package must fail with the expected code |
| **Course server**, one profile per custody option | Black box over MCP, against any URL, with a scripted adversarial client. Option 2 uses a bundled test LRS. Option 3 uses export. Option 4 uses results. | discovery and extension settings; step order; required replies; invented, foreign and early branches refused with no statement written; failed check leaves only failing branches; bug secrecy scan; injection strings wrapped and inert; no tool writes the record; custody label on every result; practice category; every statement validated against xAPI 1.0.3 and 2.0, the cxm profile and the cmi5 requirement IDs (`@cmi5/requirements`); session order; no defined `failed` after `passed`; waivers and satisfaction in the LMS role |
| **Launch bridge** (option 1) | A bundled cmi5 LMS/LRS simulator drives the launch, then the scripted MCP client connects | fetch done server-side once; LaunchData honoured; contextTemplate on every statement; `initialized` first and `terminated` last; duration; token not leaked; relaunch handling; `waive-recommended` present |
| **Badge issuer** | Fixtures of earning statements, then issue, then verify | triggers fire only on the declared events and only from trusted credentials; one per registration; evidence shape; no actor id; status list; the signed output passes the 1EdTech validator and the DCC verifier |

**CATAPULT.**

- The CTS fits the bridge. It launches the AU URL in an iframe and checks the LRS traffic through its proxy ([CMI5] §5).
- BC-29: the bundled simulator runs in CI. A manual CTS run on the reference bridge is required before every release, and its results are published in `docs/implementations.md`. Why: the CTS is a UI-driven web service, which is awkward in CI, but it's the authority people trust. Cost if wrong: drift between the simulator and the CTS between releases.
- The LTS doesn't apply, because no course server claims to be an LMS.
- For badge issuers, the LRS side is tested with ADL's lrs-conformance-test-suite, which belongs to Learning Ledger's design, not this one.

## 14. Licence, IRIs, going public

- **Licence (owner decision):** Apache-2.0 for everything in this repo: spec text, schemas, profile, conformance suite, reference implementation, examples. That is the same licence as xAPI, cmi5, MCP and OpenAPI ([PRIOR] §5).
- **Relicensing:** all 9 commits are by Derin, so the owner can relicense alone. The steps:
  1. replace `LICENSE` with Apache-2.0
  2. delete `LICENSE-CC-BY-SA-4.0`
  3. add `NOTICE`, including the 1EdTech attribution for OB 3.0
  4. set `"license": "Apache-2.0"` in every package.json, change the example course's licence, and add SPDX headers
  5. add a README line saying versions before the relicensing commit were GPL-2.0-or-later and CC BY-SA 4.0

  Do this before the repo goes public.
- **Downstream licences:** the prototype site and the WordPress plugin (Learning Ledger) are GPL-2.0-or-later. Including Apache-2.0 code makes the combined work effectively GPLv3, which "or later" allows. This is the same situation the vendored copy already has with the MCP SDK.
- **IRI hosting:** `course-xapi-mcp.sqwrlz.com` serves the static build of `site/`. The hosting target is the builder's choice (a Spacefast space or GitHub Pages behind the subdomain). The subdomain's DNS and the domain renewal are the owner's.
- **Going public (BC-30, confirmed by owner answer 13):** make the repo public at the **0.2 draft milestone**, when:
  - the relicensing is done
  - the IRIs resolve
  - `spec/draft` holds the decisions in this document
  - the conformance suite runs against the reference server

  That has to happen before the prototype writes its first official record. Why: IRIs and an open standard need a public home, and the 1.0 exit criterion needs outside implementers, who can't come while the repo is private. Cost if wrong: early readers see unstable drafts. The status banner and `0.x` numbering say so.

## 15. Migration from learning-mcp

1. **Merge `plan-b-fixes` into `main` first.** It's one commit, `f2c8362`: nested file names, plus `StoreError` and `StoreConflictError`. The prototype's vendored copy is already pinned to it (`learn-wp-reimagined/vendor/learning-mcp/VENDORED.json`).
2. **Rename** the repo, folders and packages (§5.2). Then relicense (§14). Move `RULES.md`, `rules/AGENT_RULES.md`, `docs/spec.md` and `docs/STATUS.md` into `docs/history/`, marked superseded. Copy the three scratchpad research files and `lrs-options.md` into `docs/research/`.
3. **Code: keep** `engine`, `checks`, `learner-text`, the rules-digest mechanism, branch validation and their tests. They're unchanged in substance.
4. **Code: change**
   - `schema.ts` becomes a cmi5 package reader plus JSON Schemas generated from it
   - `xapi.ts` gets cmi5-shaped statements
   - `session.ts` gets AU sessions, review, waivers and `reveal_bug`
   - `record.ts` becomes the practice record only
   - `server.ts` gets the extension declaration, MCP authorization hooks and the new tools
5. **Code: add**
   - custody adapters behind one interface (LMS endpoint, author LRS, own store, practice relay)
   - the bridge
   - the validator and its MCP server
   - badge rules, plus a course-server signer for options 3, 1 (when the LMS can't issue) and 2 (when declared), with its issuer record (BC-32), using the Digital Bazaar libraries ([OB] §2.5)
   - `restart_course`, and the course server's own MCP authorization server with OIDC federation (§8.1)
   - the conformance suite
6. **Records.** No official records exist anywhere today:
   - learning-mcp records are test data
   - the prototype's `learn-wp-reimagined/record` v1 records live in learners' browsers and were never official

   Nothing is converted into an official record, because a learner-held copy can't become official without breaking R2. The prototype keeps a read-only "download your old record" path. It MAY offer to import an old record as a practice copy (BC-31. Why: honesty about what the old record proves. Cost if wrong: early prototype learners redo lessons to get official progress and badges.)
7. **The vendored copy in learn-wp-reimagined** stays pinned until the prototype rebuild, which comes last (owner decision). It is then replaced by vendoring the renamed reference packages with the same script, renamed `vendor-course-xapi-mcp.ts`. The prototype then uses custody option 2 with the separate LRS space running Learning Ledger at `lrs.sqwrlz.com` (owner decision; owner answer 9).

## 16. Decisions on the former open questions

The four open questions in the first draft are now answered by the owner. Everything else above is decided as a numbered builder's call, provisional until the owner approves this document (builder's call, reconciliation 15).

- **Q1. Who signs badges in option 1 when the LMS can't? Decided (owner answer 7): option (a).** The course server signs lesson badges (`au-moveon`) from the defined statements it sent and the LMS accepted, and signs path and course badges only if it can read the LMS's `satisfied` statement with the session token. The badge's issuer is the course server, and the criteria name the LMS. Where `earned` goes is BC-32 (§11). Option (b), badges only from LMSs that implement the cxm badge rules, is dropped. Learning Ledger v1 provides the cmi5 LMS side for Sensei sites (a cmi5 player), so option 1 is demonstrable on WordPress via the standard's launch bridge (owner answer, round 3, reversing reconciliation 8).
- **Q2. Governance. Decided (owner answer 15).** Derin is the sole editor until a second independent implementation exists; then the project seeks a neutral home, IEEE LTSC or an MCP interest group. No co-editor is named before then (§5.5).
- **Q3. Strictness and attestation. Decided.**
  - Strictness (owner answer 19): keep required verbatim replies, and add a recorded `reveal_bug` after 3 failed fix attempts (BC-23 confirmed, §9.2).
  - Statement attestation (owner answer 20): none in 1.0. Official records are verified by asking the record holder, and badges are the portable proof. Practice copies stay unattested and labelled.
- **Q4. The ChatGPT test. Decided (owner answer 21).** Derin has ChatGPT Pro. Once a public course-server URL exists, Derin signs in once in an agent-browser window, the agent runs the developer-mode connector test, and then removes the connector. "Works in ChatGPT" is claimed only after that test passes (§9.4).

## Changes in this revision

- Domain: every `appsurd.org` reference is now `sqwrlz.com`. The spec site, profile and IRIs are at `https://course-xapi-mcp.sqwrlz.com/`, and the MCP extension id is `com.sqwrlz/course-xapi-mcp` (owner, round 2).
- Status and reading guide: added owner answers and reconciliation rulings as sources; all builder's calls are provisional until approval (reconciliation 15).
- Governance (§5.5): editor and hand-over set by owner answer 15.
- Package (§6.1, §6.2): the ZIP in two flavours is the only interchange format, served with an ETag (reconciliation 2). New courses keep AU ids under the course IRI base, using the `{au@id}/au` scheme (reconciliation 7). An LMS Review launch is now kept apart from the server's own review walk-throughs.
- Sequencing (§6.3): after `maxAttempts`, a new session may retry and pass. Lessons count as done only on moveOn. The waiver rules for badges are fixed, with a `carried-over` extension. Multi-path mapping for LMSs that model one course per path (reconciliations 1, 6, 7, 13).
- Custody (§7.1, §7.2): new signer and actor columns, a one-writer rule (reconciliation 3), and the course server as its own MCP authorization server federating over OIDC (reconciliation 13).
- Launch (§8.1): `launched` with Review removed, actor derivation stated, registration reuse until `restart_course` (reconciliation 13).
- Tools (§9.2): `get_badges` returns metadata and a claim-page URL; new `restart_course` (reconciliations 5, 13).
- Profile (§10): `carried-over` extension; where `earned` goes.
- Badges (§11): `badgeIssuer` declaration. The normative claim-page model, with Learning Ledger's issuer API informative (reconciliation 5). Option 1 signing by the course server (owner answer 7), the option 2 fallback signer, BC-32 on where `earned` goes in option 1, the tested-out count in the narrative (owner answer 6), revocation on erase (owner answer 4), and course import into the issuer (reconciliation 4).
- Removed the claim that our WordPress plugin acts as the option-1 LMS; it is now future work (reconciliation 8). The plugin is named Learning Ledger throughout.
- Round 3: Learning Ledger v1 includes a cmi5 player and so provides the cmi5 LMS side for Sensei sites; option 1 is demonstrable on WordPress via the standard's launch bridge. This reverses reconciliation 8 and replaces the "future work" wording in Q1.
- §14, §15: BC-30 confirmed by owner answer 13. Migration adds the signer scope, `restart_course` and the authorization server. The prototype LRS is at `lrs.sqwrlz.com`.
- §16: open questions Q1 to Q4 turned into recorded decisions.
