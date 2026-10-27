// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ISSUE_CATALOG } from '../../reference/packages/core/src/issues.ts';
import { checkRequirements } from '../check-requirements.ts';

const repo = new URL('../../', import.meta.url).pathname;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cxm-req-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const SPEC = '# Server\n\n## Tools\n\n1. A server MUST do it. [CXM-SRV-001]\n';
const entry = (extra: string) => `- id: CXM-SRV-001\n  class: server\n  text: A server MUST do it.\n  source: spec/draft/server.md#tools\n${extra}`;

describe('checkRequirements', () => {
  it('the repo passes the non-strict check', () => {
    expect(checkRequirements({ strict: false })).toEqual([]);
  });

  it('a well-formed fixture passes', () => {
    const root = fixture({ 'spec/draft/server.md': SPEC, 'conformance/requirements/draft.yaml': entry('  status: pending\n') });
    expect(checkRequirements({ strict: false, root })).toEqual([]);
  });

  it('reports an ID in the spec text with no YAML entry', () => {
    const root = fixture({
      'spec/draft/server.md': SPEC + '2. A server MUST NOT do that. [CXM-SRV-002]\n',
      'conformance/requirements/draft.yaml': entry('  status: pending\n'),
    });
    expect(checkRequirements({ strict: false, root }).join('\n')).toContain('CXM-SRV-002');
  });

  it('reports a YAML entry with no ID in the spec text', () => {
    const root = fixture({ 'spec/draft/server.md': '# Server\n\n## Tools\n', 'conformance/requirements/draft.yaml': entry('  status: pending\n') });
    expect(checkRequirements({ strict: false, root }).join('\n')).toContain('CXM-SRV-001');
  });

  it('reports duplicate IDs', () => {
    const root = fixture({
      'spec/draft/server.md': SPEC,
      'conformance/requirements/draft.yaml': entry('  status: pending\n') + entry('  status: pending\n'),
    });
    expect(checkRequirements({ strict: false, root }).join('\n')).toMatch(/CXM-SRV-001.*duplicate|duplicate.*CXM-SRV-001/);
  });

  it('reports a tested entry whose test file lacks the ID', () => {
    const root = fixture({
      'spec/draft/server.md': SPEC,
      'conformance/requirements/draft.yaml': entry('  status: tested\n  test: conformance/server/x.test.ts\n'),
      'conformance/server/x.test.ts': "it('[CXM-SRV-999] other', () => {});\n",
    });
    expect(checkRequirements({ strict: false, root }).join('\n')).toContain('CXM-SRV-001');
  });

  it('accepts a tested entry whose test file names the ID', () => {
    const root = fixture({
      'spec/draft/server.md': SPEC,
      'conformance/requirements/draft.yaml': entry('  status: tested\n  test: conformance/server/x.test.ts\n'),
      'conformance/server/x.test.ts': "it('[CXM-SRV-001] does it', () => {});\n",
    });
    expect(checkRequirements({ strict: false, root })).toEqual([]);
  });

  it('reports an excluded entry without a reason', () => {
    const root = fixture({ 'spec/draft/server.md': SPEC, 'conformance/requirements/draft.yaml': entry('  status: excluded\n') });
    expect(checkRequirements({ strict: false, root }).join('\n')).toContain('CXM-SRV-001');
  });

  it('reports a class that does not match the ID prefix', () => {
    const root = fixture({ 'spec/draft/server.md': SPEC, 'conformance/requirements/draft.yaml': entry('  status: pending\n').replace('class: server', 'class: badges') });
    expect(checkRequirements({ strict: false, root }).join('\n')).toContain('CXM-SRV-001');
  });

  it('reports a source that names the wrong file or a missing anchor', () => {
    const wrongFile = fixture({
      'spec/draft/server.md': SPEC,
      'spec/draft/custody.md': '# Custody\n\n## Tools\n',
      'conformance/requirements/draft.yaml': entry('  status: pending\n').replace('server.md#tools', 'custody.md#tools'),
    });
    expect(checkRequirements({ strict: false, root: wrongFile }).join('\n')).toContain('CXM-SRV-001');
    const noAnchor = fixture({ 'spec/draft/server.md': SPEC, 'conformance/requirements/draft.yaml': entry('  status: pending\n').replace('#tools', '#nowhere') });
    expect(checkRequirements({ strict: false, root: noAnchor }).join('\n')).toContain('CXM-SRV-001');
  });

  it('strict mode reports pending entries', () => {
    const root = fixture({ 'spec/draft/server.md': SPEC, 'conformance/requirements/draft.yaml': entry('  status: pending\n') });
    expect(checkRequirements({ strict: false, root })).toEqual([]);
    expect(checkRequirements({ strict: true, root }).join('\n')).toContain('CXM-SRV-001');
  });

  it('every catalog code, and every error code in particular, is a package requirement', () => {
    const entries = parse(readFileSync(join(repo, 'conformance/requirements/draft.yaml'), 'utf8')) as { id: string; class: string }[];
    const pkg = new Set(entries.filter((e) => e.class === 'package').map((e) => e.id));
    const errors = Object.entries(ISSUE_CATALOG).filter(([, v]) => v.severity === 'error').map(([k]) => k);
    expect(errors.length).toBeGreaterThan(0);
    for (const code of errors) expect(pkg.has(code), code).toBe(true);
    for (const code of Object.keys(ISSUE_CATALOG)) expect(pkg.has(code), code).toBe(true);
    for (const id of pkg) expect(Object.keys(ISSUE_CATALOG), id).toContain(id);
  });
});
