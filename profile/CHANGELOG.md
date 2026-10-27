# xAPI profile changelog

## v0.2 (draft, 2026-10-27)

Profile `https://course-xapi-mcp.sqwrlz.com/xapi`, version `https://course-xapi-mcp.sqwrlz.com/xapi/v0.2`. Replaces the learning-mcp profile v0.1 (`https://w3id.org/learning-mcp/xapi/v0.1`); no records used the old IRIs.

- IRIs move from `https://w3id.org/learning-mcp/` to `https://course-xapi-mcp.sqwrlz.com/`.
- The fixed actor home page goes, except for practice. Actors the course server mints use the course id as `account.homePage`, and `https://course-xapi-mcp.sqwrlz.com/practice-learner` in practice. In LMS-launched custody the actor is the LMS-supplied agent, copied verbatim.
- cmi5 defined statements are added: `launched`, `initialized`, `completed`, `passed`, `failed`, `terminated`, `abandoned`, `waived` on the AU, and `satisfied` on a block or the course. Lesson `completed` and `passed` move from `/lessons/{id}` to the AU activityId and gain `duration` and the moveOn category.
- `completed` is re-timed to "material experienced": the last beat, and the planted bug caught or revealed. Lesson pass is the defined `passed`.
- Path `completed` is replaced by `satisfied` on the block.
- `placed` happens inside the placement AU session.
- Failed checkpoint attempts are allowed `failed` statements on the checkpoint, with an `attempt` result extension.
- Every statement carries `registration`, the cmi5 `sessionid` context extension, the publisher-id and course grouping, and the `rules-version` and `custody` context extensions. Allowed statements carry the profile version category and never the cmi5 category.
- New: the `revealed` verb; the `waive-recommended`, `carried-over`, `attempt` and `custody` extensions; the `achievement` activity type; the practice category `https://course-xapi-mcp.sqwrlz.com/xapi/practice` on every practice statement; the Open Badges `earned` verb with the `badgeassertion` result extension and `context.statement` pointing at the earning statement.
- `branched` keeps the checkpoint as its object.
- `platform` stays as the client's self-reported name.

## v0.1

The learning-mcp profile, `https://w3id.org/learning-mcp/xapi/v0.1`. Superseded by v0.2.
