// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CXM_ACTIVITY_TYPES, CXM_EXT, CXM_VERBS, ERROR_HELP_BASE, SITE } from '../../reference/packages/core/src/constants.ts';
import { ISSUE_CATALOG } from '../../reference/packages/core/src/issues.ts';
import { buildSite, findMissingIris } from '../build.ts';

const tmp = mkdtempSync(join(tmpdir(), 'cxm-site-'));
const noAuthoring = join(tmp, 'no-such-authoring-dir');
const path = (iri: string) => iri.slice(SITE.length);
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');

/** A stand-in for the owner's docs/authoring, so these tests do not depend on it being committed. */
const authoringFixture = join(tmp, 'authoring-fixture');
mkdirSync(authoringFixture);
writeFileSync(join(authoringFixture, 'index.md'), '# Authoring\n\nSee [errors](errors.md#every-code).\n');
writeFileSync(join(authoringFixture, 'errors.md'), '---\nname: x\n---\n# Errors\n\n<!-- hidden -->\n\n<script>alert(1)</script>\n');

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
    for (const [code, entry] of Object.entries(ISSUE_CATALOG)) {
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

  it('writes _headers with CORS and content types, and _redirects with 303s to JSON-LD', () => {
    const headers = read(bare.dir, '_headers');
    expect(headers).toMatch(/^\/\*\.jsonld\n {2}Access-Control-Allow-Origin: \*\n {2}Content-Type: application\/ld\+json$/m);
    expect(headers).toMatch(/^\/schema\/draft\/\*\.json\n {2}Access-Control-Allow-Origin: \*\n {2}Content-Type: application\/schema\+json$/m);
    const redirects = read(bare.dir, '_redirects');
    expect(redirects).toContain('/xapi/verbs/placed  /xapi/verbs/placed/index.jsonld  303  Accept=application/ld+json');
  });
});

describe('findMissingIris', () => {
  it('reports the IRI when a concept page is removed', async () => {
    const dir = join(tmp, 'broken');
    await buildSite(dir, { authoringDir: noAuthoring });
    expect(await findMissingIris(dir)).toEqual([]);
    rmSync(join(dir, 'xapi/verbs/placed/index.html'));
    expect(await findMissingIris(dir)).toContain(CXM_VERBS.placed);
  }, 60_000);

  it('reports an error page that is removed', async () => {
    const dir = join(tmp, 'broken-errors');
    await buildSite(dir, { authoringDir: noAuthoring });
    rmSync(join(dir, 'errors/CXM-PKG-001/index.html'));
    expect(await findMissingIris(dir)).toContain(ERROR_HELP_BASE + 'CXM-PKG-001');
  }, 60_000);
});
