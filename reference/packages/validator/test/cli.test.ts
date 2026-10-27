// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPackage, readDir } from '@course-xapi-mcp/core/package';

const BIN = fileURLToPath(new URL('../bin/cxm.mjs', import.meta.url));
const fx = (name: string) => fileURLToPath(new URL(`./fixtures/packages/${name}/`, import.meta.url));

function cxm(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'cxm-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('cxm validate', () => {
  it('exits 0 on the minimal fixture', async () => {
    const r = await cxm('validate', fx('minimal'));
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
  });

  it('exits 1 on a broken fixture and prints one line per issue', async () => {
    const r = await cxm('validate', fx('au-no-url'));
    expect(r.code).toBe(1);
    const lines = r.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l).toMatch(/^CXM-PKG-\d{3} (error|warning|info) \S+( \S+)?: .+\. Fix: .+$/);
    expect(lines.find((l) => l.startsWith('CXM-PKG-002'))).toMatch(/^CXM-PKG-002 error cmi5\.xml \/courseStructure\[1\]\/block\[1\]\/au\[1\]: .+\. Fix: .+$/);
  });

  it('--json prints {valid, issues} with keys in a fixed order', async () => {
    const r = await cxm('validate', fx('au-no-url'), '--json');
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.valid).toBe(false);
    expect(Object.keys(out)).toEqual(['valid', 'issues']);
    for (const i of out.issues) expect(Object.keys(i)).toEqual(['code', 'severity', 'file', ...(i.xpath ? ['xpath'] : []), ...(i.pointer ? ['pointer'] : []), 'message', 'fix', 'help']);
    expect(out.issues.map((i: { code: string }) => i.code)).toContain('CXM-PKG-002');
    const again = await cxm('validate', '--json', fx('au-no-url'));
    expect(again.stdout).toBe(r.stdout);
  });

  it('validates a ZIP', async () => {
    const zip = join(tmp, 'minimal.zip');
    writeFileSync(zip, zipSync(await readDir(fx('minimal'))));
    expect((await cxm('validate', zip, '--json')).stdout).toBe(JSON.stringify({ valid: true, issues: [] }, null, 2) + '\n');
  });

  it('an unreadable ZIP exits 1 with CXM-PKG-001', async () => {
    const zip = join(tmp, 'bad.zip');
    writeFileSync(zip, 'not a zip');
    const r = await cxm('validate', zip, '--json');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).issues[0].code).toBe('CXM-PKG-001');
  });

  it('exits 2 on a usage error', async () => {
    expect((await cxm()).code).toBe(2);
    expect((await cxm('validate')).code).toBe(2);
    expect((await cxm('validate', join(tmp, 'nope'))).code).toBe(2);
    expect((await cxm('frobnicate')).code).toBe(2);
    expect((await cxm('validate', fx('minimal'), '--xml')).code).toBe(2);
  });
});

describe('cxm explain', () => {
  it('prints the fix and the help URL', async () => {
    const r = await cxm('explain', 'CXM-PKG-014');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Remove the bug explanation, fix checks and reference solution from the distribution package; build it with the validator.');
    expect(r.stdout).toContain('https://course-xapi-mcp.sqwrlz.com/errors/CXM-PKG-014');
  });

  it('exits 2 on an unknown code', async () => {
    const r = await cxm('explain', 'CXM-PKG-999');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('CXM-PKG-999');
  });
});

describe('cxm convert', () => {
  const LEGACY = fileURLToPath(new URL('./fixtures/json-basics.course.json', import.meta.url));
  const opts = ['--iri', 'https://course-xapi-mcp.sqwrlz.com/examples/json-basics', '--mcp', 'http://127.0.0.1:8787/mcp', '--launch', 'http://127.0.0.1:8787/cmi5/launch', '--custody', 'server-kept'];

  it('writes a package folder that loads with no errors', async () => {
    const out = join(tmp, 'converted');
    const r = await cxm('convert', LEGACY, out, ...opts);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const loaded = loadPackage(await readDir(out));
    expect(loaded.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('exits 1 with the errors of a course that does not parse, and 2 on a usage error', async () => {
    const bad = join(tmp, 'bad.course.json');
    writeFileSync(bad, '{"title": 1}');
    const r = await cxm('convert', bad, join(tmp, 'never'), ...opts);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toBe('');
    expect((await cxm('convert', LEGACY, join(tmp, 'x'), '--iri', 'https://e.org/c')).code).toBe(2);
    expect((await cxm('convert', LEGACY, join(tmp, 'x'), ...opts.slice(0, -1), 'nope')).code).toBe(2);
  });
});
