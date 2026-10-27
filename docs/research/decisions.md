# Decisions from Derin (owner), 2026-10-27

These are the owner's decisions from conversation. Anything not listed here is the builder's call and must be marked as such in a design.

## The four pieces
1. **course-xapi-mcp** — an open standard. Renamed from "learning-mcp" (repo /Users/cedarstone/Projects/learning-mcp, GitHub derintolu/learning-mcp, private). The owner's words: "an open spec to create an MCP server for any course so course creators can create courses that people can do within their own LLM account."
2. **A WordPress LRS plugin** — open source, standalone, usable by any xAPI client, learning-mcp or not.
3. **LMS integrations inside that same plugin** — Sensei LMS first, then "all major WordPress LMS plugins" (LearnDash, LifterLMS, Tutor LMS, LearnPress, MasterStudy…).
4. **The prototype** — Learn WordPress Reimagined (/Users/cedarstone/Projects/learn-wp-reimagined) rebuilt to use the standard, the plugin and Sensei.
Order: the standard and the plugin can be designed and built in parallel; the prototype comes last.

## The standard (course-xapi-mcp)
- It is a standard "like xAPI": implementation-neutral and unopinionated about how courses are authored or hosted. Courses "can be built many different ways… it can take many shapes."
- Course authors mostly don't code: they are expected to ask their own LLM to convert an existing course and make it course-xapi-mcp accessible. So the spec must be legible to agents (an authoring guide an agent can follow, a validator with fixable errors).
- **Built on cmi5.** A course-xapi-mcp course is a valid cmi5 course package with a namespaced extension for what cmi5 lacks (beats, checkpoints, branches, rubrics, deterministic checks, planted bugs, placement, teaching rules). Research: scratchpad/cmi5-fit.md (mapping table, conflicts C1–C4 with options, sample cmi5.xml, LMS-launched "mode B" bridge).
- Published as an **MCP extension**, identifier `org.appsurd/course-xapi-mcp` (MCP's SEP-2133 extension scheme; `io.modelcontextprotocol/skills` is the closest model for shipping teaching rules). Research: scratchpad/standards-prior-art.md (repo structure, versioning, governance models, MCP 2026-07-28 statelessness).
- **Record custody: the course author chooses; the standard offers options.** The LMS or LRS is normally the primary owner "so the learner cannot alter the record themself." The earlier learner-owned record was only "for ease of operation" so the server needn't store anything. Approved option set (owner said "everything sounds correct" to the draft):
  1. LMS-launched (official record in the LMS's LRS via cmi5 launch) — badges yes
  2. Author's LRS (e.g. our WordPress LRS plugin) — badges yes
  3. Server-kept (the course server keeps the record itself) — badges yes, signed by the course server
  4. Practice (no official record; learner may export an unofficial copy) — no badges
  Rules for all: the course declares its option and the server tells the agent; the learner's agent can never write or replace the official record (today's `link_record` must be removed or restricted); in 1–3 the learner can always view/export their record; badges link only to the earning statement; option 4 is clearly labelled.
- **Badges: Open Badges 3.0** built in. The standard defines when a badge is earned (cmi5 AU moveOn met / block satisfied / course satisfied) and what it contains; it references OB 3.0 (whose licence forbids derivative copies) rather than copying it. Research: scratchpad/open-badges.md (eddsa-rdfc-2022 + Ed25519 + did:web + Bitstring Status List; no OB 2.0 for now; ADL's xAPI Open Badges profile verb `earned`; privacy: never put the xAPI actor id in a badge; evidence = urn:uuid of the earning statement + narrative).
- **Licence: same as the standards it builds on** → Apache-2.0 for the spec text, schemas, profile, conformance suite and the reference implementation (relicensing from today's GPL-2.0-or-later code and CC BY-SA docs; the owner owns all of it).
- **Web address: a subdomain of appsurd.org** (owner: "hosted on appsurd.org. We can create subdomains on that domain"). Proposed and accepted with the name: `https://course-xapi-mcp.appsurd.org/` for the spec site, the xAPI profile and every permanent IRI. Replaces the unregistered w3id.org/learning-mcp IRIs. The domain must stay renewed as long as records exist.
- Existing work to build on: learning-mcp's docs/spec.md, RULES.md, rules/AGENT_RULES.md, profile/xapi-profile.jsonld, docs/xapi-profile.md, docs/STATUS.md (21 decisions, 9 open questions), packages/core and packages/server (102 tests), the plan-b-fixes branch (unmerged). Open questions now answered: IRIs (appsurd.org), licence (Apache-2.0), name (course-xapi-mcp), record migration for the prototype (the prototype moves to the standard), going public (yes, it's an open standard; timing is the builder's call to propose). Still open from STATUS: account linking (largely superseded: the LMS/LRS assigns the actor), strictness (reveal_bug / skip path), statement attestation (smaller now: only for learner copies), ChatGPT plan support (test).

## The WordPress plugin (LRS + LMS integrations)
- Licence GPL-2.0-or-later (same as WordPress).
- **One plugin, two roles, both possible on one install:**
  - **LRS role** — stores the official xAPI record, answers xAPI queries, signs Open Badges 3.0 badges. **Recommended to run on a separate WordPress install**, because "it will have a ton of records and can slow down a site."
  - **LMS connector role** — on the site running the LMS; sends the site's own learning to the LRS as xAPI and applies results from the LRS back into the LMS.
- **LMS integrations are not separate plugins.** "It should just activate those files if Sensei is present. We'll do the same for all major WordPress LMS plugins." One shared interface; Sensei first.
- For Sensei, all four directions are in scope ("All 4 should be possible"): (1) agent results → Sensei progress; (2) Sensei on-site learning → LRS as xAPI; (3) identity matching xAPI actor ↔ WordPress user; (4) Sensei courses become course-xapi-mcp courses (the course-xapi-mcp parts are attached to Sensei lessons via blocks/fields provided by the integration).
- How the LRS informs the connector was proposed as a notification (webhook) with a periodic catch-up poll; the owner accepted the playback ("everything sounds correct"); exact mechanism remains the builder's call.
- No usable WordPress LRS exists today (research: scratchpad/lrs-options.md): ours would be the only maintained open-source one. cmi5 needs Statements (incl. voiding), State, Agent Profile; Activity Profile optional. Run ADL's lrs-conformance-test-suite and publish results honestly; attachments may be cut for the prototype. No WordPress plugin signs OB 3.0 badges (BadgeOS, WPBadger, OBF plugin closed; myCred unsigned 2.0) — ours issues them. PHP JSON-LD/RDF canonicalisation libraries are immature; test against W3C vectors.
- **Runs on Spacefast, proven:** a claimed Spacefast space has WordPress 7.1.3 / PHP 8.5.12 on WP Cloud (Atomic). Custom plugins install via Spacefast's WP-CLI endpoint `POST /v1/spaces/{id}/wp-cli` with `["plugin","install","<zip URL>","--activate","--force"]` (zip published as a file of the space, fetched via a share link). Plugins survive republishing. `eval`, `eval-file`, `shell`, `core version` are disallowed; WP-CLI returns success/failure only. Research: scratchpad/spacefast-platform.md and the spike notes in scratchpad/sf-spike/. Unverified: sodium in that PHP; `/.well-known/did.json` reaching WordPress; Sensei installing there.

## The prototype
- Mirrors the recommended setup with **two separate Spacefast spaces**:
  1. **Learn WordPress Reimagined** (existing space `learn-wp-reimagined`): the app, the course-xapi-mcp course server (Spacefast Functions), and the space's built-in WordPress running **Sensei** with the plugin in **connector** role, like a real Learn site.
  2. **The LRS** (a new space): WordPress with the plugin in **LRS** role only.
- **Rebuild with Sensei as the backend** ("keep the look of the current prototype and use Sensei as much as we can… we are building adaptive learning paths with branching which Sensei may not support, so maybe we just use Sensei as a backend"):
  - Keep the current studio look and experience: outline, conversation, live WordPress Playground preview, placement, AI tutor.
  - Sensei owns what it already does: courses and lessons (titles, order, content), enrolment, WordPress user accounts, lesson/course completion feeding Sensei's own progress and certificates.
  - Our layer owns what Sensei can't: adaptive placement and branching, beats/checkpoints/rubrics/checks/planted bugs (attached to Sensei lessons through the plugin's Sensei integration), the tutor, and course-xapi-mcp for learners' own agents.
  - Official xAPI record and badges go to the separate LRS space (record option 2).
  - A lesson skipped by branching shows in Sensei as complete but marked "tested out" (cmi5 "waived") — proposed, builder to confirm what Sensei allows.
- The three existing paths (Block theme, Learner, Vibe coder; 6 lessons each, content in content/paths/*.yaml, accuracy docs in docs/) carry over; only their format and home change.
- Plan C of the prototype is complete on main (see docs/superpowers/plans/2026-10-22-plan-c-paths-pages-launch.md). Four docs there are still uncommitted pending owner approval.

## Global rules (owner's)
- Commit to `main` and push to `origin/main` immediately after each commit; never push to `production` unless told; never a local `production` branch.
- Browser verification uses the agent-browser CLI only; never Puppeteer or Playwright.
- Documentation files are shown to Derin before they are committed.
- No emojis. Concise. Don't over-engineer.
- Never modify WPO365 or OAuth/SSO settings.

## Owner answers, 2026-10-27 (round 2) — binding, supersede anything above
- **Domain changed: sqwrlz.com replaces appsurd.org everywhere.** Spec site, xAPI profile and all permanent IRIs: `https://course-xapi-mcp.sqwrlz.com/`. MCP extension identifier: `com.sqwrlz/course-xapi-mcp`. LRS and badge issuer host: `lrs.sqwrlz.com` (pointed at the LRS Spacefast space).
- Accepted all controller recommendations:
  1. Prototype learners get an anonymous WordPress user (no email) on their first recorded action; optional "keep my progress" via email magic link later.
  2. Anonymous learners deleted after 180 idle days.
  3. Learners' free-text answers are kept in the official record.
  4. GDPR erase deletes the learner's official statements and revokes their badges.
  5. Building our own MCP authorization (OAuth) server for agent sign-in is approved; it does not touch any existing SSO/WPO365 configuration.
  6. Tested-out (waived) lessons count toward path badges; the badge narrative states how many.
  7. Custody option 1 with an LMS that can't issue OB 3.0: the course server signs badges from what the LMS accepted (standard's Q1 option a).
  8. Install Sensei LMS Certificates in the prototype: PDF certificate alongside the badge.
  9. LRS address `lrs.sqwrlz.com`.
  10. Badge issuer name for the prototype: "Learn WordPress, reimagined".
  11. Plugin name "Learning Ledger", slug `learning-ledger` (so block names are `learning-ledger/*`).
  12. Plugin repo `derintolu/learning-ledger` on GitHub, public from the first commit.
  13. Rename learning-mcp to course-xapi-mcp; public at the first draft milestone, before the prototype writes its first official record.
  14. Submit the plugin to wordpress.org after the first release that passes the cmi5-relevant ADL conformance tests.
  15. Governance: Derin is sole editor until a second independent implementation exists; then seek a neutral home (IEEE LTSC or an MCP interest group).
  16. Sensei's own pages are visible in the prototype, labelled "the backend view".
  17. Content is edited in wp-admin; a content snapshot committed to git is the reviewable record.
  18. LMS integrations after Sensei: LifterLMS, Tutor LMS, LearnPress (no LearnDash for now).
  19. Strictness: keep verbatim replies required; add a recorded `reveal_bug` after 3 failed fix attempts.
  20. No statement attestation in 1.0; badges are the portable proof.
  21. ChatGPT test: Derin has ChatGPT Pro; once a public course-server URL exists, Derin signs in once in an agent-browser window and the agent runs the developer-mode connector test, then removes the connector.
- Controller rulings in reconciliation.md (same folder) apply to all three designs; #14 is confirmed by answer 5.

## Owner answers, 2026-10-27 (round 3)
- **Learning Ledger v1 includes a cmi5 player for Sensei** (the LMS side of cmi5): import any cmi5 package into Sensei, launch its AUs (launch URL, one-time auth-token fetch, LMS.LaunchData state, launched/waived/satisfied/abandoned statements, moveOn evaluation, session handling, returnURL), mark Sensei lessons/courses complete when cmi5 says so, and test against CATAPULT's LMS test suite. It is part of the connector role and switches on when Sensei is present (no separate plugin). This reverses reconciliation ruling 8: Learning Ledger IS the option-1 LMS side for Sensei sites in v1.
- Build approach: parallel agents per independent part once interfaces are fixed (estimate ~1 extra day elapsed for the player; the whole plugin 2-3 days elapsed).
