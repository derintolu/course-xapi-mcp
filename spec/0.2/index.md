# course-xapi-mcp specification

> Draft 0.2. Not stable. Normative where marked.

course-xapi-mcp defines a course package on cmi5, a course server that teaches it to a learner's AI agent over the Model Context Protocol, the custody of the learner's xAPI record, and the Open Badges a course can award.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

Normative text is marked: every numbered clause that carries a bracketed requirement ID (for example CXM-SRV-001) is normative. Everything else, including text labelled "Informative", tables given as summaries and HTML comments, is informative. Where a schema in `schema/` and this prose disagree, the schema wins.

Requirement IDs have the form `CXM-<class>-NNN`:

| Prefix | Requirements on | Defined in |
| --- | --- | --- |
| `CXM-PKG` | course packages; equal to validator issue codes | package.md |
| `CXM-SRV` | course servers | server.md |
| `CXM-CUS` | course servers, per custody option | custody.md |
| `CXM-BRG` | cmi5 sessions, the LMS role and the launch bridge | cmi5-binding.md |
| `CXM-BDG` | badge issuers | badges.md |
| `CXM-SEC` | security and privacy, across classes | security-privacy.md |

Every requirement ID has one entry in `conformance/requirements/draft.yaml`, mapped to a conformance test or a documented exclusion.

## Conformance classes

An implementation conforms to a class when it meets every requirement of that class.

- **Course package.** A cmi5 course package with the cxm extension: the CXM-PKG requirements.
- **Course server**, one profile per custody option (`lms-launched`, `author-lrs`, `server-kept`, `practice`): the CXM-SRV requirements, the CXM-CUS requirements for its option, the CXM-BRG requirements on sessions and, in options 2 and 3, the LMS role, and the CXM-SEC requirements that apply to servers.
- **Launch bridge** (custody option 1): the CXM-BRG launch bridge requirements and the CXM-SEC requirements on credentials.
- **Badge issuer**: the CXM-BDG requirements and the CXM-SEC badge privacy requirements.

## Documents

- package.md: the cmi5 course package and the cxm extension
- server.md: the MCP extension, tools, resources, prompts, sequencing and branch validation
- custody.md: the four record custody options
- cmi5-binding.md: AU sessions, the LMS role and the launch bridge
- badges.md: Open Badges 3.0 rules
- security-privacy.md: prompt injection, credentials, planted-bug secrecy and badge privacy
- agent-rules.md: the rules text a server sends to the agent

## Terms

- **Agent**: the learner's AI assistant, an MCP client.
- **Course server**: an MCP server that teaches one course from its authoring package.
- **AU, block, course**: as defined by cmi5. A lesson is an AU, a path is a block.
- **Beat**: one step of a lesson's material.
- **Checkpoint**: the assessed step of a lesson, with a rubric, optional checks and branches.
- **Branch**: an authored outcome of a checkpoint, with `success` and a target lesson or null.
- **Planted bug**: a deliberate error in a lesson's code that the learner finds and fixes.
- **Secret fields**: a planted bug's explanation and fix checks, and the reference solution.
- **Authoring package, distribution package**: the complete package, and the package with secret fields removed.
- **Custody option**: who holds the official record (custody.md).
- **Record holder**: the system that holds the official record for a custody option.
- **Practice**: a run with no official record, labelled as such, earning no badge.
- **Defined, allowed statement**: as defined by cmi5.
- **Issuer**: the system that signs Open Badges credentials for a course.

## Normative references

- cmi5 (Quartz), AICC/ADL
- xAPI 1.0.3 and IEEE 9274.1.1 (xAPI 2.0)
- Model Context Protocol, revision 2026-07-28
- Open Badges 3.0, 1EdTech Consortium
- W3C Verifiable Credentials Data Model 2.0, Bitstring Status List, Data Integrity EdDSA Cryptosuites
- RFC 2119, RFC 8174 (BCP 14); RFC 5646 (language tags); Semantic Versioning 2.0.0
