# cmi5 and learning-mcp: what cmi5 says, and how a learning-mcp course can build on it

Date: 2026-10-27. Research only; no repo was changed.

Abbreviations for sources used throughout:

- **[SPEC]** = cmi5 specification, https://github.com/AICC/CMI-5_Spec_Current/blob/quartz/cmi5_spec.md (section numbers given as §x.y)
- **[XSD]** = https://github.com/AICC/CMI-5_Spec_Current/blob/quartz/v1/CourseStructure.xsd (published IRI `https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd`, [SPEC] §14.0)
- **[EXT-XML]** / **[EXT-XSD]** = https://github.com/AICC/CMI-5_Spec_Current/blob/quartz/v1/examples/extended-cmi5.xml and `.../extended-cmi5.xsd`
- **[CAT]** = https://github.com/adlnet/CATAPULT (README); [CTS-GUIDE] = https://github.com/adlnet/CATAPULT/blob/main/docs/cts/index.markdown; [LTS] = https://github.com/adlnet/CATAPULT/blob/main/lts/README.md; [LTS-TPL] = https://github.com/adlnet/CATAPULT/blob/main/lts/lib/lms.template.js; [LTS-HELP] = https://github.com/adlnet/CATAPULT/blob/main/lts/lib/helpers.js; [CTS-SESS] = https://github.com/adlnet/CATAPULT/blob/main/cts/service/plugins/routes/v1/sessions.js
- learning-mcp files: `docs/spec.md`, `RULES.md`, `docs/xapi-profile.md`, `packages/core/src/schema.ts`, `examples/json-basics/course.json` (all in /Users/cedarstone/Projects/learning-mcp)

Where I state an inference rather than a fact from a source, it is marked **(inference)**.

---

## 0. Version and standardisation status

- **Current release: Quartz, 1st Edition (June 1, 2016).** [SPEC] "Revision History"; also the repo README, https://github.com/AICC/CMI-5_Spec_Current. Versioning: Stones = major, Editions = minor, errata unversioned ([SPEC] Revision History). The `quartz` branch has had errata-only commits since; the latest is 2024-09-06 ("Replace reference for publisher ID in section 10.2.1", PR #816), https://github.com/AICC/CMI-5_Spec_Current/commits/quartz.
- cmi5 Quartz normatively references **xAPI 1.0.3** ([SPEC] §2.0). learning-mcp already writes statements valid under both 1.0.3 and 2.0 (`RULES.md` §6.2), so there is no xAPI-version conflict.
- **IEEE: in progress, not published.** IEEE P9274.3.1, "Standard for Packaging, Launch, and Run-time of Experience API (xAPI) in Session-based Learning", working group "xAPI cmi5 Working Group", sponsor IEEE C/LT (https://sagroups.ieee.org/9274-3-1/). IEEE SA lists it as **Active PAR**, PAR approved **2023-02-15**, no ballot information (https://standards.ieee.org/ieee/9274.3.1/11183/). I found no ballot or publication through October 2026; a third-party note dated 2026-08-19 also says "IEEE P9274.3.1 remains Active PAR" and "cmi5 current release remains Quartz 1st Edition" (https://github.com/ContextualWisdomLab/learning-interoperability-contracts/issues/3). Wikipedia says the IEEE work may become a "2.0" version (https://en.wikipedia.org/wiki/Aviation_Industry_Computer-Based_Training_Committee); treat that as unconfirmed.
- **Consequence for learning-mcp:** build against Quartz plus the CATAPULT requirement IDs (published on npm as `@cmi5/requirements`, [CAT] README "Requirements"), and plan for one revision when P9274.3.1 is published.

---

## 1. Course structure

### 1.1 Package

- A course package is an XML course structure, either standalone or inside a ZIP. Inside a ZIP it MUST be named `cmi5.xml` and sit at the ZIP root. It MUST conform to the CourseStructure.xsd ([SPEC] §14.0, §14.1).
- An LMS MUST import standalone XML and 32-bit and 64-bit ZIP ([SPEC] §14.0). Without a ZIP, every URL MUST be fully qualified ([SPEC] §14.2). AUs may be "packaged by reference", meaning remote URLs ([SPEC] §14.0).
- A course MUST ship course structure data that meets §13 and §14, and MUST NOT implement any cmi5 feature in a non-conforming way ([SPEC] §4.4).
- The LMS MUST support more than 1000 AUs and MUST support structures that conform to the XSD ([SPEC] §6.1). The LMS MUST strip leading and trailing whitespace from every data element on import ([SPEC] §13.1).

### 1.2 Elements and attributes ([SPEC] §13.1.1 to §13.1.4; [XSD])

Root `<courseStructure>` (namespace `https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd`), sequence:

1. `<course id="IRI">` (required): `<title>`, `<description>` (langstring lists, both required), then extension elements.
2. `<objectives>` (optional): one or more `<objective id="IRI">` with `<title>` and `<description>` ([SPEC] §13.1.3).
3. One or more `<au>` or `<block>`, in any mix, as a choice.
4. Extension elements.

`<block id="IRI">` ([SPEC] §13.1.2): `title`, `description` (required), `objectives` (`<objective idref>` references, optional), then one or more `au`/`block` (blocks nest), then extensions. **A block has no moveOn, masteryScore or sequencing attributes.** The id MUST be unique within the course structure.

`<au id="IRI">` ([SPEC] §13.1.4):

| Item | Kind | Required | Rules |
| --- | --- | --- | --- |
| `id` | attr, IRI | yes | globally unique; unique in the structure; defined by the AU publisher |
| `launchMethod` | attr | no, default `AnyWindow` | `OwnWindow` or `AnyWindow`; browser window context only |
| `moveOn` | attr | no, default `NotApplicable` | `Passed`, `Completed`, `CompletedAndPassed`, `CompletedOrPassed`, `NotApplicable` |
| `masteryScore` | attr | no | decimal 0 to 1, up to 4 decimal places |
| `activityType` | attr | no | IRI (typed `xs:string` in the XSD); shown to the user before first launch |
| `title`, `description` | elements | yes | langstring |
| `objectives` | element | no | `objective idref` references |
| `url` | element | yes | relative or absolute; **"To accommodate 'non-browser' applications, an application specific protocol MAY be used in the url: `<application>://<URL to content>`"**; the rest MUST follow RFC 1738; any query string in it MUST be merged with the cmi5 launch parameters |
| `launchParameters` | element | no | free string set by the course designer, passed to the AU in LMS.LaunchData |
| `entitlementKey` | element | no | free string, for the AU to check that the LMS is entitled to use it |

### 1.3 Extensions

- **Spec text:** "Course Designers MAY place their own namespaced elements into the course structure... they MUST provide a XML Schema Definition and SHOULD provide a human readable specification... These extensions MUST keep the course structure XML valid. **An importing LMS MAY ignore these elements.** Therefore the extension SHOULD be created in such a manner that a course is still useable if the LMS does not support the additional elements." The spec also recommends an open licence for the extension spec ([SPEC] §13.1.5).
- **XSD mechanics:** an `anyElement` group, `<xs:any namespace="##other" processContents="lax" minOccurs="0" maxOccurs="unbounded"/>`, and an `anyAttribute` group, `<xs:anyAttribute namespace="##other" processContents="lax"/>` ([XSD], bottom). So:
  - extension elements must be in a **different namespace** from cmi5's
  - `lax` means a validator checks them only when it has their schema, and otherwise accepts them
  - they are allowed **only at the end** of each sequence: after `description` inside `<course>`; after the au/block choice in `<courseStructure>` and in `<block>`; after `entitlementKey` in `<au>`; after `langstring` in text types. Foreign attributes are allowed on `courseStructure`, `course`, `block`, `au`, `objectives` and `langstring`.
  - the `<objective>` definition inside `objectivesType` (an `xs:all`) has **no** extension hook.
- **Worked example:** [EXT-XML] puts `kw:keyword` elements at the end of an `<au>` and a `kw:keywords` element at the end of `<courseStructure>`, in their own namespace. Caveat: [EXT-XSD] imports the cmi5 namespace as `http://www.adlnet.gov/cmi5/CourseStructure.xsd`, which differs from the real target namespace `https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd` in [XSD]. Don't copy that import line.
- **What an LMS must do with unknown extensions:** nothing. It MAY ignore them, and it must still import the course because the XML stays XSD-valid ([SPEC] §13.1.5, §6.1). **No rule makes an LMS keep extensions on export** (§6.1 only says export SHOULD be offered). **(inference)** A learning-mcp extension may be lost after an LMS round trip, so the canonical copy must live with the course server, not in the LMS.

---

## 2. Launch

### 2.1 The contract

1. Before launch, the LMS records a **`launched`** statement ([SPEC] §9.3.1) and writes the **`LMS.LaunchData`** State document for (activityId, agent, registration) ([SPEC] §10.1).
2. The LMS opens the AU URL with the query parameters **`endpoint`, `fetch`, `actor`, `registration`, `activityId`**. Each is URL-encoded, they come in any order, and they must not collide with the AU's own query names ([SPEC] §8.1).
   - `endpoint`: the LMS xAPI base URL ([SPEC] §8.1.1).
   - `fetch`: a one-time URL for the auth token ([SPEC] §8.1.2).
   - `actor`: an Agent with an `account`, from the authenticated learner, and SHOULD NOT contain sensitive PII ([SPEC] §8.1.3, §9.2).
   - `registration`: a UUID for the learner's enrolment in the course ([SPEC] §8.1.4).
   - `activityId`: an IRI **generated by the LMS** that MUST NOT equal the AU's publisher id. It is stable within a registration and SHOULD be stable across registrations. The AU MUST use it as the object id of every cmi5 defined statement ([SPEC] §8.1.5).
3. **Fetch:** the AU MUST HTTP **POST** (GET is not allowed) to `fetch`. The response is 200, `application/json`, `{"auth-token": "..."}`. The token goes in the `Authorization` header (Basic scheme per RFC 1945 §11.1) of every xAPI call, and is valid only for the session. The URL is one-time: repeat calls SHOULD fail with `error-code` 1, 2 or 3 ([SPEC] §8.2.1 to §8.2.3).
4. The AU reads `LMS.LaunchData` ([SPEC] §10.2) and MUST NOT modify or delete it ([SPEC] §10.2.1). Its fields:
   - `contextTemplate` (required): carries the `sessionid` extension and the publisher-id grouping activity. The AU MUST use it as the template for the context of **all** statements and MUST NOT overwrite its values ([SPEC] §10.2.1).
   - `launchMode` (required): `Normal`, `Browse` or `Review`. In Browse and Review the AU sends only `initialized` and `terminated` among the cmi5 defined statements, so no satisfaction data ([SPEC] §10.2.2).
   - `launchParameters`, `masteryScore`: present if authored; the LMS may override the authored values ([SPEC] §10.2.3, §10.2.4).
   - `moveOn` (required; the LMS may override it) ([SPEC] §10.2.5).
   - `returnURL` (optional): the AU MUST redirect the browser window or frame to it on termination ([SPEC] §10.2.6).
   - `entitlementKey` {`courseStructure`, `alternate`} ([SPEC] §10.2.7).
5. The AU MUST read the Agent Profile document **`cmi5LearnerPreferences`** (`languagePreference`, `audioPreference`) on startup. A 403 when it writes to that document is not an error ([SPEC] §11, §11.1, §11.2).
6. **Session:** "a period of time marked by the launch of an AU until its termination (or abandonment)" ([SPEC] §3.0). The LMS generates the `sessionid` and puts it in LaunchData before launch ([SPEC] §9.6.3.1). Launching again with the same registration while a session is active MUST abandon the earlier session ([SPEC] §9.3.6). After `terminated`, the LMS waits a period it chooses and then rejects further statements for that session ([SPEC] §9.3.8).

### 2.2 Browser-bound versus transport-agnostic parts

| Part | Browser/LMS-bound? | Source |
| --- | --- | --- |
| `launchMethod` (OwnWindow/AnyWindow) | browser only | [SPEC] §8.1, §13.1.4 |
| `returnURL` | browser only ("in a web-browser environment") | [SPEC] §10.2.6 |
| Launch by URL with query string | assumes the LMS opens a URL. The `url` may use an application scheme for non-browser apps, but the query-string parameters still apply | [SPEC] §8.1, §13.1.4 `url` |
| "Other launch environments" | explicitly **not specified**: such implementations "will use the same REST communication interface as specified in xAPI" | [SPEC] §8.3 |
| fetch POST and auth token | plain HTTP, so any client works (including a server-to-server call) | [SPEC] §8.2 |
| xAPI Statements, State and Agent Profile calls | plain xAPI REST, transport-agnostic | [SPEC] §6.0, §7.0, §10, §11 |
| Statement rules (verbs, result, context, ordering) | transport-agnostic data rules | [SPEC] §9 |
| Course structure XML | transport-agnostic; an LMS must import it | [SPEC] §13, §14 |
| LMS role (registration, actor, activityId, sessionid, launched/abandoned/waived/satisfied) | assumes an LMS **integrated with an LRS** ("the term 'LMS' refers to an integrated entity of LMS and LRS") | [SPEC] §3.0, §4.2, §6.0 |

---

## 3. Statements

### 3.1 The three kinds ([SPEC] §7.1.3)

- **cmi5 defined:** uses a cmi5 verb, the cmi5 category activity `https://w3id.org/xapi/cmi5/context/categories/cmi5`, and the context template.
- **cmi5 allowed:** uses **any verb** and the cmi5 context template (so it carries the `sessionid` and the publisher-id grouping), but **does not** include the cmi5 category. Allowed statements MUST come between `initialized` and `terminated`, and "are not considered in 'cmi5 defined' session management and satisfaction rules".
- **cmi5 not-allowed:** anything else.

The LMS MUST record and report every defined and allowed statement that it does not reject, whatever the verb ([SPEC] §9.3). "AUs MAY use additional verbs" ([SPEC] §9.3). Extensions not defined by cmi5 MAY be used ([SPEC] §9.6.3). The LMS SHOULD reject, and otherwise MUST void, statements that conflict with §9 ([SPEC] §6.3).

**For learning-mcp:** `answered`, `experienced`, `branched`, `caught`, `placed`, and `passed`/`failed` on files and checkpoints can all be **cmi5 allowed** statements. Their objects may be any activity (beat, checkpoint, file and so on), they may carry the learning-mcp profile category and extensions, and they must carry the LMS contextTemplate (sessionid plus publisher grouping) and sit inside an initialized-to-terminated session. Only the object-is-the-AU rule (§9.4) and the result rules (§9.5) are limited to cmi5 defined statements.

### 3.2 Defined verbs ([SPEC] §9.3.1 to §9.3.9)

| Verb | IRI | Issued by | Key obligations |
| --- | --- | --- | --- |
| launched | `http://adlnet.gov/expapi/verbs/launched` | LMS | before launch; one per session; context carries `launchmode`, `launchurl`, `moveon`, plus `masteryscore` and `launchparameters` when present (§9.6.3.2 to §9.6.3.7) |
| initialized | `http://adlnet.gov/expapi/verbs/initialized` | AU | first statement of any kind in the session; one per session |
| completed | `http://adlnet.gov/expapi/verbs/completed` | AU | when the learner "has experienced all relevant material"; **at most one per registration** |
| passed | `http://adlnet.gov/expapi/verbs/passed` | AU | **at most one per registration**; a scaled score, if given, must be ≥ masteryScore |
| failed | `http://adlnet.gov/expapi/verbs/failed` | AU | a scaled score, if given, must be < masteryScore |
| abandoned | `https://w3id.org/xapi/adl/verbs/abandoned` | LMS | for an abnormal end; no statements accepted afterwards in that session |
| waived | `https://w3id.org/xapi/adl/verbs/waived` | LMS | AU requirements met by other means; needs the `reason` extension; own session id; one per AU per registration |
| terminated | `http://adlnet.gov/expapi/verbs/terminated` | AU | last statement of any kind in the session |
| satisfied | `https://w3id.org/xapi/adl/verbs/satisfied` | LMS | object is the **block or course** (LMS-generated ids, types `https://w3id.org/xapi/cmi5/activitytype/block` and `.../course`, §9.4); SHOULD NOT repeat per object per registration |

### 3.3 Ordering rules ([SPEC] §9.3; order is by `timestamp`)

- Per AU session: no defined verb twice; at most one of {passed, failed}; `initialized` first and `terminated` last, counting defined **and allowed** statements.
- Per registration, per AU: zero or one `completed`; zero or one `passed`; **no `failed` after a `passed`**.
- LMS: may send several `satisfied` statements in a session, but SHOULD NOT send more than one per block or course per registration; at most one `abandoned` per session; at most one `waived` per session and per AU per registration.
- `initialized` MUST follow `launched` "within a reasonable period of time" ([SPEC] §9.3.2).

### 3.4 Required context ([SPEC] §9.6)

- `registration`: the LMS-provided value ([SPEC] §9.6.1).
- `contextActivities`: everything in the contextTemplate ([SPEC] §9.6.2).
- The cmi5 category, on defined statements only ([SPEC] §9.6.2.1).
- The **moveOn category** `https://w3id.org/xapi/cmi5/context/categories/moveon`, on defined statements whose result has `success` or `completion`, and on no others ([SPEC] §9.6.2.2).
- The **publisher-id grouping activity**: the unaltered `au@id` from the course structure, placed in contextTemplate grouping by the LMS ([SPEC] §9.6.2.3).
- The `sessionid` extension `https://w3id.org/xapi/cmi5/context/extensions/sessionid`, required on every defined and allowed statement from both LMS and AU ([SPEC] §9.6.3.1).
- The `masteryscore` extension, on passed/failed statements decided by masteryScore ([SPEC] §9.6.3.2).
- Every statement needs a UTC `timestamp` ([SPEC] §9.7). The AU assigns a UUID `id` to every statement ([SPEC] §9.1).

### 3.5 Result rules ([SPEC] §9.5)

- `score`: only on passed or failed. `raw` needs `min` and `max`. It must agree with masteryScore ([SPEC] §9.5.1).
- `success`: `true` on passed and waived, `false` on failed, absent on all other defined statements ([SPEC] §9.5.2).
- `completion`: `true` on completed and waived, absent otherwise ([SPEC] §9.5.3).
- `duration` (ISO 8601) is **required** on terminated, completed, passed, failed (AU) and abandoned (LMS) ([SPEC] §9.5.4).
- Result extensions:
  - `progress` (0 to 100), optional; SHOULD NOT appear on or after completed ([SPEC] §9.5.5.1)
  - `reason`, required on waived. Suggested values: "Tested Out", "Equivalent AU", "Equivalent Outside Activity", "Administrative" ([SPEC] §9.5.5.2).

### 3.6 Object rule ([SPEC] §9.4)

In every defined statement except satisfied, the object **is the AU**, with `id` = the launch `activityId`.

---

## 4. Roles and satisfaction

### 4.1 LMS versus AU duties

- **LMS** ([SPEC] §5.0, §6.0 to §6.3):
  - is an LRS and conforms to xAPI's LRS requirements; has an account that can read all data for any learner ([SPEC] §4.2)
  - imports the course structure and the ZIP or XML package
  - creates registrations, the actor, activityIds, session ids, LaunchData and contextTemplate
  - issues launched, abandoned, waived and satisfied
  - evaluates moveOn
  - rejects or voids statements that break the rules
  - never gives the AU credentials that can void statements
- **AU** ([SPEC] §5.0, §7.0, §7.1):
  - parses the launch parameters, does the fetch, reads LaunchData and the learner preferences
  - sends initialized first and terminated last
  - sends completed/passed/failed according to its own (designer-defined) criteria
  - follows launchMode
  - uses the contextTemplate in every statement

### 4.2 Satisfaction ([SPEC] §13.1.4 `moveOn`, §9.3.9, §9.6.1)

- **AU satisfied** when its moveOn condition is met: `Passed` (a passed statement), `Completed`, `CompletedAndPassed`, `CompletedOrPassed`, or `NotApplicable` (always satisfied). A **waived** AU counts as satisfied (§9.3.9).
- **Block satisfied** when **all** its member AUs (and nested blocks) are satisfied. **Course satisfied** when all member AUs and blocks are satisfied ([SPEC] §13.1.4 `moveOn` "Usage"). The LMS then MUST issue `satisfied` for the block or course (§9.3.9). Satisfied statements caused by an AU session use that session's id; others get a fresh session id (§9.3.9).
- The LMS MUST evaluate moveOn at registration time, so `NotApplicable` AUs can trigger `satisfied` straight away (§9.6.1).
- **Sequencing:** cmi5 has none beyond an "implied sequence" ([SPEC] §3.0 "Course Structure"). Satisfaction is used "for prerequisites and sequencing" by the LMS, but no prerequisite or branching model is defined (§13.1.4 `moveOn` Usage). There is no "any one of", no "this path only", and no conditional routing.

---

## 5. Conformance testing (CATAPULT)

- **What exists:** ADL's CATAPULT project (Rustici Software, Apache-2.0) delivers ([CAT] README):
  - a **cmi5 Player**, "a web service intended to be integrated into an LMS to provide the cmi5 launching system capabilities", with an external LRS
  - a **Content Test Suite (CTS)** for testing cmi5 packages (web service plus browser UI)
  - an **LMS Test Suite (LTS)**: a package library, a manual procedure, and a CLI for CI
  - **requirements JSON** mapping requirement IDs to spec text (npm `@cmi5/requirements`)
  - sample course packages

  The repository was last committed on 2026-01-20 (GitHub API).
- **CTS, which tests content and AUs:**
  - You upload a ZIP package or a `cmi5.xml`. Import errors such as XSD failures are shown ([CTS-GUIDE] "Adding a Course").
  - You create a test registration with a chosen or random actor, set Agent Profile values, then launch, waive or abandon each AU. Browse and Review modes are available ([CTS-GUIDE] "Testing").
  - The AU runs "in an iframe or a new window" beside a statement log ([CTS-GUIDE]).
  - Server-side, the CTS rewrites the launch `endpoint` to its own proxy `/api/v1/sessions/{id}/lrs` and checks each LRS request (statements, State, Agent Profile) against the spec, logging "Spec requirement violated" events ([CTS-SESS], around lines 198 to 204 and 402 to 636).
- **LTS, which tests LMSs:**
  - The LMS imports CATAPULT's test packages (e.g. `001-essentials`, `002-allowed`, `003-launchMethod-OwnWindow`, `004-1-moveOn-Completed`, ...).
  - For automation you write an adapter exposing `setup`, `teardown`, `getLrsEndpoint`, `getLrsAuthHeader`, `importCourse`, `getLaunchUrl`, `cleanup`, `hasWaive`/`waiveAU`, `hasAbandon`/`abandonSession` ([LTS]; [LTS-TPL]).
  - It then runs the test AUs in a headless browser (`jest-puppeteer`; `page.goto(launchUrl)` in [LTS-HELP]) and checks the resulting statements in the LRS.
- **Can it test a non-browser AU?**
  - CTS: **partly, with a bridge.** **(inference)** Its checks run in an HTTP proxy rather than in the browser, so any client that receives the launch URL and follows the protocol (POST fetch, GET LaunchData, POST statements) is checked. The launch itself opens the AU URL in an iframe or window, so a learning-mcp AU needs a small web "launch bridge" page at its `url`, which then hands the session to the MCP server. The CTS cannot see the MCP conversation, only the xAPI traffic.
  - LTS: **no.** It tests LMSs using its own browser-based test AUs. A learning-mcp server would face the LTS only if it claimed to be a cmi5 LMS, and then it would have to import arbitrary cmi5 packages and implement an LRS ([LTS], [LTS-TPL]).

---

## 6. Fit analysis for learning-mcp

### 6.1 Mapping table

| learning-mcp concept | cmi5 construct | Verdict |
| --- | --- | --- |
| **Course** (`id`, `title`, `description`, `version`, `language`, `activityBase`, `license`) | `<course id>` + title/description langstrings ([SPEC] §13.1.1). `activityBase` → `course@id` | **Maps.** `version`, `license`, the `rules` list and the `placement` config need a course-level **extension** (allowed after `description` in `<course>`) |
| **Path** | `<block>` ([SPEC] §13.1.2) | **Maps structurally.** `status: coming-soon`, `tagline` and `placementHints` need an extension. The satisfaction meaning **conflicts** when a course has several paths (see C2) |
| **Lesson** | `<au>`: one lesson = one AU ([SPEC] §13.1.4). `url` = the course server's launch bridge. `moveOn` = `CompletedAndPassed` with a checkpoint, `Completed` without one. No masteryScore | **Maps.** `minutes`, `sources`, `starterFiles` and the lesson body need an extension inside `<au>` |
| **Beat** | nothing in the structure. At runtime: cmi5 allowed `experienced`/`answered` with the beat as object | **Extension needed** (content); statements fit as allowed |
| **Checkpoint** | nothing in the structure. Outcome → the AU's cmi5 defined `passed`/`failed` (object = AU activityId, moveOn category, duration) **plus** the current allowed `passed`/`failed` on the checkpoint activity | **Extension needed** (question, rubric, kind). Runtime **partly conflicts**: one passed/failed per session, none after a pass (C2) |
| **Branch** (`when`, `success`, `to`) | no equivalent; cmi5 has no conditional sequencing (§4.2 above) | **Extension needed.** Runtime record = allowed `branched`. Routing is invisible to a plain LMS |
| **Rubric** | none | **Extension needed** (stays server-side and agent-facing) |
| **Check** (contains/regex/json) | none. Results = allowed `passed`/`failed` on the file activity | **Extension needed** |
| **Planted bug** | none. Result = allowed `caught` | **Extension needed.** Note: in a package given to an LMS the bug and fix checks sit in plain XML. That's acceptable because the AU (server) never sends them to the agent, but the course file should not be served to agents raw |
| **Placement** | no equivalent. The closest is LMS-issued **`waived`** with `reason: "Tested Out"` for skipped lessons ([SPEC] §9.3.7, §9.5.5.2), plus allowed `placed` | **Extension needed + role conflict**: only the LMS may waive (C1). Placement also happens outside any AU session, so `placed` would be "not-allowed" unless it runs in a session (see R3) |
| **Record** (learner-owned, many courses, statements) | the LRS's statements for one actor across registrations; cmi5 assumes the LMS's integrated LRS holds them ([SPEC] §3.0, §4.2) | **Conflicts** in ownership and location (C4); compatible in content (statements, registration per course) |
| **Record handle** (128-bit bearer) | closest: the `fetch` URL and `auth-token` (bearer credential, session-limited, one-time, [SPEC] §8.2) | **No equivalent; keep as is.** Different lifetime (the handle outlives sessions). Never put it in statements, as now (`RULES.md` §5.2) |
| **Registration** (UUID per learner per course) | `registration` ([SPEC] §3.0, §8.1.4, §9.6.1) | **Maps**, but cmi5 says the **LMS** generates it (C1) |
| **Anonymous actor** (`account.homePage = w3id.org/learning-mcp/learner`) | actor = an Agent with `account`, defined by the LMS, SHOULD avoid PII ([SPEC] §8.1.3, §9.2) | **The shape conforms**; who assigns it **conflicts** under an LMS launch (C3) |
| **Agent session** (MCP; 2026-07-28 is stateless) | AU **session**: launched … initialized … terminated/abandoned, with an LMS `sessionid` ([SPEC] §3.0, §9.6.3.1) | **Extension of behaviour needed**: the server must define session start and end, since MCP gives none. Duration becomes required |
| **Activity IRIs** (`{activityBase}/lessons/{id}`) | the publisher id (`au@id`) goes in grouping; defined statements use the **LMS-generated** activityId, which must differ ([SPEC] §8.1.5, §9.6.2.3) | **Conflicts mildly**: today's `completed`/`passed` on `/lessons/{id}` would have to move to the activityId, or stay as allowed statements |
| **Teaching rules** (core + `course.rules`) | none. `launchParameters` is a free string the LMS may rewrite ([SPEC] §10.2.3), so it is unsuitable | **Extension needed** |
| **`launchMode`** | Normal/Browse/Review ([SPEC] §10.2.2) | **Maps neatly**: Review = revisit a done lesson with no pass/fail; Browse = look around without checkpoints. Not modelled in learning-mcp today |
| **Learner preferences** | Agent Profile `cmi5LearnerPreferences` ([SPEC] §11) | **Small add**: the server must read it when an LMS launches it; course `language` stays per course |
| **xAPI profile** (verbs, types, extensions, category) | cmi5 allows any verbs and extensions in allowed statements ([SPEC] §7.1.3, §9.3, §9.6.3) | **Fits.** The current profile's ADL passed/failed/completed IRIs already match cmi5 |

### 6.2 Hard conflicts

**C1. Who is the LMS and who is the AU, when the "launcher" is an AI agent connecting to an MCP server.**
cmi5 assumes an LMS (with an LRS) that authenticates the learner, assigns actor and registration, writes LaunchData and launches the AU by URL ([SPEC] §5.0, §8.1). In learning-mcp, nobody launches. The agent connects to the server, and the server holds content, logic and statement building. The agent is neither: it is the presentation layer inside the AU.

- **Option A: the server plays both roles for its own record ("self-hosted LMS+AU").**
  - How: the server generates registration, activityId and sessionid; writes `launched`, `initialized`, …, `terminated`; and issues `waived`/`satisfied` itself, all into the learner's record.
  - Pros: no new infrastructure; standalone use keeps working; statements are cmi5-shaped.
  - Cons: not a conformant cmi5 LMS, because there is no LRS REST API and no import of arbitrary packages ([SPEC] §4.2, §6.1), so it can't pass the LTS. "cmi5 defined" statements issued without a real LMS may surprise a downstream LRS that assumes LMS governance.
- **Option B: a real LMS launches; the server is the AU behind a launch bridge.**
  - How: the AU `url` is an https bridge page on the course server. It reads the launch parameters, does the fetch POST **server-side**, reads LaunchData, and shows "continue in your agent" with an MCP connector URL bound to that session. The server then posts statements to the LMS `endpoint`.
  - Pros: real cmi5 conformance for the AU side, testable in the CTS; LMSs get real tracking.
  - Cons: the browser hop is mandatory; the auth token is "limited to the duration of the session" ([SPEC] §8.2.1), so long or paused agent sessions risk expiry; an LMS may abandon the session if the learner relaunches ([SPEC] §9.3.6).
- **Option C: the agent host plays the LMS.**
  - How: a future agent-side "learning wallet" holds the record and launches courses.
  - Pros: cleanest ownership story.
  - Cons: no host does this today, and it depends on vendors.

Tradeoff: A is needed for the main use case (no LMS), B for institutional adoption. They are compatible if the server builds statements the same way in both modes, with only the source of actor/registration/sessionid/activityId differing.

**C2. Branching, placement and multiple paths versus moveOn.**
cmi5 satisfaction is "all AUs in the block/course satisfied", with no routing ([SPEC] §13.1.4). learning-mcp skips lessons through placement, routes through branches (including back to review), and lets a course hold several paths that a learner may not all take. The per-registration rules ([SPEC] §9.3) also say: one `passed` per AU, and no `failed` after `passed`.

- **Skipped lessons (placement):**
  - (a) Issue `waived`, reason "Tested Out", in the LMS role. This works in mode A. In mode B, only the LMS can waive, so the server can only *report* the skip as an allowed `placed` statement and the LMS stays unsatisfied unless an admin waives.
  - (b) Mark optional lessons `moveOn="NotApplicable"`. They are then always satisfied, which hides real progress.
  - (c) Accept "course not satisfied" for skippers. This is honest but unhelpful.
- **Branch retries:**
  - End the AU session (`terminated`) whenever a checkpoint resolves. A failed branch then puts `failed` in session N and a later pass puts `passed` in session N+1. That is legal: one of passed/failed per session, and failed may come *before* passed.
  - Never send a cmi5 defined `failed` after the lesson has passed. Later reviews would use launchMode `Review` or allowed statements only.
  - Tradeoff: more sessions in reports, in exchange for full conformance.
- **Several paths in one course:**
  - (a) One block per path, and use **block** satisfaction as the meaningful signal. Course `satisfied` happens only if every path is done. This is accurate cmi5 but misleading as "course done".
  - (b) Publish one cmi5 course structure per path. That is clean satisfaction, but placement across paths becomes "which course to enrol in", and registration becomes per path.
  - (c) Make off-path lessons `NotApplicable`. Rejected: it misreports.

**C3. Anonymous, self-assigned actor versus LMS-assigned actor.**
cmi5: "The `actor` property MUST be defined by the LMS" ([SPEC] §9.2). The AU MUST use the launch actor ([SPEC] §8.1.3). learning-mcp mints `account{homePage: w3id.org/learning-mcp/learner, name: uuid}` (`RULES.md` §6.3). The shape is compatible (an Agent with `account`, no PII).

- **Option 1: mode-dependent actor.** Mode A uses the anonymous actor; mode B uses the LMS actor. The record has to accept several actors and its "one learner" invariant weakens. `RULES.md` §5.1 and §6.3 must allow the LMS actor under an LMS launch.
- **Option 2: dual write in mode B.** Send the LMS-actor copy to the LMS and keep an anonymous-actor copy in the learner record, linked by `context.statement` or by a shared statement id. That gives clean ownership, but two statements describe one event, and the ids must differ because xAPI ids are unique per LRS. **(inference)**
- **Option 3: the learner links the identities later** through the "link statement" idea (`docs/spec.md` §11 Q3). Lowest effort, and it leaves LMS data separate.

**C4. Statements returned to the learner versus sent to an LRS, and one record spanning courses versus per-course registrations.**
cmi5's AU sends every statement to the LMS endpoint in real time; the LMS/LRS is the system of record ([SPEC] §6.0, §7.0, §8.1.1). learning-mcp's server never posts to an LRS without the learner's explicit request (`RULES.md` §5.5), and the record is learner-held and spans courses (`docs/spec.md` §9). Registration itself is compatible: learning-mcp already uses one registration per learner per course.

- **Option 1: an LMS launch counts as the learner's request** for that registration's statements. Amend `RULES.md` §5.5 to say so. Simple, and matches what learners expect from an LMS course.
- **Option 2: queue and confirm.** Show the learner what will be sent before each post. Most consent-respecting, but it breaks cmi5's "terminated within the session" timing and risks abandoned sessions.
- **Option 3: post to the LMS only the cmi5 defined statements** (launched/initialized/completed/passed/failed/terminated) and keep the rich allowed statements (answers, rationales) in the learner record unless the learner opts in. This is the privacy-minimal choice and cmi5-legal, because allowed statements are optional. Tradeoff: the LMS sees outcomes, not learning evidence.

**Smaller conflicts to fix in the profile**

- `duration` is required on completed, passed, failed and terminated ([SPEC] §9.5.4); not emitted today.
- Defined statements need the AU activityId as object ([SPEC] §9.4), not `/lessons/{id}`.
- learning-mcp's lesson `completed` means "success branch chosen" (`RULES.md` §3.4), while cmi5 `completed` means "experienced all relevant material" ([SPEC] §9.3.3). Re-time it to after the last beat (and the bug), and put success on `passed`, with `moveOn="CompletedAndPassed"`.
- A path `completed` maps to an LMS `satisfied` on the block, not an AU verb.
- MCP has no session lifecycle, so the server must define session start (first tool call on a lesson), end (lesson resolved, or the learner leaves) and abandonment (inactivity timeout) itself.

### 6.3 Recommendation

**Shape: "a learning-mcp course *is* a valid cmi5 course package with a namespaced learning-mcp extension. Each path is a block, each lesson is an AU, and the course server implements the AU role always and the LMS role only when no LMS launched it."**

**R1. Course format.**
- Make `cmi5.xml` (XSD-valid, standalone or zipped) the canonical publication format, with an `lm:` namespace (e.g. `https://w3id.org/learning-mcp/course/v1`) whose XSD and human-readable spec the project publishes under an open licence, as [SPEC] §13.1.5 asks.
- The current JSON bundle becomes either the content of those extension elements, or a JSON file in the ZIP referenced by an `lm:bundle` element. **(inference)** Keeping JSON as the authored source and generating cmi5.xml from it is the least disruptive path; `parseCourse` then runs on the extension payload.
- Extension elements go at the allowed tail positions only (§1.3 above).

```xml
<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd"
                 xmlns:lm="https://w3id.org/learning-mcp/course/v1">
  <course id="https://example.org/learning-mcp/courses/json-basics">
    <title><langstring lang="en">JSON basics</langstring></title>
    <description><langstring lang="en">A two-lesson example course...</langstring></description>
    <lm:course version="0.1.0" license="CC-BY-SA-4.0" rulesVersion="v0.1">
      <lm:rule>When the learner writes JSON, ask them to read it back as data types...</lm:rule>
      <lm:placement maxQuestions="2">Find out whether the learner has written JSON by hand before...</lm:placement>
      <lm:mcp endpoint="https://json-basics.example.org/mcp"/>
    </lm:course>
  </course>
  <block id="https://example.org/learning-mcp/courses/json-basics/paths/json" lm:status="live">
    <title><langstring lang="en">Read and write JSON</langstring></title>
    <description><langstring lang="en">From the six value types to fixing a real config file.</langstring></description>
    <au id="https://example.org/learning-mcp/courses/json-basics/lessons/what-is-json"
        moveOn="CompletedAndPassed" launchMethod="OwnWindow"
        activityType="http://adlnet.gov/expapi/activities/lesson">
      <title><langstring lang="en">What JSON is</langstring></title>
      <description><langstring lang="en">...</langstring></description>
      <url>https://json-basics.example.org/cmi5/launch?lesson=what-is-json</url>
      <lm:lesson minutes="5"><!-- sources, beats, checkpoint, branches, bug, checks --></lm:lesson>
    </au>
    <!-- fix-the-config AU ... -->
    <lm:path><lm:placementHints>Start at what-is-json for anyone new...</lm:placementHints></lm:path>
  </block>
</courseStructure>
```

**R2. One statement builder, two identity sources.**
- The server always builds cmi5-conformant AU statements: initialized first, terminated last, the defined verbs with the required result, context and duration, and the learning-mcp verbs as **cmi5 allowed** statements carrying the contextTemplate plus the learning-mcp category.
- **Mode A (agent-only, the default):** the server acts as the LMS for the learner's own record. It mints registration, activityId (e.g. `{au@id}/au`, never equal to `au@id`) and sessionid, and issues launched, waived ("Tested Out" for placement skips) and satisfied (per block).
- **Mode B (LMS-launched):** the AU `url` is a launch bridge. The server takes actor, registration, activityId and contextTemplate from the LMS and never issues LMS verbs.
- Claim **"cmi5 AU-conformant (mode B)"** and **"cmi5-shaped records (mode A)"**. Do not claim LMS conformance.

**R3. Fix the session and statement model.**
- One AU session per lesson attempt, ending at checkpoint resolution or a lesson change.
- Make placement its own short AU (`moveOn="NotApplicable"`) so `placed` sits inside a session.
- Re-time `completed`, add `duration`, and stop sending defined `failed` after `passed`.
- Map Review and Browse launch modes onto read-only lesson walk-throughs.

**R4. Rule changes in RULES.md.**
- §5.1/§6.3: allow the LMS actor in mode B.
- §5.5: an LMS launch is consent to send that session's cmi5 defined statements. Allowed statements are sent per Option C4-3, opt-in.
- §6.4: profile category on allowed statements only, never alongside the cmi5 category.
- Add the cmi5 requirement IDs (`@cmi5/requirements`) to the test suite, and run the CATAPULT CTS against mode B through the bridge.

**What this means for existing cmi5 LMSs**

- An LMS can **import** a learning-mcp course: it is XSD-valid, and the LMS ignores `lm:` ([SPEC] §13.1.5).
- It can **show** paths as blocks and lessons as AUs, with titles, descriptions and activity types.
- It can **assign** the course and **launch** lessons. With R1/R2 it **tracks** real completed/passed/failed per lesson, sessions with durations, and block/course `satisfied`, and it records all the learning-mcp allowed statements in its LRS for reporting ([SPEC] §9.3).
- It **cannot** teach. The teaching happens in the learner's agent, reached from the bridge page.
- It **cannot** follow branches or placement as routing: it sees an implied linear order and blocks that need every AU satisfied, so skipped lessons stay unsatisfied unless an admin waives them.
- An LMS without the course server reachable gets nothing to play: the AU URL points to the server, and there is no offline HTML version.
- So the useful result is "an LMS can enrol, launch into the agent, and get conformant completion and pass data back". The LMS cannot replace the server.

**Open decisions for Derin**

1. Whether the canonical source stays JSON (generate cmi5.xml) or moves to XML.
2. Multi-path courses: block-per-path (C2-a) or package-per-path (C2-b).
3. The C3 actor option.
4. The C4 consent option.
5. Whether to wait for P9274.3.1 before freezing the `lm:` extension namespace version.
