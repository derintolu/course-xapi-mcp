# learning-mcp: standards prior art, cmi5 ecosystem, spec governance models

Researched 2026-10-27. Every fact has a URL. "Unverified" marks secondary or vendor claims. Gaps are flagged. adlnet.gov was unreachable from the fetch tool (connection refused) for several pages, so ADL claims rest on search snippets, GitHub, and IEEE pages.

## Headline findings

1. No prior art found that combines MCP (or any agent tool protocol) with cmi5. Searches of GitHub for cmi5+mcp, xapi+mcp, scorm+mcp, lti+mcp turned up only authoring/packaging servers and LRS query servers (section 1). The "course served as an MCP server, taken inside the learner's own agent, recorded as learner-owned xAPI" combination still looks novel.
2. 1EdTech announced an MCP-based "educational context" effort on 2025-10-21, but it publishes no deliverable. I found nothing newer. ADL and IEEE have nothing public on MCP or AI tutors. This is the main standards-body overlap to watch.
3. MCP changed under you: the current spec is 2026-07-28, stateless (per-request `_meta`, no initialize handshake, mandatory `server/discover`). Anything in learning-mcp that assumes an MCP session or handshake needs re-checking against it.
4. MCP now has a formal extension mechanism (SEP-2133). A learning-mcp spec can be shipped as an MCP extension with identifier `{reversed-domain}/{name}`, with no one's permission, and could later be proposed upstream on the Extensions Track. "Skills over MCP" (`io.modelcontextprotocol/skills`, SEP-2640, Final, merged 2026-09-13) is directly adjacent: it serves SKILL.md teaching instructions from an MCP server.
5. cmi5 is healthy but not growing: the spec is still Quartz 1st Edition (June 2016), the AICC repo's last push was 2024-09-06, the IEEE P9274.3.1 PAR (approved 2023-02-15) has no published standard and no scheduled meetings. CATAPULT is maintained (v1.0.8 released 2026-01-20). Wide LMS support is via Rustici Engine, SCORM Cloud, and plugins. A vendor-neutral LMS conformance list does not exist publicly.
6. No documented precedent for a cmi5 AU that is not a browser/app launched from an LMS. Nothing was found for a CLI, a server-side AU, or an agent-driven AU. The launch handshake itself is not browser-bound, so this would be new ground.
7. w3id.org is the right IRI host. A new id is a PR adding `ids/<name>/.htaccess`. Sampled turnaround: median 7.3 h from open to merge (57 recently merged PRs), p90 ~48 h, max ~135 h. No SLA. ADL's profile server repo is archived (2025-11-14), and `w3id.org/xapi/...` now 303-redirects to `tools.xapi.ly/profiles/` (a third-party host, see section 4).
8. Licence norm among the closest comparators: Apache-2.0 for spec text and code (MCP, OpenAPI, xAPI, cmi5, IEEE xAPI repos), CC BY 4.0 for non-spec docs (MCP). ActivityPub uses the W3C Software and Document License under the W3C Patent Policy. No comparator uses CC BY-SA.

---

## 1. Prior art since docs/research.md section 4

research.md already covers LearnMCP-xAPI, Veracity LRS MCP, generic MCP tutors, Study/Learning modes, GrassBlade.

### 1a. Standards bodies

| Body / effort | What it is | Evidence | How learning-mcp differs |
|---|---|---|---|
| 1EdTech, "responsible AI in education" community effort | Cross-sector effort to define a shared open framework giving AI models educational context, "builds on MCP". Run through 1EdTech Labs Live webinars and technical working groups. No deliverable or timeline stated. Announced 2025-10-21; first webinar 2025-10-23. | https://www.1edtech.org/1edtech-article/1edtech-leads-collaborative-effort-to-shape-responsible-ai-in-education/411336 | 1EdTech's effort is about giving a model context about the learner and the structures of teaching (data in). learning-mcp is a course runtime contract (content, rubrics, branching, checks, xAPI out). Likely complementary. Monitor for a LTI/Caliper/CASE tie-in. No 2026 update found (two searches). |
| IEEE 9274.1.1-2023 (xAPI 2.0) | Published IEEE standard, active, SASB approved 2023-03-30, expires 2033-12-31. | https://sagroups.ieee.org/ltsc/active-standards ; ADL announcement via search: https://adlnet.gov/news/2023/11/22/xAPI-Officially-Becomes-a-Published-IEEE-Standard | Foundation for the record format. |
| IEEE P9274.2.1 (xAPI Profiles) | In progress. IEEE repo `xapi/xapi-profiles` active (last activity 2026-03-09). | https://opensource.ieee.org/xapi/xapi-profiles ; https://github.com/adlnet/xapi-profiles (banner: "spec review / upgrade in progress") | learning-mcp's profile should target the profiles spec as it stands (1.0, ADL repo last push 2024-12-16) and expect a revision. |
| IEEE P9274.3.1 (cmi5) | Project page says "Active PAR", PAR approved 2023-02-15, no target completion. Not on LTSC's active standards list. Meetings page shows no upcoming events. ADL says a "2.0" of cmi5 is under lengthy discussion (search snippet, adlnet.gov not fetched). | https://standards.ieee.org/ieee/9274.3.1/11183/ ; https://sagroups.ieee.org/9274-3-1/meetings/today ; https://sagroups.ieee.org/ltsc/active-standards ; https://sagroups.ieee.org/9274-3-1/how-to-participate | A window may exist to influence cmi5 2.0 or the IEEE draft (non-browser AUs, agent runtimes). Gap: I could not confirm the IEEE draft's current state or whether the WG is active. |
| ADL AI work | Nothing found tying ADL to MCP, AI tutors, or agentic learning in 2026. | Search 2026-10-27, nothing relevant. | Gap, not evidence of absence. ADL's site was unreachable for fetching. |
| Open edX | LinkedIn post says Open edX's AI Extensions Framework includes MCP client integration (unverified). A Teachfloor blog says a new open-source Open edX MCP was announced 2026-09-24 (unverified). PyPI `openedx-mcp` is a staff-admin REST facade for an MCP server. | https://pypi.org/project/openedx-mcp/ ; https://www.teachfloor.com/blog/best-mcp-servers-for-lms | These expose LMS admin operations to agents. They are not course-delivery contracts. |
| LMS MCP servers (Canvas, Moodle, LearnDash, Docebo, Cubite) | Community and vendor servers that expose LMS APIs (courses, grades) to agents. Teachfloor: Canvas, Moodle, Brightspace, Blackboard have no official vendor MCP server (unverified, vendor blog). LearnDash and Docebo reported to have vendor-built servers (unverified). A LinkedIn post claims Instructure's IgniteAI Agent is moving to MCP (unverified, conflicts with Teachfloor). | https://minicoursegenerator.com/blog/best-mcp-servers-for-education/ ; https://cubite.io/compare/lms-mcp-servers ; https://github.com/bruchris/canvas-lms-mcp | Admin/grading access to an LMS, not courses taught inside the learner's agent. No LTI/cmi5 launch. |
| Learning Context paper (OpenStax / Rice, Baraniuk et al.) | arXiv 2512.24362, submitted 2025-12-30, v2 2026-01-30. Proposes a "Learning Context" data structure that AI tutors load at session start via MCP. Does not mention xAPI or name standards. | https://arxiv.org/abs/2512.24362 | Learner-model server (context in) vs. course server (content and evidence out). Possible composition: a learner-owned record could feed a Learning Context server. |
| MCP "Skills over MCP" extension | Official extension `io.modelcontextprotocol/skills`, SEP-2640 Final, merged 2026-09-13. Servers expose SKILL.md workflow instructions plus supporting files as `skill://` resources with SHA-256 manifests. Hosts treat skill content as untrusted and need approval. | https://modelcontextprotocol.io/extensions/skills/overview ; https://github.com/modelcontextprotocol/ext-skills | Highly relevant mechanism for shipping the "teaching rules travel with the course" (AGENT_RULES.md) in a standard way. Also a design precedent for a spec repo (section 3). Check client support in https://modelcontextprotocol.io/extensions/client-matrix . |

### 1b. Open-source projects (GitHub search 2026-10-27)

| Project | What it does | Link | Difference |
|---|---|---|---|
| CourseCode (course-code-framework/coursecode, pushed 2026-10-26) | AI-assisted authoring framework with a built-in MCP server; exports SCORM 1.2/2004, cmi5 and an "LTI 1.3 browser contract". | https://github.com/course-code-framework/coursecode | MCP is used to author; output is still a browser package launched from an LMS. Evidence that "authors use their AI to build cmi5 courses" is already mainstream, and a conversion source/target for learning-mcp. |
| edumints-scorm-mcp (kemalyy, MIT, pushed 2026-10-14) | MCP server where the client AI is the author and the server compiles/validates/packages a SCORM zip. Anti-slop lint. | https://github.com/kemalyy/edumints-scorm-mcp | Authoring-time MCP, SCORM output. |
| scorm-mcp-server (giacomomaria81, 2026-09-03) | Turns HTML into SCORM packages. | https://github.com/giacomomaria81/scorm-mcp-server | Same category. |
| mcp-learning-server (shastripranav, 2026-06-30) | MCP server for SCORM package parsing, xAPI analytics, course catalog (13 tools, 25 seeded courses). | https://github.com/shastripranav/mcp-learning-server | Catalog/analytics. No delivery contract. |
| Veracity_MCP (chadudell, 2026-04-02) | 20-tool MCP server for querying a Veracity LRS (learners, courses, classes, launches). | https://github.com/chadudell/Veracity_MCP | Query-only, same category as Veracity's own MCP. |
| cubite-mcp (amirtds, 2026-09-23) | MCP server for Cubite hosted LMS (SCORM, xAPI, certificates). Cubite lists no cmi5 support. | https://github.com/amirtds/cubite-mcp ; https://cubite.io/compare/lms-mcp-servers | LMS admin. |
| LearnMCP-xAPI (DavidLMS, last push 2025-08-29, 15 stars) | Already in research.md. Appears dormant. | https://github.com/DavidLMS/learnmcp-xapi | See research.md. |
| ConductionNL/learniq issue 1543 | Planning doc for cmi5/xAPI LRS ingest endpoints. Not MCP. | https://github.com/ConductionNL/learniq/issues/1543 | Irrelevant to the contract. |

No result for LTI-over-MCP, Common Cartridge-over-MCP, or any MCP-for-education specification other than 1EdTech's unpublished effort. Gap: GitHub search is keyword-limited, and private/commercial work would not appear.

---

## 2. cmi5 ecosystem

### Spec and standards status
- Spec repo: AICC/CMI-5_Spec_Current, branch `quartz`, Apache-2.0, "Current Release: Quartz, 1st Edition (June 2016)", no GitHub releases, last push 2024-09-06. Files: `cmi5_spec.md`, `v1/`, `README.md`, `LICENSE`. https://github.com/AICC/CMI-5_Spec_Current
- IEEE P9274.3.1: see 1a. PAR approved 2023-02-15, no publication found.

### CATAPULT (conformance and reference player)
- Repo adlnet/CATAPULT, Apache-2.0, not archived, last push and latest release v1.0.8 on 2026-01-20 (v1.0.7 2025-12-15, v1.0.6 2025-08-01). Release notes say all previous versions are deprecated; v1.0.8 swaps libxmljs for xml-parser. https://github.com/adlnet/CATAPULT/releases
- Components: `player/` (web service for LMS integration), `cts/` (Content Test Suite, web UI to test packages), `lts/` (LMS Test Suite: package library, manual procedure, automatable tool; vendors can show JUnit XML as proof), `requirements/` (requirement-ID map on npm as @cmi5/requirements), `course_examples/`. https://github.com/adlnet/CATAPULT ; docs https://adlnet.github.io/CATAPULT/cts/ ; https://aicc.github.io/CMI-5_Spec_Current/catapult/
- Origin: delivered to ADL by Rustici Software in September 2021, plus course templates and the "From Conception to Conformance" best practices guide. https://rusticisoftware.com/blog/we-launched-catapult-a-giant-step-forward-for-cmi5/ ; guide https://apps.dtic.mil/sti/trecms/pdf/AD1156141.pdf
- Gap: I found no official public list of LMSs that passed the LMS test suite. One secondary guide claims that any LMS built on Rustici Engine passes (unverified): https://lmspedia.org/cmi5-guide-for-lms-admins-developers/

### LMS / LRS / authoring support (all secondary, unverified unless stated)
- LMSPedia's 2026-03-26 table says: Moodle native-with-plugin, Docebo native, Cornerstone partial, SAP Litmos native but no LRS, TalentLMS partial (xAPI pass-through), SCORM Cloud native reference implementation, Absorb native, SimpliTrain native. https://lmspedia.org/cmi5-guide-lms-implementation-2026/ . Treat as a lead list, not a fact list.
- Moodle: ADL publishes a cmi5 launch plugin, adlnet/Moodle-mod_cmi5launch (pushed 2026-03-18) and logstore_xapi (2025-05-01). https://github.com/adlnet/Moodle-mod_cmi5launch . Rustici sells SCORM Cloud / Content Controller for cmi5 in Moodle: https://rusticisoftware.com/resources/play-xapi-and-cmi5-in-moodle/ . One third-party PR found the Moodle cmi5 plugins non-conformant (single developer, weak evidence): https://github.com/mblanke/TrueNorth/pull/139
- Open edX: community thread asks about cmi5; only xAPI event emission exists (undated). https://discuss.openedx.org/t/is-there-cmi5-support/6419
- Canvas: only "via integrations" (vague, unverified).
- LRSs: cmi5 needs only an xAPI-conformant LRS. Named: Learning Locker, SCORM Cloud LRS, Watershed, Veracity. ADL_LRS (adlnet/ADL_LRS pushed 2025-11-14) and adlnet/lrs-conformance-test-suite (2025-09-04) exist. Neither is a cmi5 conformance claim.
- Authoring: Storyline 360 (cmi5 export from 3.68), Captivate (2022+), Lectora 21 (all per LMSPedia, unverified). CATAPULT course templates for SCORM conversion: https://xapi.com/blog/converting-scorm-content-to-cmi5-with-catapult-course-templates/ . CourseCode and others are AI-first authoring paths (see 1b).

### Player / launch libraries
- `@xapi/cmi5` (xAPI.js cmi5 Profile Library): TypeScript, v1.4.0 on npm, MIT, claims full compliance with Quartz. AU side only (initialize, statements). https://www.npmjs.com/package/@xapi/cmi5 ; https://www.xapijs.dev/cmi5-profile-library
- `@openlearning/xapi`: OpenLearning's own client. https://github.com/OpenLearningNet/xapi
- ADL cmi5-Client-Library: archived (last push 2021-08-04). https://github.com/adlnet/cmi5-Client-Library
- LMS/player side: CATAPULT `player/` (Node), Rustici Engine (commercial), Moodle plugin. There is no widely used LMS-side cmi5 launch library for building a new launcher, other than reading CATAPULT's player. Gap worth noting for learning-mcp's implementers.

### Precedent for non-browser AUs
- Practitioner sources say cmi5's launch is URL-parameter based and "does not require a browser," and cite mobile apps, simulations, AR/VR and serious games launched from an LMS. https://xapi.com/cmi5/technical-systems-professionals/ ; https://adlnet.gov/news/2021/09/09/cmi5-Resources ; https://www.forasoft.com/learn/elearning-video/articles-elearning/cmi5-explained
- Caveat: `launchMethod` is about window context (https://developers.masterplan.com/sso-integrations/cmi5).
- No documented CLI, server-side or agent-hosted AU. The first documented example would be learning-mcp's. An AU that is "an MCP server" means the AU is not launched by URL into a window at all. It would need the launch parameters (endpoint, fetch URL, actor, registration, activityId) delivered to the server, a fetch-token exchange, and a spec-sanctioned way to declare "no browser surface". Another agent is reading the cmi5 spec for how well this fits.

---

## 3. How comparable open standards are published and governed

### MCP (closest comparator, and what your agent consumes)
- Repo: modelcontextprotocol/modelcontextprotocol. Top level: `docs/` (including `specification/<date>/`, `extensions/`, `community/`, `registry/`), `schema/<date>/` (contains `schema.ts` as source of truth, generated `schema.json`, and `examples/`), `seps/`, `blog/`, `tools/sep-automation`, plus GOVERNANCE.md, MAINTAINERS.md (last updated 2026-10-01), CONTRIBUTING.md, SECURITY.md, ANTITRUST.md, AI_POLICY.md, CODE_OF_CONDUCT.md, AGENTS.md. https://github.com/modelcontextprotocol/modelcontextprotocol (verified via GitHub API listing 2026-10-27).
- Normative language: RFC 2119 MUST/SHOULD/MAY, visible in the spec text and required explicitly for extension specs. https://modelcontextprotocol.io/extensions/overview
- Versioning: `YYYY-MM-DD` = last date a backwards-incompatible change was made. Revisions are Draft / Current / Final. Current is 2026-07-28 (released 2026-07-28 after an RC on 2026-05-29; previous 2025-11-25). Backwards-compatible changes do not bump the version. Every request carries `io.modelcontextprotocol/protocolVersion` in `_meta`; `server/discover` is mandatory. Features have a lifecycle (Deprecated stays at least 12 months, 90 days if expedited, then Removed) plus a deprecated-features registry. https://modelcontextprotocol.io/specification/versioning ; https://github.com/modelcontextprotocol/modelcontextprotocol/releases
- Process: SEPs (markdown in `seps/NNNN-title.md`, numbered by PR number). Types: Standards Track, Informational, Process, Extensions Track. Needs prior WG/IG discussion, a Core Maintainer sponsor, review every two weeks, a prototype before acceptance, and a reference implementation before Final. Since SEP-2484, Standards Track SEPs with observable behavior need a merged conformance scenario and a traceability file (`sep-NNNN.yaml`) mapping each MUST/SHOULD to a check or documented exclusion. Statuses: draft, in-review, accepted, rejected, withdrawn, final, superseded, dormant. SEPs are frozen once final; the spec is authoritative. https://modelcontextprotocol.io/community/sep-guidelines
- Extensions: identifier `{vendor-prefix}/{name}`; official ones use `io.modelcontextprotocol`; third parties should use a reversed domain they own (`com.example/my-extension`). Official extensions live in `ext-*` repos; incubation in `experimental-ext-*` repos tied to a WG/IG with Core Maintainers able to archive. Extensions must use RFC 2119, are off by default, are negotiated in `capabilities.extensions`, must degrade gracefully, evolve independently via versioning inside the settings object, and use a new identifier (e.g. `-v2`) only for breaking changes. https://modelcontextprotocol.io/extensions/overview (SEP-2133)
- Extension repo model (ext-skills): `specification/stable/skills.mdx` = source of truth, "stable is a released snapshot and is not edited in place", a `docs/decisions.md` decision log (ADR-lite) as the change vehicle, `docs/rationale.md`, `docs/implementations.md`, and explicit statement that docs are not part of the spec. https://github.com/modelcontextprotocol/ext-skills
- Conformance: separate repo modelcontextprotocol/conformance (`npx @modelcontextprotocol/conformance`; client and server modes, GitHub Action, expected-failures baselines, per-revision requirement sets in `requirements/<revision>.yaml`, SDK tier-check per SEP-1730). Still young (action v0.1.11 cited). https://github.com/modelcontextprotocol/conformance
- Governance: "Model Context Protocol a Series of LF Projects, LLC", donated to the Linux Foundation's Agentic AI Foundation (announced 2025-12-09). Lead Maintainers (BDFL), Core Maintainers, Maintainers, Contributors. Membership is personal, not corporate. WGs/IGs. https://modelcontextprotocol.io/community/governance ; https://linuxiac.com/model-context-protocol-joins-linux-foundation-in-major-ai-shift/
- Neutrality: protocol defined in TypeScript schema, many SDKs, SDK tiering, conformance suite independent of any SDK, design principles doc, no seats reserved for companies.

### xAPI (and IEEE)
- ADL repo adlnet/xAPI-Spec (Apache-2.0, default branch `master`, latest release tag xAPI-1.0.3 from 2016-09-23). Spec split in `xAPI-About.md`, `xAPI-Data.md`, `xAPI-Communication.md` plus `xAPI.md`; README says 1.0.3 is old and xAPI 2.0 is hosted on IEEE open source. https://github.com/adlnet/xAPI-Spec
- xAPI 2.0 = IEEE 9274.1.1-2023. Repo: opensource.ieee.org/xapi/xapi-base-standard-documentation (Apache-2.0 LICENSE, last activity 2026-10-12): front matter, overview, "for Content", "for LRSs" documents, ChangeLog, AUTHORS, CONTRIBUTORS, CONTRIBUTING. Also xapi-base-standard-examples, xapi-profiles. https://opensource.ieee.org/xapi/xapi-base-standard-documentation (API-listed; page itself returned HTTP 418 to the fetcher)
- Normative language: RFC 2119 (MUST/SHOULD/MAY) in the spec. Versioning: semver-ish 1.0.0 to 1.0.3 then 2.0 (2.0 was released by ADL in 2023, then IEEE-ized).
- Extensions: statement `extensions` objects keyed by IRI; vocabularies and profiles registered via xAPI Profiles (JSON-LD, versioned, with concepts, templates, patterns). Profile spec lives at adlnet/xapi-profiles (Apache-2.0, folders `context/`, `libraries/`, `ontology/`) and IEEE xapi-profiles. https://github.com/adlnet/xapi-profiles ; https://opensource.ieee.org/xapi/xapi-profiles
- Conformance: adlnet/lrs-conformance-test-suite (last push 2025-09-04) for LRSs; no suite for content/profiles beyond validators (section 4).
- Neutrality: ADL (US DoD) incubated it, then handed to an IEEE open-source standard (IEEE-SA Open) so no single vendor owns it. LRS reference implementation ADL_LRS stays separate from the spec.

### cmi5 (AICC to ADL to IEEE)
- AICC created it as part of the CMI family; the spec repo is now AICC/CMI-5_Spec_Current (Apache-2.0), one-file spec `cmi5_spec.md` on branch `quartz` (named releases are rock-themed: Quartz is the first edition, June 2016), 1,055 commits. Normative language is MUST/SHOULD in the spec. Conformance requirements enumerated in a wiki page then in CATAPULT's `requirements/` JSON map. Extensions: cmi5 builds on xAPI; "Other" statements and context extensions are allowed. IEEE path: P9274.3.1 WG, stalled/slow (section 1a). https://github.com/AICC/CMI-5_Spec_Current ; https://github.com/AICC/CMI-5_Spec_Current/wiki/(Indexed)-cmi5-Conformance-Testing-Requirements-Draft
- Lesson: it stayed implementation-neutral by funding independent tooling (CATAPULT via Rustici) and publishing requirement IDs separate from the prose. Cost: little happened for ten years after 1.0.

### OpenAPI
- Repo OAI/OpenAPI-Specification (Apache-2.0). Top level: `versions/` (published, immutable `3.2.0.md`, `3.1.2.md` ...), `src/` on `dev` and `vX.Y-dev` branches, `proposals/`, `tests/`, `schemas`, `EDITORS.md`, `GOVERNANCE.md`, `MAINTAINERS.md`, `TOB.md`, `IMPLEMENTATIONS.md`, `SECURITY_CONSIDERATIONS.md`, `SPECIAL_INTEREST_GROUPS.md`, `style-guide.md`, `AI.md`. Releases: 3.2.0 and 3.1.2 on 2025-09-19, 3.2.1 on 2026-09-10. https://github.com/OAI/OpenAPI-Specification
- Normative language: BCP 14 / RFC 2119 + RFC 8174 boilerplate at the top; "licensed under the Apache License, Version 2.0" stated in the document. https://raw.githubusercontent.com/OAI/OpenAPI-Specification/main/versions/3.2.0.md
- Versioning: `major.minor.patch`. major.minor = feature set; patch = errata and clarifications only; tooling SHOULD ignore patch. Occasional low-impact breaking changes in minors. Patch releases need a TSC majority, minor/major 66%. https://github.com/OAI/OpenAPI-Specification/blob/main/CONTRIBUTING.md
- Proposals: discussion -> prove it as an `x-*` extension -> formal proposal PR (template in `proposals/`). Extensions: `x-` prefix, with `x-oai-` and `x-oas-` reserved. Registries (extension fields, namespaces, formats, tag kinds, media types, draft features, alternative schema types) run as Markdown files in `registries/_{name}` in the spec.openapis.org repo, submitted by PR, with JSON/RSS feeds. https://spec.openapis.org/registry/index.html
- Governance: OAI under the Linux Foundation; TSC (3-9 members, 25% opposition threshold to add, 66% to remove), liaison, community manager; unresolved conflicts to OAI's Technical Oversight Board. https://github.com/OAI/OpenAPI-Specification/blob/main/GOVERNANCE.md
- Neutrality: spec says nothing about implementations; ecosystem/tooling kept in `IMPLEMENTATIONS.md`; registries let third parties extend without TSC review of the core.
- Conformance: no official conformance suite for the OAS. A `tests/` folder holds schema test data. (Based on repo listing; not read in depth.)

### ActivityPub (W3C)
- W3C Recommendation 2018-01-23, produced by the Social Web WG, editors Lemmer-Webber and Tallon. Everything normative except sections marked non-normative (examples, diagrams, notes). RFC 2119 keywords. Conformance classes: Client, Server, Federated Server. Test suite test.activitypub.rocks and an implementation report. Errata page. https://www.w3.org/TR/activitypub/
- Extensions: JSON-LD, with an `activitystreams` context (https://www.w3.org/ns/activitystreams) plus any extra contexts; namespace stability comes from W3C-hosted URLs.
- Licence: GitHub repo says all documents are under the W3C Software and Document License; the published document is under the W3C Document License and W3C Patent Policy (royalty-free patent commitments from WG participants, public disclosure list). The 2023 document licence forbids republishing as a competing spec but allows derivatives to help implement it. https://github.com/w3c/activitypub (LICENSE.md) ; https://www.w3.org/copyright/document-license-2023/
- Repo (w3c/activitypub): `index.html` (ReSpec), `activitypub-context.jsonld`, `implementation.md`, `userstories/`, `w3c.json`. Default branch `gh-pages`.
- Neutrality: formal WG, mandatory two implementations rule (W3C process; not re-verified here), test suite, patent policy.

### Recommended structure for a learning-mcp spec repo

Principles taken from the above: one normative source file per version (MCP schema.ts / OpenAPI versions/x.md); informative material kept physically separate (ext-skills `docs/`); immutable released snapshots; a decision log or proposal folder; a conformance suite that is separate from the reference implementation; an extension mechanism that does not need the maintainers' approval.

```
learning-mcp-spec/
  README.md                  status banner, what this is, links
  GOVERNANCE.md              roles, decision rule, how to become editor, how to fork
  CONTRIBUTING.md
  LICENSE                    Apache-2.0 (code, schemas, tests)
  LICENSE-SPEC               see recommendation in section 5
  SECURITY.md  CODE_OF_CONDUCT.md  AI_POLICY.md (authors use AI to convert courses; say how AI-assisted contributions are handled)
  spec/
    draft/                   work in progress
    2026-xx-xx/ or 1.0/      released snapshot, immutable
      index.md               normative; RFC 2119 + RFC 8174 boilerplate; conformance classes
      course-format.md       normative: course.json (what a course author produces)
      server.md              normative: tools/resources/prompts; rule digest; branch validation; check semantics
      record.md              normative: record ownership, export, portability
      cmi5-binding.md        normative: how a course server acts as a cmi5 AU, launch handshake, session/registration mapping
      agent-rules.md         normative content of the rules a server must send (versioned with the spec)
      security-privacy.md    normative/informative split, injection, anonymity
  schema/
    <version>/course.schema.json, tools.ts or .json (source of truth, MCP style)
  profile/
    xapi-profile.jsonld      versioned; IRIs under w3id.org/learning-mcp/...
    CHANGELOG.md
  conformance/
    README.md  requirements/<version>.yaml (requirement IDs, one per MUST)
    server/ (black-box suite, MCP-client-driven)   course/ (course.json linter)   record/ (statement and profile checks)
  extensions/
    registry.md              reserved prefixes, extension IDs, status; entries by PR
  proposals/ (or seps/)      NNNN-title.md, statuses draft..final; conformance entry required before Final
  docs/                      informative only: rationale, decision log, implementations list, authoring/conversion guide, examples
  examples/                  informative sample courses
```

Rules:
- Normative vs informative: only `spec/<version>/` and `schema/` and `profile/` are normative. Everything else says "not part of the specification" in its header. When the schema and prose disagree, the schema wins (as MCP does).
- Versioning: take OpenAPI's pattern of major.minor.patch where minor = feature set and patch = clarifications only, tied to MCP's per-request negotiation, since an MCP client states a protocol revision per request in 2026-07-28. Pick one: either date-based (MCP-style, only bumps on breaking change) or semver (OpenAPI-style). For a spec whose artefacts include a course file that authors keep for years, semver with explicit `specVersion` in course.json, plus a profile version in the xAPI profile, is easier to explain. Mark profile concept versions per the xAPI Profiles spec (profiles are versioned, concepts are deprecated rather than deleted).
- Extensions: reserve a prefix for the spec and require everyone else to use a reversed-domain or w3id-style prefix (MCP model) for tool names, course metadata and xAPI extension IRIs. Extensions off by default, negotiated, must degrade. Keep a small registry file in the repo (OpenAPI registry model: file per entry, PR to add).
- Two-way MCP fit: define learning-mcp as an MCP extension (`org.example/learning` or the eventual domain) so it rides MCP version negotiation, and use `server/discover` capabilities for the declaration. Consider shipping the teaching rules via Skills-over-MCP (`skill://`) as an additional path, falling back to the server-instructions/prompt/digest route for clients without it.
- Conformance: write requirement IDs (one per MUST) from day one and give them a machine-checkable test, MCP's traceability-file idea and cmi5's `@cmi5/requirements`. Black-box tests should run against any URL, not against one SDK.
- Neutrality: separate repo or directory for the reference implementation (like ADL_LRS vs xAPI-Spec; MCP spec vs SDKs). Keep an `IMPLEMENTATIONS.md` that lists others' work. State in GOVERNANCE.md that membership is personal, decisions are public, and that a second independent implementation is needed before 1.0 (W3C-style exit criterion; this is my recommendation, not verified for the other bodies).
- Homes: begin personal org -> consider an IEEE xAPI/cmi5 WG liaison or ADL contact, or the MCP Skills/Education interest group, and 1EdTech's AI community, once there are two implementers. LF-hosted projects need a legal entity and trademark policy; MCP's "Series of LF Projects, LLC" is the template.

---

## 4. IRI/namespace hosting for xAPI profiles

### w3id.org
- Run by the W3C Permanent Identifier Community Group; W3C hosts the software only. HTTPS-only. "Identifiers are intended to last as long as the Web does." https://w3id.org/ ; https://github.com/perma-id/w3id.org
- Process (current README and guide):
  1. Fork perma-id/w3id.org.
  2. Add `ids/<name>/.htaccess` (minimal `RewriteEngine on` + `RewriteRule`), optional `ids/<name>/README.md`, with a maintainer contact that includes a GitHub username (the most common review comment).
  3. Run `node tools/check/bin/w3id-check.js` locally. Automated checks run on every PR; they do not verify where the redirect goes.
  4. Open a PR. One identifier per PR, squashed, descriptive commit message with the project name, only touch your own directory.
  5. A maintainer reviews and merges, live "shortly afterwards".
  https://github.com/perma-id/w3id.org/blob/master/docs/guides/create-an-id.md
- Rules: one top-level directory per project (lowercase letters, digits, hyphens), avoid generic names; target must already be live over HTTPS (a dead target is treated as a permanent broken link); 302 default, 303 for content-negotiated ontology IRIs, avoid 301; do not point to `github.com/.../blob/...`; the service redirects only and does not host files. Email alternative: public-perma-id@w3.org with the desired URL, target, status code, contact. https://github.com/perma-id/w3id.org/blob/master/docs/faq.md
- Turnaround: no SLA ("varies with maintainer availability"). My measurement from the GitHub API on 2026-10-27, last 57 merged PRs: median 7.3 hours, p90 47.7 hours, max 134.8 hours from open to merge. Merge activity is continuous (PR number 7001 merged 2026-10-27). This is not specific to new-namespace PRs.
- Practice for profiles: ADL registered `ids/xapi` (contact: ADL, andy.johnson.ctr@adlnet.gov / support@adlnet.gov, backup Jason Haag). The `.htaccess` there sends ontology and statement-context requests to adlnet.github.io/xapi-ontology and profile paths (`/xapi/<profile>/...`) to https://tools.xapi.ly/profiles/ with 303s. So `https://w3id.org/xapi/cmi5/context` currently 303s to `tools.xapi.ly/profiles/` (verified by fetch and HEAD 2026-10-27; HEAD of `/xapi/cmi5/context` and `/xapi/adl/verbs/satisfied` on w3id returned 404 from curl, so the pattern is not uniform, treat the live resolution as fragile).
- Recommendation: register a dedicated `ids/learning-mcp/` (or an agreed short name) rather than putting profile IRIs under `/xapi/`, because `/xapi/` belongs to ADL. Point it at a stable host you control (GitHub Pages or a domain), serve the JSON-LD with `Access-Control-Allow-Origin: *`, and use 303 for content negotiation like ADL does. Owning your own subdomain or domain is the alternative if long-term custody is a concern; w3id gives neutrality when the spec is handed to a community.

### ADL profile server and tooling (state in 2026)
- adlnet/profile-server: archived, last push 2025-11-14. Described as a React + Express + MongoDB app to "create profiles, link vocabularies semantically, persist identifiers, and provide lookup services". https://github.com/adlnet/profile-server (API: archived true)
- adlnet/xapi-authored-profiles (profiles for acrossx, adl, cmi5, scorm, tincan, video, virtual-patient, Profile_Server_Profiles): archived read-only, last push 2025-11-17. https://github.com/adlnet/xapi-authored-profiles
- ADL authoring guide (via search; adlnet.gov not fetchable): the server validates a JSON-LD profile against the profiles spec, hosts profiles and offers lookup. https://adlnet.gov/guides/xapi-profile-server/authoring-guide . The hosted instance's URL: `tools.xapi.ly/profiles/` (HTTP 200, 716-byte page, content not captured). Gap: whether this hosting is run by ADL, Yet Analytics, or another party; and whether it is a supported long-term service. Treat as unconfirmed.
- Validators available now:
  - project-pan (Yet Analytics, Clojure, validates whole profiles; 0.5.4 per cljdoc) https://github.com/yetanalytics/project-pan
  - project-persephone (Yet Analytics, validates Statements against a profile, Docker image `yetanalytics/persephone`, 0.9.1) https://cljdoc.org/d/com.yetanalytics/project-persephone/0.9.1
  - UNC Veracity profile validator web tool, v1.12.7 https://veracity.fpg.unc.edu/ui/tools/xapi-profile-validator
  - Yet Analytics DATASIM + ADL webinar from 2021 (profile test data) https://adlnet.gov/webinars/20210721-Designing-and-Testing-xAPI-Profiles-Using-the-xAPI-Profile-Server-and-DATASIM
  - Dates for validators come from cljdoc and tool pages, not from recent release checks. Check currency before wiring into CI.
- Profile spec status: IEEE P9274.2.1 draft in opensource.ieee.org/xapi/xapi-profiles (active 2026-03-09); ADL's xapi-profiles README flags "spec review / upgrade in progress" and the current published version is 1.0. Pin to profile spec 1.0 and watch for 2.0.

---

## 5. Licensing norms

Observed (verified):
| Project | Spec text | Code | Other docs | Patent / IP | Source |
|---|---|---|---|---|---|
| MCP | Apache-2.0 for new spec contributions (project transitioning from MIT; unconsented older contributions stay MIT) | Apache-2.0 | CC BY 4.0 for documentation excluding specs | Contributors keep copyright, no assignment; Apache-2.0 patent grant; LF Projects policies; ANTITRUST.md; SEP text is CC0/public domain | https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/LICENSE ; https://modelcontextprotocol.io/community/governance ; https://modelcontextprotocol.io/community/sep-guidelines |
| xAPI (ADL repo and IEEE repos) | Apache-2.0 | Apache-2.0 | n/a | Apache-2.0 patent grant (IEEE repos; IEEE SA Open terms not verified) | https://github.com/adlnet/xAPI-Spec ; https://opensource.ieee.org/xapi/xapi-base-standard-documentation |
| cmi5 | Apache-2.0 | n/a (CATAPULT Apache-2.0; @xapi/cmi5 MIT) | n/a | Apache-2.0 | https://github.com/AICC/CMI-5_Spec_Current ; https://github.com/adlnet/CATAPULT |
| OpenAPI | Apache-2.0 (stated inside the spec document) | Apache-2.0 | n/a | Apache-2.0 | https://raw.githubusercontent.com/OAI/OpenAPI-Specification/main/versions/3.2.0.md |
| ActivityPub | W3C Document License (no republishing as a competing spec; derivatives for implementation allowed); code examples under W3C Software License | W3C Software and Document License in repo | n/a | W3C Patent Policy: royalty-free commitments from WG participants | https://www.w3.org/copyright/document-license-2023/ ; https://www.w3.org/TR/activitypub/ |

Reading of the norm (analysis, not verified against a licensing source):
- The tech-industry comparators converged on Apache-2.0 for spec text because it carries an explicit patent grant and permits implementation, forks, and derived specs. All four non-W3C comparators use it for the spec. CC BY 4.0 appears for prose that is not a specification (MCP docs). CC BY-SA 4.0 is not used by any comparator found; its share-alike term would bind implementations that embed spec text or schemas, which cuts against being an implementable standard. Note that Creative Commons itself advises against CC licences for software, and CC BY 4.0 grants no express patent licence (the CC 4.0 licences say patent rights are not licensed). For schemas, profile JSON-LD and conformance tests, treat them as code: Apache-2.0. For the prose spec, either Apache-2.0 (MCP/OpenAPI/xAPI precedent, includes a patent grant, one licence across the repo) or CC BY 4.0 (plus a separate patent non-assert) are defensible; Apache-2.0 is the lower-friction choice and is what the neighbours use.
- If you want W3C-like strength (no forks that call themselves the standard), reserve the name via a trademark policy rather than a restrictive copyright licence; MCP delegates trademark guidance to LF Projects policies. OWF (Open Web Foundation) patent terms are not used by any of the comparators; I did not research OWF/Community Specification License further. Gap.
- Reference implementation and conformance tests: Apache-2.0 (CATAPULT, MCP conformance, ADL_LRS). The learning-mcp reference code license is whatever the repo says today; I did not audit it.
- Practical: keep one SPDX identifier per directory, add a DCO or CLA-free "contributors keep copyright" statement like MCP, and add a patent-grant statement (Apache-2.0 §3) so implementers in regulated or government settings (ADL's audience) are comfortable.

---

## Open gaps worth a follow-up
- Real IEEE P9274.3.1 and cmi5 2.0 status (ADL working-group page unreachable).
- An authoritative list of cmi5-conformant LMSs.
- Whether `tools.xapi.ly` is a durable host for ADL-authored profiles.
- 1EdTech's progress after 2025-10-23 and whether the effort publishes a spec or a profile.
- MCP 2026-07-28 effect on session-based designs in the current learning-mcp code (not checked, outside this brief).
