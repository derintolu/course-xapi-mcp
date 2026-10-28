# Course package

> Draft 0.2. Not stable. Normative where marked.

This document defines the course package conformance class: a cmi5 course package with the cxm extension. Requirement IDs in this document equal the validator issue codes. A consumer is a validator or a course server reading a package. A validator reports each breach under the requirement's ID, as an error, a warning or information.

## Package shape

A package is a ZIP with `cmi5.xml` at its root and a `cxm/` folder: `cxm/course.json` (course-level extension data), `cxm/lessons/<key>.json` (one per lesson AU) and optionally `cxm/files/<key>/...`. Structure lives only in `cmi5.xml`; content lives only in JSON referenced from `cxm:` elements, so no fact is written twice. <!-- design §6.1, BC-7 -->

1. A package MUST be a readable ZIP with `cmi5.xml` at its root. [CXM-PKG-001] <!-- design §6.1 -->
2. `cmi5.xml` MUST be valid against the cmi5 CourseStructure XSD (namespace `https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd`). [CXM-PKG-002] <!-- design §6.1 -->
3. Every element and attribute in the cxm namespace (`https://course-xapi-mcp.sqwrlz.com/course/v1`) MUST be valid against `cxm.xsd`, and cxm extension elements MUST sit only at the tail positions the cmi5 XSD allows for extensions. [CXM-PKG-003] <!-- design §6.1 -->
4. The `course` element MUST carry `<cxm:course src="..." specVersion="..."/>`, and a consumer MUST refuse a package whose `specVersion` major it does not support. [CXM-PKG-004] <!-- design §5.3, §6.1 -->
5. Every `src` reference MUST resolve to a file in the package and, when it has a fragment, to a JSON Pointer that resolves in that file. [CXM-PKG-005] <!-- design §6.1 -->
6. `cxm/course.json` MUST be valid against `course.schema.json`. [CXM-PKG-006] <!-- design §6.2 -->
7. Every lesson JSON MUST be valid against `lesson.schema.json`. [CXM-PKG-007] <!-- design §6.2 -->
8. Every file name in a lesson MUST be a relative POSIX path with no empty, `.` or `..` segment, no backslash and no segment starting with a space. [CXM-PKG-020] <!-- design §6.2 -->

## Keys and identifiers

1. Every block and AU MUST carry a `cxm:key` matching `[a-z0-9-]{1,64}`. [CXM-PKG-009] <!-- design §6.1 -->
2. Two blocks or AUs MUST NOT share a `cxm:key`. [CXM-PKG-008] <!-- design §6.1 -->
3. The course, every block and every AU MUST have an absolute IRI as `id`, and these ids MUST be distinct. [CXM-PKG-029] <!-- design §6.1 -->
4. Every AU `url` MUST be https; plain http is allowed only for `127.0.0.1` and `localhost`. [CXM-PKG-028] <!-- design §8.2 -->
5. The course `language` MUST be an RFC 5646 tag and its `version` MUST be a semver version. [CXM-PKG-030] <!-- design §6.2 -->

Informative: new courses put block and AU ids under the course's own IRI base; converted cmi5 courses keep their IRIs and add keys.

## Course structure

1. A package MUST declare exactly one placement AU (`cxm:role="placement"`), first in the course, with `moveOn="NotApplicable"`. [CXM-PKG-015] <!-- design §6.2 -->
2. Every live path in `course.json#/paths` MUST have exactly one block and every block MUST have a path entry; coming-soon paths MUST be left out of `cmi5.xml`. [CXM-PKG-016] <!-- design §6.2, BC-9 -->
3. The block of every live path MUST contain at least one AU. [CXM-PKG-012] <!-- design §12 -->
4. A lesson AU's `moveOn` MUST be `CompletedAndPassed` when the lesson has a checkpoint and `Completed` when it has none. [CXM-PKG-013] <!-- design §6.2 -->
5. Beat keys MUST be unique within a lesson. [CXM-PKG-019] <!-- design §6.2 -->

## Branches

1. Every branch `to` MUST be the `cxm:key` of a lesson in the package, or null. [CXM-PKG-010] <!-- design §6.2 -->
2. Every branch target MUST be in the same path (block) as the checkpoint. [CXM-PKG-011] <!-- design §6.3 rule 5, BC-14 -->
3. Branch keys MUST be unique within a checkpoint, and every checkpoint MUST have at least one branch with `success: true`. [CXM-PKG-017] <!-- design §6.2 -->
4. A `success: false` branch MUST target the current lesson, an earlier lesson in the same path, or null. [CXM-PKG-026] <!-- design §6.3 -->
5. The `when` texts of a checkpoint's branches SHOULD NOT overlap (word-set Jaccard similarity below 0.8). [CXM-PKG-201] <!-- design §12 -->

## Checks and planted bugs

1. A code checkpoint MUST have a `file`, at least one check and a branch with `success: false`. [CXM-PKG-018] <!-- design §6.2 -->
2. Every regex check MUST compile as a JavaScript RegExp using only the flags `i`, `m`, `s` and `u`. [CXM-PKG-021] <!-- design §6.2 -->
3. A regex check SHOULD NOT contain a quantifier inside a quantified group. [CXM-PKG-202] <!-- design §12 -->
4. Every check MUST fail on the starter files. [CXM-PKG-022] <!-- design §12 -->
5. Every check MUST pass on the reference solution. [CXM-PKG-023] <!-- design §12 -->
6. Every fix check MUST fail on the planted bug code. [CXM-PKG-024] <!-- design §12 -->
7. Every fix check MUST pass on `referenceSolution.bugFix`. [CXM-PKG-025] <!-- design §12 -->

## Authoring and distribution packages

The secret fields are the planted bug's `explanation` and `fixChecks`, and `referenceSolution`. An authoring package is complete and is loaded by course servers; a distribution package has the secret fields removed and is given to LMSs. Both are valid cmi5. <!-- design §6.2, BC-10 -->

1. In an authoring package, every lesson with a code checkpoint or a planted bug MUST have a `referenceSolution` (with `bugFix` when it has a bug). [CXM-PKG-027] <!-- design §12 -->
2. A distribution package MUST NOT contain any secret field. [CXM-PKG-014] <!-- design §6.2 -->
3. A course server MUST load only an authoring package and MUST refuse a distribution package. [CXM-PKG-034] <!-- design §6.2, BC-10 -->

Informative: tooling names the two flavours `*-authoring.zip` and `*-lms.zip`.

## Badge declarations

Badges are declared in `course.json#/badges[]` and the issuer in `course.json#/badgeIssuer`; see badges.md for issuing. <!-- design §11 -->

1. A course with custody `practice` MUST NOT declare badges or `allowPractice: true`. [CXM-PKG-031] <!-- design §7.1, §11 -->
2. A badge's `for` MUST name a known lesson key for `au-moveon` and a known path key for `block-satisfied`, MUST be absent for `course-satisfied` and `any-path`, and its `id` MUST be https. [CXM-PKG-032] <!-- design §11 -->
3. A course that declares badges MUST declare `badgeIssuer`. [CXM-PKG-033] <!-- design §11 -->

## Content

1. A beat's content SHOULD be at most 250 words. [CXM-PKG-203] <!-- design §12 -->
2. Course content and author rules MUST NOT address the agent beyond how to teach this course; a validator reports a likely breach as a warning. [CXM-PKG-204] <!-- design §9.4 -->
3. Every lesson SHOULD list at least one source (title and url). [CXM-PKG-205] <!-- design §12 -->

## Versions and extensions

1. A consumer SHOULD warn on a package whose `specVersion` minor is newer than it supports. [CXM-PKG-206] <!-- design §5.3 -->
2. A consumer MUST ignore foreign extension elements, attributes and `extensions` keys it does not know; a validator reports them as information, not as errors. [CXM-PKG-100] <!-- design §5.4 -->

In the JSON files, extra keys are allowed only under `extensions`, keyed by an IRI or a reversed-domain name.
