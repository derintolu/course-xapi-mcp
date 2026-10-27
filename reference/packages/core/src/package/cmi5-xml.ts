// SPDX-License-Identifier: Apache-2.0
// Reads cmi5.xml into a plain structure. Namespaces are resolved by URI, never by prefix.
import { XMLParser } from 'fast-xml-parser';
import { CMI5_XML_NS, CXM_XML_NS } from '../constants.ts';
import { makeIssue } from '../issues.ts';
import type { ValidationIssue } from '../issues.ts';

const FILE = 'cmi5.xml';

export interface Cmi5Au {
  id: string;
  key?: string;
  role?: string;
  moveOn: string;
  launchMethod?: string;
  title: string;
  description: string;
  url: string;
  /** The `src` of the `cxm:lesson` child. */
  lessonSrc?: string;
  lessonXpath?: string;
  /** XPath of the top-level block this AU sits in; absent for course-level AUs. */
  blockXpath?: string;
  /** Ordinal among the au/block siblings at its level. */
  position: number;
  xpath: string;
}

export interface Cmi5Block {
  id: string;
  key?: string;
  title: string;
  description: string;
  /** The `src` of the `cxm:path` child. */
  pathSrc?: string;
  pathXpath?: string;
  /** True for a block inside another block (not a path). */
  nested: boolean;
  position: number;
  xpath: string;
}

export interface Cmi5Structure {
  course: {
    id: string;
    title: string;
    description: string;
    cxm?: { src: string; specVersion: string; mcp: string; xpath: string };
    xpath: string;
  };
  aus: Cmi5Au[];
  blocks: Cmi5Block[];
}

interface Node {
  local: string;
  ns: string | null;
  qname: string;
  /** Unprefixed attributes by name; namespaced ones as `{uri}local`. */
  attrs: Record<string, string>;
  children: Node[];
  text: string;
  xpath: string;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

type Raw = Record<string, unknown>;

function build(raw: Raw, scope: Record<string, string>, parentPath: string, siblingCounts: Map<string, number>): Node | null {
  const qname = Object.keys(raw).find((k) => k !== ':@');
  if (qname === undefined || qname.startsWith('?') || qname === '#text') return null;
  const rawAttrs = (raw[':@'] ?? {}) as Record<string, string>;
  const here = { ...scope };
  for (const [k, v] of Object.entries(rawAttrs)) {
    if (k === '@_xmlns') here[''] = v;
    else if (k.startsWith('@_xmlns:')) here[k.slice(8)] = v;
  }
  const colon = qname.indexOf(':');
  const prefix = colon < 0 ? '' : qname.slice(0, colon);
  const local = colon < 0 ? qname : qname.slice(colon + 1);
  const n = (siblingCounts.get(qname) ?? 0) + 1;
  siblingCounts.set(qname, n);
  const xpath = `${parentPath}/${qname}[${n}]`;
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawAttrs)) {
    const name = k.slice(2);
    if (name === 'xmlns' || name.startsWith('xmlns:') || name.startsWith('xml:')) continue;
    const c = name.indexOf(':');
    if (c < 0) attrs[name] = String(v);
    else attrs[`{${here[name.slice(0, c)] ?? ''}}${name.slice(c + 1)}`] = String(v);
  }
  const children: Node[] = [];
  let text = '';
  const counts = new Map<string, number>();
  for (const child of raw[qname] as Raw[]) {
    if ('#text' in child) {
      text += String(child['#text']);
      continue;
    }
    const node = build(child, here, xpath, counts);
    if (node) children.push(node);
  }
  return { local, ns: here[prefix] ?? null, qname, attrs, children, text: text.trim(), xpath };
}

const inNs = (n: Node, ns: string, local: string) => n.ns === ns && n.local === local;
const cmi5 = (n: Node, local: string) => inNs(n, CMI5_XML_NS, local);
const cxmAttr = (n: Node, local: string) => n.attrs[`{${CXM_XML_NS}}${local}`];

function pickLang(parent: Node, name: string, language: string | undefined): string {
  const holder = parent.children.find((c) => cmi5(c, name));
  if (!holder) return '';
  const strings = holder.children.filter((c) => cmi5(c, 'langstring'));
  if (strings.length === 0) return holder.text;
  if (language) {
    const want = language.toLowerCase();
    const primary = want.split('-')[0];
    const hit = strings.find((s) => (s.attrs.lang ?? '').toLowerCase() === want) ?? strings.find((s) => (s.attrs.lang ?? '').toLowerCase().split('-')[0] === primary);
    if (hit) return hit.text;
  }
  return strings[0]!.text;
}

function foreign(n: Node, out: ValidationIssue[]): void {
  for (const k of Object.keys(n.attrs)) {
    const m = /^\{(.*)\}(.*)$/.exec(k);
    if (m && m[1] !== CMI5_XML_NS && m[1] !== CXM_XML_NS) {
      out.push(makeIssue('CXM-PKG-100', { file: FILE, xpath: n.xpath }, `Unknown attribute "${m[2]}" in namespace ${m[1]} is ignored.`));
    }
  }
  for (const c of n.children) {
    if (c.ns !== CMI5_XML_NS && c.ns !== CXM_XML_NS) {
      out.push(makeIssue('CXM-PKG-100', { file: FILE, xpath: c.xpath }, `Unknown element <${c.qname}> in namespace ${c.ns ?? '(none)'} is ignored.`));
    } else {
      foreign(c, out);
    }
  }
}

function bad(message: string): { issues: ValidationIssue[] } {
  return { issues: [makeIssue('CXM-PKG-001', { file: FILE }, message, 'Provide a well-formed cmi5.xml whose root is <courseStructure> in the cmi5 CourseStructure namespace.')] };
}

/**
 * Parses cmi5.xml. `language` picks the langstring for titles and descriptions (else the first one).
 * Per-element rules (keys, ids, urls) are checked by `loadPackage`, not here.
 */
export function parseCmi5Xml(xml: string, language?: string): { structure: Cmi5Structure; issues: ValidationIssue[] } | { issues: ValidationIssue[] } {
  let raw: Raw[];
  try {
    raw = parser.parse(xml) as Raw[];
  } catch (err) {
    return bad(`cmi5.xml is not well-formed XML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rootRaw = raw.find((r) => Object.keys(r).some((k) => k !== ':@' && !k.startsWith('?')));
  const root = rootRaw ? build(rootRaw, {}, '', new Map()) : null;
  if (!root || !cmi5(root, 'courseStructure')) return bad('cmi5.xml has no <courseStructure> root element in the cmi5 CourseStructure namespace.');
  const courseEl = root.children.find((c) => cmi5(c, 'course'));
  if (!courseEl) return bad('cmi5.xml has no <course> element.');

  const issues: ValidationIssue[] = [];
  foreign(root, issues);

  const cxmEl = courseEl.children.find((c) => inNs(c, CXM_XML_NS, 'course'));
  const structure: Cmi5Structure = {
    course: {
      id: courseEl.attrs.id ?? '',
      title: pickLang(courseEl, 'title', language),
      description: pickLang(courseEl, 'description', language),
      ...(cxmEl ? { cxm: { src: cxmEl.attrs.src ?? '', specVersion: cxmEl.attrs.specVersion ?? '', mcp: cxmEl.attrs.mcp ?? '', xpath: cxmEl.xpath } } : {}),
      xpath: courseEl.xpath,
    },
    aus: [],
    blocks: [],
  };

  const walk = (parent: Node, topBlock: string | undefined, nested: boolean): void => {
    let position = 0;
    for (const c of parent.children) {
      if (cmi5(c, 'au')) {
        const lesson = c.children.find((x) => inNs(x, CXM_XML_NS, 'lesson'));
        structure.aus.push({
          id: c.attrs.id ?? '',
          ...(cxmAttr(c, 'key') !== undefined ? { key: cxmAttr(c, 'key')! } : {}),
          ...(cxmAttr(c, 'role') !== undefined ? { role: cxmAttr(c, 'role')! } : {}),
          moveOn: c.attrs.moveOn ?? 'NotApplicable',
          ...(c.attrs.launchMethod !== undefined ? { launchMethod: c.attrs.launchMethod } : {}),
          title: pickLang(c, 'title', language),
          description: pickLang(c, 'description', language),
          url: c.children.find((x) => cmi5(x, 'url'))?.text ?? '',
          ...(lesson ? { lessonSrc: lesson.attrs.src ?? '', lessonXpath: lesson.xpath } : {}),
          ...(topBlock !== undefined ? { blockXpath: topBlock } : {}),
          position: position++,
          xpath: c.xpath,
        });
      } else if (cmi5(c, 'block')) {
        const path = c.children.find((x) => inNs(x, CXM_XML_NS, 'path'));
        structure.blocks.push({
          id: c.attrs.id ?? '',
          ...(cxmAttr(c, 'key') !== undefined ? { key: cxmAttr(c, 'key')! } : {}),
          title: pickLang(c, 'title', language),
          description: pickLang(c, 'description', language),
          ...(path ? { pathSrc: path.attrs.src ?? '', pathXpath: path.xpath } : {}),
          nested,
          position: position++,
          xpath: c.xpath,
        });
        walk(c, topBlock ?? c.xpath, true);
      }
    }
  };
  walk(root, undefined, false);
  return { structure, issues };
}
