# course-xapi-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn learning-mcp into course-xapi-mcp: an Apache-2.0 open standard (spec text, schemas, xAPI profile, conformance suite) for courses that are cmi5 packages taught over MCP, with a reference implementation covering all four record-custody options, Open Badges 3.0 and the cmi5 launch bridge.

**Architecture:** One repo, separate top-level layers: `spec/` and `schema/` and `profile/` (normative), `conformance/` (requirements normative, test code informative), `reference/packages/*` (TypeScript reference: `core`, `lrs-client`, `bridge`, `badges`, `server`, `validator`), `docs/` and `examples/` (informative), `site/` (static build for `https://course-xapi-mcp.sqwrlz.com/`). `core` stays pure (package model, branch engine, checks, cmi5-shaped statement builders, an AU-session state machine over a `LearnerState`); the server composes it with one `Custody` adapter per option, its own OAuth 2.1 authorization server, the bridge and the badge issuer.

**Tech Stack:** Node with `--experimental-strip-types`, TypeScript 7.0.2 (`strict`, `erasableSyntaxOnly`), Vitest 5.0.5, zod 4.6.7, `@modelcontextprotocol/server` and `/client` 2.3.1, `jose` (JWT), `openid-client` (OIDC), `fflate` (ZIP), `fast-xml-parser` (cmi5.xml), `xmllint-wasm` (XSD), Digital Bazaar VC libraries (`eddsa-rdfc-2022`), `@cmi5/requirements`, `yaml`, `marked` (site).

**Spec:** `docs/superpowers/specs/2026-10-27-course-xapi-mcp-design.md` (cited below as "design §n"). Owner decisions: `docs/research/decisions.md` and `docs/research/reconciliation.md` once Task 2 copies them in.

## Global Constraints

- Repo `/Users/cedarstone/Projects/learning-mcp` (local folder keeps its name). GitHub repo renamed to `derintolu/course-xapi-mcp` in Task 2.
- Work on `main`. Every commit step is `git add <files> && git commit -m "<message>" && git push origin main`, pushed immediately. Never push to `production`; never create a local `production` branch.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Documentation files (`*.md` under `spec/`, `docs/`, root governance files, README) are shown to the owner as a complete diff and committed only after approval. The controller handles this; a doc task ends at "diff ready".
- Licence: Apache-2.0 everywhere. First line of every `.ts`/`.mjs`/`.js` source: `// SPDX-License-Identifier: Apache-2.0`. Every `package.json`: `"license": "Apache-2.0"`.
- npm scope `@course-xapi-mcp/*`. All third-party dependencies are installed in Task 4 with `--save-exact`; no later task runs `npm install <pkg>` (parallel tasks would collide on `package-lock.json`). If a later task needs a new dependency, it stops and reports.
- Permanent IRI base `https://course-xapi-mcp.sqwrlz.com`. MCP extension id `com.sqwrlz/course-xapi-mcp`. cmi5 XML namespace `https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd`; cxm namespace `https://course-xapi-mcp.sqwrlz.com/course/v1`, prefix `cxm`.
- Draft version: `SPEC_VERSION = '0.2'`. Package `specVersion`, extension settings `version`, `rulesVersion` and the profile version IRI `/xapi/v0.2` all use it.
- MCP 2026-07-28, stateless: no reliance on MCP sessions; identity per request from the bearer token (options 1-3) or the `handle` argument (practice). 2025-era clients served through `createMcpHandler`'s default stateless legacy path.
- Statements valid under xAPI 1.0.3 and 2.0; never `version`, `contextAgents`, `contextGroups`; actors the course server mints never carry `mbox`, `mbox_sha1sum`, `openid` or `name` (option 1 actors are copied verbatim from the LMS, see Task 6).
- The server never calls a model. No tool accepts statements, records, actor ids or registrations, except `resume_practice`, which accepts only a practice copy. No LRS/LMS credential, token, actor account name or registration appears in any agent-visible result except inside the learner's own export.
- Planted-bug `explanation`, `fixChecks` and `referenceSolution` are never sent to the agent before `caught` or `revealed`.
- Normative files (`spec/`, `schema/`, `profile/`, `conformance/requirements/`) never name a reference package.
- Fixed values: AU session idle timeout 30 min (1 800 000 ms); option-1 session cap 50 min after token fetch (3 000 000 ms); `revealAfter` default 3; pairing code 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, single use, 10 min; practice relay TTL 30 days; status list length 131 072; recipient salt 16 random bytes; access token 3600 s; refresh token 30 days; authorization code 60 s.
- Browser checks use the `agent-browser` CLI only. Never Puppeteer or Playwright; never drive Chrome headless by hand.
- Never modify WPO365 or any existing SSO/OAuth configuration. The authorization server in Task 17 is new code in this repo and touches nothing else.
- No emojis. Tests: `npm test` (all), `npx vitest run <file>` (one), `npm run typecheck`.
- Legacy modules `reference/packages/core/src/{schema,session,record,store,xapi}.ts`, `reference/packages/server/src/{server,dir-store}.ts` and their tests keep compiling and passing until Task 22 deletes them. Earlier tasks add new modules beside them and edit them only where the task says so.
- Requirement IDs: `CXM-PKG-NNN` (package; equal to validator error codes), `CXM-SRV-NNN` (server), `CXM-CUS-NNN` (custody), `CXM-BRG-NNN` (cmi5 binding and bridge), `CXM-BDG-NNN` (badges), `CXM-SEC-NNN` (security and privacy). A conformance test that proves a requirement starts its name with `[<ID>]`.

## Review Focus

1. **Several statements built in one tool call share a millisecond.** cmi5 orders by `timestamp`, so `passed` and `terminated` with equal timestamps are ambiguous. Expect strictly increasing timestamps within a step (+1 ms each). Test in Task 14; checked by `checkCmi5Order` (Task 6).
2. **Two agent tabs call tools for the same learner at once.** Expect one call to win and the other to get "the record was changed by another call at the same time; call this tool again", with no duplicate defined statement. Tests in Task 15 (store conflict), Task 16 (412 from the State API) and Task 22 (parallel `next_beat`).
3. **The record holder (LRS or LMS) is down or slow during a call.** Expect a tool error, the step's statements kept in `state.outbox` and redelivered by statement id on the next call, and nothing lost or duplicated. Tests in Task 16 (fault injection) and Task 22.
4. **The course package is updated while a learner is mid-lesson** (a lesson removed or renamed, version bumped). Expect a clear error naming `choose_placement`, any open AU session closed with `terminated`, and no defined statement for a lesson the course no longer has. Test in Task 14.
5. **Option 1: the learner relaunches from the LMS, or the AU token expires.** Expect calls bound to the abandoned launch to answer "this lesson was relaunched elsewhere", nothing written to the LMS after `terminated`, and the sweeper terminating before the 50-minute cap. Tests in Task 16 and Task 18.

---

## Waves

Tasks in the same wave touch disjoint files and may run in parallel. A wave starts when every earlier wave is merged and `npm test` and `npm run typecheck` pass on `main`.

- **Wave 0 (sequential):** 1, then 2, then 3
- **Wave 1 (shared interfaces, one task):** 4
- **Wave 2:** 5, 6, 7, 8, 9, 10, 11, 12
- **Wave 3:** 13, 14, 15, 16, 17, 18
- **Wave 4:** 19, 20, 21
- **Wave 5:** 22, 24, 25
- **Wave 6:** 23, 26
- **Wave 7:** 27, 28
- **Wave 8:** 29, 30, 31
- **Wave 9 (deferred, needs the owner):** 32

---

### Task 1: Merge `plan-b-fixes` into `main`

**Files:**
- Modify (by merge): `packages/core/src/schema.ts`, `packages/core/src/store.ts`, `packages/core/test/schema.test.ts`, `packages/server/src/server.ts`, `packages/server/test/server.test.ts`

**Interfaces:**
- Produces: `StoreError`, `StoreConflictError` in `packages/core/src/store.ts`; nested relative file names accepted by the `fileName` schema.

- [ ] **Step 1:** `git fetch origin && git merge --no-ff origin/plan-b-fixes -m "Merge plan-b-fixes: nested file names, store errors"`. The branch predates the design commit, so the diff shows the design file as deleted; keep `main`'s copy of `docs/superpowers/specs/2026-10-27-course-xapi-mcp-design.md` if git reports a conflict.
- [ ] **Step 2:** Run `npm test && npm run typecheck`. Expected: all pass (102 tests plus the branch's additions).
- [ ] **Step 3:** `git push origin main`.

### Task 2: Rename and restructure

**Files:**
- Move: `packages/core` to `reference/packages/core`, `packages/server` to `reference/packages/server`
- Modify: `package.json` (name `course-xapi-mcp`, workspaces `["reference/packages/*", "conformance"]`), `tsconfig.json` (include `reference/packages/*/src`, `reference/packages/*/test`, `conformance`, `scripts`, `site`, `examples`), `vitest.config.ts` (include `reference/packages/*/test/**/*.test.ts`, `conformance/lib/test/**/*.test.ts`, `scripts/test/**/*.test.ts`, `site/test/**/*.test.ts`), both package.json files (names `@course-xapi-mcp/core`, `@course-xapi-mcp/server`), every `@learning-mcp/` import, `scripts/*.ts|mjs` paths, `README.md` paths only
- Move to `docs/history/` with a first line `> Superseded by the course-xapi-mcp design (docs/superpowers/specs/2026-10-27-course-xapi-mcp-design.md). Kept as history.`: `RULES.md`, `docs/spec.md`, `docs/STATUS.md`
- Create: `docs/research/` with copies of `cmi5-fit.md`, `standards-prior-art.md`, `open-badges.md`, `lrs-options.md`, `designs/decisions.md`, `designs/reconciliation.md`, and `cmi5src/{cmi5_spec.md,CourseStructure.xsd}` (as `docs/research/cmi5/`) from `/private/tmp/claude-501/-Users-cedarstone-Projects-learn-wp-reimagined/5376001d-2862-4ef6-85e3-26e5bd4cbe50/scratchpad/`
- Modify: the design doc's research citation paths (`scratchpad/...` to `docs/research/...`)

**Interfaces:**
- Produces: the layout every later task uses. `rules/AGENT_RULES.md` stays where it is (Task 10 moves it).

- [ ] **Step 1 (controller):** `gh repo rename course-xapi-mcp --repo derintolu/learning-mcp --yes`, then `git remote set-url origin git@github.com:derintolu/course-xapi-mcp.git` (match the current remote's scheme). Verify with `git ls-remote origin main`.
- [ ] **Step 2:** `git mv` the packages and the history files; copy the research files; update names, imports and configs as listed. Delete `node_modules` and run `npm install` so workspace links use the new names.
- [ ] **Step 3:** Run `npm test && npm run typecheck`. Expected: same test count as after Task 1, all pass. `grep -r "@learning-mcp" --include=*.ts --include=*.json --exclude-dir=node_modules .` prints nothing.
- [ ] **Step 4:** Commit: `chore: rename to course-xapi-mcp; reference/ layout; history and research docs`.

### Task 3: Relicense to Apache-2.0

**Files:**
- Replace: `LICENSE` (Apache-2.0 full text). Delete: `LICENSE-CC-BY-SA-4.0`
- Create: `NOTICE`, `scripts/test/licence.test.ts`
- Modify: every `package.json` (`"license": "Apache-2.0"`), `examples/json-basics/course.json` (`"license": "Apache-2.0"`), every `.ts`/`.mjs` under `reference/`, `scripts/` (SPDX first line), `README.md` (one line under the title: "Versions before commit `<this commit>` were GPL-2.0-or-later (code) and CC BY-SA 4.0 (docs).")

**Interfaces:**
- Produces: `scripts/test/licence.test.ts`, which every later task's new files must satisfy.

`NOTICE` content: `course-xapi-mcp`, `Copyright 2026 Derin Tolu`, the Apache-2.0 notice line, and an attribution paragraph: this work references Open Badges 3.0, copyright 1EdTech Consortium, Inc., used under its licence and not reproduced; the cmi5 CourseStructure.xsd (vendored in Task 5) is copyright ADL / AICC contributors under Apache-2.0.

- [ ] **Step 1: Write the failing test** `scripts/test/licence.test.ts`:

```ts
it('every source file starts with the Apache-2.0 SPDX line', () => {
  for (const f of sourceFiles(['reference', 'scripts', 'conformance', 'site'])) // .ts .mjs .js, excluding node_modules, dist, *.generated.ts
    expect(firstLine(f), f).toBe('// SPDX-License-Identifier: Apache-2.0');
});
it('every package.json is Apache-2.0', () => { for (const p of packageJsons()) expect(p.license, p.name).toBe('Apache-2.0'); });
it('LICENSE is Apache-2.0 and the CC licence file is gone', () => {
  expect(read('LICENSE')).toContain('Apache License\n                           Version 2.0, January 2004');
  expect(exists('LICENSE-CC-BY-SA-4.0')).toBe(false);
});
```

Generated files (`*.generated.ts`) get the SPDX line from their generator script (update `scripts/sync-rules.mjs`'s output prefix), so the test includes them.
- [ ] **Step 2:** `npx vitest run scripts/test/licence.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Make the edits listed under Files.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit (after the owner approves the README/NOTICE diff): `chore: relicense to Apache-2.0`.

### Task 4: Shared contracts, package skeletons and dependencies

**Files:**
- Create: `reference/packages/core/src/constants.ts`, `model.ts`, `state.ts`, `custody.ts`, `issues.ts`, `errors.ts`, `xapi/types.ts`
- Modify: `reference/packages/core/src/store.ts` (re-export `StoreError`, `StoreConflictError` from `errors.ts` instead of defining them), `reference/packages/core/src/index.ts` (add the new modules), `reference/packages/core/package.json` (exports map below, deps), root `package.json` (all scripts later tasks use, so no parallel task edits it: `"schemas": "node --experimental-strip-types scripts/build-schemas.ts"`, `"requirements": "node --experimental-strip-types scripts/check-requirements.ts"`, `"author-skill": "node scripts/sync-author-skill.mjs"`, `"conformance": "vitest run --config conformance/vitest.config.ts"`, `"conformance:reference": "node --experimental-strip-types conformance/run-reference.ts"`, `"site": "node --experimental-strip-types site/build.ts"`)
- Create skeletons (`package.json` + `src/index.ts` containing only the SPDX line and `export {};`): `reference/packages/{lrs-client,bridge,badges,validator}`, `conformance/`
- Test: `reference/packages/core/test/contracts.test.ts`

**Interfaces:**
- Produces (exact names; every later task relies on these):
  - `constants.ts`: `SPEC_VERSION = '0.2'`; `SITE = 'https://course-xapi-mcp.sqwrlz.com'`; `EXTENSION_ID = 'com.sqwrlz/course-xapi-mcp'`; `CXM_XML_NS = SITE + '/course/v1'`; `CMI5_XML_NS`; `PROFILE_ID = SITE + '/xapi'`; `PROFILE_VERSION_IRI = SITE + '/xapi/v0.2'`; `PRACTICE_CATEGORY = SITE + '/xapi/practice'`; `PRACTICE_HOMEPAGE = SITE + '/practice-learner'`; `CXM_VERBS` (`placed`, `branched`, `caught`, `revealed` under `/xapi/verbs/`); `CXM_ACTIVITY_TYPES` (`path`, `beat`, `checkpoint`, `file`, `planted-bug`, `achievement` under `/xapi/activity-types/`); `CXM_EXT` (`branch`, `to`, `rationale`, `checks`, `start-lesson`, `skipped`, `waive-recommended`, `carried-over`, `attempt`, `rules-version`, `custody` under `/xapi/extensions/`); `CMI5` (`categoryCmi5 = 'https://w3id.org/xapi/cmi5/context/categories/cmi5'`, `categoryMoveOn = 'https://w3id.org/xapi/cmi5/context/categories/moveon'`, `extSessionId = 'https://w3id.org/xapi/cmi5/context/extensions/sessionid'`, `extReason = 'https://w3id.org/xapi/cmi5/result/extensions/reason'`, `extMasteryScore = 'https://w3id.org/xapi/cmi5/context/extensions/masteryscore'`); `ADL_VERBS` (`launched`, `initialized`, `completed`, `passed`, `failed`, `terminated`, `experienced`, `answered` under `http://adlnet.gov/expapi/verbs/`; `waived`, `satisfied`, `abandoned` under `https://w3id.org/xapi/adl/verbs/`); `OB_XAPI = { earned: 'http://specification.openbadges.org/xapi/verbs/earned', badgeAssertion: 'http://specification.openbadges.org/xapi/extensions/badgeassertion' }`; `activityIds = { au(auId) => auId + '/au', beat(auId, key), checkpoint(auId, key), file(auId, name), bug(auId, key) }` giving `{auId}/beats/{key}`, `/checkpoints/{key}`, `/files/{encodeURIComponent(name)}`, `/bugs/{key}`; `URIS = { rules: 'course-xapi-mcp://rules/agent', course: 'course-xapi-mcp://course', recordExport: 'course-xapi-mcp://record/export', tutorSkill: 'skill://course-xapi-mcp-tutor/SKILL.md', authorSkill: 'skill://course-xapi-mcp-author/SKILL.md' }`; `PRACTICE_LABEL = 'Practice run: this is not an official record, and it cannot earn badges.'`; `DEFAULTS` holding the fixed values in Global Constraints (`sessionIdleMs`, `lmsSessionMaxMs`, `revealAfter`, `pairingCodeLength`, `pairingAlphabet`, `pairingTtlMs`, `practiceTtlMs`, `statusListLength`, `accessTokenTtlS`, `refreshTokenTtlS`, `authCodeTtlS`); `STATE_IDS = { learner: 'cxm-learner-state', registration: 'cxm-current-registration' }`; `ERROR_HELP_BASE = SITE + '/errors/'`; `TOOL_NAMES` (the 16 names in Task 22's order).
  - `model.ts`: `type CustodyOption = 'lms-launched' | 'author-lrs' | 'server-kept' | 'practice'`; `CUSTODY_OPTIONS`; `Check` (contains/notContains/regex/json, as today); `Source {title, url}`; `Beat {key, goal, content, question?}`; `Branch {key, when, success, to: string | null, message}`; `Checkpoint {key, kind: 'free-text' | 'code', question, rubric, file?, checks?, branches, maxAttempts?}`; `PlantedBug {key, file, code, hint?, revealAfter?: number | null, explanation, fixChecks}`; `ReferenceSolution {files: Record<string, string>, bugFix?: string}`; `LessonModel {key, auId, pathKey, title, description, url, moveOn: 'Completed' | 'CompletedAndPassed', minutes, sources: Source[], beats, starterFiles?, bug?, checkpoint?, referenceSolution?}`; `PathModel {key, blockId?, title, description?, tagline, status: 'live' | 'coming-soon', lessons: string[], placementHints?}`; `PlacementModel {key, auId, url, title, intro, maxQuestions}`; `BadgeDecl {id, name, description, criteria: {narrative}, image?, achievementType, alignment?, awardOn: 'au-moveon' | 'block-satisfied' | 'course-satisfied' | 'any-path', for?: string, countWaived: boolean, includeScore: boolean}`; `BadgeIssuerDecl {signer: 'record-holder' | 'course-server', claimPage: string, name?: string}`; `CourseModel {specVersion, flavour: 'authoring' | 'distribution', id, title, description, mcp, version, language, license?, rules: string[], placement: PlacementModel, custody, allowPractice, badges: BadgeDecl[], badgeIssuer?, paths: Record<string, PathModel>, lessons: Record<string, LessonModel>, extensions?: Record<string, unknown>}`.
  - `state.ts`: `Phase = 'beats' | 'bug' | 'checkpoint' | 'branch' | 'review' | 'done'`; `Placement {pathKey, startLessonKey, skip: string[], reason}`; `Cursor {pathKey, lessonKey, beat, phase, awaitingReply?, review?: {lessonKey, beat}}`; `AuSession {id, auKey, startedAt, lastActivityAt, attempts, launchId?}`; `AuProgress {completed, passed, failed, waived?: 'Tested Out' | 'Administrative', carriedOver, fixAttempts, bug?: 'caught' | 'revealed'}`; `PendingCheckpoint {lessonKey, checkpointKey, checksPassed: boolean | null, allowed: string[]}`; `LearnerState {v: 1, courseVersion, registration, createdAt, updatedAt, placement?, cursor?, session?, au: Record<string, AuProgress>, satisfied: {blocks: string[], course: boolean}, files: Record<string, string>, pending?, outbox: XapiStatement[], awards: {badgeId, statementId}[]}`; `SatisfactionEvent = {type: 'au', lessonKey, statementId, waived: boolean, carriedOver: boolean} | {type: 'block', pathKey, statementId} | {type: 'course', statementId}`.
  - `custody.ts`: `LearnerRef {kind: 'official' | 'practice', subject: string, actor: XapiAgent, handle?: string, launchId?: string}`; `RecordLinks {holder: string, view?: string, export?: string, delete?: string, policy?: string}`; `RecordView {official: boolean, statements: XapiStatement[], receipt?: {id, verb, object, timestamp}[], complete: boolean, note: string}`; `interface Custody { readonly option: CustodyOption; readonly official: boolean; load(l): Promise<{state?: LearnerState, etag?: string}>; save(l, state, etag?): Promise<{etag: string}>; deliver(l, statements): Promise<void>; record(l): Promise<RecordView>; links(l): RecordLinks }` (`save` throws `StoreConflictError` on a lost race; `deliver` throws `StoreError`); `LaunchContext {launchId, endpoint, authToken, tokenFetchedAt, actor, registration, activityId, auId, auKey, contextTemplate, launchMode: 'Normal' | 'Browse' | 'Review', moveOn, returnURL?, sessionId, initializedAt, terminatedAt?, pairingCode, pairingExpiresAt, pairedSubject?}`; `interface LaunchStore { put(c): Promise<void>; get(launchId): Promise<LaunchContext | undefined>; byPairingCode(code): Promise<LaunchContext | undefined>; latestFor(endpoint, actorKey, registration): Promise<LaunchContext | undefined>; update(launchId, patch): Promise<void> }`; `interface AuthServer { routes(req: Request): Promise<Response | undefined>; authenticate(req: Request): Promise<LearnerRef | Response>; browserLearner(req: Request): Promise<LearnerRef | undefined> }`; `BadgeSummary {badgeId, name, earnedAt, claimed: boolean}`; `interface BadgeService { summaries(l): Promise<BadgeSummary[]>; claimPage: string; onAwards(l, awards: Award[]): Promise<void> }`; `Award {badgeId, registration, earningStatementId, testedOut: number}`.
  - `issues.ts`: `Severity = 'error' | 'warning' | 'info'`; `ValidationIssue {code, severity, file, xpath?, pointer?, message, fix, help}` (`help = ERROR_HELP_BASE + code`); `ISSUE_CATALOG: Record<IssueCode, {severity, title, fix}>` with exactly the codes in the table below; `makeIssue(code, at: {file, xpath?, pointer?}, message, fix?): ValidationIssue`.
  - `errors.ts`: `StoreError`, `StoreConflictError` (moved verbatim from plan-b-fixes).
  - `xapi/types.ts`: `XapiAgent` (account form or the LMS-supplied shape), `ActivityRef`, `Activity`, `XapiResult` (+ `duration`, `score`), `XapiStatement` (+ `context.statement`, `contextActivities.other`), `ContextTemplate`, `DefinedVerb`, `AllowedVerb = 'experienced' | 'answered' | 'passed' | 'failed' | 'placed' | 'branched' | 'caught' | 'revealed' | 'earned'`, `ActivityKind = 'course' | 'block' | 'au' | 'path' | 'beat' | 'checkpoint' | 'file' | 'planted-bug' | 'achievement'`.
- Core `package.json` exports: `"."` (`src/index.ts`), `"./xapi"` (`src/xapi/index.ts`, Task 6), `"./package"` (`src/package/index.ts`, Tasks 5 and 13), `"./session"` (`src/session/index.ts`, Task 14), `"./practice"` (`src/practice-record.ts`, Task 15).

Issue catalog (severity e = error, w = warning, i = info):

| Code | Sev | Condition |
| --- | --- | --- |
| CXM-PKG-001 | e | ZIP unreadable, or no `cmi5.xml` at the root |
| CXM-PKG-002 | e | `cmi5.xml` not valid against the cmi5 XSD |
| CXM-PKG-003 | e | `cxm:` elements or attributes not valid against `cxm.xsd` |
| CXM-PKG-004 | e | no `cxm:course`, or `specVersion` major not supported |
| CXM-PKG-005 | e | a `src` reference points at a missing file or JSON Pointer |
| CXM-PKG-006 | e | `cxm/course.json` violates `course.schema.json` |
| CXM-PKG-007 | e | a lesson JSON violates `lesson.schema.json` |
| CXM-PKG-008 | e | duplicate `cxm:key` |
| CXM-PKG-009 | e | `cxm:key` missing on a block or AU, or not `[a-z0-9-]{1,64}` |
| CXM-PKG-010 | e | branch `to` is not a lesson key |
| CXM-PKG-011 | e | branch `to` is in a different path |
| CXM-PKG-012 | e | a live path's block has no AU |
| CXM-PKG-013 | e | moveOn is not `CompletedAndPassed` with a checkpoint / `Completed` without one |
| CXM-PKG-014 | e | secret field in a distribution package |
| CXM-PKG-015 | e | placement AU missing, not first, not `NotApplicable`, or more than one |
| CXM-PKG-016 | e | `course.json#/paths` and the blocks disagree (live path without block, block without path entry, coming-soon path with a block) |
| CXM-PKG-017 | e | checkpoint has duplicate branch keys or no `success: true` branch |
| CXM-PKG-018 | e | code checkpoint lacks `file`, `checks` or a `success: false` branch |
| CXM-PKG-019 | e | duplicate beat keys in a lesson |
| CXM-PKG-020 | e | invalid file name (plan-b-fixes rules) |
| CXM-PKG-021 | e | a regex check does not compile |
| CXM-PKG-022 | e | a check passes on the starter files |
| CXM-PKG-023 | e | a check fails on the reference solution |
| CXM-PKG-024 | e | a fix check passes on the bug code |
| CXM-PKG-025 | e | a fix check fails on `referenceSolution.bugFix` |
| CXM-PKG-026 | e | a `success: false` branch targets a lesson after the current one |
| CXM-PKG-027 | e | authoring package: code checkpoint or bug without `referenceSolution` |
| CXM-PKG-028 | e | AU `url` is not https (`http://127.0.0.1` and `http://localhost` allowed) |
| CXM-PKG-029 | e | an AU, block or course id is not an absolute IRI, or two are equal |
| CXM-PKG-030 | e | `language` not RFC 5646, or `version` not semver |
| CXM-PKG-031 | e | badges declared with custody `practice`, or `allowPractice: true` with custody `practice` |
| CXM-PKG-032 | e | badge invalid: `for` missing/unknown for `au-moveon`/`block-satisfied`, present for `course-satisfied`/`any-path`, or `id` not https |
| CXM-PKG-033 | e | badges declared without `badgeIssuer` |
| CXM-PKG-034 | e | the server was given a distribution package |
| CXM-PKG-100 | i | unknown foreign extension element/attribute or `extensions` key (ignored) |
| CXM-PKG-201 | w | two branches' `when` texts overlap (word-set Jaccard >= 0.8) |
| CXM-PKG-202 | w | regex with nested quantifiers (catastrophic backtracking risk) |
| CXM-PKG-203 | w | beat content over 250 words |
| CXM-PKG-204 | w | content or rules address the agent out of scope |
| CXM-PKG-205 | w | lesson has no sources |
| CXM-PKG-206 | w | `specVersion` minor newer than supported |

- [ ] **Step 1: Write the failing test** `reference/packages/core/test/contracts.test.ts`:

```ts
it('puts every cxm IRI under the site', () => { for (const v of allIris()) expect(v.startsWith(SITE + '/')).toBe(true); });
it('derives activity ids from the publisher AU id', () => {
  expect(activityIds.au('https://e.org/c/l1')).toBe('https://e.org/c/l1/au');
  expect(activityIds.file('https://e.org/c/l1', 'a b.json')).toBe('https://e.org/c/l1/files/a%20b.json');
});
it('has unique issue codes in the reserved ranges, each with a fix', () => {
  for (const [code, e] of Object.entries(ISSUE_CATALOG)) { expect(code).toMatch(/^CXM-PKG-(0\d\d|1\d\d|2\d\d)$/); expect(e.fix.length).toBeGreaterThan(10); }
  expect(makeIssue('CXM-PKG-014', { file: 'cxm/lessons/a.json', pointer: '/bug/explanation' }, 'm').help).toBe(SITE + '/errors/CXM-PKG-014');
});
it('lists 16 tools in order', () => expect(TOOL_NAMES).toEqual(['get_status', 'list_paths', 'start_placement', 'choose_placement', 'get_lesson', 'next_beat', 'check_code', 'reveal_bug', 'submit_checkpoint', 'choose_branch', 'end_session', 'get_record', 'get_badges', 'restart_course', 'resume_practice', 'delete_practice_record']));
```

- [ ] **Step 2:** `npx vitest run reference/packages/core/test/contracts.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Write the contract files (types and constants only, no behaviour beyond `activityIds` and `makeIssue`). Install dependencies with `--save-exact` at their current latest versions: core `fflate fast-xml-parser`; server `jose openid-client`; badges `@digitalbazaar/vc @digitalbazaar/data-integrity @digitalbazaar/eddsa-rdfc-2022-cryptosuite @digitalbazaar/ed25519-multikey @digitalbazaar/vc-bitstring-status-list`; validator `xmllint-wasm @modelcontextprotocol/server zod`; conformance `@modelcontextprotocol/client @cmi5/requirements yaml`; root dev `marked yaml`. Workspace deps between packages use exact `0.2.0` (server depends on core, lrs-client, bridge, badges and, as a dev dependency, conformance; bridge on core and lrs-client; badges, validator and conformance on core); set every package `version` to `0.2.0`. If a package name does not resolve, stop and report.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): shared contracts, issue catalog, package skeletons and dependencies`.

### Task 5: Package schemas: zod, JSON Schema, cxm.xsd

**Files:**
- Create: `reference/packages/core/src/package/schemas.ts`, `reference/packages/core/src/package/index.ts` (exports this task's names; Task 13 appends), `schema/draft/course.schema.json`, `schema/draft/lesson.schema.json`, `schema/draft/cxm.xsd`, `schema/vendor/cmi5/CourseStructure.xsd` (copy of `docs/research/cmi5/CourseStructure.xsd`), `scripts/build-schemas.ts`
- Test: `reference/packages/core/test/package-schemas.test.ts`

**Interfaces:**
- Consumes: `model.ts` types (Task 4).
- Produces: `CourseJsonSchema`, `LessonJsonSchema` (zod); `type CourseJson`, `type LessonJson`; `courseJsonSchema()`, `lessonJsonSchema()` returning JSON Schema 2020-12 objects with `$id` `https://course-xapi-mcp.sqwrlz.com/schema/draft/course.schema.json` and `.../lesson.schema.json`. `scripts/build-schemas.ts` writes them; Task 22 extends it with tool schemas.

`course.json` shape: `{specVersion, flavour, version, language, license?, rules?: string[] (max 20), placement: {intro, maxQuestions 1-10}, custody, allowPractice (default false), paths: Record<key, {tagline, placementHints?} | {status: 'coming-soon', title, tagline}>, badges?: BadgeDecl[], badgeIssuer?, extensions?: Record<IRI-or-reversed-domain, unknown>}`. Lesson JSON: `{minutes, sources?, starterFiles?, beats, bug?, checkpoint?, referenceSolution?, extensions?}`. Titles, descriptions, ids and lesson order are not in JSON (they live in `cmi5.xml`). Both objects are strict except `extensions`. Secret fields carry `"x-cxm-secret": true` in the JSON Schema output (`bug.explanation`, `bug.fixChecks`, `referenceSolution`). Cross-reference rules (duplicates, file names, targets) are not zod refinements; Task 13 reports them with their own codes. `cxm.xsd` (target namespace `CXM_XML_NS`) declares elements `course` (attrs `src`, `specVersion`, `mcp`), `lesson` (`src`), `path` (`src`) and attributes `key`, `role` (enum `placement`).

- [ ] **Step 1: Write the failing tests:**

```ts
it('accepts the minimal course and lesson objects', ...);           // fixtures inline
it('rejects unknown keys outside extensions', () => expect(CourseJsonSchema.safeParse({ ...min, extra: 1 }).success).toBe(false));
it('marks secret fields in the JSON Schema', () => expect(JSON.stringify(lessonJsonSchema())).toMatch(/"explanation":\{[^}]*"x-cxm-secret":true/));
it('matches schema/draft/*.json (run npm run schemas after changes)', () => expect(readJson('schema/draft/course.schema.json')).toEqual(courseJsonSchema()));
it('z.infer of the schemas is assignable to the model fragments', () => { /* compile-time: const _: LessonJson['bug'] = {} as PlantedBug */ });
it('cxm.xsd is well formed and targets the cxm namespace', () => expect(read('schema/draft/cxm.xsd')).toContain('targetNamespace="https://course-xapi-mcp.sqwrlz.com/course/v1"'));
```

- [ ] **Step 2:** `npx vitest run reference/packages/core/test/package-schemas.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the zod schemas (reuse the legacy `CheckSchema`, `fileName` and `text` definitions by copying, not importing), `courseJsonSchema()`/`lessonJsonSchema()` via `z.toJSONSchema(..., { target: 'draft-2020-12' })` plus the `$id` and secret markers, the script, and `cxm.xsd`.
- [ ] **Step 4:** `npm run schemas && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(schema): course and lesson JSON Schemas and cxm.xsd`.

### Task 6: cmi5-shaped xAPI: builders, validators, order checker, profile

**Files:**
- Create: `reference/packages/core/src/xapi/{build.ts,validate.ts,profile-check.ts,cmi5-order.ts,duration.ts,templates.ts,profile.ts,index.ts}`, `profile/CHANGELOG.md`
- Modify: `scripts/build-profile.ts` (import from `xapi/profile.ts`), `profile/xapi-profile.jsonld` (regenerated)
- Delete: `reference/packages/core/src/profile.ts`, `reference/packages/core/test/profile.test.ts` (remove the `profile.ts` line from `src/index.ts`)
- Test: `reference/packages/core/test/xapi-build.test.ts`, `xapi-validate.test.ts`, `cmi5-order.test.ts`, `xapi-profile.test.ts`

**Interfaces:**
- Consumes: Task 4 `constants.ts`, `xapi/types.ts`, `CustodyOption`.
- Produces:
  - `interface Cmi5Context { actor; registration; sessionId; courseId; language; rulesVersion; custody: CustodyOption; practice: boolean; platform?; contextTemplate?: ContextTemplate }`
  - `buildDefined(c, verb: DefinedVerb, target: {au: {publisherId, activityId}} | {blockId} | {courseId}, o: {id, timestamp, duration?, reason?: 'Tested Out' | 'Administrative', success?, completion?, extensions?}): XapiStatement`
  - `buildAllowed(c, verb: AllowedVerb, object: {id, kind: ActivityKind, name}, parent: {publisherId, activityId}, o: {id, timestamp, result?}): XapiStatement`
  - `buildEarned(c, achievement: {id, name}, credentialId, earningStatementId, o: {id, timestamp}): XapiStatement`
  - `isoDuration(ms: number): string` (`isoDuration(12345) === 'PT12.345S'`, `isoDuration(3723000) === 'PT1H2M3S'`)
  - `validateStatement(s: unknown): string[]` (legacy rules, plus `result.duration` ISO 8601, `result.score`, `context.statement` StatementRef, `contextActivities.other`; an actor may be any xAPI Agent IFI; minted actors are checked in `checkProfile`)
  - `checkProfile(s: XapiStatement, o?: {lmsActor?: boolean}): string[]` against `TEMPLATES`
  - `checkCmi5Order(statements: XapiStatement[]): Cmi5Problem[]`, `Cmi5Problem {rule: string, statementId: string, message: string}`
  - `TEMPLATES: {verb: DefinedVerb | AllowedVerb, object: ActivityKind, kind: 'defined' | 'allowed' | 'badge'}[]`
  - `buildProfile(): object` (xAPI Profiles 1.0 JSON-LD, `id = PROFILE_ID`, version `PROFILE_VERSION_IRI`)

Rules the builders enforce (design §10.3; cmi5 §9.5, §9.6): every statement has `registration`, the `sessionid`, `rules-version` and `custody` context extensions, and contextActivities grouping `[publisherId, courseId]` merged with `contextTemplate` when given. Defined: cmi5 category; object is the AU activity id (block or course id for `satisfied`); moveOn category when the result has `success` or `completion`; `duration` required on completed/passed/failed/terminated/abandoned; `success: true` on passed and waived, `false` on failed; `completion: true` on completed and waived; `reason` extension required on waived. Allowed: `PROFILE_VERSION_IRI` category, never the cmi5 category; parent is the AU activity id. Practice: add `PRACTICE_CATEGORY` to every statement. `earned`: object kind `achievement`, result extension `OB_XAPI.badgeAssertion = {"@id": credentialId}`, `context.statement = {objectType: 'StatementRef', id: earningStatementId}`, category `PROFILE_VERSION_IRI`. `checkProfile` rejects minted actors carrying `mbox`, `mbox_sha1sum`, `openid` or `name` unless `lmsActor: true`; minted actors use `PRACTICE_HOMEPAGE` in practice and the course id as `homePage` otherwise.

`checkCmi5Order` rules (cite the cmi5 section in `rule`, and the `@cmi5/requirements` id where one exists): per session `initialized` first and `terminated` last (defined and allowed); no defined verb twice in a session; at most one of passed/failed per session; nothing after `terminated` in a session; per registration and AU at most one `completed` and one `passed`, and no `failed` after `passed`; timestamps strictly increasing within a session; `launched` (when present) precedes `initialized`.

- [ ] **Step 1: Write the failing tests:**

```ts
// xapi-build.test.ts
it('defined passed has cmi5 + moveOn categories, AU object, duration, success true', () => {
  const s = buildDefined(ctx, 'passed', { au: { publisherId: AU, activityId: AU + '/au' } }, { id, timestamp, duration: 'PT1M' });
  expect(cats(s)).toEqual(expect.arrayContaining([CMI5.categoryCmi5, CMI5.categoryMoveOn]));
  expect(s.object.id).toBe(AU + '/au'); expect(s.result).toMatchObject({ success: true, duration: 'PT1M' });
  expect(s.context.extensions[CMI5.extSessionId]).toBe(ctx.sessionId);
});
it('allowed statements carry the profile version category and never the cmi5 category', ...);
it('practice statements carry the practice category', ...);
it('waived requires a reason and has success and completion true', ...);
it('earned refers to the earning statement and the credential id', ...);
it('merges the LMS contextTemplate and keeps the publisher id in grouping', ...);
// xapi-validate.test.ts: keep the legacy "rejects" cases; add: bad duration 'P1X' rejected; 'version' rejected; minted actor with mbox rejected by checkProfile; same actor accepted with { lmsActor: true }
// cmi5-order.test.ts
it('flags failed after passed in a registration', () => expect(rules(checkCmi5Order([init, passed, term, init2, failed, term2]))).toContain('9.3.5'));
it('flags equal timestamps within a session', ...);
it('flags any statement after terminated in the same session', ...);
it('accepts initialized, allowed..., completed, passed, terminated', () => expect(checkCmi5Order(goodSession)).toEqual([]));
// xapi-profile.test.ts: legacy profile tests ported (matches profile/xapi-profile.jsonld; required properties; one template per TEMPLATES entry; every concept IRI under SITE or ADL/cmi5/OB)
```

- [ ] **Step 2:** Run the four files. Expected: FAIL.
- [ ] **Step 3:** Implement the modules; regenerate the profile with `npm run profile`; write `profile/CHANGELOG.md` with the v0.2 changes from design §10.4.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS (legacy `xapi.test.ts` still passes against legacy `xapi.ts`).
- [ ] **Step 5:** Commit: `feat(xapi): cmi5-shaped statements, order checker, profile v0.2 at sqwrlz.com`.

### Task 7: LRS client (xAPI 1.0.3 and 2.0)

**Files:**
- Create: `reference/packages/lrs-client/src/{client.ts,cmi5-fetch.ts,index.ts}`
- Test: `reference/packages/lrs-client/test/client.test.ts` (uses a local stub `fetch`, not Task 8's LRS)

**Interfaces:**
- Consumes: `XapiStatement`, `XapiAgent`, `StoreError`, `StoreConflictError` (Task 4).
- Produces:
  - `createLrsClient(o: {endpoint: string, auth: {type: 'basic', key: string, secret: string} | {type: 'token', value: string}, version?: '1.0.3' | '2.0.0' | 'auto', fetch?: typeof fetch, timeoutMs?: number}): LrsClient` (default `version: 'auto'`, `timeoutMs: 10000`)
  - `interface LrsClient { version(): Promise<'1.0.3' | '2.0.0'>; putStatement(s): Promise<void>; postStatements(list): Promise<void>; getStatements(q: {agent?, verb?, activity?, registration?, since?, limit?}): Promise<XapiStatement[]>; getState(k: {activityId, agent, registration?, stateId}): Promise<{body: unknown, etag?: string} | undefined>; putState(k, body, cond?: {ifMatch?: string, ifNoneMatch?: '*'}): Promise<{etag?: string}>; getAgentProfile(agent, profileId): Promise<unknown | undefined> }`
  - `fetchAuthToken(fetchUrl: string, f?: typeof fetch): Promise<string>`; `class Cmi5FetchError extends Error { code: '1' | '2' | '3' }`
  - `class LrsError extends StoreError { status: number }`

Behaviour: header `X-Experience-API-Version` on every request; `auto` reads `GET about` once and picks `2.0.0` when listed, else `1.0.3`. Token auth sends `Authorization: Basic <value>` (the cmi5 auth-token is already the Basic credential). `putStatement` treats 204 and 409 as delivered (an id the LRS already has). `postStatements` falls back to one `putStatement` per statement on 409. `getStatements` follows `more` until exhausted. `putState`/`getState` map 412 to `StoreConflictError` and pass ETags through. Network errors and timeouts become `LrsError` with `status: 0` and the message "the record holder is not responding; try again shortly". Error messages never include credentials.

- [ ] **Step 1: Write the failing tests:** version negotiation (`about` lists `["1.0.3","2.0.0"]` gives `2.0.0`; only `1.0.3` gives `1.0.3`); every request carries the version header and Basic auth; 409 on PUT counts as delivered; POST 409 falls back to PUTs; `more` paging returns all statements across three pages; 412 on `putState` throws `StoreConflictError`; `If-Match` sent when given; timeout throws `LrsError` with status 0 and no secret in `message`; `fetchAuthToken` returns `auth-token` and maps `{"error-code":"1"}` to `Cmi5FetchError` code `'1'`.
- [ ] **Step 2:** `npx vitest run reference/packages/lrs-client`. Expected: FAIL.
- [ ] **Step 3:** Implement with web `fetch` and `AbortSignal.timeout`.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(lrs-client): xAPI 1.0.3/2.0 client with State API and cmi5 fetch`.

### Task 8: Test LRS and cmi5 LMS simulator

**Files:**
- Create: `conformance/lib/test-lrs.ts`, `conformance/lib/lms-sim.ts`, `conformance/lib/index.ts`
- Test: `conformance/lib/test/test-lrs.test.ts`, `conformance/lib/test/lms-sim.test.ts`

**Interfaces:**
- Consumes: `validateStatement`, `checkCmi5Order` (Task 6, via `@course-xapi-mcp/core/xapi`), `fetchAuthToken` shape (Task 7 protocol, not code).
- Produces:
  - `createTestLrs(o?: {versions?: ('1.0.3' | '2.0.0')[], credentials?: {key, secret}[]}): TestLrs`; `interface TestLrs { fetch(req: Request): Promise<Response>; listen(port?: number): Promise<string /* base URL */>; close(): Promise<void>; statements(): XapiStatement[]; addToken(token: string): void; failNext(n: number, status: number): void; reset(): void }`
  - `createLmsSim(o: {lrs: TestLrs, lrsUrl: string, courseId: string, aus: {auId, url, moveOn}[], actor?: XapiAgent}): LmsSim`; `interface LmsSim { launch(auId, o?: {launchMode?, returnURL?, registration?}): Promise<{launchUrl, registration, sessionId, activityId, token}>; abandonLatest(): Promise<void>; problems(): Cmi5Problem[] }`

The test LRS implements `GET about`, `PUT`/`POST`/`GET statements` (`statementId`, `agent`, `verb`, `activity`, `registration`, `limit`, `more`), `PUT`/`GET`/`DELETE activities/state` with ETags (`If-Match` mismatch gives 412, `If-None-Match: *` on an existing doc gives 412), `GET`/`PUT agents/profile`. It answers 400 without the version header or for a statement failing `validateStatement`, 401 without valid Basic credentials or a known token, 409 on a PUT of an existing id with different content and 204 for identical content. The simulator writes `LMS.LaunchData` (contextTemplate with the sessionid extension and the publisher-id grouping, launchMode, moveOn, returnURL), sends `launched` with the cmi5 category, and serves a fetch URL (`POST` once returns `{"auth-token"}`, a second `POST` returns `{"error-code":"1","error-text":"already in use"}`).

- [ ] **Step 1: Write the failing tests:** state round-trip with ETag and 412 on stale `If-Match`; 409/204 PUT semantics; `failNext(1, 503)` fails exactly one request; both versions accepted when configured, `2.0.0` rejected when only `1.0.3` is; `launch()` builds a launch URL with `endpoint`, `fetch`, `actor`, `registration`, `activityId` query parameters; fetch works once then gives error-code 1; `LMS.LaunchData` contains `contextTemplate.extensions[CMI5.extSessionId]`; `problems()` is empty after a scripted good session and non-empty after `failed` follows `passed`.
- [ ] **Step 2:** `npx vitest run conformance/lib`. Expected: FAIL.
- [ ] **Step 3:** Implement as web-standard fetch handlers; `listen` wraps them with `node:http` on `127.0.0.1`.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(conformance): in-memory test LRS and cmi5 LMS simulator`.

### Task 9: Badges library (OB 3.0)

**Files:**
- Create: `reference/packages/badges/src/{awards.ts,credential.ts,sign.ts,status-list.ts,did.ts,document-loader.ts,index.ts}`, `reference/packages/badges/src/contexts/{credentials-v2.json,ob-v3p0-3.0.3.json,multikey-v1.json,did-v1.json,sources.json}`
- Test: `reference/packages/badges/test/{awards,credential,sign,status-list,did}.test.ts`

**Interfaces:**
- Consumes: `CourseModel`, `BadgeDecl`, `LearnerState`, `SatisfactionEvent`, `Award` (Task 4).
- Produces:
  - `awardsFor(course: CourseModel, state: LearnerState, events: SatisfactionEvent[]): Award[]`
  - `buildCredential(o: {badge: BadgeDecl, issuer: {id: string, name: string}, recipient: {did: string} | {email: string, salt: string}, award: Award, credentialId: string, validFrom: string, status: StatusEntry, assessed: 'checks' | 'agent-rubric' | 'mixed'}): object`
  - `signCredential(unsigned: object, key: {id: string, controller: string, publicKeyMultibase: string, secretKeyMultibase: string}): Promise<object>`; `verifyCredential(signed: object, didDocs: Record<string, object>): Promise<{verified: boolean, errors: string[]}>`
  - `createStatusList(length = DEFAULTS.statusListLength): StatusList`; `interface StatusList { allocate(): number; revoke(i: number): void; isRevoked(i): boolean; encode(): string; entry(listUrl, i): StatusEntry }`; `statusListCredential(o: {listUrl, issuer, list, validFrom}): object` (unsigned)
  - `didWeb(publicUrl: string): string` (`didWeb('https://a.example/x') === 'did:web:a.example:x'`, port as `%3A`); `didDocument(did, keys: {id, publicKeyMultibase}[]): object`
  - `generateKey(controllerDid): Promise<{id, controller, publicKeyMultibase, secretKeyMultibase}>`

Award rules (design §6.3 rule 5, §11): one award per badge per registration (skip ids already in `state.awards`); `au-moveon` from a `{type:'au'}` event whose `lessonKey === badge.for`, but a waived lesson only with `countWaived` and never when `carriedOver`; `block-satisfied` from the `{type:'block'}` event for `badge.for`, withheld when any lesson in that path is carried over; `course-satisfied` from `{type:'course'}`; `any-path` from the first `{type:'block'}` event; `testedOut` counts lessons in scope with `waived === 'Tested Out'`. Credential (design §11): types `['VerifiableCredential','OpenBadgeCredential']`, contexts `https://www.w3.org/ns/credentials/v2` and `https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json`; `credentialSubject = {type: ['AchievementSubject'], achievement, id?: did | identifier: [{type: 'IdentityObject', identityType: 'emailAddress', hashed: true, identityHash: 'sha256$' + hex(sha256(email + salt)), salt}]}`; exactly one evidence `{id: 'urn:uuid:' + earningStatementId, type: ['Evidence'], genre: 'xAPI statement', narrative}`; the narrative names how learning was assessed ("deterministic checks", "the learner's AI agent judging against an authored rubric", or both) and, when `testedOut > 0`, "N lessons were tested out."; `credentialStatus` is the BitstringStatusListEntry; no xAPI actor, no statements, no score unless `includeScore`. The document loader resolves only the bundled contexts and the given DID documents, and throws on anything else (no network).

- [ ] **Step 1: Write the failing tests:** awards: one per registration; waived lesson gives no lesson badge without `countWaived`, gives one with it; carried-over gives none even with `countWaived` and blocks the path badge; `any-path` fires once on the first block; credential: no field anywhere equals the xAPI account name (deep scan); evidence id is `urn:uuid:<statement id>`; narrative contains "2 lessons were tested out." when `testedOut: 2`; email hash recomputes from salt; sign then `verifyCredential` gives `verified: true`; tampering `credentialSubject.achievement.name` gives `verified: false`; status list: `allocate()` returns distinct random indexes in `[0, 131072)`, `revoke` then `isRevoked` true, `encode()` round-trips; `didWeb('https://course.example:8443/a')` is `did:web:course.example%3A8443:a`; the loader throws for `https://example.com/ctx`.
- [ ] **Step 2:** `npx vitest run reference/packages/badges`. Expected: FAIL.
- [ ] **Step 3:** Implement with the Digital Bazaar libraries (`eddsa-rdfc-2022`, Ed25519 Multikey). Fetch each context once from its canonical URL, commit it, and record URL and SHA-256 in `contexts/sources.json`.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(badges): award rules, OB 3.0 credentials, eddsa-rdfc-2022 signing, status list, did:web`.

### Task 10: Agent rules v0.2

**Files:**
- Create: `spec/draft/agent-rules.md`
- Move: `rules/AGENT_RULES.md` to `docs/history/AGENT_RULES-v0.1.md` (with the superseded line)
- Modify: `scripts/sync-rules.mjs` (source `spec/draft/agent-rules.md`), `reference/packages/core/src/rules.ts`, `reference/packages/core/src/agent-rules.generated.ts` (regenerated), `reference/packages/core/test/rules.test.ts`, `reference/packages/server/test/server.test.ts` (only the assertions on the rules URI and version)

**Interfaces:**
- Produces: `RULES_VERSION = '0.2'`; `RULES_URI = URIS.rules`; `RULES_DIGEST` (array, below); `rulesBlock(c: {rules?: string[]}): RulesBlock`; `agentInstructions(c: {rules?: string[]}): string`; `tutorSkill(c): string` (SKILL.md text: YAML front matter `name: course-xapi-mcp-tutor`, a one-line `description`, then `agentInstructions(c)`).

Rules text: today's 12 rules with these changes (design §9.2): heading `# Teaching rules for agents (course-xapi-mcp rules 0.2)`; a new rule 0, "Before the first recorded step, call `get_status` and tell the learner where their record is kept and whether it is official; in practice, say it is not official and earns no badges"; "Never claim progress, a pass or a badge the server did not confirm"; "When a result says `return-to-lms`, send the learner back to their LMS to launch the next lesson"; rule 6 mentions `reveal_bug` (only when the server offers it); rule 12 rewritten per custody: official records are held by the record holder named by `get_status`, which the learner can view and export but nobody in the conversation can change; in practice the handle is a secret, `get_record` exports, `resume_practice` continues, `delete_practice_record` deletes; no mention of `link_record`. Digest lines: the seven legacy lines, with the last replaced by "Tell the learner who holds the record and whether it is official; never claim unconfirmed progress."

- [ ] **Step 1: Write the failing tests** (`rules.test.ts`): generated text equals `spec/draft/agent-rules.md`; heading names `0.2`; text contains `get_status`, `reveal_bug`, `return-to-lms` and does not contain `link_record`; course rules are appended after the core rules; `tutorSkill(c)` starts with `---\nname: course-xapi-mcp-tutor\n`.
- [ ] **Step 2:** `npx vitest run reference/packages/core/test/rules.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Write the rules, update the script and `rules.ts`, run `npm run rules`, update the two legacy server assertions.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit (after owner approval of the rules diff): `feat(rules): agent rules 0.2 per custody`.

### Task 11: Spec text skeleton and requirement traceability

**Files:**
- Create: `spec/draft/{index.md,package.md,server.md,custody.md,cmi5-binding.md,badges.md,security-privacy.md}`, `conformance/requirements/draft.yaml`, `scripts/check-requirements.ts`, `scripts/test/requirements.test.ts`

**Interfaces:**
- Consumes: `ISSUE_CATALOG` (Task 4) for the package requirements.
- Produces: requirement IDs referenced by Tasks 24, 27 and 29. YAML entry shape: `{id, class: package | server | custody | bridge | badges | security, text, source: 'spec/draft/<file>.md#<anchor>', status: pending | tested | excluded, test?: '<path>', exclusion?: '<reason>'}`. `checkRequirements(o: {strict: boolean}): string[]`.

Each spec file: status banner ("Draft 0.2. Not stable. Normative where marked."), BCP 14 boilerplate in `index.md`, the conformance classes (course package, course server per custody option, launch bridge, badge issuer), terms, and one numbered clause per MUST/SHOULD from the design (`package.md` from design §6, `server.md` §9, `custody.md` §7, `cmi5-binding.md` §6.3 and §8, `badges.md` §11 referencing OB 3.0 without copying it, `security-privacy.md` §9.4-9.5 and §11 privacy). Every MUST carries its ID inline, e.g. "A server MUST NOT send the explanation before... [CXM-SRV-040]". Package-class IDs are the catalog codes. Prose stays short: one or two sentences per clause, pointing to the design section in an HTML comment.

The check: every `[CXM-...]` in `spec/draft/*.md` has one YAML entry and vice versa; IDs are unique; `tested` entries name a test file that contains `[<ID>]`; `excluded` entries have a reason; with `--strict`, no entry is `pending`.

- [ ] **Step 1: Write the failing tests** (`scripts/test/requirements.test.ts`): non-strict check on the repo returns `[]`; a fixture with an ID in the text but not the YAML is reported; a `tested` entry whose file lacks the ID is reported; strict mode reports pending entries; every catalog error code appears as a package requirement.
- [ ] **Step 2:** `npx vitest run scripts/test/requirements.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Write the spec skeleton, the YAML (all `pending`) and the script.
- [ ] **Step 4:** `npm run requirements && npm test`. Expected: PASS.
- [ ] **Step 5:** Diff ready for owner review; then commit: `docs(spec): draft 0.2 skeleton with requirement IDs`.

### Task 12: Governance and repository documents

**Files:**
- Create: `GOVERNANCE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `AI_POLICY.md`, `extensions/registry.md`, `proposals/CXP-0000-template.md`, `docs/decisions.md`, `docs/rationale.md`

Content (design §5.4, §5.5): Derin is sole editor and merges until a second independent implementation exists, then the project seeks IEEE LTSC or an MCP interest group; every normative change goes through a `CXP-NNNN` proposal or a `docs/decisions.md` entry; a proposal adding a MUST includes its conformance test; personal membership, DCO sign-off (`git commit -s`), no reserved seats; 1.0 exit criterion: two independent course servers pass the suite. `SECURITY.md`: private reporting via GitHub security advisories. `CODE_OF_CONDUCT.md`: Contributor Covenant 2.1 by reference with the contact address. `AI_POLICY.md`: AI-assisted contributions are welcome, the human submitter is responsible and signs off, and AI-written normative text gets the same review. `extensions/registry.md`: the registration rule ("the name isn't taken") and an empty table (prefix, owner, URL). `docs/decisions.md`: one entry per owner decision and per BC-n, linking the design. `docs/rationale.md`: why cmi5, why custody options, why one repo (design §1, §5.2, §7).

- [ ] **Step 1:** Write the files. Every informative file starts with "Informative: not part of the specification."
- [ ] **Step 2:** `npm test` (the licence test ignores `.md`). Expected: PASS.
- [ ] **Step 3:** Diff ready for owner review; then commit: `docs: governance, contribution, security and extension registry`.

### Task 13: Package reader

**Files:**
- Create: `reference/packages/core/src/package/{zip.ts,cmi5-xml.ts,load.ts}`
- Modify: `reference/packages/core/src/package/index.ts` (append exports)
- Test: `reference/packages/core/test/package-load.test.ts`, fixtures under `reference/packages/core/test/fixtures/packages/` (a minimal good package directory and one directory per error case)

**Interfaces:**
- Consumes: Task 5 schemas, Task 4 model and issues.
- Produces:
  - `type PackageFiles = Record<string, Uint8Array>` (paths relative to the package root, `/`-separated)
  - `readZip(bytes: Uint8Array): PackageFiles | ValidationIssue` (CXM-PKG-001 on failure; rejects entries with `..` or absolute paths)
  - `readDir(dir: string): Promise<PackageFiles>` (Node only; in `load.ts` behind a dynamic `node:fs` import)
  - `parseCmi5Xml(xml: string): {structure: Cmi5Structure} | {issues: ValidationIssue[]}`; `Cmi5Structure {course: {id, title, description, cxm: {src, specVersion, mcp}}, aus: Cmi5Au[], blocks: Cmi5Block[]}` with XPath locations
  - `loadPackage(files: PackageFiles, o?: {allowDistribution?: boolean}): {ok: true, course: CourseModel, issues: ValidationIssue[] /* warnings and info only */} | {ok: false, issues: ValidationIssue[]}`
  - `SUPPORTED_SPEC_MAJOR = 0`, `SUPPORTED_SPEC_MINOR = 2`

`loadPackage` reports every problem in one pass, sorted by file then location. It emits codes 001, 004-013, 015-021, 026, 028-034, 100 and 206 (the validator adds 002, 003, 014, 022-025, 027 and 2xx). Titles and descriptions take the first `langstring` matching the course `language`, else the first. A missing `cxm:path` on a block, or a `paths` entry without a block, is 016. Zod issues map to 006/007 with `pointer` from the issue path and `fix` "Change <pointer>: <zod message>". `flavour: 'distribution'` gives 034 unless `allowDistribution`.

- [ ] **Step 1: Write the failing tests:** the minimal good package loads with `issues: []` and the expected `CourseModel` (snapshot of keys, `lessons['l1'].auId`, `paths['p'].lessons`); one test per emitted error code using its fixture, asserting `code`, `file` and `xpath` or `pointer`; a package with three independent errors reports all three; a ZIP entry `../evil` gives 001; `specVersion="1.0"` gives 004; `specVersion="0.3"` gives 206 and still loads; an unknown `<other:thing>` element gives 100 and still loads; a distribution package gives 034, and loads with `allowDistribution: true`.
- [ ] **Step 2:** `npx vitest run reference/packages/core/test/package-load.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with `fflate.unzipSync` and `fast-xml-parser` (`ignoreAttributes: false`, `removeNSPrefix: false`, namespaces resolved by URI, not prefix).
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): cmi5 package reader with agent-fixable issues`.

### Task 14: Session engine (AU sessions, review, waivers, reveal, satisfaction)

**Files:**
- Create: `reference/packages/core/src/session/{env.ts,au-session.ts,placement.ts,lesson.ts,checkpoint.ts,satisfaction.ts,status.ts,index.ts}`, `reference/packages/core/src/engine-keys.ts` (key-based ports of `validatePlacement`, `allowedBranches`, `nextLessonId`)
- Test: `reference/packages/core/test/session/{flow,branching,sessions,waivers,option1,reveal,status}.test.ts`, `reference/packages/core/test/fixtures/course-model.ts` (a typed `CourseModel` literal: placement AU, path `p` with lessons `a` (free-text checkpoint with `ready` to `b`, `review` to `a`, `skip` success to `c`), `b` (bug + code checkpoint, `maxAttempts: 2`), `c` (no checkpoint); a second path `q` with one lesson)

**Interfaces:**
- Consumes: Tasks 4, 6 (`buildDefined`, `buildAllowed`, `isoDuration`), `runChecks`, `wrapLearner`, `LIMITS`.
- Produces (all pure; never mutate input):
  - `interface Env { now(): string; uuid(): string; actor: XapiAgent; custody: CustodyOption; practice: boolean; language?: string; platform?: string; launch?: LaunchBinding }`; `LaunchBinding {auKey, activityId, registration, sessionId, contextTemplate, launchMode, returnURL?}`
  - `type Step<T> = {ok: true, state: LearnerState, statements: XapiStatement[], events: SatisfactionEvent[], data: T, next?: NextAction} | {ok: false, error: string}`; `NextAction = {type: 'continue'} | {type: 'return-to-lms', returnURL?: string, lessonKey: string} | {type: 'done'}`
  - `newState(course, env): LearnerState`; `expireSession(course, state, env): Step<null>` (closes an idle session)
  - `startPlacement(course, state | undefined, env): Step<{intro, maxQuestions, paths}>`
  - `choosePlacement(course, state, input: {pathKey, startLessonKey, skip, reason}, env)`
  - `nextBeat(course, state, input: {learner_reply?}, env)`; `checkCode(course, state, input: {file, content}, env)`; `revealBug(course, state, env)`
  - `submitCheckpoint(course, state, input: {response, files?}, env)`; `chooseBranch(course, state, input: {branch, rationale}, env)`
  - `endSession(course, state, env)`; `restartCourse(course, state, env)` (new registration, fresh `au`, keeps nothing but `awards`)
  - `status(course, state | undefined, env): {position: {pathKey?, lessonKey?, phase?}, next: string[]}`; `listPaths(course)`; `getLesson(course, lessonKey)`

Behaviour (design §6.3, §8.1): the first write call on a lesson opens an AU session; in options 2, 3 and 4 that emits `launched` (launchMode Normal) then `initialized`; in option 1 the bridge already sent `initialized`, so the engine uses `env.launch.sessionId` and emits neither. A session idle longer than `DEFAULTS.sessionIdleMs` is closed by `expireSession` with `terminated` (timestamp `lastActivityAt` + 1 ms, `duration` = `lastActivityAt - startedAt`). `completed` follows the last beat and the bug being caught or revealed. A `success: true` branch emits defined `passed` (once per registration), then `terminated`; the AU's moveOn met emits a `{type:'au'}` event; in options 2-4 the engine then emits `satisfied` for each newly satisfied block and the course (LMS role, same session id) with matching events. A `success: false` branch emits allowed `failed` on the checkpoint with the `attempt` extension; when `session.attempts` reaches `maxAttempts`, defined `failed` (never after `passed`) and `terminated`. Branch to a lesson satisfied in this registration: phase `review` over its beats inside the current session (allowed statements, parent = target AU), then back to this checkpoint. Branch to the same unpassed lesson: restart its beats in the same session. A success branch that jumps ahead, and placement skips, waive the skipped lessons with reason `Tested Out` in options 2-4 (statement `waived` per lesson, own session id each); in option 1 they put the AU ids in the `waive-recommended` extension on `placed`/`branched` instead. In option 1, moving to a different AU returns `next: {type: 'return-to-lms'}` and does not open its session. `revealBug` is allowed only when `au.fixAttempts >= (bug.revealAfter ?? 3)` and `revealAfter !== null`; it emits `revealed`, returns the explanation, and does not count as caught. Every statement in one step gets a timestamp 1 ms after the previous one. Learner text in results is wrapped with `wrapLearner`. If the cursor's lesson no longer exists (course changed), every write returns `{ok: false, error: 'this lesson is no longer in the course (it was updated); call choose_placement to continue'}` and `expireSession` closes the open session with `terminated` only.

- [ ] **Step 1: Write the failing tests** (names and key assertions):

```ts
it('a full run of path p emits launched, initialized, ..., completed, passed, terminated per lesson, then satisfied for p', () => expect(verbs(run)).toEqual([...]); expect(checkCmi5Order(run.statements)).toEqual([]));
it('timestamps strictly increase within one step', () => expect(strictlyIncreasing(step.statements.map(s => s.timestamp))).toBe(true));
it('a failed retry records allowed failed with attempt 1 and keeps the session open', ...);
it('maxAttempts spent sends defined failed then terminated; a later session can still pass', ...);
it('never sends defined failed after passed', ...);
it('a branch to a passed lesson runs a review inside the current session and returns to the checkpoint', ...);
it('placement skips and forward success branches waive with reason Tested Out (options 2-4)', ...);
it('option 1 records waive-recommended instead of waived and returns return-to-lms for the next AU', ...);
it('option 1 never emits launched, initialized, waived or satisfied', ...);
it('reveal_bug is refused before 3 failed fixes, allowed after, emits revealed, and the lesson can still pass', ...);
it('reveal_bug is refused when revealAfter is null', ...);
it('no result before caught or revealed contains the explanation or a fix-check value', ...);
it('an idle session is terminated with timestamp lastActivity+1ms and the next call opens a new one', ...);
it('restart_course mints a new registration and keeps earned awards', ...);
it('a removed lesson after a course update gives the choose_placement error and closes the open session', ...);
it('practice statements all carry the practice category', ...);
```

- [ ] **Step 2:** `npx vitest run reference/packages/core/test/session`. Expected: FAIL.
- [ ] **Step 3:** Implement. Port the legacy validation and limits from `session.ts`/`engine.ts` by copying (they stay in place until Task 22).
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): cmi5 AU-session engine with review, waivers, reveal_bug and satisfaction`.

### Task 15: Custody adapters: practice and server-kept

**Files:**
- Create: `reference/packages/core/src/practice-record.ts`, `reference/packages/server/src/custody/{practice.ts,server-kept.ts,stores.ts,mutex.ts}`
- Test: `reference/packages/core/test/practice-record.test.ts`, `reference/packages/server/test/custody-local.test.ts`

**Interfaces:**
- Consumes: `Custody`, `LearnerRef`, `LearnerState`, `StoreConflictError` (Task 4); `validateStatement`, `checkProfile` (Task 6).
- Produces:
  - `PRACTICE_FORMAT = 'course-xapi-mcp/practice-record'`, `PRACTICE_VERSION = 1`; `PracticeRecord {format, version, official: false, label: PRACTICE_LABEL, courseId, actor, createdAt, updatedAt, state: LearnerState, statements: XapiStatement[]}`
  - `parsePracticeRecord(raw: unknown, courseId: string): {ok: true, record: PracticeRecord} | {ok: false, error: string}`
  - `newPracticeHandle(): string` (`cxp_` + 32 base64url chars, 192 bits); `isPracticeHandle(h): h is string`
  - `createPracticeCustody(o: {store?: PracticeStore}): Custody & {deletePractice(handle): Promise<boolean>, importCopy(handle, rec: PracticeRecord): Promise<void>}`
  - `createServerKeptCustody(o: {store: ServerStore, publicUrl: string}): Custody`
  - `interface PracticeStore { get(handle); put(handle, rec, etag?); delete(handle) }` with `MemoryPracticeStore(ttlMs = DEFAULTS.practiceTtlMs)` and `DirectoryPracticeStore(dir)` (file name = SHA-256 of the handle)
  - `interface ServerStore { getState(subject); putState(subject, state, etag?): Promise<{etag}>; append(subject, statements): Promise<void> /* idempotent by id */; statements(subject): Promise<XapiStatement[]>; deleteLearner(subject): Promise<void> }` with `MemoryServerStore` and `DirectoryServerStore(dir)`
  - `withLearnerLock<T>(subject: string, fn: () => Promise<T>): Promise<T>` (in-process mutex)

`parsePracticeRecord` refuses: another format (including `learning-mcp/record`) with "this is not a course-xapi-mcp practice copy"; a newer version; another course; any statement failing `validateStatement` or `checkProfile`, or lacking `PRACTICE_CATEGORY`, or with an actor other than the record's practice actor (`homePage === PRACTICE_HOMEPAGE`). Server-kept `links()` gives `{holder: '<course title> (this course server)', view: publicUrl + '/record', export: publicUrl + '/record/export.json', delete: publicUrl + '/record', policy: publicUrl + '/record/policy'}`; practice `links()` gives `{holder: 'nobody: practice run'}`. Etag mismatch on save throws `StoreConflictError`.

- [ ] **Step 1: Write the failing tests:** practice record round-trips through JSON; a `learning-mcp/record` file, a copy with one statement missing the practice category, and a copy with a foreign actor are each refused with their messages; handles match `/^cxp_[A-Za-z0-9_-]{32}$/`; memory practice store expires after 30 days with an injected clock; server-kept `save` with a stale etag throws `StoreConflictError`; `append` twice with the same ids stores one copy; two concurrent `withLearnerLock` calls for one subject run one after the other; `deleteLearner` removes state and statements; directory stores never write the handle or subject in a file name.
- [ ] **Step 2:** Run both test files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): practice and server-kept custody`.

### Task 16: Custody adapters: author LRS and LMS-launched

**Files:**
- Create: `reference/packages/server/src/custody/{author-lrs.ts,lms-launched.ts}`
- Test: `reference/packages/server/test/custody-lrs.test.ts` (uses `createTestLrs` and `createLmsSim` from `@course-xapi-mcp/conformance`)

**Interfaces:**
- Consumes: `createLrsClient` (Task 7), `LaunchStore`, `LaunchContext`, `Custody` (Task 4), test LRS and simulator (Task 8).
- Produces:
  - `createAuthorLrsCustody(o: {course: CourseModel, lrs: {endpoint, key, secret, version?}, publicUrl: string, assignActor?: (subject: string) => Promise<XapiAgent>, fetch?}): Custody`
  - `createLmsLaunchedCustody(o: {course: CourseModel, launches: LaunchStore, fetch?}): Custody & {launchFor(l: LearnerRef, auKey?: string): Promise<LaunchContext | {error: string}>}`

Author LRS: actor `{objectType: 'Agent', account: {homePage: course.id, name: subject}}` unless `assignActor`. Current registration in State doc `STATE_IDS.registration` (activity = course id, no registration); working state in `STATE_IDS.learner` (activity = course id, registration). `save` uses `If-Match` (or `If-None-Match: *` on first save). `deliver` uses `postStatements`. `record()` reads the learner's statements for the course (all registrations). `links()` points at the server's `/record` pages. LMS-launched: State and statements go to `launch.endpoint` with `{type: 'token', value: launch.authToken}`; `launchFor` returns the newest launch for the learner's (endpoint, actor, registration); a call bound to an older launch than the newest for the same AU gets `{error: 'this lesson was relaunched elsewhere; continue in the newest window or launch it again from your LMS'}`; after `terminatedAt` nothing is delivered (`deliver` throws `StoreError('this lesson session has ended; launch it again from your LMS')`). `record()` returns whatever the token can read for the registration plus `receipt` from the issued statements kept in state, with `complete: false` when the read fails, and the note "Your LMS holds the official record; ask it for a full export."

- [ ] **Step 1: Write the failing tests:** author LRS: first save uses `If-None-Match: *`, second uses the returned ETag, a concurrent stale save throws `StoreConflictError`; `deliver` lands statements in the test LRS and redelivering the same batch adds nothing; `failNext(1, 503)` makes `deliver` throw `LrsError` and the retry succeeds without duplicates; the registration pointer survives a new client instance; works against a `1.0.3`-only and a `2.0.0`-only test LRS. LMS-launched: statements land in the simulator's LRS under the LMS actor and registration with the contextTemplate grouping; a relaunch makes the older launch answer the relaunched error; nothing is delivered after `terminatedAt`; `record()` includes a receipt entry per delivered statement.
- [ ] **Step 2:** `npx vitest run reference/packages/server/test/custody-lrs.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): author-LRS and LMS-launched custody`.

### Task 17: MCP authorization server (OAuth 2.1)

**Files:**
- Create: `reference/packages/server/src/auth/{auth-server.ts,metadata.ts,clients.ts,pkce.ts,tokens.ts,accounts.ts,pages.ts,stores.ts}`
- Test: `reference/packages/server/test/auth.test.ts`

**Interfaces:**
- Consumes: `AuthServer`, `LearnerRef`, `LaunchStore`, `DEFAULTS` (Task 4).
- Produces:
  - `createAuthServer(o: {publicUrl: string, course: CourseModel, signingKey: JWK /* Ed25519 private */, mode: 'accounts' | 'federated' | 'launch-paired', launches?: LaunchStore, federation?: FederationHooks, store?: AuthStore, now?: () => number}): AuthServer`
  - `interface FederationHooks { begin(state: string, redirectUri: string): Promise<string /* IdP URL */>; complete(req: Request): Promise<{subject: string, state: string}> }` (Task 20 implements it)
  - `interface AuthStore` (clients, codes, refresh tokens, browser sessions, accounts) with `MemoryAuthStore`
  - Routes: `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728: `resource = publicUrl + '/mcp'`, `authorization_servers = [publicUrl]`, `scopes_supported = ['cxm:learn']`); `GET /.well-known/oauth-authorization-server` (RFC 8414: `code_challenge_methods_supported: ['S256']`, `grant_types_supported: ['authorization_code', 'refresh_token']`, `registration_endpoint`, `client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported: ['none']`); `POST /oauth/register` (RFC 7591, public clients only); `GET|POST /oauth/authorize`; `POST /oauth/token`; `GET /oauth/callback` (federation return); `POST /oauth/login` (accounts form)

Rules: PKCE S256 required; `redirect_uri` must exactly match a registered one (or one in the client's metadata document when `client_id` is an https URL, fetched with a 5 s timeout and 64 KB cap, no redirects); `resource` parameter must equal `publicUrl + '/mcp'`; codes single use, 60 s; access tokens JWT EdDSA, `iss = publicUrl`, `aud = publicUrl + '/mcp'`, `sub = subject`, `scope = 'cxm:learn'`, `exp` 3600 s; refresh tokens opaque (32 random bytes, base64url), rotated on use, 30 days, reuse of a rotated token revokes the family. `authenticate` returns 401 with `WWW-Authenticate: Bearer resource_metadata="<publicUrl>/.well-known/oauth-protected-resource/mcp", scope="cxm:learn"` when the token is missing, invalid or for another audience. Mode `accounts` (option 3): the authorize page offers sign in or create account (username 3-64 chars `[a-z0-9._-]`, password at least 12 chars, scrypt N=16384 r=8 p=1 with a 16-byte salt; 5 failed sign-ins per username per 15 min then refuse). Mode `launch-paired` (option 1): if the `cxm_launch` cookie names a live launch, bind it; otherwise ask for the pairing code (`DEFAULTS.pairingAlphabet`, case-insensitive, single use, expires at `pairingExpiresAt`, 5 wrong codes per authorization request end it); subject = hex SHA-256 of `endpoint + '\n' + actorKey + '\n' + registration`; the token carries `cxm_launch`. Mode `federated`: delegate to `federation`. After sign-in the server sets `cxm_sid` (HttpOnly, Secure unless `127.0.0.1`/`localhost`, SameSite=Lax, 12 h), which `browserLearner` reads. Pages are plain server-rendered HTML with every interpolated value HTML-escaped, a CSP `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'`, and `X-Frame-Options: DENY`.

- [ ] **Step 1: Write the failing tests:** metadata documents match the values above; DCR registers a public client; a CIMD `client_id` URL is fetched (stub fetch) and its redirect URI accepted, a mismatching one refused; the full code flow with PKCE yields a token that `authenticate` turns into `LearnerRef {kind: 'official', subject}`; wrong `code_verifier`, reused code, expired code (injected clock) and wrong `resource` are each refused; an unauthenticated request gets 401 with the exact `WWW-Authenticate` value; a refresh rotates and reuse of the old one revokes both; accounts: sign-up then sign-in works, the sixth bad password in 15 min is refused; launch-paired: cookie binding works, a correct pairing code works once, the same code a second time fails, an expired code fails, the sixth wrong code ends the request; HTML pages escape `<script>` in a `client_name`.
- [ ] **Step 2:** `npx vitest run reference/packages/server/test/auth.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with `jose` (`SignJWT`, `jwtVerify`, `importJWK`) and `node:crypto` `scrypt`, `randomBytes`, `timingSafeEqual`.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): OAuth 2.1 authorization server with accounts and launch pairing`.

### Task 18: Launch bridge (option 1)

**Files:**
- Create: `reference/packages/bridge/src/{bridge.ts,launch-store.ts,pairing.ts,page.ts,sweeper.ts,index.ts}`
- Test: `reference/packages/bridge/test/bridge.test.ts` (with `createTestLrs` and `createLmsSim`)

**Interfaces:**
- Consumes: `fetchAuthToken`, `createLrsClient` (Task 7); `LaunchStore`, `LaunchContext`, `DEFAULTS` (Task 4); `buildDefined`, `isoDuration` (Task 6).
- Produces:
  - `createBridge(o: {course: CourseModel, mcpUrl: string, launches: LaunchStore, now?, uuid?, fetch?}): {fetch(req: Request): Promise<Response | undefined>, sweep(): Promise<number>, terminate(launchId: string): Promise<void>}` (handles `GET /cmi5/launch`)
  - `MemoryLaunchStore implements LaunchStore`
  - `newPairingCode(): string`
  - `startSweeper(bridge, intervalMs = 60_000): () => void`

`GET /cmi5/launch?au=<key>&endpoint=&fetch=&actor=&registration=&activityId=`: validate parameters (`endpoint` https or loopback; `actor` parses as an Agent; `au` is a lesson or placement key whose AU id matches the course), `POST fetch` once server-side, read `LMS.LaunchData` (State, `activityId`, `registration`, stateId `LMS.LaunchData`) and the `cmi5LearnerPreferences` agent profile, store the `LaunchContext` with a new `launchId` and pairing code, send `initialized` with the contextTemplate, then return the page: "Continue in your agent", the course's MCP URL in a copyable field, a short "how to add it" list (Claude, ChatGPT, Cursor, Claude Code), and the pairing code with "Type this code only on the sign-in page, never in the chat." Set `cxm_launch=<launchId>` (HttpOnly, Secure unless loopback, SameSite=Lax, Max-Age 600). The token, endpoint and actor never appear in the page or a redirect. A launch in `Browse` or `Review` mode is stored with that mode (the engine then serves no checkpoint outcome). `sweep()` terminates live launches idle for `DEFAULTS.sessionIdleMs` or older than `DEFAULTS.lmsSessionMaxMs` since `tokenFetchedAt`, sending `terminated` with `duration`. A new launch for the same (endpoint, actor, registration, AU) marks older live ones superseded (no statements for them after that). Fetch errors render an error page with the cmi5 error text and send nothing.

- [ ] **Step 1: Write the failing tests:** a simulator launch makes the bridge fetch exactly once and send `initialized` first, with the contextTemplate's sessionid and grouping; the page HTML does not contain the auth token, the endpoint or the actor; the cookie is set with `HttpOnly` and `Max-Age=600`; pairing codes are 6 characters from the alphabet; a second launch of the same AU supersedes the first; `sweep()` at 31 min idle sends `terminated` with a duration and `problems()` stays empty; `sweep()` at 51 min after fetch terminates an active session; a reused fetch URL renders the error page and sends nothing; an `http://evil.example` endpoint is refused.
- [ ] **Step 2:** `npx vitest run reference/packages/bridge`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS. Optional visual check: serve the page locally and `agent-browser open http://127.0.0.1:<port>/cmi5/launch?...` then `agent-browser screenshot`; confirm it reads at 375 px width.
- [ ] **Step 5:** Commit: `feat(bridge): cmi5 launch bridge with server-side fetch, pairing and sweeper`.

### Task 19: Converter and the converted example course

**Files:**
- Create: `reference/packages/validator/src/convert.ts`, `examples/json-basics/cmi5.xml`, `examples/json-basics/cxm/course.json`, `examples/json-basics/cxm/lessons/{what-is-json,fix-the-config}.json`
- Move: `examples/json-basics/course.json` to `examples/legacy/json-basics.course.json` (the converter's input; legacy server tests point here until Task 22)
- Modify: `reference/packages/server/test/helpers.ts` (legacy path only)
- Test: `reference/packages/validator/test/convert.test.ts`

**Interfaces:**
- Consumes: `loadPackage`, `readDir` (Task 13).
- Produces: `convertLegacyCourse(raw: unknown, o: {courseIri: string, mcpUrl: string, launchBase: string, custody: CustodyOption, allowPractice?: boolean}): {ok: true, files: Record<string, string>} | {ok: false, errors: string[]}`; the example package used by Tasks 22-27.

Mapping: legacy `id`s become `cxm:key`s and `key` fields; AU ids `<courseIri>/lessons/<key>`, block ids `<courseIri>/paths/<key>`, placement AU `<courseIri>/placement` with `cxm:role="placement"`; AU `url` `<launchBase>?au=<key>`; moveOn per checkpoint presence; `bug.revealAfter` 3. The example: `courseIri = 'https://course-xapi-mcp.sqwrlz.com/examples/json-basics'`, `mcp = 'http://127.0.0.1:8787/mcp'`, launch base `http://127.0.0.1:8787/cmi5/launch`, custody `server-kept`, `allowPractice: true`, licence `Apache-2.0`; hand-added after conversion: `referenceSolution` for `fix-the-config` (files and `bugFix`), badges `{for: 'fix-the-config', awardOn: 'au-moveon'}` and `{for: 'json', awardOn: 'block-satisfied'}` with ids under `https://course-xapi-mcp.sqwrlz.com/examples/json-basics/badges/`, honest criteria narratives (checks for the lesson badge; checks and agent rubric for the path badge), `badgeIssuer {signer: 'course-server', claimPage: 'http://127.0.0.1:8787/badges/claim'}`.

- [ ] **Step 1: Write the failing tests:** converting the legacy example gives a package that `loadPackage` loads with no errors; beat, branch and checkpoint counts equal the legacy course's; every branch target maps; the committed `examples/json-basics/` loads with no errors, has custody `server-kept`, two badges, and `referenceSolution` on `fix-the-config`; converting a legacy course with an unknown branch target returns the error.
- [ ] **Step 2:** `npx vitest run reference/packages/validator/test/convert.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the converter; run it on the legacy file; hand-add the listed fields.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(validator): legacy course converter; json-basics as a cmi5 package`.

### Task 20: OIDC federation for option 2

**Files:**
- Create: `reference/packages/server/src/auth/oidc.ts`, `reference/packages/server/test/fake-idp.ts`
- Test: `reference/packages/server/test/oidc.test.ts`

**Interfaces:**
- Consumes: `FederationHooks`, `createAuthServer` (Task 17).
- Produces: `createOidcFederation(o: {issuer: string, clientId: string, clientSecret?: string, redirectUri: string, scopes?: string[] /* ['openid'] */, fetch?}): Promise<FederationHooks>`; `startFakeIdp(): Promise<{issuer, clientId, clientSecret, close(), setSubject(sub)}>` (test helper built on `jose`: discovery, JWKS, authorize redirect, token endpoint).

Behaviour: authorization code flow with PKCE and `state` and `nonce`, using `openid-client`; the subject is the ID token's `sub`; the auth server's learner subject is `sub` (actor name per design §8.1). Discovery once at startup. Errors from the IdP render the auth error page and never leak the client secret.

- [ ] **Step 1: Write the failing tests:** against the fake IdP, a full MCP authorization in `federated` mode yields a token whose `LearnerRef.subject` is the IdP `sub`; a wrong `state` is refused; a bad `nonce` is refused; an ID token signed by another key is refused; the error page does not contain the client secret.
- [ ] **Step 2:** `npx vitest run reference/packages/server/test/oidc.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): OIDC federation to the author's identity provider`.

### Task 21: Validator: validate, lint, CLI

**Files:**
- Create: `reference/packages/validator/src/{validate.ts,xsd.ts,behaviour.ts,lint.ts,explain.ts,cli.ts,index.ts}`, `reference/packages/validator/bin/cxm.mjs`
- Modify: `reference/packages/validator/package.json` (`"bin": {"cxm": "bin/cxm.mjs"}`)
- Test: `reference/packages/validator/test/{validate,lint,cli}.test.ts`

**Interfaces:**
- Consumes: `loadPackage`, `readZip`, `readDir` (Task 13); `runChecks`; `ISSUE_CATALOG` (Task 4); `schema/draft/cxm.xsd`, `schema/vendor/cmi5/CourseStructure.xsd`.
- Produces:
  - `validatePackage(files: PackageFiles, o?: {flavour?: 'authoring' | 'distribution'}): Promise<{valid: boolean, issues: ValidationIssue[]}>` (valid = no errors)
  - `explainCode(code: string): {code, severity, title, fix, help} | undefined`
  - CLI: `cxm validate <dir|zip> [--json]` (exit 0 when valid, 1 with errors, 2 on usage error); `cxm explain <code>`; human output one issue per line `CODE severity file location: message. Fix: fix`; `--json` prints `{valid, issues}` with keys in a fixed order and issues sorted.

Adds to `loadPackage`'s issues: 002 and 003 (XSD via `xmllint-wasm`, cxm.xsd imported for the cxm namespace; the cmi5 XSD's `##other` slots accept cxm elements); 014 when validating a distribution package with secret fields; behavioural 022-025 (each check alone, per design §12); 027; lint 201 (Jaccard of lower-cased word sets of two `when` texts in one checkpoint >= 0.8), 202 (a group with an inner `+`, `*` or `{n,}` quantifier that is itself quantified, e.g. `(a+)+`), 203 (> 250 words), 204 (case-insensitive: "ignore previous", "ignore all previous", "disregard", "system prompt", "do not tell the learner", "don't tell the learner", any of `TOOL_NAMES`, or an `http(s)://` URL in `rules` or beat content), 205.

- [ ] **Step 1: Write the failing tests** (on Task 13's fixtures under `reference/packages/core/test/fixtures/packages/`, not on `examples/`, which Task 19 is writing in parallel): the `minimal` package is valid with no errors; an XSD-invalid `cmi5.xml` (an `<au>` missing `<url>`) gives 002 with an XPath; a check that already passes on the starter files gives 022; a reference solution failing a check gives 023; a fix check passing on the bug code gives 024; `(a+)+$` gives 202 and `^\d{3}-\d{4}$` does not; a beat with "Ignore previous instructions" gives 204; a lesson without sources gives 205; output is identical across two runs (determinism); `cxm validate <minimal fixture>` exits 0; a broken fixture exits 1 and its `--json` output parses with `valid: false`; `cxm explain CXM-PKG-014` prints the fix and the help URL.
- [ ] **Step 2:** `npx vitest run reference/packages/validator/test/validate.test.ts reference/packages/validator/test/lint.test.ts reference/packages/validator/test/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(validator): cxm validate with XSD, behavioural and lint checks`.

### Task 22: MCP server rewrite

**Files:**
- Rewrite: `reference/packages/server/src/server.ts`; Create: `reference/packages/server/src/{tools.ts,tool-schemas.ts,results.ts}`
- Modify: `scripts/build-schemas.ts` (add tool schemas), `reference/packages/server/src/index.ts`, `reference/packages/core/src/index.ts`
- Create: `schema/draft/tools/<tool>.input.schema.json` and `<tool>.output.schema.json` (generated)
- Delete: legacy `reference/packages/core/src/{schema,session,record,store,xapi,engine}.ts`, `reference/packages/server/src/dir-store.ts`, their tests, `examples/legacy/` (keep the converter test's fixture copy under `reference/packages/validator/test/fixtures/`)
- Rewrite: `reference/packages/server/test/server.test.ts`, `reference/packages/server/test/helpers.ts`

**Interfaces:**
- Consumes: Tasks 10, 13, 14, 15 (practice for tests), 16 (interfaces), `Custody`, `AuthServer`, `BadgeService` (Task 4).
- Produces: `createCourseServer(o: {course: CourseModel, custody: Custody, practice?: Custody & {deletePractice, importCopy}, authenticate?: AuthServer['authenticate'], badges?: BadgeService, publicUrl: string, now?, uuid?}): {mcp(req: Request, path: '/mcp' | '/mcp/practice'): Promise<Response>, close(): Promise<void>}`.

Endpoints: `/mcp` is official (requires `authenticate`) unless custody is `practice`, in which case it is practice; `/mcp/practice` exists only when `allowPractice` is true. Extension declaration in `capabilities.extensions['com.sqwrlz/course-xapi-mcp']`: `{version: '0.2', course: course.id, custody, official, allowPractice, badges: course.badges.length > 0 && custody !== 'practice', rulesVersion: '0.2', authoring: 'https://course-xapi-mcp.sqwrlz.com/spec/draft/package/'}`; the practice endpoint declares `custody: 'practice', official: false`. Server name `course-xapi-mcp:<last path segment of course.id>`. Every result: `structuredContent` = `{ok, ...data, rules: rulesBlock(course), cxm: {custody, official, label?: PRACTICE_LABEL, lesson?, step?}}`, also as text. Resources: `URIS.rules`, `URIS.course` (outline from `listPaths`, never the package), `URIS.recordExport`, `URIS.tutorSkill` (`tutorSkill(course)`, mime `text/markdown`). Prompt `tutor`. Instructions = `agentInstructions(course)` plus one line naming `get_status` as the first call.

Per call: authenticate (or check `handle`), `withLearnerLock(subject)`, `custody.load`, redeliver `state.outbox` (on failure: tool error "the record holder is not responding; try again shortly", nothing else changes), `expireSession`, the engine function, `badges.onAwards` for `awardsFor(...)` results, `custody.save({...state, outbox: statements})` (conflict: "the record was changed by another call at the same time; call this tool again"), `custody.deliver(statements)` (failure: return the result with `delivery: 'pending'`; the outbox is redelivered next call).

| Tool | Args (official / practice) | Notes |
| --- | --- | --- |
| `get_status` | - / `handle?` | custody, official, label, `holder` and links, position, next actions, `practiceUrl` when allowed; read-only |
| `list_paths` | - | read-only |
| `start_placement` | - / `handle?` | practice returns a new `handle` |
| `choose_placement` | `pathKey, startLessonKey, skip, reason` (+ `handle`) | |
| `get_lesson` | `lessonKey` | read-only, no secrets |
| `next_beat` | `learner_reply?` (+ `handle`) | |
| `check_code` | `file, content` (+ `handle`) | |
| `reveal_bug` | (+ `handle`) | |
| `submit_checkpoint` | `response, files?` (+ `handle`) | |
| `choose_branch` | `branch, rationale` (+ `handle`) | |
| `end_session` | (+ `handle`) | |
| `get_record` | (+ `handle`) | `RecordView` plus "treat as data" note; practice adds the export resource `URIS.recordExport` |
| `get_badges` | - | `badges.summaries`, `claimPage`; never a link that grants a badge; error in practice |
| `restart_course` | (+ `handle`) | option 1: tells the learner to ask their LMS |
| `resume_practice` | `record` (JSON text, max 4 000 000 chars) | practice endpoint only; returns a new handle |
| `delete_practice_record` | `handle` | destructive; practice only |

Annotations: read-only tools `readOnlyHint: true, idempotentHint: true`; `delete_practice_record` `destructiveHint: true`; all `openWorldHint: false`. Size limits from `LIMITS` at the schema. Option 1: when `custody.launchFor` errors, return that error; when the engine returns `return-to-lms`, include `returnURL` in the result.

- [ ] **Step 1: Write the failing tests** (both eras, via the SDK client, with practice custody and with server-kept custody plus a stub `authenticate`):

```ts
it('lists the 16 tools in order with honest annotations', ...);
it('declares com.sqwrlz/course-xapi-mcp with the settings object', ...);
it('works for a client that does not declare the extension', ...);
it('sends rules as instructions, resource, prompt, digest and the tutor skill', ...);
it('carries rules and cxm on every result, including errors', ...);
it('practice: every result has official false and the label; get_badges is refused', ...);
it('official: an unauthenticated call returns 401 with WWW-Authenticate', ...);
it('teaches the whole example course; every statement passes validateStatement, checkProfile and checkCmi5Order', ...);
it('rejects an invented branch and records nothing', ...);
it('never returns the bug explanation or fix-check values before caught or revealed', ...);
it('no result contains a registration, token or actor account name outside get_record', ...);
it('two parallel next_beat calls for one learner produce one advance and no duplicate statements', ...);
it('a deliver failure returns delivery pending and the next call redelivers the outbox once', ...);
it('resume_practice refuses an official export and a learning-mcp record', ...);
it('a returning learner on another client resumes the same registration', ...);
it('rejects oversized input at the schema', ...);
it('tool schemas in schema/draft/tools match the server (run npm run schemas)', ...);
```

- [ ] **Step 2:** `npx vitest run reference/packages/server/test/server.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement; delete the legacy modules and tests; regenerate schemas.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS, and `grep -rn "link_record\|learning-mcp" reference schema spec` prints nothing.
- [ ] **Step 5:** Commit: `feat(server): course-xapi-mcp extension, 16 tools, custody-aware results`.

### Task 23: Validator: build, scaffold, MCP server

**Files:**
- Create: `reference/packages/validator/src/{build.ts,scaffold.ts,mcp.ts,author-skill.generated.ts}`, `scripts/sync-author-skill.mjs` (run by `npm run author-skill`)
- Modify: `reference/packages/validator/src/cli.ts` (subcommands), `reference/packages/validator/src/index.ts`
- Test: `reference/packages/validator/test/{build,scaffold,mcp}.test.ts`

**Interfaces:**
- Consumes: Task 21 `validatePackage`, `explainCode`; Task 19 `convertLegacyCourse`; `docs/authoring/SKILL.md` (Task 25).
- Produces:
  - `buildPackages(files: PackageFiles, name: string): Promise<{authoring: {file: '<name>-authoring.zip', bytes, etag}, distribution: {file: '<name>-lms.zip', bytes, etag}} | {issues}>` (refuses when invalid)
  - `scaffoldCourse(o: {id, title, language, custody}): Record<string, string>`; `scaffoldLesson(files, o: {pathKey, key, title}): Record<string, string>`
  - `createValidatorMcp(): McpServer factory` with tools `validate_package({files: Record<string, string>} | {zipBase64: string})`, `explain_error({code})`, `scaffold({kind: 'course' | 'lesson', ...})`, and resource `URIS.authorSkill`
  - CLI: `cxm init <dir> --id <iri> --title <t> [--custody <c>]`, `cxm add-lesson <dir> --path <key> --key <key> --title <t>`, `cxm build <dir> [--out <dir>]`, `cxm convert <course.json> <out-dir> --iri <iri> --mcp <url> --launch <url> --custody <c>`, `cxm mcp` (stdio via `@modelcontextprotocol/server/stdio`)

ZIPs are deterministic: entries sorted, mtime 1980-01-01T00:00:00Z, no extra fields; `etag = '"sha256-' + base64url(sha256(bytes)) + '"'`. The distribution package removes `bug.explanation`, `bug.fixChecks` and `referenceSolution` and sets `flavour: 'distribution'`.

- [ ] **Step 1: Write the failing tests:** `validatePackage` on `examples/json-basics` gives no errors; building the example twice gives byte-identical ZIPs and equal ETags; the LMS ZIP validates as a distribution package with no 014 and contains none of the secret strings; the authoring ZIP loads in `loadPackage`; `cxm init` then `cxm add-lesson` then `cxm validate` gives only the expected "fill this in" errors (no crash, each with a fix); the MCP server's `validate_package` returns the same issues as the library; `explain_error` for an unknown code is an error result; the author skill resource equals `docs/authoring/SKILL.md`.
- [ ] **Step 2:** Run the three files. Expected: FAIL.
- [ ] **Step 3:** Implement; `scripts/sync-author-skill.mjs` generates `author-skill.generated.ts` (with the SPDX line) from `docs/authoring/SKILL.md`.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(validator): deterministic authoring and LMS packages, scaffolding, MCP server`.

### Task 24: Conformance: course package class

**Files:**
- Create: `conformance/package/corpus/good/<name>/` (at least: `minimal`, `two-paths`, `foreign-extension`), `conformance/package/corpus/bad/<CODE>-<slug>/` (one per error code in the catalog, each with `expected.json` `{"codes": ["CXM-PKG-0NN"]}`), `conformance/package/package.test.ts`, `conformance/vitest.config.ts`, `conformance/README.md`
- Modify: `conformance/requirements/draft.yaml` (package entries to `tested`)

**Interfaces:**
- Consumes: the `cxm` CLI contract (Task 21): any validator is run as `CXM_VALIDATOR="<command>" npm run conformance -- package`, called with `validate <dir> --json`.
- Produces: the corpus other validators run.

- [ ] **Step 1: Write the tests:** for each good package, `valid: true`; for each bad package, `valid: false` and every expected code present; test names `[CXM-PKG-0NN] <slug>`.
- [ ] **Step 2:** `CXM_VALIDATOR="node reference/packages/validator/bin/cxm.mjs" npm run conformance -- package`. Expected: PASS once the corpus is complete; any corpus entry the reference validator misses is a validator bug to fix in `reference/packages/validator/` (note it in the report; do not edit the expected codes to match).
- [ ] **Step 3:** Mark package requirements `tested`; `npm run requirements`. Expected: PASS.
- [ ] **Step 4:** Commit: `test(conformance): course package class corpus`.

### Task 25: Authoring guide, author skill, second worked example

**Files:**
- Create: `docs/authoring/{index.md,procedure.md,fields.md,never.md,errors.md,conversion-json-basics.md,conversion-cmi5-html.md,SKILL.md}`, `examples/cmi5-html/original/` (a two-AU plain cmi5 course with HTML AUs and its `cmi5.xml`), `examples/cmi5-html/converted/` (the course-xapi-mcp package)
- Test: `scripts/test/authoring.test.ts`

Content (design §12): the 12-step procedure with a custody decision table; per field: rule, good example, bad example, why; the "never do" list; working through validator errors one at a time with `cxm validate --json` and `cxm explain`; the two worked conversions. `SKILL.md` front matter `name: course-xapi-mcp-author`, `description: Convert an existing course into a course-xapi-mcp package and validate it.`, body: the procedure condensed, the loop "validate, fix the first error, validate again", and the never list. The converted HTML course keeps its original IRIs and adds `cxm:key`s (BC-8).

- [ ] **Step 1: Write the failing test:** `examples/cmi5-html/converted` validates with no errors; `examples/cmi5-html/original/cmi5.xml` and the converted one have the same AU ids; every `CXM-PKG-` code in the catalog is mentioned in `docs/authoring/errors.md`; `SKILL.md` front matter parses with `name: course-xapi-mcp-author`.
- [ ] **Step 2:** `npx vitest run scripts/test/authoring.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Write the guide and the example.
- [ ] **Step 4:** `npm test`. Expected: PASS.
- [ ] **Step 5:** Diff ready for owner review; then commit: `docs(authoring): guide, author skill and the cmi5 HTML conversion`.

### Task 26: App composition and the reference binary

**Files:**
- Create: `reference/packages/server/src/{app.ts,config.ts,record-pages.ts}`
- Rewrite: `reference/packages/server/src/bin.ts`, `scripts/verify-client.ts`
- Test: `reference/packages/server/test/app.test.ts`

**Interfaces:**
- Consumes: Tasks 15-18, 20, 22, and Task 13 (`readDir`/`readZip` + `loadPackage`).
- Produces: `createApp(o: AppOptions): {fetch(req): Promise<Response>, close()}` routing, in order: Origin/Host guards (as today), `auth.routes`, `bridge.fetch`, `/record*` pages, `/mcp` and `/mcp/practice`, `GET /` description JSON, 404. `AppOptions` adds an optional `badgeRoutes?: (req) => Promise<Response | undefined>` slot that Task 28 fills. `loadConfig(env): AppConfig | {errors: string[]}` with env vars: `CXM_PACKAGE` (dir or ZIP, default `examples/json-basics`), `CXM_PUBLIC_URL` (default `http://127.0.0.1:<PORT>`), `PORT` (8787), `CXM_DATA_DIR` (directory stores; memory when unset), `CXM_LRS_ENDPOINT`, `CXM_LRS_KEY`, `CXM_LRS_SECRET`, `CXM_LRS_VERSION`, `CXM_OIDC_ISSUER`, `CXM_OIDC_CLIENT_ID`, `CXM_OIDC_CLIENT_SECRET`, `CXM_SIGNING_KEY` (Ed25519 JWK JSON; generated per process with a warning when unset), `CXM_BADGE_KEY`, `CXM_BADGE_ISSUER_NAME`, `CXM_ALLOWED_ORIGINS` (comma-separated). Custody `author-lrs` without the three LRS variables, or federated mode without OIDC variables, is a config error naming the missing variable. Mode by custody: `lms-launched` gives `launch-paired`, `author-lrs` gives `federated`, `server-kept` gives `accounts`. `/record` (options 2 and 3, browser session): view, `export.json` download, and for option 3 a delete form (POST with a CSRF token) and `/record/policy` (retention text from config, default "Records are kept until you delete them.").

- [ ] **Step 1: Write the failing tests:** each custody option starts from config with the example (custody overridden), and `GET /.well-known/oauth-protected-resource/mcp` answers in options 1-3; missing LRS variables give the named error; the bin's `GET /` reports the course and both MCP URLs; `/record/export.json` without a browser session is 401; the option-3 delete form refuses a missing CSRF token; an end-to-end option-3 run (sign-up through the auth pages with `fetch`, then MCP calls) passes `checkCmi5Order`; an end-to-end option-1 run (simulator launch, pairing code, MCP calls) puts the statements in the simulator's LRS with `problems()` empty.
- [ ] **Step 2:** `npx vitest run reference/packages/server/test/app.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement; update `scripts/verify-client.ts` to the new tools (practice endpoint by default).
- [ ] **Step 4:** `npm test && npm run typecheck`; then `npm start` and `node --experimental-strip-types scripts/verify-client.ts http://127.0.0.1:8787/mcp/practice modern`; stop the server by PID. Expected: a full practice transcript ending in `passed` and `satisfied`.
- [ ] **Step 5:** Commit: `feat(server): app composition and configurable reference binary`.

### Task 27: Conformance: course server and launch bridge classes

**Files:**
- Create: `conformance/server/{client.ts,practice.test.ts,official.test.ts,adversarial.test.ts,statements.test.ts}`, `conformance/bridge/bridge.test.ts`, `conformance/fixtures/course/` (the conformance course package), `conformance/run-reference.ts`
- Modify: `conformance/requirements/draft.yaml` (server, custody, bridge, security entries to `tested` or `excluded` with a reason), `conformance/README.md`

**Interfaces:**
- Consumes: only the wire contract: MCP over HTTP via `@modelcontextprotocol/client`, the test LRS and LMS simulator (Task 8), `validateStatement`, `checkProfile`, `checkCmi5Order` (Task 6). Never imports a reference server module.
- Produces: env contract: `CXM_URL` (MCP endpoint), `CXM_CUSTODY`, `CXM_TOKEN` (pre-obtained bearer token for options 1-3), `CXM_LRS_URL` (the bundled test LRS the server under test writes to in option 2), `CXM_EXPORT_URL` (option 3 export). The server under test must load `conformance/fixtures/course/`. `conformance/run-reference.ts` starts the reference app per option in-process, obtains tokens through its auth pages, and runs the classes (`npm run conformance:reference`).

Checks (design §13): discovery and extension settings; step order; required verbatim replies; invented, foreign and early branches refused with no statement; a failed check leaves only failing branches; bug secrecy scan of every response before `caught`/`revealed`; injection strings in learner text come back wrapped and inert; no tool accepts statements (`tools/list` input schemas contain no statement- or record-shaped parameter except `resume_practice.record` on practice); custody label on every result; practice category on practice statements; every statement valid under 1.0.3 and 2.0, the profile and cmi5 order; no defined `failed` after `passed`; waivers and satisfaction in the LMS role (options 2, 3); bridge: fetch once and server-side, LaunchData honoured, contextTemplate on every statement, `initialized` first and `terminated` last, durations, token absent from every page and result, relaunch handling, `waive-recommended` present after a skip.

- [ ] **Step 1: Write the tests**, each named `[<ID>] ...` per the YAML.
- [ ] **Step 2:** `npm run conformance:reference`. Expected: PASS for all four custody profiles and the bridge class. A failure is a reference bug: fix it in the owning reference file, keeping that file's tests green.
- [ ] **Step 3:** `npm run requirements`. Expected: PASS.
- [ ] **Step 4:** Commit: `test(conformance): course server and launch bridge classes`.

### Task 28: Badge issuing in the course server

**Files:**
- Create: `reference/packages/server/src/badges/{service.ts,issuer-store.ts,routes.ts,claim-page.ts}`
- Modify: `reference/packages/server/src/bin.ts` (pass `badges` and `badgeRoutes`), `reference/packages/server/src/config.ts` (badge key loading only)
- Test: `reference/packages/server/test/badges.test.ts`

**Interfaces:**
- Consumes: Task 9 library; `BadgeService` (Task 4); `createApp`'s `badgeRoutes` slot (Task 26); `buildEarned` (Task 6); `Custody.deliver`; `LaunchStore` and `createLrsClient` for option 1.
- Produces: `createBadgeService(o: {course, publicUrl, issuerName, key, store: IssuerStore, custody: Custody, auth: AuthServer, launches?: LaunchStore, now?, uuid?}): BadgeService & {routes(req): Promise<Response | undefined>, revokeLearner(subject): Promise<number>}`; `interface IssuerStore` (awards, credentials, status list bits, claim state) with memory and directory implementations.

Active only when `badgeIssuer.signer === 'course-server'` or custody is `server-kept`; in practice `get_badges` and `onAwards` do nothing. `onAwards` records eligibility. Option 1 (design §11, BC-32): lesson badges from the defined statements the LMS accepted (delivery succeeded); path and course badges only when `getStatements({registration, verb: satisfied})` with the session token finds the LMS's `satisfied` for that block or course. Routes: `GET /.well-known/did.json` (`didDocument(didWeb(publicUrl), keys)`); `GET /badges/status/1` (signed BitstringStatusListCredential); `GET|POST /badges/claim` (requires `browserLearner`; lists unclaimed badges; the learner gives a wallet DID or an email, the page generates a 16-byte salt client-side and shows it; POST with a CSRF token issues and signs, stores only the hash and salt, writes `earned` with `context.statement` to the official record in options 2 and 3, and in option 1 to the issuer record and also to the LMS only while a session for that registration is open); `GET /badges/credentials/<uuid>` (the signed credential, only to its owner's browser session). `revokeLearner` flips the status bit of every credential for the subject (called from the option-3 delete form in `/record`). A voided earning statement found on read also revokes.

- [ ] **Step 1: Write the failing tests:** finishing `fix-the-config` in option 3 makes `get_badges` list the lesson badge as unclaimed; claiming with an email issues a credential that `verifyCredential` accepts against `/.well-known/did.json`; the credential has no xAPI account name anywhere; an `earned` statement referencing the earning statement lands in the record; claiming twice issues one credential; practice never lists badges; option 1 without a readable `satisfied` issues the lesson badge but not the path badge; option 1 writes `earned` to the LMS only while a session is open; deleting the record revokes (status bit set); `claim` without a browser session redirects to sign-in.
- [ ] **Step 2:** `npx vitest run reference/packages/server/test/badges.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): Open Badges 3.0 issuing, claim page, status list, did:web`.

### Task 29: Conformance: badge issuer class

**Files:**
- Create: `conformance/badges/{fixtures/,badges.test.ts}`
- Modify: `conformance/requirements/draft.yaml` (badge entries), `conformance/run-reference.ts` (add the class)

**Interfaces:**
- Consumes: wire contract only: fixtures of earning statements are written to the bundled test LRS (or posted through the server's record for option 3); the issuer under test is reached at `CXM_ISSUER_URL`; verification uses a verifier the suite bundles (Digital Bazaar verify with a static loader and the fetched DID document).

Checks (design §13): triggers fire only on declared events and only from trusted credentials (a `satisfied` posted with a learner-scoped credential triggers nothing); one per registration; evidence shape; no actor id; status list entry resolves and revocation flips; the signed output verifies. Manual (documented in `conformance/README.md`, run in Task 32): the 1EdTech validator at https://vc.1ed.tech and the DCC verifier.

- [ ] **Step 1: Write the tests**, named `[CXM-BDG-NNN] ...`.
- [ ] **Step 2:** `npm run conformance:reference`. Expected: PASS.
- [ ] **Step 3:** `npm run requirements`. Expected: PASS.
- [ ] **Step 4:** Commit: `test(conformance): badge issuer class`.

### Task 30: Spec site build

**Files:**
- Create: `site/build.ts`, `site/serve.ts`, `site/template.html`, `site/style.css`, `site/test/build.test.ts`
- Modify: `.gitignore` (`site/dist/`)

**Interfaces:**
- Consumes: `spec/draft/*.md`, `docs/authoring/*.md`, `schema/draft/**`, `profile/xapi-profile.jsonld`, `ISSUE_CATALOG`, `buildProfile`, `TEMPLATES`.
- Produces: `site/dist/` with: `/index.html`; `/spec/draft/<page>/index.html`; `/authoring/<page>/index.html`; `/course/v1/index.html` (namespace page) and `/course/v1/cxm.xsd`; `/schema/draft/*.json` and `/schema/draft/tools/*.json`; `/xapi/index.html` and `/xapi/index.jsonld`; `/xapi/v0.2/index.html`; one `index.html` plus `index.jsonld` per concept IRI (`/xapi/verbs/placed/`, `/xapi/activity-types/beat/`, `/xapi/extensions/branch/`, `/xapi/practice/`, ...); `/practice-learner/index.html`; `/errors/<CODE>/index.html` per catalog code (title, severity, fix, link to the authoring errors page); `_headers` (`Access-Control-Allow-Origin: *` and `Content-Type: application/ld+json` for `*.jsonld`, `application/schema+json` for schemas) and `_redirects` (303 from each concept IRI to `index.jsonld` when `Accept: application/ld+json`, for hosts that honour them). `buildSite(out: string): Promise<{files: string[], missingIris: string[]}>`.

BC-26: the build fails (exit 1) when any IRI under `SITE` used by the profile, the constants, the schemas' `$id`s or the error help URLs has no file in `dist`. Pages render Markdown with `marked`, escape nothing raw from outside the repo, and work at 375 px width.

- [ ] **Step 1: Write the failing tests:** `buildSite` to a temp dir returns `missingIris: []`; every `CXM_VERBS`/`CXM_EXT`/`CXM_ACTIVITY_TYPES` IRI has `index.html` and `index.jsonld`; `/errors/CXM-PKG-014/index.html` contains the catalog fix text; `_headers` has the CORS line for `/*.jsonld`; removing a concept page makes `missingIris` non-empty.
- [ ] **Step 2:** `npx vitest run site/test/build.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm run site && npm test`. Expected: PASS. Browser check: serve `site/dist` on `127.0.0.1` with a small `node:http` static server in `site/serve.ts`, then `agent-browser open http://127.0.0.1:<port>/spec/draft/server/`, `agent-browser screenshot` at desktop and at 375 px width; confirm no horizontal scroll. Stop the server by PID.
- [ ] **Step 5:** Commit: `feat(site): static spec site with resolvable IRIs`.

### Task 31: README, implementations list, status

**Files:**
- Rewrite: `README.md`
- Create: `docs/implementations.md`, `docs/STATUS.md` (new, short)

Content: README states what course-xapi-mcp is (design §1 intent quote), the four custody options in a table, the layer map (normative/informative/reference), quick start (`npm install`, `npm start`, add `http://127.0.0.1:8787/mcp/practice` to an MCP client; `cxm validate examples/json-basics`), conformance (`npm run conformance:reference`), licence (Apache-2.0, with the relicensing line from Task 3), status "Draft 0.2, not stable", and that it is not affiliated with ADL, IEEE, 1EdTech, Anthropic or OpenAI. `docs/implementations.md`: the reference (server, bridge, validator, badge issuer) with its conformance results and date; Learning Ledger listed as an LRS/badge implementation in progress; an empty "CATAPULT CTS runs" table. `docs/STATUS.md`: done, verified, deferred (Task 32 items).

- [ ] **Step 1:** Write the files; every command in the README is run once and works.
- [ ] **Step 2:** `npm test`. Expected: PASS.
- [ ] **Step 3:** Diff ready for owner review; then commit: `docs: README, implementations and status for draft 0.2`.

### Task 32 (deferred, owner): Deploy, verify live, go public at 0.2

Needs the owner for DNS, accounts and the decision to go public. The controller runs it only when the owner says so.

- [ ] **Step 1 (owner):** Create the DNS record for `course-xapi-mcp.sqwrlz.com` pointing at the chosen static host. The builder proposes a Spacefast space serving `site/dist` if it can serve a custom domain; otherwise GitHub Pages from the public repo. The controller confirms the choice with the owner before deploying.
- [ ] **Step 2:** Deploy `site/dist`. Verify live: for every IRI the build listed, `curl -s -o /dev/null -w '%{http_code}' -H 'Accept: application/ld+json' <iri>` returns 200 or 303, and `curl -sI <profile jsonld URL>` shows `access-control-allow-origin: *`. Browser check with `agent-browser` on three pages.
- [ ] **Step 3:** Snapshot: copy `spec/draft` to `spec/0.2`, `schema/draft` to `schema/0.2` (never edited afterwards), rebuild and redeploy the site; `npm run requirements -- --strict` passes (no pending requirement).
- [ ] **Step 4:** Run the 1EdTech validator (https://vc.1ed.tech) and the DCC verifier on one credential issued by a deployed reference server; record results in `docs/implementations.md`.
- [ ] **Step 5 (owner):** Make the repo public: `gh repo edit derintolu/course-xapi-mcp --visibility public --accept-visibility-change-consequences`. Preconditions (BC-30): relicensing done, IRIs resolve, `spec/draft` holds the design's decisions, conformance runs against the reference.
- [ ] **Step 6 (owner, later):** Once a public course-server URL exists, the ChatGPT developer-mode connector test per owner answer 21 (owner signs in once in an `agent-browser` window; the agent runs the test and removes the connector). A manual CATAPULT CTS run on the reference bridge before the first release, results in `docs/implementations.md`.
- [ ] **Step 7:** Commit any doc updates (after owner approval): `docs: draft 0.2 published at course-xapi-mcp.sqwrlz.com`.

---

## Self-review notes

- Spec coverage: §5.2 layout (Tasks 2, 11, 12, 24, 27, 30); §5.3 versioning (Task 4 constants, Task 13 specVersion rules); §5.4 extensions (Task 13 code 100, Task 12 registry, Task 22 `cxm_` reservation via `TOOL_NAMES`); §6 package (5, 13, 19, 21, 23); §6.3 sequencing (14); §7 custody (15, 16, 22, 26); §8 launch (17, 18, 20); §9 MCP surface (10, 22); §10 profile (6, 30); §11 badges (9, 28); §12 authoring (21, 23, 25); §13 conformance (24, 27, 29, 32); §14 licence and going public (3, 32); §15 migration (1, 2, 22; the learn-wp-reimagined vendoring is the prototype's own plan).
- Decisions this plan made where the spec is silent are listed in the report to the controller and recorded by Task 12 in `docs/decisions.md`.
