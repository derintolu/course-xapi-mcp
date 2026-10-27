// SPDX-License-Identifier: Apache-2.0
// XSD validation of cmi5.xml: CXM-PKG-002 (cmi5 CourseStructure.xsd) and CXM-PKG-003 (cxm.xsd).
import { readFile } from 'node:fs/promises';
import { validateXML } from 'xmllint-wasm';
import type { XMLValidationError } from 'xmllint-wasm';
import { CMI5_XML_NS, CXM_XML_NS, makeIssue } from '@course-xapi-mcp/core';
import type { ValidationIssue } from '@course-xapi-mcp/core';

const FILE = 'cmi5.xml';
const SCHEMA_DIR = new URL('../../../../schema/', import.meta.url);

/** Imports both namespaces, so the cmi5 XSD's lax `##other` slots validate cxm elements and attributes against cxm.xsd. */
const WRAPPER = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:import namespace="${CMI5_XML_NS}" schemaLocation="CourseStructure.xsd"/>
  <xs:import namespace="${CXM_XML_NS}" schemaLocation="cxm.xsd"/>
</xs:schema>`;

let schemas: Promise<{ cmi5: string; cxm: string }> | undefined;
const loadSchemas = () =>
  (schemas ??= Promise.all([readFile(new URL('vendor/cmi5/CourseStructure.xsd', SCHEMA_DIR), 'utf8'), readFile(new URL('draft/cxm.xsd', SCHEMA_DIR), 'utf8')]).then(([cmi5, cxm]) => ({ cmi5, cxm })));

// ---- a small XML scanner: element locations, namespaces and XPaths --------

interface Span {
  start: number;
  end: number;
}

interface ScannedElement {
  local: string;
  ns: string | undefined;
  xpath: string;
  line: number;
  /** The whole element, start tag to end tag. */
  span: Span;
  /** Attributes in the cxm namespace, by source position. */
  cxmAttrs: Span[];
}

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR = /([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g;

/** Scans the elements of a well-formed document. XPaths match the loader's: `/qname[n]` steps counted per qname. */
function scan(xml: string): ScannedElement[] {
  const out: ScannedElement[] = [];
  const stack: { el: ScannedElement; scope: Record<string, string>; counts: Map<string, number> }[] = [];
  const rootCounts = new Map<string, number>();
  let line = 1;
  let last = 0;
  for (const m of xml.matchAll(TOKEN)) {
    for (let i = last; i < m.index; i++) if (xml.charCodeAt(i) === 10) line++;
    last = m.index;
    const [whole, closeName, openName, attrText = '', selfClose] = m;
    if (closeName !== undefined) {
      const top = stack.pop();
      if (top) top.el.span.end = m.index + whole.length;
      continue;
    }
    if (openName === undefined) continue;
    const parent = stack[stack.length - 1];
    const scope = { ...(parent?.scope ?? {}) };
    const attrs: { name: string; span: Span }[] = [];
    const attrBase = m.index + 1 + openName.length;
    for (const a of attrText.matchAll(ATTR)) {
      const name = a[1]!;
      const value = a[2]!.slice(1, -1);
      if (name === 'xmlns') scope[''] = value;
      else if (name.startsWith('xmlns:')) scope[name.slice(6)] = value;
      else attrs.push({ name, span: { start: attrBase + a.index, end: attrBase + a.index + a[0].length } });
    }
    const colon = openName.indexOf(':');
    const counts = parent?.counts ?? rootCounts;
    const n = (counts.get(openName) ?? 0) + 1;
    counts.set(openName, n);
    const el: ScannedElement = {
      local: colon < 0 ? openName : openName.slice(colon + 1),
      ns: scope[colon < 0 ? '' : openName.slice(0, colon)],
      xpath: `${parent?.el.xpath ?? ''}/${openName}[${n}]`,
      line,
      span: { start: m.index, end: m.index + whole.length },
      cxmAttrs: attrs.filter((a) => a.name.includes(':') && scope[a.name.slice(0, a.name.indexOf(':'))] === CXM_XML_NS).map((a) => a.span),
    };
    out.push(el);
    if (!selfClose) stack.push({ el, scope, counts: new Map() });
  }
  return out;
}

/** Blanks every cxm element and cxm attribute, keeping line numbers, so the cmi5 structure can be validated on its own. */
function stripCxm(xml: string, elements: ScannedElement[]): string {
  const spans: Span[] = [];
  for (const el of elements) {
    if (el.ns === CXM_XML_NS) spans.push(el.span);
    else spans.push(...el.cxmAttrs);
  }
  const chars = xml.split('');
  for (const s of spans) for (let i = s.start; i < s.end; i++) if (chars[i] !== '\n') chars[i] = ' ';
  return chars.join('');
}

// ---- mapping xmllint errors to issues -------------------------------------

const SUBJECT = /^Element '\{([^}]*)\}([^']+)'(?:, attribute '(?:\{([^}]*)\})?([^']+)')?/;
const PREFIX = /^Schemas validity error : /;

interface Mapped {
  message: string;
  xpath?: string;
  /** The error is about a cxm element or attribute. */
  aboutCxm: boolean;
  misplaced: boolean;
}

function mapError(err: XMLValidationError, elements: ScannedElement[]): Mapped {
  const raw = err.message.replace(PREFIX, '').trim();
  const subject = SUBJECT.exec(raw);
  const message = raw.replaceAll(`{${CMI5_XML_NS}}`, '').replaceAll(`{${CXM_XML_NS}}`, 'cxm:');
  let xpath: string | undefined;
  if (err.loc) {
    const lineNo = err.loc.lineNumber;
    const named = subject ? elements.filter((e) => e.line === lineNo && e.ns === subject[1] && e.local === subject[2]) : [];
    xpath = (named[0] ?? elements.filter((e) => e.line <= lineNo).at(-1))?.xpath;
  }
  return {
    message,
    ...(xpath !== undefined ? { xpath } : {}),
    aboutCxm: !!subject && (subject[1] === CXM_XML_NS || subject[3] === CXM_XML_NS),
    misplaced: raw.includes('This element is not expected'),
  };
}

const toIssue = (code: 'CXM-PKG-002' | 'CXM-PKG-003', m: Mapped) =>
  makeIssue(code, { file: FILE, ...(m.xpath !== undefined ? { xpath: m.xpath } : {}) }, m.message.endsWith('.') ? m.message : m.message + '.');

/**
 * Validates a well-formed cmi5.xml. The cmi5 structure is first checked with every cxm element and attribute
 * blanked out (errors are CXM-PKG-002); the full document is then checked with cxm.xsd imported, and what
 * that adds is CXM-PKG-003.
 */
export async function xsdIssues(xml: string): Promise<ValidationIssue[]> {
  const { cmi5, cxm } = await loadSchemas();
  const elements = scan(xml);
  const run = (doc: string, schema: { fileName: string; contents: string }) =>
    validateXML({ xml: { fileName: FILE, contents: doc }, schema, preload: [{ fileName: 'CourseStructure.xsd', contents: cmi5 }, { fileName: 'cxm.xsd', contents: cxm }] });

  const structural = await run(stripCxm(xml, elements), { fileName: 'CourseStructure.xsd', contents: cmi5 });
  const issues = structural.errors.map((e) => toIssue('CXM-PKG-002', mapError(e, elements)));
  const full = await run(xml, { fileName: 'cxm-wrapper.xsd', contents: WRAPPER });
  for (const e of full.errors) {
    const m = mapError(e, elements);
    // With the cmi5 structure already broken, keep only errors that are plainly about cxm content.
    if (structural.valid || (m.aboutCxm && !m.misplaced)) issues.push(toIssue('CXM-PKG-003', m));
  }
  return issues;
}
