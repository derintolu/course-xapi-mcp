// SPDX-License-Identifier: Apache-2.0
// Builds the static spec site into site/dist (or the directory given). Every IRI under SITE that the profile, the
// constants, the schemas and the error help links use must resolve to a file in the output, or the build fails.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Marked, type Tokens } from 'marked';
import * as constants from '../reference/packages/core/src/constants.ts';
import { ISSUE_CATALOG } from '../reference/packages/core/src/issues.ts';
import { TEMPLATES } from '../reference/packages/core/src/xapi/templates.ts';
import { buildProfile } from '../reference/packages/core/src/xapi/profile.ts';

const { ERROR_HELP_BASE, PRACTICE_HOMEPAGE, PRACTICE_LABEL, PROFILE_ID, PROFILE_VERSION_IRI, SITE, SPEC_VERSION, CXM_XML_NS } = constants;

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

export interface BuildOptions {
  /** Directory of the authoring guide pages. Default docs/authoring; its pages are included only when it exists. */
  authoringDir?: string;
}

export interface BuildResult {
  files: string[];
  missingIris: string[];
}

interface Concept {
  id: string;
  type: string;
  prefLabel?: { en?: string };
  definition?: { en?: string };
  [k: string]: unknown;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pathOf = (iri: string) => iri.slice(SITE.length);

// ---- Markdown -------------------------------------------------------------------------------------------------

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .replace(/ /g, '-');

const NAMED_ENTITIES: Record<string, string> = {
  colon: ':', Tab: '\t', NewLine: '\n', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", sol: '/', period: '.', num: '#',
};

function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);?/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, n: string) => NAMED_ENTITIES[n] ?? m);
}

const ALLOWED_HREF = /^(\/(?!\/)|#|\.\/|\.\.\/|https?:|mailto:)/i;

/**
 * Allow-list for link and image targets: entity-decoded, then only site paths, fragments, relative paths and
 * http(s)/mailto survive. A relative `.md` link becomes the site path of that page, which must exist.
 */
function safeHref(raw: string, base: string, known: ReadonlySet<string>, from: string): string {
  const decoded = decodeEntities(raw);
  if (/&[A-Za-z][A-Za-z0-9]*;/.test(decoded)) return '#';
  const href = decoded.replace(/[\u0000- \u007f]/g, '');
  const md = /^([^#?:]*)\.md([#?].*)?$/.exec(href);
  if (md && !/^[/#]/.test(href)) {
    const target = posix.join(base, md[1]!);
    const url = posix.basename(target) === 'index' ? posix.dirname(target) + '/' : target + '/';
    if (!known.has(url)) throw new Error(`${from}: link to ${raw} does not resolve to a page of the site (${url})`);
    return url + (md[2] ?? '');
  }
  return ALLOWED_HREF.test(href) ? href : '#';
}

/** Renders repo Markdown: front matter and HTML comments dropped, other raw HTML escaped, links rewritten to site paths. */
function renderMarkdown(src: string, base: string, known: ReadonlySet<string>, from: string): { title: string; html: string } {
  const text = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const used = new Map<string, number>();
  const md = new Marked({
    walkTokens(token) {
      if (token.type === 'html') {
        const t = token as Tokens.HTML;
        t.text = /^\s*<!--[\s\S]*?-->\s*$/.test(t.text) ? '' : esc(t.text);
      } else if (token.type === 'link' || token.type === 'image') {
        const t = token as Tokens.Link | Tokens.Image;
        t.href = safeHref(t.href, base, known, from);
      }
    },
    renderer: {
      heading({ tokens, depth, text: raw }) {
        const slug = slugify(raw) || 'section';
        const n = used.get(slug) ?? 0;
        used.set(slug, n + 1);
        const id = n === 0 ? slug : `${slug}-${n}`;
        return `<h${depth} id="${esc(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  });
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.replace(/[`*_]/g, '') ?? 'Untitled';
  return { title, html: md.parse(text, { async: false }) };
}

// ---- IRI checking ---------------------------------------------------------------------------------------------

const IRI_RE = /https:\/\/course-xapi-mcp\.sqwrlz\.com[A-Za-z0-9._~/-]*/g;
const FILE_EXT = /\.(json|jsonld|xsd|css|html|txt)$/;

function irisIn(text: string): string[] {
  return (text.match(IRI_RE) ?? []).map((i) => i.replace(/\.+$/, ''));
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function constantIris(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.startsWith(SITE)) out.push(value);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) constantIris(v, out);
  }
  return out;
}

/** Every IRI under SITE that the profile, the constants, the schemas' $ids and the error help links use. */
function requiredIris(): string[] {
  const set = new Set<string>();
  const add = (iris: string[]) => iris.forEach((i) => set.add(i));
  add(irisIn(read('profile/xapi-profile.jsonld')));
  add(irisIn(JSON.stringify(buildProfile())));
  add(constantIris(constants));
  for (const f of walkFiles(join(root, 'schema/draft')).filter((f) => f.endsWith('.json'))) add(irisIn(readFileSync(f, 'utf8')));
  for (const code of Object.keys(ISSUE_CATALOG)) set.add(ERROR_HELP_BASE + code);
  return [...set].sort();
}

function fileForIri(iri: string): string {
  const p = pathOf(iri).split(/[?#]/)[0]!;
  if (FILE_EXT.test(p)) return p.slice(1);
  return posix.join(p.replace(/^\//, ''), 'index.html');
}

/** IRIs that are required but have no file in `out`; a profile concept IRI needs its JSON-LD document too. */
export function findMissingIris(out: string): string[] {
  const profile = JSON.parse(read('profile/xapi-profile.jsonld')) as { concepts: Concept[]; templates: Concept[]; patterns: Concept[] };
  const concepts = new Set([PROFILE_ID, PROFILE_VERSION_IRI, ...[...profile.concepts, ...profile.templates, ...profile.patterns].map((c) => c.id)]);
  return requiredIris().filter((iri) => {
    const file = fileForIri(iri);
    if (!existsSync(join(out, file))) return true;
    return concepts.has(iri) && !existsSync(join(out, posix.dirname(file), 'index.jsonld'));
  });
}

// ---- Build ----------------------------------------------------------------------------------------------------

const TYPE_HEADINGS: [string, string][] = [
  ['Verb', 'Verbs'],
  ['ActivityType', 'Activity types'],
  ['ResultExtension', 'Result extensions'],
  ['ContextExtension', 'Context extensions'],
  ['Activity', 'Activities'],
  ['StatementTemplate', 'Statement templates'],
  ['Pattern', 'Patterns'],
];

/** The host's limit on header blocks (Spacefast: 100). */
export const MAX_HEADER_BLOCKS = 100;

/**
 * `_headers` for a host whose matchers take `*` only at the end of a segment and `:name` for one segment (Spacefast),
 * so a type cannot be set by extension alone (R69). Each JSON-LD document gets its type and CORS, and each IRI's page
 * a `Link` to it; directories whose subdirectories are all IRIs share one `:name` block, others get exact blocks.
 * Schemas get their type and CORS per directory with `:file.json`.
 */
export function hostingHeaders(files: readonly string[]): string {
  const dirs = new Set<string>();
  for (const f of files) for (let d = posix.dirname(f); d !== '.'; d = posix.dirname(d)) dirs.add(d);
  const parentOf = (d: string) => (posix.dirname(d) === '.' ? '' : posix.dirname(d));
  const ldDirs = files.filter((f) => f.endsWith('/index.jsonld')).map((f) => posix.dirname(f));
  const ldSet = new Set(ldDirs);
  const groups = new Set<string>();
  for (const d of ldDirs) {
    const parent = parentOf(d);
    const shared = [...dirs].filter((s) => parentOf(s) === parent).every((s) => ldSet.has(s));
    groups.add(shared ? `/${parent ? parent + '/' : ''}:name` : `/${d}`);
  }
  const blocks: string[] = [];
  const ld = `  Access-Control-Allow-Origin: *\n  Content-Type: application/ld+json`;
  for (const g of [...groups].sort()) {
    const link = `  Link: <${g}/index.jsonld>; rel="alternate"; type="application/ld+json"`;
    blocks.push(`${g}/index.jsonld\n${ld}`, `${g}\n${link}`, `${g}/\n${link}`);
  }
  const schemaDirs = new Set(files.filter((f) => f.startsWith('schema/draft/') && f.endsWith('.json')).map((f) => posix.dirname(f)));
  for (const d of [...schemaDirs].sort()) blocks.push(`/${d}/:file.json\n  Access-Control-Allow-Origin: *\n  Content-Type: application/schema+json`);
  blocks.push(`/course/v1/cxm.xsd\n  Access-Control-Allow-Origin: *\n  Content-Type: application/xml`);
  if (blocks.length > MAX_HEADER_BLOCKS) throw new Error(`_headers has ${blocks.length} blocks; the host allows ${MAX_HEADER_BLOCKS}`);
  return blocks.join('\n\n') + '\n';
}

export async function buildSite(out: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const authoringDir = opts.authoringDir ?? join(root, 'docs/authoring');
  const hasAuthoring = existsSync(authoringDir) && statSync(authoringDir).isDirectory();
  const template = read('site/template.html');

  const target = resolve(out);
  if (target === sep || target === root.replace(/[\\/]+$/, '') || root.startsWith(target + sep)) {
    throw new Error(`refusing to build into ${target}: it is the repository root or one of its ancestors`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const files: string[] = [];
  const write = (rel: string, content: string) => {
    const p = join(out, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    files.push(rel);
  };
  const copy = (from: string, rel: string) => {
    const p = join(out, rel);
    mkdirSync(dirname(p), { recursive: true });
    copyFileSync(from, p);
    files.push(rel);
  };

  const nav = [
    '<a href="/spec/draft/">Specification</a>',
    hasAuthoring ? '<a href="/authoring/">Authoring</a>' : '',
    '<a href="/xapi/">xAPI profile</a>',
    '<a href="/schema/draft/">Schemas</a>',
    '<a href="/errors/">Errors</a>',
  ]
    .filter(Boolean)
    .join('\n');

  const page = (rel: string, title: string, description: string, body: string, head = '') => {
    const values: Record<string, string> = { title: esc(title), description: esc(description), nav, body, version: SPEC_VERSION, head };
    write(rel, template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? ''));
  };

  // Markdown sections: spec and (when present) authoring.
  const sectionPages = (dir: string, urlBase: string) =>
    readdirSync(dir)
      .filter((n) => n.endsWith('.md'))
      .sort()
      .map((f) => ({ f, name: f.slice(0, -3), url: f === 'index.md' ? urlBase : `${urlBase}${f.slice(0, -3)}/` }));
  const known = new Set<string>([
    ...sectionPages(join(root, 'spec/draft'), '/spec/draft/').map((p) => p.url),
    ...(hasAuthoring ? sectionPages(authoringDir, '/authoring/').map((p) => p.url) : []),
  ]);
  const markdownSection = (dir: string, urlBase: string, outBase: string) => {
    for (const { f, name } of sectionPages(dir, urlBase)) {
      const { title, html } = renderMarkdown(readFileSync(join(dir, f), 'utf8'), urlBase, known, `${outBase}/${f}`);
      const desc = `${title}, course-xapi-mcp draft ${SPEC_VERSION}.`;
      page(name === 'index' ? `${outBase}/index.html` : `${outBase}/${name}/index.html`, title, desc, html);
    }
  };
  markdownSection(join(root, 'spec/draft'), '/spec/draft/', 'spec/draft');
  if (hasAuthoring) markdownSection(authoringDir, '/authoring/', 'authoring');

  // Schemas and the namespace.
  const schemaDir = join(root, 'schema/draft');
  const schemaFiles = walkFiles(schemaDir).filter((f) => f.endsWith('.json'));
  for (const f of schemaFiles) copy(f, 'schema/draft/' + posix.relative(schemaDir, f).split('\\').join('/'));
  copy(join(schemaDir, 'cxm.xsd'), 'course/v1/cxm.xsd');
  copy(join(root, 'site/style.css'), 'style.css');

  const schemaRows = schemaFiles
    .map((f) => posix.relative(schemaDir, f).split('\\').join('/'))
    .sort()
    .map((rel) => `<li><a href="/schema/draft/${esc(rel)}">${esc(rel)}</a></li>`)
    .join('\n');
  page(
    'schema/draft/index.html',
    'Schemas',
    'JSON Schemas for course packages and the course server tools.',
    `<h1>Schemas</h1>
<p class="lede">JSON Schema (draft ${SPEC_VERSION}) for the course and lesson files, and for the input and output of every course server tool. Where a schema and the prose disagree, the schema wins.</p>
<p>The XML Schema for the <code>cxm:</code> extension elements is <a href="/course/v1/cxm.xsd">cxm.xsd</a>.</p>
<ul>
${schemaRows}
</ul>`,
  );
  page(
    'course/v1/index.html',
    'The cxm namespace',
    'The XML namespace of the course-xapi-mcp extension to cmi5.xml.',
    `<h1>The cxm namespace</h1>
<p class="lede">This is the XML namespace of the course-xapi-mcp extension elements and attributes in <code>cmi5.xml</code>.</p>
<table>
<tr><th>Namespace</th><td><code>${esc(CXM_XML_NS)}</code></td></tr>
<tr><th>Prefix</th><td><code>cxm</code></td></tr>
<tr><th>Schema</th><td><a href="/course/v1/cxm.xsd">cxm.xsd</a></td></tr>
</table>
<pre><code>${esc(`<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd"
                 xmlns:cxm="${CXM_XML_NS}">`)}</code></pre>
<p>The extension elements sit at the tail positions that cmi5 allows. The package rules are in the <a href="/spec/draft/package/">package specification</a>.</p>`,
  );

  // The xAPI profile and every concept IRI.
  const profile = JSON.parse(read('profile/xapi-profile.jsonld')) as Record<string, unknown> & {
    concepts: Concept[];
    templates: Concept[];
    patterns: Concept[];
  };
  if (profile.templates.length !== TEMPLATES.length) {
    throw new Error(`profile/xapi-profile.jsonld has ${profile.templates.length} statement templates but TEMPLATES has ${TEMPLATES.length}; run npm run profile`);
  }
  const profileJson = JSON.stringify(profile, null, 2) + '\n';
  const ldContext = (profile['@context'] as string) ?? 'https://w3id.org/xapi/profiles/context';
  // The host does no content negotiation: an IRI's HTML page points at its JSON-LD document (R69).
  const alternate = (p: string) => `<link rel="alternate" type="application/ld+json" href="${esc(p)}/index.jsonld">\n`;

  const all: Concept[] = [...profile.concepts, ...profile.templates, ...profile.patterns];
  const conceptPage = (c: Concept) => {
    const p = pathOf(c.id);
    const label = c.prefLabel?.en ?? posix.basename(p);
    const def = c.definition?.en ?? '';
    write(`${p.slice(1)}/index.jsonld`, JSON.stringify({ '@context': ldContext, ...c }, null, 2) + '\n');
    const scheme = typeof c.inScheme === 'string' ? `<tr><th>In</th><td><a href="${esc(pathOf(c.inScheme))}/">${esc(c.inScheme)}</a></td></tr>` : '';
    page(
      `${p.slice(1)}/index.html`,
      label,
      def || label,
      `<h1>${esc(label)}</h1>
<p class="lede">${esc(def)}</p>
<table>
<tr><th>Type</th><td>${esc(c.type)}</td></tr>
<tr><th>Identifier</th><td><code>${esc(c.id)}</code></td></tr>
${scheme}
<tr><th>Machine-readable</th><td><a href="${esc(p)}/index.jsonld">index.jsonld</a></td></tr>
</table>
<h2>Definition</h2>
<pre><code>${esc(JSON.stringify(c, null, 2))}</code></pre>`,
      alternate(p),
    );
  };
  all.forEach(conceptPage);

  const profileLabel = (profile.prefLabel as { en?: string } | undefined)?.en ?? 'course-xapi-mcp';
  const profileDef = (profile.definition as { en?: string } | undefined)?.en ?? '';
  const groups = TYPE_HEADINGS.map(([type, heading]) => {
    const items = all.filter((c) => c.type === type);
    if (!items.length) return '';
    const lis = items.map((c) => `<li><a href="${esc(pathOf(c.id))}/">${esc(c.prefLabel?.en ?? c.id)}</a></li>`).join('\n');
    return `<h2>${heading}</h2>\n<ul>\n${lis}\n</ul>`;
  }).join('\n');
  const profileBody = (h1: string, extra: string) => `<h1>${esc(h1)}</h1>
<p class="lede">${esc(profileDef)}</p>
${extra}
<table>
<tr><th>Profile</th><td><code>${esc(PROFILE_ID)}</code></td></tr>
<tr><th>This version</th><td><code>${esc(PROFILE_VERSION_IRI)}</code></td></tr>
<tr><th>Machine-readable</th><td><a href="/xapi/index.jsonld">index.jsonld</a> (JSON-LD, xAPI Profile 1.0)</td></tr>
</table>
${groups}`;
  write('xapi/index.jsonld', profileJson);
  write(pathOf(PROFILE_VERSION_IRI).slice(1) + '/index.jsonld', profileJson);
  page('xapi/index.html', `${profileLabel} xAPI profile`, profileDef, profileBody(`${profileLabel} xAPI profile`, `<p>The verbs, activity types, extensions, statement templates and patterns that course-xapi-mcp adds to cmi5. Each has its own page and JSON-LD document.</p>`), alternate(pathOf(PROFILE_ID)));
  page(
    pathOf(PROFILE_VERSION_IRI).slice(1) + '/index.html',
    `${profileLabel} xAPI profile, version ${SPEC_VERSION}`,
    profileDef,
    profileBody(`Version ${SPEC_VERSION}`, `<p>The concepts of this version of the profile. <a href="/xapi/">Profile overview</a>.</p>`),
    alternate(pathOf(PROFILE_VERSION_IRI)),
  );

  page(
    'practice-learner/index.html',
    'Practice learner',
    'The account home page of practice-run learners.',
    `<h1>Practice learner</h1>
<p class="lede">${esc(PRACTICE_LABEL)}</p>
<p>A practice run records its statements for an actor that is an account under this page, <code>${esc(PRACTICE_HOMEPAGE)}</code>, with a random identifier as the account name. The actor has no name, email address or other personal data. Every statement of a practice run also carries the category <a href="/xapi/practice/"><code>${esc(constants.PRACTICE_CATEGORY)}</code></a>.</p>
<p>A practice record is not an official record, and a practice run cannot earn badges. See the <a href="/spec/draft/custody/">custody specification</a>.</p>`,
  );

  // Error help pages.
  const authoringErrors = hasAuthoring && existsSync(join(authoringDir, 'errors.md'));
  const codes = Object.keys(ISSUE_CATALOG) as (keyof typeof ISSUE_CATALOG)[];
  for (const code of codes) {
    const e = ISSUE_CATALOG[code];
    page(
      `${pathOf(ERROR_HELP_BASE + code).slice(1)}/index.html`,
      code,
      e.title,
      `<h1>${esc(code)}</h1>
<p><span class="tag ${e.severity}">${e.severity}</span></p>
<h2>What it means</h2>
<p>${esc(e.title)}</p>
<h2>How to fix it</h2>
<p>${esc(e.fix)}</p>
<p><a href="/errors/">All validator codes</a>${authoringErrors ? '. <a href="/authoring/errors/">Working through validator errors</a>' : ''}. The requirement is defined in the <a href="/spec/draft/package/">package specification</a>.</p>`,
    );
  }
  const errorRows = codes.map((c) => `<tr><td><a href="/errors/${esc(c)}/">${esc(c)}</a></td><td>${ISSUE_CATALOG[c].severity}</td><td>${esc(ISSUE_CATALOG[c].title)}</td></tr>`).join('\n');
  page(
    'errors/index.html',
    'Validator codes',
    'Every issue code the course package validator reports, with its fix.',
    `<h1>Validator codes</h1>
<p class="lede">Every issue code the course package validator reports. Each links to a page with the fix.${authoringErrors ? ' <a href="/authoring/errors/">Working through validator errors</a> explains the loop.' : ''}</p>
<table>
<tr><th>Code</th><th>Severity</th><th>Meaning</th></tr>
${errorRows}
</table>`,
  );

  // Home.
  page(
    'index.html',
    'course-xapi-mcp',
    'Courses that run inside an AI agent over MCP, with the learner record in xAPI.',
    `<h1>course-xapi-mcp</h1>
<p class="lede">A course package on cmi5, a course server that teaches it to a learner's AI agent over the Model Context Protocol, the custody of the learner's xAPI record, and the Open Badges a course can award. Draft ${SPEC_VERSION}, not stable.</p>
<ul>
<li><a href="/spec/draft/">Specification</a>: the normative text, one page per conformance class.</li>
${hasAuthoring ? '<li><a href="/authoring/">Authoring guide</a>: converting an existing course, field by field.</li>\n' : ''}<li><a href="/xapi/">xAPI profile</a>: the verbs, activity types, extensions and statement templates, each with a JSON-LD document.</li>
<li><a href="/schema/draft/">Schemas</a>: JSON Schema for packages and tools, and <a href="/course/v1/">the cxm XML namespace</a>.</li>
<li><a href="/errors/">Validator codes</a>: every code with its fix.</li>
<li><a href="/practice-learner/">Practice learner</a>: the account home page of practice runs.</li>
</ul>`,
  );

  // Hosting files.
  write('_headers', hostingHeaders(files));

  const missingIris = findMissingIris(out);
  return { files: files.sort(), missingIris };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] ?? join(root, 'site/dist');
  const { files, missingIris } = await buildSite(out);
  if (missingIris.length) {
    console.error(`site build failed: ${missingIris.length} IRI(s) have no file in ${out}:`);
    for (const iri of missingIris) console.error('  ' + iri);
    process.exit(1);
  }
  console.log(`built ${files.length} files into ${out}`);
}
