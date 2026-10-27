// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { readDir } from '@course-xapi-mcp/core/package';
import type { PackageFiles } from '@course-xapi-mcp/core/package';
import { explainCode, validatePackage } from '../src/index.ts';

const fixture = (name: string) => readDir(new URL(`./fixtures/packages/${name}/`, import.meta.url).pathname);
const validate = async (name: string) => validatePackage(await fixture(name));
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

const enc = new TextEncoder();
const dec = new TextDecoder();
/** Rewrites one JSON file of a package. */
function editJson(files: PackageFiles, file: string, edit: (doc: any) => void): PackageFiles {
  const doc = JSON.parse(dec.decode(files[file]!));
  edit(doc);
  return { ...files, [file]: enc.encode(JSON.stringify(doc)) };
}

describe('validatePackage', () => {
  it('the minimal package is valid with no issues', async () => {
    const r = await validate('minimal');
    expect(r.issues).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('an <au> without <url> is CXM-PKG-002 with an XPath', async () => {
    const r = await validate('au-no-url');
    expect(r.valid).toBe(false);
    const xsd = r.issues.filter((i) => i.code === 'CXM-PKG-002');
    expect(xsd).toHaveLength(1);
    expect(xsd[0]).toMatchObject({ severity: 'error', file: 'cmi5.xml', xpath: '/courseStructure[1]/block[1]/au[1]' });
    expect(codes(r)).not.toContain('CXM-PKG-003');
  });

  it('a cxm:course without its required mcp attribute is CXM-PKG-003', async () => {
    const r = await validate('cxm-attr-missing');
    const xsd = r.issues.filter((i) => i.code === 'CXM-PKG-003');
    expect(xsd).toHaveLength(1);
    expect(xsd[0]).toMatchObject({ file: 'cmi5.xml', xpath: '/courseStructure[1]/course[1]/cxm:course[1]' });
    expect(codes(r)).not.toContain('CXM-PKG-002');
  });

  it('a cxm element before the cmi5 elements is CXM-PKG-003, not 002', async () => {
    const files = await fixture('minimal');
    const xml = dec.decode(files['cmi5.xml']!).replace('<cxm:path src="cxm/course.json#/paths/p"/>', '').replace(
      '<title><langstring lang="en">Path P</langstring></title>',
      '<cxm:path src="cxm/course.json#/paths/p"/><title><langstring lang="en">Path P</langstring></title>',
    );
    const r = await validatePackage({ ...files, 'cmi5.xml': enc.encode(xml) });
    expect(codes(r)).toContain('CXM-PKG-003');
    expect(codes(r)).not.toContain('CXM-PKG-002');
  });

  it('a check that already passes on the starter files is CXM-PKG-022', async () => {
    const r = await validate('check-passes-starter');
    expect(r.valid).toBe(false);
    expect(r.issues.find((i) => i.code === 'CXM-PKG-022')).toMatchObject({ file: 'cxm/lessons/l2.json', pointer: '/checkpoint/checks/0' });
  });

  it('a reference solution that fails a check is CXM-PKG-023', async () => {
    const r = await validate('check-fails-reference');
    expect(r.issues.find((i) => i.code === 'CXM-PKG-023')).toMatchObject({ file: 'cxm/lessons/l2.json', pointer: '/checkpoint/checks/0' });
  });

  it('a fix check that passes on the bug code is CXM-PKG-024', async () => {
    const r = await validate('fix-check-passes-bug');
    expect(codes(r)).toEqual(['CXM-PKG-024']);
    expect(r.issues[0]).toMatchObject({ file: 'cxm/lessons/l2.json', pointer: '/bug/fixChecks/0' });
  });

  it('a fix check that fails on referenceSolution.bugFix is CXM-PKG-025', async () => {
    const files = editJson(await fixture('fix-check-passes-bug'), 'cxm/lessons/l2.json', (l) => {
      l.bug.fixChecks = [{ type: 'contains', file: 'b.js', value: '= 0', message: 'start at zero' }];
      l.referenceSolution.bugFix = 'let total = 2;';
    });
    const r = await validatePackage(files);
    expect(codes(r)).toEqual(['CXM-PKG-025']);
    expect(r.issues[0]!.pointer).toBe('/bug/fixChecks/0');
  });

  it('each check is judged alone: one failing check does not hide another passing on the starter', async () => {
    const files = editJson(await fixture('minimal'), 'cxm/lessons/l2.json', (l) => {
      l.checkpoint.checks.push({ type: 'contains', file: 'a.json', value: '{', message: 'is an object' });
    });
    const r = await validatePackage(files);
    expect(r.issues.filter((i) => i.code === 'CXM-PKG-022').map((i) => i.pointer)).toEqual(['/checkpoint/checks/1']);
  });

  it('an authoring lesson with a code checkpoint and no referenceSolution is CXM-PKG-027', async () => {
    const files = editJson(await fixture('minimal'), 'cxm/lessons/l2.json', (l) => delete l.referenceSolution);
    const r = await validatePackage(files);
    expect(codes(r)).toEqual(['CXM-PKG-027']);
  });

  it('a bug without referenceSolution.bugFix is CXM-PKG-027', async () => {
    const files = editJson(await fixture('fix-check-passes-bug'), 'cxm/lessons/l2.json', (l) => {
      l.bug.fixChecks = [{ type: 'contains', file: 'b.js', value: '= 0', message: 'start at zero' }];
      delete l.referenceSolution.bugFix;
    });
    expect(codes(await validatePackage(files))).toEqual(['CXM-PKG-027']);
  });

  it('a distribution package with a secret field is CXM-PKG-014, and 034 is not reported', async () => {
    const r = await validate('distribution-secret');
    expect(r.valid).toBe(false);
    expect(codes(r)).toEqual(['CXM-PKG-014']);
    expect(r.issues[0]).toMatchObject({ file: 'cxm/lessons/l2.json', pointer: '/referenceSolution' });
  });

  it('a distribution package without secrets is valid; the flavour option overrides course.json', async () => {
    const files = editJson(await fixture('distribution-secret'), 'cxm/lessons/l2.json', (l) => delete l.referenceSolution);
    expect(await validatePackage(files)).toEqual({ valid: true, issues: [] });
    expect(codes(await validatePackage(await fixture('minimal'), { flavour: 'distribution' }))).toEqual(['CXM-PKG-014']);
  });

  it('keeps the loader issues and reports them in the same pass', async () => {
    const files = editJson(await fixture('check-passes-starter'), 'cxm/course.json', (c) => (c.version = 'one'));
    const r = await validatePackage(files);
    expect(codes(r)).toContain('CXM-PKG-030');
    expect(codes(r)).toContain('CXM-PKG-022');
  });

  it('gives the same output on two runs, sorted by file and location', async () => {
    const files = editJson(await fixture('beat-ignore-previous'), 'cxm/lessons/l2.json', (l) => {
      delete l.sources;
      l.starterFiles['a.json'] = 'x';
    });
    const a = await validatePackage(files);
    const b = await validatePackage(files);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.issues.length).toBeGreaterThan(1);
    const keys = a.issues.map((i) => `${i.file}\u0000${i.xpath ?? i.pointer ?? ''}\u0000${i.code}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('explainCode', () => {
  it('returns the catalog entry with the help URL', () => {
    expect(explainCode('CXM-PKG-014')).toEqual({
      code: 'CXM-PKG-014',
      severity: 'error',
      title: 'secret field in a distribution package',
      fix: 'Remove the bug explanation, fix checks and reference solution from the distribution package; build it with the validator.',
      help: 'https://course-xapi-mcp.sqwrlz.com/errors/CXM-PKG-014',
    });
  });

  it('is undefined for an unknown code', () => {
    expect(explainCode('CXM-PKG-999')).toBeUndefined();
    expect(explainCode('toString')).toBeUndefined();
  });
});
