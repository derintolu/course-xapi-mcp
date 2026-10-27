// SPDX-License-Identifier: Apache-2.0
// Course package class: runs the validator named by CXM_VALIDATOR over the corpus.
// Each case is `<validator> validate <dir> --json`; exit 0 when valid, 1 with errors.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CORPUS = new URL('./corpus/', import.meta.url).pathname;
const VALIDATOR = process.env.CXM_VALIDATOR;
if (!VALIDATOR) {
  throw new Error('Set CXM_VALIDATOR to the validator command, e.g. CXM_VALIDATOR="node reference/packages/validator/bin/cxm.mjs" npm run conformance -- package');
}

// Directory `bad/<CODE>-<slug>`; the package is invalid and reports every code in its expected.json.
const BAD = [
  '[CXM-PKG-001] cmi5-xml-not-at-root',
  '[CXM-PKG-002] au-without-url',
  '[CXM-PKG-003] cxm-course-without-mcp',
  '[CXM-PKG-004] spec-major-unsupported',
  '[CXM-PKG-005] lesson-src-missing-file',
  '[CXM-PKG-006] course-json-schema',
  '[CXM-PKG-007] lesson-json-schema',
  '[CXM-PKG-008] duplicate-key',
  '[CXM-PKG-009] key-missing',
  '[CXM-PKG-010] branch-to-unknown-lesson',
  '[CXM-PKG-011] branch-to-other-path',
  '[CXM-PKG-012] empty-block',
  '[CXM-PKG-013] moveon-wrong',
  '[CXM-PKG-014] distribution-with-secrets',
  '[CXM-PKG-015] placement-missing',
  '[CXM-PKG-016] live-path-without-block',
  '[CXM-PKG-017] no-success-branch',
  '[CXM-PKG-018] code-checkpoint-without-failure-branch',
  '[CXM-PKG-019] duplicate-beat-key',
  '[CXM-PKG-020] invalid-file-name',
  '[CXM-PKG-021] regex-does-not-compile',
  '[CXM-PKG-022] check-passes-on-starter',
  '[CXM-PKG-023] check-fails-on-reference',
  '[CXM-PKG-024] fix-check-passes-on-bug',
  '[CXM-PKG-025] fix-check-fails-on-bug-fix',
  '[CXM-PKG-026] failure-branch-forward',
  '[CXM-PKG-027] code-checkpoint-without-reference-solution',
  '[CXM-PKG-028] au-url-http',
  '[CXM-PKG-029] id-not-absolute-iri',
  '[CXM-PKG-030] language-not-rfc5646',
  '[CXM-PKG-031] practice-with-badges',
  '[CXM-PKG-032] badge-id-not-https',
  '[CXM-PKG-033] badges-without-issuer',
];

// Directory `good/<slug>`; the package is valid and reports every code in its expected.json, if any,
// at the severity the catalog gives it (100 is info, 201-206 are warnings).
const GOOD = [
  'minimal',
  'two-paths',
  '[CXM-PKG-100] foreign-extension',
  '[CXM-PKG-201] overlapping-branch-when',
  '[CXM-PKG-202] nested-quantifier-regex',
  '[CXM-PKG-203] beat-over-250-words',
  '[CXM-PKG-204] beat-addresses-agent',
  '[CXM-PKG-205] lesson-without-sources',
  '[CXM-PKG-206] spec-minor-newer',
];

const NAME = /^(?:\[(CXM-PKG-\d{3})\] )?([a-z0-9-]+)$/;
const parse = (name: string) => {
  const m = NAME.exec(name);
  if (!m) throw new Error(`bad case name ${name}`);
  return { code: m[1], slug: m[2]! };
};
const badDir = (name: string) => {
  const { code, slug } = parse(name);
  return `${code}-${slug}`;
};
const goodDir = (name: string) => parse(name).slug;

interface Issue {
  code: string;
  severity: string;
}
interface Run {
  exit: number;
  valid: boolean;
  issues: Issue[];
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function validate(dir: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-c', `${VALIDATOR} validate ${quote(dir)} --json`], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const exit = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      if (exit !== 0 && exit !== 1) return reject(new Error(`validator exited ${exit}: ${stderr}`));
      try {
        const r = JSON.parse(stdout) as { valid: boolean; issues: Issue[] };
        resolve({ exit, valid: r.valid, issues: r.issues });
      } catch {
        reject(new Error(`validator printed no JSON result: ${stdout}${stderr}`));
      }
    });
  });
}

const expectedCodes = (dir: string): string[] => {
  const f = join(dir, 'expected.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { codes: string[] }).codes : [];
};

const SEVERITY = (code: string) => (code === 'CXM-PKG-100' ? 'info' : 'warning');

describe('course package corpus', () => {
  it('lists every corpus directory exactly once', () => {
    const on = (sub: string) => readdirSync(join(CORPUS, sub), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    expect(on('bad')).toEqual(BAD.map(badDir).sort());
    expect(on('good')).toEqual(GOOD.map(goodDir).sort());
  });
});

describe.concurrent('bad packages', () => {
  it.each(BAD)('%s', async (name) => {
    const dir = join(CORPUS, 'bad', badDir(name));
    const codes = expectedCodes(dir);
    expect(codes).toContain(parse(name).code);
    const r = await validate(dir);
    expect(r.valid).toBe(false);
    expect(r.exit).toBe(1);
    const errors = r.issues.filter((i) => i.severity === 'error').map((i) => i.code);
    for (const code of codes) expect(errors, `${code} not reported as an error`).toContain(code);
  });
});

describe.concurrent('good packages', () => {
  it.each(GOOD)('%s', async (name) => {
    const dir = join(CORPUS, 'good', goodDir(name));
    const codes = expectedCodes(dir);
    const { code } = parse(name);
    if (code) expect(codes).toContain(code);
    const r = await validate(dir);
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.exit).toBe(0);
    for (const c of codes) expect(r.issues.filter((i) => i.code === c).map((i) => i.severity), `${c} not reported`).toContain(SEVERITY(c));
  });
});
