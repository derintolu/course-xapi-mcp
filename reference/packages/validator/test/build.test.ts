// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPackage, readDir, readZip } from '@course-xapi-mcp/core/package';
import type { PackageFiles } from '@course-xapi-mcp/core/package';
import { buildPackages, validatePackage } from '../src/index.ts';

const EXAMPLE = fileURLToPath(new URL('../../../../examples/json-basics/', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/cxm.mjs', import.meta.url));
const dec = new TextDecoder();
const example = () => readDir(EXAMPLE);

type Built = Exclude<Awaited<ReturnType<typeof buildPackages>>, { issues: unknown }>;
async function build(files: PackageFiles, name = 'json-basics'): Promise<Built> {
  const r = await buildPackages(files, name);
  if ('issues' in r) throw new Error(JSON.stringify(r.issues, null, 2));
  return r;
}

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

/** Every central-directory entry of a ZIP without an archive comment, with its local header's extra length. */
function entries(zip: Uint8Array) {
  const eocd = zip.length - 22;
  expect(u32(zip, eocd)).toBe(0x06054b50);
  const out: { name: string; time: number; date: number; extra: number; localExtra: number }[] = [];
  let at = u32(zip, eocd + 16);
  for (let n = u16(zip, eocd + 10); n > 0; n--) {
    expect(u32(zip, at)).toBe(0x02014b50);
    const nameLen = u16(zip, at + 28);
    const local = u32(zip, at + 42);
    out.push({
      name: dec.decode(zip.subarray(at + 46, at + 46 + nameLen)),
      time: u16(zip, at + 12),
      date: u16(zip, at + 14),
      extra: u16(zip, at + 30),
      localExtra: u16(zip, local + 28),
    });
    at += 46 + nameLen + u16(zip, at + 30) + u16(zip, at + 32);
  }
  return out;
}

/** The secret texts of the example's lessons, as they would appear inside a JSON file. */
function secrets(files: PackageFiles): string[] {
  const out: string[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.startsWith('cxm/lessons/')) continue;
    const l = JSON.parse(dec.decode(bytes));
    if (l.bug) out.push(l.bug.explanation, ...l.bug.fixChecks.map((c: unknown) => JSON.stringify(c)));
    if (l.referenceSolution) {
      if (l.referenceSolution.bugFix !== undefined) out.push(l.referenceSolution.bugFix);
      out.push(...Object.values(l.referenceSolution.files as Record<string, string>));
    }
  }
  return out.map((s) => JSON.stringify(s).slice(1, -1));
}

const tmp = mkdtempSync(join(tmpdir(), 'cxm-build-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('buildPackages', () => {
  it('the json-basics example validates with no errors', async () => {
    const r = await validatePackage(await example());
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('building twice gives byte-identical ZIPs and equal ETags', async () => {
    const a = await build(await example());
    const b = await build(await example());
    expect(a.authoring.file).toBe('json-basics-authoring.zip');
    expect(a.distribution.file).toBe('json-basics-lms.zip');
    expect(Buffer.from(a.authoring.bytes).equals(Buffer.from(b.authoring.bytes))).toBe(true);
    expect(Buffer.from(a.distribution.bytes).equals(Buffer.from(b.distribution.bytes))).toBe(true);
    expect(a.authoring.etag).toBe(b.authoring.etag);
    expect(a.distribution.etag).toBe(b.distribution.etag);
    expect(a.authoring.etag).not.toBe(a.distribution.etag);
  });

  it('the ETag is "sha256-" plus the base64url SHA-256 of the bytes, quoted', async () => {
    const { authoring } = await build(await example());
    expect(authoring.etag).toBe(`"sha256-${createHash('sha256').update(authoring.bytes).digest('base64url')}"`);
  });

  it('entries are sorted, dated 1980-01-01 00:00:00, with no extra fields and cmi5.xml at the root', async () => {
    const { authoring, distribution } = await build(await example());
    for (const zip of [authoring.bytes, distribution.bytes]) {
      const es = entries(zip);
      const names = es.map((e) => e.name);
      expect(names).toEqual([...names].sort());
      expect(names).toContain('cmi5.xml');
      for (const e of es) expect(e).toMatchObject({ time: 0, date: (0 << 9) | (1 << 5) | 1, extra: 0, localExtra: 0 });
    }
  });

  it('the authoring ZIP loads in loadPackage with the same files', async () => {
    const files = await example();
    const { authoring } = await build(files);
    const unzipped = readZip(authoring.bytes) as PackageFiles;
    expect(Object.keys(unzipped).sort()).toEqual(Object.keys(files).sort());
    const loaded = loadPackage(unzipped);
    expect(loaded.ok).toBe(true);
  });

  it('the LMS ZIP validates as a distribution package, with no CXM-PKG-014 and no secret text', async () => {
    const files = await example();
    const { distribution } = await build(files);
    const lms = readZip(distribution.bytes) as PackageFiles;
    const r = await validatePackage(lms);
    expect(r.valid).toBe(true);
    expect(r.issues.map((i) => i.code)).not.toContain('CXM-PKG-014');
    expect(JSON.parse(dec.decode(lms['cxm/course.json']!)).flavour).toBe('distribution');
    const all = Object.values(lms).map((b) => dec.decode(b)).join('\n');
    const hidden = secrets(files);
    expect(hidden.length).toBeGreaterThan(2);
    for (const s of hidden) expect(all).not.toContain(s);
    for (const k of ['"explanation"', '"fixChecks"', '"referenceSolution"']) expect(all).not.toContain(k);
    expect(lms['cmi5.xml']).toEqual(files['cmi5.xml']);
  });

  it('refuses a package with errors and returns its issues', async () => {
    const fixture = await readDir(fileURLToPath(new URL('./fixtures/packages/au-no-url/', import.meta.url)));
    const r = await buildPackages(fixture, 'x');
    expect('issues' in r && r.issues.some((i) => i.code === 'CXM-PKG-002')).toBe(true);
  });

  it('refuses to build from a distribution package', async () => {
    const { distribution } = await build(await example());
    const r = await buildPackages(readZip(distribution.bytes) as PackageFiles, 'again');
    expect(r).toMatchObject({ issues: [{ code: 'CXM-PKG-034', file: 'cxm/course.json', pointer: '/flavour' }] });
  });
});

function cxm(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

describe('cxm build', () => {
  it('writes both ZIPs to --out and prints each path with its ETag', async () => {
    const out = join(tmp, 'out');
    const r = await cxm('build', EXAMPLE, '--out', out);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const built = await build(await example());
    expect(r.stdout).toBe(`${join(out, 'json-basics-authoring.zip')} ${built.authoring.etag}\n${join(out, 'json-basics-lms.zip')} ${built.distribution.etag}\n`);
    expect(Buffer.from(readFileSync(join(out, 'json-basics-lms.zip'))).equals(Buffer.from(built.distribution.bytes))).toBe(true);
  });

  it('rebuilds from the authoring ZIP to the same bytes', async () => {
    const out = join(tmp, 'again');
    await cxm('build', EXAMPLE, '--out', out);
    const r = await cxm('build', join(out, 'json-basics-authoring.zip'), '--out', join(tmp, 'again2'));
    expect(r.code).toBe(0);
    expect(readFileSync(join(tmp, 'again2', 'json-basics-lms.zip')).equals(readFileSync(join(out, 'json-basics-lms.zip')))).toBe(true);
  });

  it('building into the package folder twice does not pack the earlier ZIPs', async () => {
    const pkg = join(tmp, 'json-basics');
    cpSync(EXAMPLE, pkg, { recursive: true });
    expect((await cxm('build', pkg, '--out', pkg)).code).toBe(0);
    const first = readFileSync(join(pkg, 'json-basics-lms.zip'));
    expect((await cxm('build', pkg, '--out', pkg)).code).toBe(0);
    expect(readFileSync(join(pkg, 'json-basics-lms.zip')).equals(first)).toBe(true);
    expect(Object.keys(readZip(new Uint8Array(first)) as PackageFiles).some((n) => n.endsWith('.zip'))).toBe(false);
  });

  it('exits 1 with the issues on an invalid package and writes nothing', async () => {
    const out = join(tmp, 'none');
    const r = await cxm('build', fileURLToPath(new URL('./fixtures/packages/au-no-url/', import.meta.url)), '--out', out);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^CXM-PKG-002 error /m);
    expect(() => readFileSync(join(out, 'au-no-url-lms.zip'))).toThrow();
  });
});
