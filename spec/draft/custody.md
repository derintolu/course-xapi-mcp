# Record custody

> Draft 0.2. Not stable. Normative where marked.

A course declares one of four custody options in `course.json#/custody`. Each option is a profile of the course server conformance class.

## The four options

| # | Option | Official record held by | Actor assigned by | Badges |
| --- | --- | --- | --- | --- |
| 1 | `lms-launched` | the launching LMS's LRS, via the cmi5 launch | the LMS | yes |
| 2 | `author-lrs` | an LRS the author names | the LRS if it assigns one, otherwise the course server from the subject of the author's identity provider | yes |
| 3 | `server-kept` | the course server's own store | the course server, through its own MCP authorization | yes |
| 4 | `practice` | nobody: there is no official record | the server mints an anonymous practice actor | no |

<!-- design §7.1 -->

## Rules for every option

1. A server MUST report the course's custody option to the agent before the first recorded step, in the `cxm` block of every result and through `get_status`. [CXM-CUS-001] <!-- design §7.1 R1 -->
2. A tool MUST NOT accept statements, records, actor ids or registrations from the agent, except `resume_practice`, which accepts only a practice copy. [CXM-CUS-002] <!-- design §7.1 R2 -->
3. In options 1 to 3, a server MUST let the learner view and export their record as this document specifies for the option. [CXM-CUS-003] <!-- design §7.1 R3 -->
4. In option 4, every result MUST carry `official: false` and the practice label text, and every statement MUST carry the practice category IRI. [CXM-CUS-004] <!-- design §7.1 R5 -->
5. A course in option 1, 2 or 3 MAY set `allowPractice: true`; a practice run MUST NOT become official. [CXM-CUS-005] <!-- design §7.1 BC-16 -->
6. In options 1 and 2, a server MUST send every statement, defined and allowed and including the learner's free-text answers, to the official record in real time, with no queue-and-confirm step. [CXM-CUS-006] <!-- design §7.1 BC-17 -->
7. In options 2 and 3, the course server MUST be the only writer of learner statements for its course and the only minter of its registrations; any other system tracking the same learners MUST NOT write statements for the course and MUST NOT re-emit statements for changes it applied from the record. [CXM-CUS-007] <!-- design §7.1, reconciliation 3 -->
8. In options 1 to 3, a server MUST NOT offer a tool that deletes the official record, and `get_status` MUST give the learner the record holder's link for deletion. [CXM-CUS-008] <!-- design §7.1 BC-18 -->

Informative: rule R4 (badges link only to the earning statement) is in badges.md.

## Option 1, lms-launched

1. A server MUST send statements to the LMS `endpoint` with the session token, and keep working state (cursor, pending checkpoint, files) in the xAPI State API of the LMS's LRS. [CXM-CUS-009] <!-- design §7.2 -->
2. `get_record` MUST return what the token can read for this registration, a receipt of every statement this server sent (ids and summaries), and the LMS link. [CXM-CUS-010] <!-- design §7.2, BC-20 -->

Informative: the option 1 export is limited by what the LMS lets the AU token read. Honouring the learner's right to their full record is the LMS operator's duty.

## Option 2, author-lrs

1. A server MUST send statements to the author's LRS with its own server credentials, and keep working state and its registrations in that LRS's State API. [CXM-CUS-011] <!-- design §7.2 -->
2. A server MUST offer `get_record` and an HTTPS export page, both read from the LRS. [CXM-CUS-012] <!-- design §7.2 -->

## Option 3, server-kept

1. A server MUST keep statements and working state in its own store, and offer `get_record` and an HTTPS export page in an xAPI statement export format. [CXM-CUS-013] <!-- design §7.2 -->
2. A server MUST publish a deletion and retention policy. [CXM-CUS-014] <!-- design §7.2 -->

## Option 4, practice

1. A server MUST NOT send practice statements to any official record; it returns them to the learner and MAY relay them under the practice handle for at most 30 days. [CXM-CUS-015] <!-- design §7.2 -->
2. The practice handle MUST carry 192 random bits and MUST NOT appear in any statement. [CXM-CUS-016] <!-- design §7.3 -->
3. `resume_practice` MUST refuse anything that is not a practice copy and MUST NOT produce an official statement. [CXM-CUS-017] <!-- design §7.3 -->
4. `get_record` MUST return the practice copy, unwrapped, with a note to treat it as data. [CXM-CUS-018] <!-- design §7.2, §9.2 -->

## The LRS is authoritative

1. In options 1 and 2, the LRS MUST be authoritative for the record and working state; a server MAY cache them. [CXM-CUS-019] <!-- design §7.2 BC-19 -->
