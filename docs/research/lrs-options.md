# LRS options for the learning-mcp prototype (researched 2026-10-27)

Confidence note: most facts come from vendor/GitHub pages fetched today. Where a page did not state something it is marked "not stated"; nothing below is invented. Several GitHub pages did not show last-commit dates.

## 0. What cmi5 actually requires of the LRS side

Source: cmi5 spec, https://github.com/AICC/CMI-5_Spec_Current/blob/quartz/cmi5_spec.md (and the conformance draft https://github.com/AICC/CMI-5_Spec_Current/wiki/%28Indexed%29-cmi5-Conformance-Testing-Requirements-Draft)

In cmi5 the "LMS" is the party that owns the LRS. Note for learning-mcp: our course server plays the cmi5 "LMS" role (issues registration, activityId, fetch URL / auth-token, writes LMS.LaunchData), and the LRS is where the record is stored.

- Statement API: required. LMS must void conflicting statements and must not give the AU credentials to void.
- State API: required (6.2 / section 10). LMS writes the `LMS.LaunchData` state doc before launch, keyed by activityId + agent + registration, stateId `LMS.LaunchData` (contextTemplate, launchMode, moveOn, optional launchParameters, masteryScore, returnURL).
- Agent Profile API: required (section 11, `cmi5LearnerPreferences`).
- Activity Profile API: NOT required of the LMS; AU MAY use it (section 12). (Your brief said Activity Profile is needed for cmi5; per the spec it is optional. Worth keeping in our own standard if desired, but not a cmi5 need.)
- Auth: fetch URL is POST-only, one-time use, returns `auth-token`; token lives for the session. This is LMS/course-server logic, not LRS logic, but the LRS must accept that token (Basic auth style credential) scoped to the session/registration.
- LMS must have an account that can read all data (statements incl. attachments, extensions) for a distinct user across sessions.
- cmi5 inherits all xAPI LRS requirements, so the cmi5 conformance draft ties LMS conformance to passing the ADL LRS test suite.

## 1. WordPress-based LRSs

| Option | WP plugin? | Resources | xAPI ver | Conformance | Licence / price | Maintenance | cmi5 fit |
|---|---|---|---|---|---|---|---|
| GrassBlade LRS | No. Standalone PHP/MySQL app, "not a WordPress plugin"; WP integration is via the paid GrassBlade xAPI Companion plugin | Not stated on vendor page | Not stated | No ADL adopters entry found; vendor/third-party claims only | Commercial. Installable: Starter $399/yr (listed sold out), Standard $999, Premium $2,999, Premium+ $5,999, Enterprise custom; Cloud from ~$144/yr. Licence terms not stated (an iSpring page calls it "open source", unverified) | Not stated | Claims cmi5 content support (authoring tools), not LRS conformance |
| Tin Canny (Uncanny Owl) | Yes, but it is a LearnDash reporting plugin with an embedded LRS | Statements for its own reports; State API not documented in what I found | Not stated | None found | Commercial (paid) | Active product | Not designed as a general LRS endpoint |
| wp-xapi-lrs (Tunapanda) | Yes | Statements only (POST, GET with agent/verb/activity/statementId/related_activities filters). No State, Profiles | Pre-1.0.3 era; "very basic" | None | GPLv3 (not "or later" per readme; incompatible-direction check needed vs GPL-2.0-or-later) | Dead: tested up to WP 4.7.1 | No |
| H5PxAPIkatchu, WP Experience API, wp-h5p-xapi | Yes | These are clients/forwarders or H5P statement loggers, not LRSs | n/a | n/a | various | n/a | No |

Sources: GrassBlade LRS page https://www.nextsoftwaresolutions.com/grassblade-lrs-experience-api/ ; iSpring page https://www.ispringsolutions.com/supported-lms/grassblade-lrs ; Tin Canny https://www.uncannyowl.com/downloads/tin-canny-reporting/ ; wp-xapi-lrs readme https://cdn.jsdelivr.net/wp/wp-xapi-lrs/trunk/readme.txt ; plugin roundup https://wordpress.org/plugins/h5pxapikatchu/ .

Findings:
- I found no maintained open-source WordPress plugin that implements the full xAPI LRS REST API (statements + state + activity profile + agent profile + about). The only open one (wp-xapi-lrs) is statements-only and abandoned since about 2017.
- GrassBlade LRS is the only credible WP-adjacent full LRS, but it is commercial, not a plugin, and its licence is not GPL-compatible as far as published.
- GPL-2.0-or-later compatibility: GPLv3-only code cannot be combined into a GPL-2.0-or-later work; Apache-2.0 is compatible with GPLv3 but not GPLv2-only. Matters for TRAX (GPL-3.0) and Learning Locker (GPL-3.0) only if we link/ship them as part of our code; running them as a separate service over HTTP is not an issue.

Catch for WordPress: there is effectively no ready WP LRS; option (a) means either buying GrassBlade (standalone anyway) or writing our own WP plugin implementing the LRS REST routes (this collapses into option c, hosted on WP/MySQL via `register_rest_route`; WP's REST auth, `If-Match`/ETag headers and `?method=` quirks need care).

## 2. Non-WordPress LRSs

| LRS | Licence | Runtime / DB | xAPI | Conformance | Maintenance | Notes |
|---|---|---|---|---|---|---|
| Yet Analytics SQL LRS (lrsql) | Apache-2.0 | Clojure/JVM, shipped as native-ish executables and Docker image; SQLite (embedded, 3.42), Postgres 14-18, MariaDB 10.6-11.8, MySQL 8.0-9.5 | 1.0.3 and 2.0.0, both on by default (`LRSQL_SUPPORTED_VERSIONS`) | Not stated on its pages; no ADL listing found by search | Active (README lists current DB versions incl. Postgres 18; latest release page shows v0.9.11 "27 Oct", year not shown, release notes are a TODO placeholder) | Best licence fit and simplest to run (single process + SQLite). OIDC auth supported. cmi5 not mentioned |
| TRAX LRS 3 (Starter Edition) | GPL-3.0 (core is dual: GPL3 or Extended Edition licence) | PHP 8.2-8.5, Laravel, Apache 2.4 + mod_rewrite, MySQL 8.0-9.5 or PostgreSQL 13-17, Composer, recommends memory_limit 1024M | Not stated on repo | README says "xAPI conformant"; older `trax/lrs` claimed ADL certification; ADL adopters listing (via search snippet) says mature LRS with cmi5 integration, Laravel 11 | Active: trax3-core v3.1 2025-12-22; trax3-starter-lrs updated 2025-12-26; Moodle plugin updated 2026-09-17 | Closest to "a PHP LRS". GitHub URL https://github.com/trax-project/trax3-starter-lrs shows 1 commit and no releases (install via Composer/git) |
| ADL LRS | Apache-2.0 | Python (manage.py, requirements.txt, Docker), DB not stated | Updated to IEEE 9274.1.1 (xAPI 2.0) per README; listed as conformant to 1.0.3 on ADL adopters | Passes ADL suite historically | Not archived (1,885 commits, 13 open issues), but README says "proof of concept", small user count | Reference implementation, not for production |
| Learning Locker | GPL-3.0 | Node.js (plus MongoDB and Redis per general knowledge; not confirmed on fetched page) | "1.0 and above" | Claims conformant | Not archived; 3,254 commits; no releases shown, Travis badge suggests stale CI; no deprecation notice found | Heavy for a prototype; GPL-3.0 |
| Veracity LRS | Commercial; no open-source licence found | Cloud (lrs.io) or self-hosted Enterprise; "Lite" download (npm `vtc-lrs`, Express + MongoDB, last published ~7 years ago) | Claims all ~1,200 requirements, xAPI 2.0 | Vendor claim only | Active as SaaS | Free cloud tier: 3 LRSs, 100 MB each, 10,000 transactions/day. Fine as a throwaway test LRS, not open source |
| lxHive | GPL-3.0 | PHP + MongoDB | older | unknown | likely dormant | Not recommended |
| Lightweight Node / Workers | none found | n/a | n/a | n/a | n/a | No maintained open-source LRS for Workers/serverless found. `@studiolxd/xapi` is a client with server helpers, not an LRS |

Sources: lrsql https://github.com/yetanalytics/lrsql , https://raw.githubusercontent.com/yetanalytics/lrsql/main/doc/xapi_versioning.md , https://raw.githubusercontent.com/yetanalytics/lrsql/main/doc/startup.md ; TRAX https://github.com/trax-project/trax3-starter-lrs , https://github.com/trax-project , https://packagist.org/packages/trax3/core , ADL adopters snippet via https://adopters.adlnet.gov/products/search/trax/0 ; ADL LRS https://github.com/adlnet/ADL_LRS ; Learning Locker https://github.com/learninglocker/learninglocker ; Veracity https://lrs.texaswic.org/docs/manual/basics/ and https://www.npmjs.com/package/vtc-lrs ; lxHive https://github.com/leogaggl/lxHive .

Unverified: lrsql and TRAX 3 current ADL conformance. Just run the suite (section 3) against whichever we pick.

## 3. ADL LRS conformance test suite

- Repo https://github.com/adlnet/lrs-conformance-test-suite : MIT, not archived, 1,039 commits, 21 open issues, no tagged releases; hosted runner at https://lrstest.adlnet.gov (about 1,400 tests per its title; the hosted site was unreachable when I tried the /about page).
- Tests the MUST requirements of the xAPI spec; `-x` selects spec version, 2.0.x supported (adds context agents/groups, RFC 3339 timestamps, Last-Modified checks; Alternate Request Syntax no longer tested).
- Run: Node >= 8 (use current LTS). `git clone`, `npm install`, then
  `node bin/console_runner.js -e https://host/xapi -a -u USER -p PASS -x 2.0.x`
  Flags: `-g <pattern>` filter by requirement ID/section, `-z` only failures, `-b` bail on first failure, `-d` dirs. Basic auth is the supported mode (OAuth1 flags exist but docs contradict themselves). Flag name for password is inconsistent in docs (`-p` / `--authPass` / `--authPassword`); check `--help`.
- Warning: it persists data and never voids it. Use a throwaway LRS instance, never production.
- No cmi5 tests in this suite; cmi5 conformance is a separate (older, draft) effort.

### Minimal "conformant enough for cmi5" LRS (what to build if we write our own)

Base: xAPI 1.0.3 (optionally 2.0) under `/xapi/` with header `X-Experience-API-Version` required and returned, CORS and `Content-Type` handling, Basic auth.

1. `GET /about` : version list.
2. `/statements`
   - POST (single or array, returns array of ids) and PUT with `statementId` (409 on conflicting duplicate, 204 on identical).
   - Validation of the statement model: actor (Agent/Group; one inverse functional identifier), verb id (IRI), object types (Activity, Agent, StatementRef, SubStatement), result, context (registration UUID, contextActivities, extensions), timestamp, stored, authority, version; reject unknown/invalid fields; ids lowercase-normalised UUIDs.
   - Server sets `id` if missing, `stored`, `authority`, `version`.
   - Voiding: `voided` verb with StatementRef object marks target voided; cannot void a voiding statement; GET by `statementId` vs `voidedStatementId`.
   - GET filters: statementId, voidedStatementId, agent (JSON, with `related_agents`), verb, activity (`related_activities`), registration, since, until, limit, ascending, format (ids/exact/canonical), attachments; `more` pagination URL; consistent ordering by stored time; `Last-Modified`/consistent-through header.
   - Multipart attachments: required by the suite if any attachment tests apply; can be deferred for a prototype but the suite will fail those tests.
3. `/activities/state` GET (single doc or list of stateIds, with `since`), PUT, POST (JSON merge), DELETE (one or all), keyed by activityId + agent + optional registration + stateId; ETag / `If-Match` / `If-None-Match` concurrency (required by suite: 409/412 behaviours).
4. `/agents/profile` GET/PUT/POST/DELETE (cmi5 needs it for `cmi5LearnerPreferences`), same concurrency rules.
5. `/activities/profile` : same shape; optional for cmi5, but cheap once State exists (same table design).
6. `/activities` and `/agents` GET (return Activity definition / Person object); the suite tests these.
7. cmi5 extras: (a) accept session-scoped credentials that can write only for one registration/actor and cannot void; (b) a separate privileged reader; (c) course server writes `LMS.LaunchData` state before launch and may void/reject conflicting statements itself.

## 4. Recommendation

Decision axis is runtime. Order of preference, conditional:

1. If Spacefast (or the host) can run a JVM/Docker container with a volume: run Yet Analytics lrsql (Apache-2.0) with SQLite or Postgres. Both xAPI 1.0.3 and 2.0 are on by default; supports State and profiles; zero custom code. This is the lowest-risk way to get a real, standards-shaped LRS. Run the ADL suite against a scratch instance to confirm (conformance not published on the pages I read).
2. If it can run only PHP + MySQL (shared-WordPress-style hosting): TRAX 3 Starter (GPL-3.0, Laravel, Composer, Apache with mod_rewrite, PHP 8.2+, MySQL 8+/Postgres 13+). Needs shell access for Composer and a 1 GB PHP memory limit; confirm State/Agent Profile support and conformance by running the ADL suite. GPL-3.0 means keep it a separate service reached over HTTP.
3. If it can run only a WordPress site: there is no off-the-shelf open-source option. Choices are GrassBlade LRS (paid, standalone PHP/MySQL, not a plugin, so it needs the same hosting as TRAX anyway) or writing an LRS as a small WP plugin (that is option c on WP/MySQL).
4. If it can run only serverless/edge + SQL (option c): write a minimal LRS yourself. No maintained open-source one exists to fork.

Option (c) effort estimate (my judgement, not sourced): roughly 7 routes and 3 tables (statements, documents keyed by (kind, activity, agent, registration, stateId) with ETag, agents/activities cache). A cmi5-only subset (statements POST/PUT/GET with filters and voiding, State, Agent Profile, about) is roughly 1-2 weeks including tests. Full ADL-suite pass is harder than it looks (about 1,400 tests, strict statement validation, attachments multipart, `more` pagination, ETag preconditions, Group and canonical-format edge cases); expect another 1-2 weeks, and plan to skip attachments and OAuth in the prototype and say so. If we only claim "passes the ADL suite minus attachments", that is honest and enough for the prototype.

Also worth doing regardless: put the course server in front of the LRS (it already holds the privileged credential), issue per-registration tokens to the AU/agent as cmi5 section 8.2 specifies, and never give the learner's agent a credential that can write statements directly. That is what protects the record from tampering, whichever LRS is chosen.

Cheap fallback for a demo while the host question is open: Veracity free cloud LRS (3 LRSs, 100 MB, 10k transactions/day), not open source, throwaway only.
