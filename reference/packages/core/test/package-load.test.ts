// SPDX-License-Identifier: Apache-2.0
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { loadPackage, parseCmi5Xml, readDir, readZip } from '../src/package/index.ts';
import type { PackageFiles } from '../src/package/index.ts';
import type { IssueCode } from '../src/issues.ts';

const dir = (name: string) => readDir(new URL(`./fixtures/packages/${name}/`, import.meta.url).pathname);
const load = async (name: string, o?: { allowDistribution?: boolean }) => loadPackage(await dir(name), o);

describe('loadPackage: the good package', () => {
  it('loads with no issues and the expected model', async () => {
    const r = await load('good');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.issues).toEqual([]);
    const c = r.course;
    expect(Object.keys(c).sort()).toEqual(
      ['allowPractice', 'badges', 'custody', 'description', 'flavour', 'id', 'language', 'lessons', 'mcp', 'paths', 'placement', 'rules', 'specVersion', 'title', 'version'].sort(),
    );
    expect(c.title).toBe('Course');
    expect(c.id).toBe('https://example.org/c');
    expect(c.mcp).toBe('http://127.0.0.1:8787/mcp');
    expect(c.placement).toEqual({ key: 'placement', auId: 'https://example.org/c/placement', url: 'http://127.0.0.1:8787/launch?au=placement', title: 'Placement', intro: 'Tell me what you know.', maxQuestions: 3 });
    expect(c.lessons['l1']!.auId).toBe('https://example.org/c/lessons/l1');
    expect(c.lessons['l1']!.pathKey).toBe('p');
    expect(c.lessons['l1']!.moveOn).toBe('Completed');
    expect(c.lessons['l2']!.moveOn).toBe('CompletedAndPassed');
    expect(c.lessons['l2']!.checkpoint?.kind).toBe('code');
    expect(c.paths['p']).toEqual({ key: 'p', blockId: 'https://example.org/c/paths/p', title: 'Path P', description: 'The path.', tagline: 'Learn P', status: 'live', lessons: ['l1', 'l2'] });
    expect(c.paths['later']).toEqual({ key: 'later', title: 'Later', tagline: 'Soon', status: 'coming-soon', lessons: [] });
  });
});

type Case = [fixture: string, code: IssueCode, file: string, where: string];
const X = '/courseStructure[1]';
const cases: Case[] = [
  ['no-cxm-course', 'CXM-PKG-004', 'cmi5.xml', `${X}/course[1]`],
  ['spec-major', 'CXM-PKG-004', 'cmi5.xml', `${X}/course[1]/cxm:course[1]`],
  ['src-missing-file', 'CXM-PKG-005', 'cmi5.xml', `${X}/block[1]/au[1]/cxm:lesson[1]`],
  ['src-bad-pointer', 'CXM-PKG-005', 'cmi5.xml', `${X}/block[1]/cxm:path[1]`],
  ['course-schema', 'CXM-PKG-006', 'cxm/course.json', '/custody'],
  ['lesson-schema', 'CXM-PKG-007', 'cxm/lessons/l1.json', '/minutes'],
  ['dup-key', 'CXM-PKG-008', 'cmi5.xml', `${X}/block[1]/au[2]`],
  ['key-missing', 'CXM-PKG-009', 'cmi5.xml', `${X}/block[1]/au[1]`],
  ['key-invalid', 'CXM-PKG-009', 'cmi5.xml', `${X}/block[1]/au[1]`],
  ['branch-unknown', 'CXM-PKG-010', 'cxm/lessons/l2.json', '/checkpoint/branches/0/to'],
  ['branch-other-path', 'CXM-PKG-011', 'cxm/lessons/l2.json', '/checkpoint/branches/0/to'],
  ['empty-block', 'CXM-PKG-012', 'cmi5.xml', `${X}/block[1]`],
  ['moveon-wrong', 'CXM-PKG-013', 'cmi5.xml', `${X}/block[1]/au[1]`],
  ['placement-missing', 'CXM-PKG-015', 'cmi5.xml', `${X}/course[1]`],
  ['placement-moveon', 'CXM-PKG-015', 'cmi5.xml', `${X}/au[1]`],
  ['path-no-block', 'CXM-PKG-016', 'cxm/course.json', '/paths/extra'],
  ['block-no-path-element', 'CXM-PKG-016', 'cmi5.xml', `${X}/block[1]`],
  ['coming-soon-with-block', 'CXM-PKG-016', 'cmi5.xml', `${X}/block[1]`],
  ['branch-dup-key', 'CXM-PKG-017', 'cxm/lessons/l2.json', '/checkpoint/branches/1/key'],
  ['branch-no-success', 'CXM-PKG-017', 'cxm/lessons/l2.json', '/checkpoint/branches'],
  ['code-no-checks', 'CXM-PKG-018', 'cxm/lessons/l2.json', '/checkpoint'],
  ['code-no-failure-branch', 'CXM-PKG-018', 'cxm/lessons/l2.json', '/checkpoint/branches'],
  ['beat-dup', 'CXM-PKG-019', 'cxm/lessons/l1.json', '/beats/1/key'],
  ['file-name', 'CXM-PKG-020', 'cxm/lessons/l2.json', '/checkpoint/file'],
  ['regex-bad', 'CXM-PKG-021', 'cxm/lessons/l2.json', '/checkpoint/checks/1/pattern'],
  ['failure-branch-forward', 'CXM-PKG-026', 'cxm/lessons/l1.json', '/checkpoint/branches/1/to'],
  ['url-http', 'CXM-PKG-028', 'cmi5.xml', `${X}/block[1]/au[1]`],
  ['id-not-iri', 'CXM-PKG-029', 'cmi5.xml', `${X}/block[1]/au[1]`],
  ['id-duplicate', 'CXM-PKG-029', 'cmi5.xml', `${X}/block[1]/au[2]`],
  ['language-bad', 'CXM-PKG-030', 'cxm/course.json', '/language'],
  ['version-bad', 'CXM-PKG-030', 'cxm/course.json', '/version'],
  ['practice-badges', 'CXM-PKG-031', 'cxm/course.json', '/badges'],
  ['practice-allow', 'CXM-PKG-031', 'cxm/course.json', '/allowPractice'],
  ['badge-for-missing', 'CXM-PKG-032', 'cxm/course.json', '/badges/0/for'],
  ['badge-for-present', 'CXM-PKG-032', 'cxm/course.json', '/badges/0/for'],
  ['badge-id-http', 'CXM-PKG-032', 'cxm/course.json', '/badges/0/id'],
  ['badge-no-issuer', 'CXM-PKG-033', 'cxm/course.json', '/badges'],
  ['distribution', 'CXM-PKG-034', 'cxm/course.json', '/flavour'],
];

/** Fixtures whose single fault legitimately causes a second code. */
const cascades: Record<string, IssueCode[]> = { 'dup-key': ['CXM-PKG-008', 'CXM-PKG-010'] };

describe('loadPackage: one fixture per error code', () => {
  it.each(cases)('%s gives %s at %s %s', async (fixture, code, file, where) => {
    const r = await load(fixture);
    expect(r.ok).toBe(false);
    const hit = r.issues.find((i) => i.code === code);
    expect(hit, JSON.stringify(r.issues)).toBeDefined();
    expect(hit!.severity).toBe('error');
    expect(hit!.file).toBe(file);
    expect(hit!.xpath ?? hit!.pointer).toBe(where);
    expect(hit!.fix.length).toBeGreaterThan(0);
    const errorCodes = [...new Set(r.issues.filter((i) => i.severity === 'error').map((i) => i.code))].sort();
    expect(errorCodes).toEqual([...(cascades[fixture] ?? [code])].sort());
  });

  it('uses the zod message in the fix for schema issues', async () => {
    const r = await load('lesson-schema');
    expect(r.issues[0]!.fix).toMatch(/^Change \/minutes: /);
  });

  it('reports a package with three independent errors in full, sorted by file', async () => {
    const r = await load('three-errors');
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => [i.code, i.file])).toEqual([
      ['CXM-PKG-028', 'cmi5.xml'],
      ['CXM-PKG-019', 'cxm/lessons/l1.json'],
      ['CXM-PKG-010', 'cxm/lessons/l2.json'],
    ]);
  });
});

describe('loadPackage: 001', () => {
  it('reports a package with no cmi5.xml', () => {
    const r = loadPackage({ 'other.txt': strToU8('x') });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: 'CXM-PKG-001', file: 'cmi5.xml' });
  });

  it('reports cmi5.xml that is not well-formed', () => {
    const r = loadPackage({ 'cmi5.xml': strToU8('<courseStructure><course></courseStructure>') });
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.code).toBe('CXM-PKG-001');
  });

  it('reads a ZIP of the good package', async () => {
    const files = await dir('good');
    const zip = zipSync(Object.fromEntries(Object.entries(files)), { level: 0 });
    const back = readZip(zip) as PackageFiles;
    expect(Object.keys(back).sort()).toEqual(Object.keys(files).sort());
    expect(loadPackage(back).ok).toBe(true);
  });

  it('gives 001 for bytes that are not a ZIP', () => {
    expect(readZip(strToU8('not a zip'))).toMatchObject({ code: 'CXM-PKG-001' });
  });

  it('rejects a ZIP entry that climbs out of the package', () => {
    const zip = zipSync({ 'cmi5.xml': strToU8('<x/>'), '../evil': strToU8('x') });
    expect(readZip(zip)).toMatchObject({ code: 'CXM-PKG-001', file: '../evil' });
  });

  it('rejects an absolute ZIP entry', () => {
    const zip = zipSync({ '/etc/passwd': strToU8('x') });
    expect(readZip(zip)).toMatchObject({ code: 'CXM-PKG-001' });
  });
});

describe('loadPackage: warnings and info still load', () => {
  it('specVersion 1.0 is refused (004)', async () => {
    const r = await load('spec-major');
    expect(r.ok).toBe(false);
  });

  it('specVersion 0.3 gives 206 and still loads', async () => {
    const r = await load('spec-minor');
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([['CXM-PKG-206', 'warning']]);
  });

  it('an unknown <other:thing> element gives 100 and still loads', async () => {
    const r = await load('foreign-element');
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: 'CXM-PKG-100', severity: 'info', file: 'cmi5.xml', xpath: `${X}/other:thing[1]` });
  });

  it('a distribution package gives 034, and loads with allowDistribution', async () => {
    expect((await load('distribution')).ok).toBe(false);
    const r = await load('distribution', { allowDistribution: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.course.flavour).toBe('distribution');
  });

  it('a distribution package with a bug and no secret fields loads with allowDistribution', async () => {
    expect((await load('distribution-bug')).issues.map((i) => i.code)).toEqual(['CXM-PKG-034']);
    const r = await load('distribution-bug', { allowDistribution: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.course.lessons['l2']!.bug?.key).toBe('bug1');
  });

  it('an unknown extensions key gives 100 and still loads', async () => {
    const r = await load('extension-key');
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: 'CXM-PKG-100', severity: 'info', file: 'cxm/course.json', pointer: '/extensions/com.example~1thing' });
  });

  it('a malformed percent-escape in a src fragment gives 005 and does not throw', async () => {
    const r = await load('bad-escape');
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === 'CXM-PKG-005')).toMatchObject({ file: 'cmi5.xml', xpath: `${X}/block[1]/au[1]/cxm:lesson[1]` });
  });

  it('resolves namespaces by URI, not prefix', async () => {
    const files = await dir('good');
    const xml = new TextDecoder().decode(files['cmi5.xml']).replaceAll('cxm:', 'z:').replace('xmlns:cxm=', 'xmlns:z=');
    const r = loadPackage({ ...files, 'cmi5.xml': strToU8(xml) });
    expect(r.ok).toBe(true);
  });
});

describe('parseCmi5Xml', () => {
  it('picks the langstring for the language, else the first', async () => {
    const xml = new TextDecoder().decode((await dir('good'))['cmi5.xml']);
    const en = parseCmi5Xml(xml, 'en');
    const fr = parseCmi5Xml(xml, 'fr');
    const de = parseCmi5Xml(xml, 'de');
    if (!('structure' in en) || !('structure' in fr) || !('structure' in de)) throw new Error('expected structures');
    expect(en.structure.course.title).toBe('Course');
    expect(fr.structure.course.title).toBe('Cours');
    expect(de.structure.course.title).toBe('Cours');
    expect(en.structure.course.cxm).toMatchObject({ src: 'cxm/course.json', specVersion: '0.2' });
    expect(en.structure.aus.map((a) => a.key)).toEqual(['placement', 'l1', 'l2']);
    expect(en.structure.blocks.map((b) => b.key)).toEqual(['p']);
  });
});
