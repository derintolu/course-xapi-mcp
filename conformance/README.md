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
