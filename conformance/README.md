# Conformance suite

Tests that an implementation meets the requirements in `requirements/draft.yaml`. Each test that proves a requirement starts its name with `[<ID>]`, for example `[CXM-PKG-013] moveon-wrong`. `npm run requirements` checks that every `tested` entry names a test file containing its ID.

Run a class with `npm run conformance -- <class>`.

## Course package class

Runs a package validator over the corpus in `package/corpus/`. Name the validator command in `CXM_VALIDATOR`; the suite calls it as `<command> validate <dir> --json` once per package:

```sh
CXM_VALIDATOR="node reference/packages/validator/bin/cxm.mjs" npm run conformance -- package
```

The validator must print `{"valid": boolean, "issues": [{"code", "severity", ...}]}` on stdout and exit 0 when the package is valid, 1 when it has errors.

The corpus:

- `package/corpus/bad/<CODE>-<slug>/`: one package per error code. The validator must report `valid: false` with every code in the package's `expected.json` (`{"codes": ["CXM-PKG-0NN"]}`) as an error. Other issues may also be reported.
- `package/corpus/good/<slug>/`: packages the validator must report `valid: true`. When the package has an `expected.json`, every code in it must also be reported: `CXM-PKG-100` as `info`, `CXM-PKG-201` to `206` as `warning`.

`expected.json` sits in the package directory, so the validator also sees it as a package file; an unreferenced file is not an error.

CXM-PKG-034 (a course server refuses a distribution package) has no corpus entry: a validator accepts distribution packages, so the server tests cover it.

The list of cases is spelled out in `package/package.test.ts`; a corpus directory that is not in the list, or a list entry without a directory, fails the run.

## Course server and launch bridge classes

Black-box tests of a running course server, over its wire contract only: MCP over Streamable HTTP with the official MCP client, the OAuth 2.1 endpoints and pages the server publishes, and the record holder the server writes to. Run them with `npm run conformance -- conformance/server` (course server class) and `npm run conformance -- conformance/bridge` (launch bridge class, option 1 only).

The server under test must load the conformance course in `fixtures/course/`, with the custody option under test in `cxm/course.json#/custody` (for `practice`, also set `allowPractice` to `false`). The suite knows the course's lessons, answers and secrets and walks it like a learner and an adversarial agent.

| Variable | Options | What it is |
| --- | --- | --- |
| `CXM_URL` | all | The MCP endpoint: the official endpoint in options 1 to 3, the practice endpoint in option 4. |
| `CXM_CUSTODY` | all | `lms-launched`, `author-lrs`, `server-kept` or `practice`. |
| `CXM_TOKEN` | 2, 3 | A bearer token for one learner, obtained beforehand through the server's sign-in. The suite acts as that learner throughout and starts each scenario with `restart_course`, so the class's files run one at a time. |
| `CXM_LRS_URL` | 2 | The bundled test LRS (`lib/test-lrs.ts`, credential `test` / `test`) the server writes the record to. Use a fresh one per run: the suite reads every statement in it as this learner's. |
| `CXM_EXPORT_URL` | 3 (2 if set) | A URL that answers a plain GET with the learner's record export: a statement array, an xAPI StatementResult, or `{"record": {"statements": [...]}}`. |
| `CXM_KNOWN_GAPS` | any | Optional JSON object of check name to reason, for checks the implementation is known to fail. Those checks run as skipped, with the reason in the test name; they never pass. |

Option 1 needs no token: the suite runs the bundled cmi5 LMS simulator and test LRS itself on loopback. It launches each AU at the path and query of the AU URL in the package, moved onto the origin of `CXM_URL`, and the LMS adds an extension of its own to every launch's `contextTemplate`. The suite then pairs an agent with the launch on the authorization page, as the learner's browser would: it follows redirects and `<meta http-equiv="refresh">`, submits a form with no visible field (continuing with the bridge's cookie), or types the pairing code shown on the bridge page into the page's only visible field. When a result says `return-to-lms`, the LMS launches the lesson it names in the same registration.

The scripted client reads the result fields the tool output schemas in `schema/draft/tools/` and the agent rules name (for example `step`, `beat`, `allowed_branches`, `checks_passed`, `next`, `links`, `handle`, `practiceUrl`).

### Against the reference server

```sh
npm run conformance:reference                # all four custody options, and the bridge class in option 1
npm run conformance:reference -- server-kept # one option
```

`run-reference.ts` starts the reference app in-process on a loopback port for each custody option, with the conformance course and that custody. In options 2 and 3 it obtains `CXM_TOKEN` through the app's own sign-in pages (option 3: the accounts page; option 2: a test OpenID Provider, then the consent page). The export page needs that browser's session, so `CXM_EXPORT_URL` points at a loopback relay that opens it with the session. Checks the reference is known to fail are passed in `CXM_KNOWN_GAPS`, with their reasons.
