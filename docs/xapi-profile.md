# The learning-mcp xAPI profile (v0.1, draft)

Machine-readable form: [`profile/xapi-profile.jsonld`](../profile/xapi-profile.jsonld), an xAPI Profile (JSON-LD, Profiles spec 1.0). It is generated from `packages/core/src/profile.ts` by `npm run profile`, from the same constants the statement builder uses, and a test fails if the file and the code disagree.

| | IRI |
| --- | --- |
| Profile | `https://w3id.org/learning-mcp/xapi` |
| Version (used as the `category` context activity) | `https://w3id.org/learning-mcp/xapi/v0.1` |
| Actor account home page | `https://w3id.org/learning-mcp/learner` |

These IRIs do not resolve yet. Registering `w3id.org/learning-mcp` is open question 1 in the spec.

## Target xAPI version

Statements are written for **IEEE 9274.1.1-2023 (xAPI 2.0)** and stay valid under **xAPI 1.0.3**, so they can be sent unchanged to either kind of LRS:

- no `version` property (2.0: LRPs "should not provide a version"; a 1.0.x LRS would reject `2.0.0`)
- no `contextAgents` or `contextGroups` (new in 2.0; unknown to 1.0.3)
- timestamps in UTC with milliseconds (`2026-10-19T12:00:18.000Z`)
- every `contextActivities` value is an array
- no properties the standard does not define

Sources and quotes are in [research.md](research.md#3-xapi).

## Verbs

| Verb | IRI | Emitted when |
| --- | --- | --- |
| placed | `https://w3id.org/learning-mcp/xapi/verbs/placed` | `choose_placement` accepted a placement |
| experienced | `http://adlnet.gov/expapi/verbs/experienced` | `next_beat` served a beat |
| answered | `http://adlnet.gov/expapi/verbs/answered` | the learner replied to a beat question, or answered a checkpoint |
| passed | `http://adlnet.gov/expapi/verbs/passed` | a checkpoint branch with `success: true` was chosen, or a file passed its checks |
| failed | `http://adlnet.gov/expapi/verbs/failed` | a checkpoint branch with `success: false` was chosen, or a file failed its checks |
| caught | `https://w3id.org/learning-mcp/xapi/verbs/caught` | the learner's fix of a planted bug passed the fix checks |
| branched | `https://w3id.org/learning-mcp/xapi/verbs/branched` | the server accepted the agent's branch choice |
| completed | `http://adlnet.gov/expapi/verbs/completed` | a lesson or a path finished |

The ADL verbs are the same IRIs cmi5 uses for passed, failed and completed, which keeps a future cmi5 bridge possible.

## Activity types

| Type | IRI | Activity IRI pattern (under the course's `activityBase`) |
| --- | --- | --- |
| course | `http://adlnet.gov/expapi/activities/course` | `{activityBase}` |
| path | `https://w3id.org/learning-mcp/xapi/activity-types/path` | `/paths/{pathId}` |
| lesson | `http://adlnet.gov/expapi/activities/lesson` | `/lessons/{lessonId}` |
| beat | `https://w3id.org/learning-mcp/xapi/activity-types/beat` | `/lessons/{lessonId}/beats/{beatId}` |
| checkpoint | `https://w3id.org/learning-mcp/xapi/activity-types/checkpoint` | `/lessons/{lessonId}/checkpoints/{checkpointId}` |
| file | `https://w3id.org/learning-mcp/xapi/activity-types/file` | `/lessons/{lessonId}/files/{fileName}` |
| planted bug | `https://w3id.org/learning-mcp/xapi/activity-types/planted-bug` | `/lessons/{lessonId}/bugs/{bugId}` |

Each segment is percent-encoded. Activity IRIs belong to the course publisher (its `activityBase`); only the vocabulary belongs to this profile.

## Extensions

| Extension | Kind | Value |
| --- | --- | --- |
| `.../extensions/branch` | result | the authored branch id, for example `"ready"` |
| `.../extensions/to` | result | the target lesson's activity IRI, or `null` when the branch ends the path |
| `.../extensions/rationale` | result | the agent's one-sentence reason (agent-written, at most 300 characters) |
| `.../extensions/checks` | result | `[{ "index": 0, "passed": true }, ...]` for authored checks; empty for planted-bug fixes |
| `.../extensions/start-lesson` | result | the lesson IRI placement starts at |
| `.../extensions/skipped` | result | lesson IRIs placement skipped |
| `.../extensions/rules-version` | context | the agent rules version the server sent, for example `"v0.1"` |

All extension IRIs start with `https://w3id.org/learning-mcp/xapi/extensions/`. Each has an inline JSON Schema in the profile.

## Context on every statement

- `registration`: one UUID per learner per course, created on enrolment. A learner who starts over in the same course keeps it; a new record gets a new one.
- `contextActivities.parent`: the lesson (for beats, checkpoints, files, bugs), the path (for lessons), or the course (for paths).
- `contextActivities.grouping`: the course.
- `contextActivities.category`: the profile version. Per the Profiles spec (§5), this is the claim that the statement follows this profile's templates.
- `language`: the course language.
- `platform`: the MCP client's self-reported name, when the client sent one (for example `claude-ai`). It is not personal data. It lets a reviewer compare how different agents taught.
- `extensions["…/rules-version"]`.

## How the special cases are expressed

**Branching.** A checkpoint produces, in order: `answered` (the learner's words in `result.response`), then for code checkpoints `passed`/`failed` on the file, then, once the agent chooses, `passed` or `failed` on the checkpoint (from the branch's authored `success`), `branched` on the checkpoint with `branch`, `to` and `rationale`, and `completed` on the lesson when the branch is a success. A rejected branch choice produces nothing.

**Planted-bug catches.** Each fix attempt is `passed`/`failed` on the file with an empty `checks` list, so the record does not point at the bug. A passing fix adds `caught` on the planted-bug activity.

**Code checks.** `passed`/`failed` on the file activity, with per-check results by index. The file content is kept in the record's course state, not in the statement.

**Who wrote what.** `result.response` on `answered` is the learner's text. `result.response` on `placed` and the `rationale` extension on `branched` are agent-written. Everything else comes from authored content.

## Statement templates and patterns

The profile defines one statement template per row of the verb table (twelve in all, because answered, passed and failed each have two object types). Every template requires the anonymous home page, the category, the registration and the rules version, and excludes `version`, `actor.mbox` and `actor.name`.

The primary pattern, `course-registration`, is: optional `placed`, then any number of `lesson` passes, then optional path `completed`. A `lesson` pass is one or more beats (`experienced`, optionally followed by `answered`), then optionally the planted-bug attempts ending in `caught`, then optionally the checkpoint sequence, then optionally `completed`. Patterns are informative in v0.1; the reference implementation's tests check the emitted order directly.

## Example

A `branched` statement from the example course (ids are from a deterministic test run):

```json
{
  "id": "00000000-0000-4000-8000-000000000010",
  "actor": { "objectType": "Agent", "account": { "homePage": "https://w3id.org/learning-mcp/learner", "name": "00000000-0000-4000-8000-000000000001" } },
  "verb": { "id": "https://w3id.org/learning-mcp/xapi/verbs/branched", "display": { "en": "branched" } },
  "object": {
    "objectType": "Activity",
    "id": "https://example.org/learning-mcp/courses/json-basics/lessons/what-is-json/checkpoints/types",
    "definition": { "type": "https://w3id.org/learning-mcp/xapi/activity-types/checkpoint", "name": { "en": "What JSON is: checkpoint" } }
  },
  "context": {
    "registration": "00000000-0000-4000-8000-000000000002",
    "language": "en",
    "contextActivities": {
      "parent": [{ "objectType": "Activity", "id": "https://example.org/learning-mcp/courses/json-basics/lessons/what-is-json" }],
      "grouping": [{ "objectType": "Activity", "id": "https://example.org/learning-mcp/courses/json-basics" }],
      "category": [{ "objectType": "Activity", "id": "https://w3id.org/learning-mcp/xapi/v0.1" }]
    },
    "extensions": { "https://w3id.org/learning-mcp/xapi/extensions/rules-version": "v0.1" },
    "platform": "test-client"
  },
  "timestamp": "2026-10-19T12:00:18.000Z",
  "result": {
    "extensions": {
      "https://w3id.org/learning-mcp/xapi/extensions/branch": "ready",
      "https://w3id.org/learning-mcp/xapi/extensions/to": "https://example.org/learning-mcp/courses/json-basics/lessons/fix-the-config",
      "https://w3id.org/learning-mcp/xapi/extensions/rationale": "Names both types and a reason."
    }
  }
}
```

## Changes from the seed (learn-wp-reimagined `docs/record-format.md`)

- Verb and extension IRIs move from the site's own domain to the shared `w3id.org/learning-mcp` namespace, so every course uses one vocabulary.
- `branched` now has the checkpoint as its object (the target is in the `to` extension), instead of the target lesson with a `from-lesson` extension. The object is then the thing the learner acted on.
- New: `placed`, `caught`, `checks`, `rationale`, `rules-version`, `registration`, `grouping`, `category`, `platform`, and `definition.type` on every object.
- Language-map keys use the course language tag (`en`), following the 2.0 text's advice to use the shortest correct tag.
