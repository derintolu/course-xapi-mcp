// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CXM_ACTIVITY_TYPES, CXM_EXT, CXM_VERBS, ERROR_HELP_BASE, SITE } from '../../reference/packages/core/src/constants.ts';
import { ISSUE_CATALOG } from '../../reference/packages/core/src/issues.ts';
import { buildSite, findMissingIris, MAX_HEADER_BLOCKS } from '../build.ts';

const tmp = mkdtempSync(join(tmpdir(), 'cxm-site-'));
const noAuthoring = join(tmp, 'no-such-authoring-dir');
const path = (iri: string) => iri.slice(SITE.length);
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');

/** A stand-in for the owner's docs/authoring, so these tests do not depend on it being committed. */
const authoringFixture = join(tmp, 'authoring-fixture');
mkdirSync(authoringFixture);
writeFileSync(join(authoringFixture, 'index.md'), '# Authoring\n\nSee [errors](errors.md#every-code).\n');
writeFileSync(join(authoringFixture, 'errors.md'), '---\nname: x\n---\n# Errors\n\n<!-- hidden -->\n\n<script>alert(1)</script>\n');

const HOSTILE = [
  '[a](javascript:alert(1))',
  '[a](JaVaScRiPt:alert(1))',
  '[a](javascript&#58;alert(1))',
  '[a](&#106;avascript:alert(1))',
  '[a](java&#x73;cript:alert(1))',
  '[a](java&Tab;script:alert(1))',
  '[a](javascript&amp;colon;alert(1))',
  '[a](data:text/html,x)',
  '[a](//evil.example/x)',
  '![i](javascript:alert(1))',
  '![i](&#106;avascript:alert(1))',
  '[r][ref]\n\n[ref]: javascript&colon;alert(1)',
  '[a](plain-file.png)',
];
const hostileDir = join(tmp, 'hostile-fixture');
mkdirSync(hostileDir);
writeFileSync(join(hostileDir, 'index.md'), '# Hostile\n\n' + HOSTILE.join('\n\n') + '\n\n[ok](https://example.org/x) [mail](mailto:a@b.example) [frag](#top) [abs](/xapi/) [rel](./x) [parent](../x)\n');

let bare: { dir: string; files: string[]; missingIris: string[] };
let withAuthoring: { dir: string; files: string[]; missingIris: string[] };

beforeAll(async () => {
  const dir = join(tmp, 'bare');
  bare = { dir, ...(await buildSite(dir, { authoringDir: noAuthoring })) };
  const dir2 = join(tmp, 'with');
  withAuthoring = { dir: dir2, ...(await buildSite(dir2, { authoringDir: authoringFixture })) };
}, 60_000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('buildSite', () => {
  it('leaves no IRI without a file, and builds without docs/authoring', () => {
    expect(bare.missingIris).toEqual([]);
    expect(withAuthoring.missingIris).toEqual([]);
    expect(existsSync(join(bare.dir, 'authoring'))).toBe(false);
    expect(bare.files).toContain('index.html');
    expect(bare.files).toContain('spec/draft/server/index.html');
  });

  it('gives every verb, extension and activity type an HTML page and a JSON-LD document', () => {
    for (const iri of [...Object.values(CXM_VERBS), ...Object.values(CXM_EXT), ...Object.values(CXM_ACTIVITY_TYPES)]) {
      expect(existsSync(join(bare.dir, path(iri), 'index.html')), iri).toBe(true);
      const ld = JSON.parse(read(bare.dir, path(iri) + '/index.jsonld'));
      expect(ld.id, iri).toBe(iri);
      expect(ld['@context']).toBe('https://w3id.org/xapi/profiles/context');
    }
    expect(existsSync(join(bare.dir, 'xapi/practice/index.html'))).toBe(true);
    expect(existsSync(join(bare.dir, 'xapi/v0.2/index.html'))).toBe(true);
    expect(existsSync(join(bare.dir, 'xapi/v0.2/templates/cmi5-launched/index.jsonld'))).toBe(true);
    expect(JSON.parse(read(bare.dir, 'xapi/index.jsonld')).id).toBe(SITE + '/xapi');
  });

  it('publishes the namespace, schemas and tool schemas', () => {
    expect(read(bare.dir, 'course/v1/index.html')).toContain('course/v1/cxm.xsd');
    expect(read(bare.dir, 'course/v1/cxm.xsd')).toContain('<xs:schema');
    expect(JSON.parse(read(bare.dir, 'schema/draft/course.schema.json')).$id).toBe(SITE + '/schema/draft/course.schema.json');
    expect(existsSync(join(bare.dir, 'schema/draft/tools/get_status.input.schema.json'))).toBe(true);
    expect(existsSync(join(bare.dir, 'practice-learner/index.html'))).toBe(true);
  });

  it('writes an error page per catalog code with title, severity and fix', () => {
    for (const code of Object.keys(ISSUE_CATALOG)) {
      expect(existsSync(join(bare.dir, 'errors', code, 'index.html')), code).toBe(true);
      expect(path(ERROR_HELP_BASE + code)).toBe('/errors/' + code);
    }
    const html = read(bare.dir, 'errors/CXM-PKG-014/index.html');
    const fix = ISSUE_CATALOG['CXM-PKG-014'].fix;
    expect(html).toContain(fix);
    expect(html).toContain(ISSUE_CATALOG['CXM-PKG-014'].title);
    expect(html).toContain('error');
    expect(existsSync(join(bare.dir, 'errors/index.html'))).toBe(true);
  });

  it('links error pages to the authoring errors page only when that page is built', () => {
    expect(read(bare.dir, 'errors/CXM-PKG-014/index.html')).not.toContain('/authoring/errors/');
    expect(read(withAuthoring.dir, 'errors/CXM-PKG-014/index.html')).toContain('href="/authoring/errors/"');
    expect(existsSync(join(withAuthoring.dir, 'authoring/errors/index.html'))).toBe(true);
  });

  it('renders Markdown with front matter and raw HTML removed, and links rewritten to site paths', () => {
    const errors = read(withAuthoring.dir, 'authoring/errors/index.html');
    expect(errors).not.toContain('name: x');
    expect(errors).not.toContain('hidden');
    expect(errors).not.toContain('<script>alert(1)</script>');
    expect(errors).toContain('&lt;script&gt;');
    expect(read(withAuthoring.dir, 'authoring/index.html')).toContain('href="/authoring/errors/#every-code"');
  });

  it('works at narrow widths: viewport meta and a stylesheet', () => {
    const html = read(bare.dir, 'spec/draft/server/index.html');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('href="/style.css"');
    expect(existsSync(join(bare.dir, 'style.css'))).toBe(true);
  });

  it('writes _headers with CORS, content types and Link headers the host can compile, and no _redirects (R69)', () => {
    const headers = read(bare.dir, '_headers');
    expect(headers).toMatch(/^\/xapi\/verbs\/:name\/index\.jsonld\n {2}Access-Control-Allow-Origin: \*\n {2}Content-Type: application\/ld\+json$/m);
    expect(headers).toMatch(/^\/xapi\/v0\.2\/index\.jsonld\n {2}Access-Control-Allow-Origin: \*\n {2}Content-Type: application\/ld\+json$/m);
    expect(headers).toMatch(/^\/schema\/draft\/:file\.json\n {2}Access-Control-Allow-Origin: \*\n {2}Content-Type: application\/schema\+json$/m);
    expect(headers).toMatch(/^\/xapi\/verbs\/:name\/\n {2}Link: <\/xapi\/verbs\/:name\/index\.jsonld>; rel="alternate"; type="application\/ld\+json"$/m);
    expect(headers).not.toContain('*.');
    expect(headers.trim().split(/\n\n+/).length).toBeLessThanOrEqual(MAX_HEADER_BLOCKS);
    expect(existsSync(join(bare.dir, '_redirects'))).toBe(false);
  });

  it('points each IRI page at its JSON-LD document', () => {
    expect(read(bare.dir, 'xapi/verbs/placed/index.html')).toContain('<link rel="alternate" type="application/ld+json" href="/xapi/verbs/placed/index.jsonld">');
    expect(read(bare.dir, 'xapi/v0.2/index.html')).toContain('<link rel="alternate" type="application/ld+json" href="/xapi/v0.2/index.jsonld">');
    expect(read(bare.dir, 'spec/draft/server/index.html')).not.toContain('rel="alternate"');
  });
});

describe('links', () => {
  it('only keeps allow-listed hrefs, including after entity decoding', async () => {
    const dir = join(tmp, 'hostile');
    await buildSite(dir, { authoringDir: hostileDir });
    const main = /<main>([\s\S]*)<\/main>/.exec(read(dir, 'authoring/index.html'))![1]!;
    const hrefs = [...main.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]!);
    expect(hrefs).toEqual([...HOSTILE.map(() => '#'), 'https://example.org/x', 'mailto:a@b.example', '#top', '/xapi/', './x', '../x']);
    expect(main).not.toMatch(/java|&#|&colon;|data:|evil/i);
  }, 60_000);

  it('keeps the directory of a relative .md link and fails the build on one that does not resolve', async () => {
    const dir = join(tmp, 'links-fixture');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.md'), '# I\n\n[a](errors.md) [b](../authoring/errors.md#x) [c](index.md)\n');
    writeFileSync(join(dir, 'errors.md'), '# E\n');
    await buildSite(join(tmp, 'links'), { authoringDir: dir });
    const html = read(join(tmp, 'links'), 'authoring/index.html');
    expect(html).toContain('href="/authoring/errors/"');
    expect(html).toContain('href="/authoring/errors/#x"');
    expect(html).toContain('href="/authoring/"');
    writeFileSync(join(dir, 'index.md'), '# I\n\n[gone](sub/missing.md)\n');
    await expect(buildSite(join(tmp, 'links2'), { authoringDir: dir })).rejects.toThrow(/does not resolve/);
  }, 60_000);
});

describe('hosting files', () => {
  it('gives each served file at most one CORS rule', () => {
    const headers = read(bare.dir, '_headers');
    const rules = headers.split(/\n\n+/).map((b) => b.trim().split('\n')).filter((l) => l[0]).map(([glob, ...lines]) => ({ re: new RegExp('^' + glob!.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+').replace(/\*/g, '.*') + '$'), cors: lines.some((l) => /Access-Control-Allow-Origin/.test(l)) }));
    for (const f of bare.files) {
      const n = rules.filter((r) => r.cors && r.re.test('/' + f)).length;
      const served = /\.(jsonld|xsd)$/.test(f) || f.startsWith('schema/draft/') && f.endsWith('.json');
      expect(n, f).toBe(served ? 1 : 0);
    }
  });
});

describe('out directory', () => {
  it('refuses the repository root, an ancestor of it and /', async () => {
    const repo = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
    await expect(buildSite(repo, { authoringDir: noAuthoring })).rejects.toThrow(/refusing/);
    await expect(buildSite(dirname(repo), { authoringDir: noAuthoring })).rejects.toThrow(/refusing/);
    await expect(buildSite('/', { authoringDir: noAuthoring })).rejects.toThrow(/refusing/);
  });
});

describe('findMissingIris', () => {
  it('reports the IRI when a concept page is removed', async () => {
    const dir = join(tmp, 'broken');
    await buildSite(dir, { authoringDir: noAuthoring });
    expect(findMissingIris(dir)).toEqual([]);
    rmSync(join(dir, 'xapi/verbs/placed/index.html'));
    expect(findMissingIris(dir)).toContain(CXM_VERBS.placed);
  }, 60_000);

  it('reports a concept IRI whose JSON-LD document is removed', async () => {
    const dir = join(tmp, 'broken-ld');
    await buildSite(dir, { authoringDir: noAuthoring });
    rmSync(join(dir, 'xapi/extensions/branch/index.jsonld'));
    expect(findMissingIris(dir)).toContain(CXM_EXT.branch);
  }, 60_000);

  it('reports an error page that is removed', async () => {
    const dir = join(tmp, 'broken-errors');
    await buildSite(dir, { authoringDir: noAuthoring });
    rmSync(join(dir, 'errors/CXM-PKG-001/index.html'));
    expect(findMissingIris(dir)).toContain(ERROR_HELP_BASE + 'CXM-PKG-001');
  }, 60_000);
});
