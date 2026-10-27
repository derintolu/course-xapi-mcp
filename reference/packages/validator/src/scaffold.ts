// SPDX-License-Identifier: Apache-2.0
// Starter files for a new course and for a new lesson. Everything the author has to write is left empty,
// so `cxm validate` lists exactly what to fill in, each issue with its fix.
import { CMI5_XML_NS, CUSTODY_OPTIONS, CXM_XML_NS, SPEC_VERSION } from '@course-xapi-mcp/core';
import type { CustodyOption } from '@course-xapi-mcp/core';
import { parseCmi5Xml } from '@course-xapi-mcp/core/package';

export interface ScaffoldCourseOptions {
  id: string;
  title: string;
  language: string;
  custody: CustodyOption;
}

export interface ScaffoldLessonOptions {
  /** The path (block) key; the block is created when the course has none with this key. */
  pathKey: string;
  key: string;
  title: string;
}

/** The local course server the scaffold points at until the author sets the real one. */
const LOCAL_SERVER = 'http://127.0.0.1:8787';
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COURSE_FILE = 'cxm/course.json';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const langstring = (tag: string, lang: string, text: string, pad: string) => `${pad}<${tag}><langstring lang="${esc(lang)}">${esc(text)}</langstring></${tag}>`;
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/** cmi5.xml and cxm/course.json for a course with only its placement AU. */
export function scaffoldCourse(o: ScaffoldCourseOptions): Record<string, string> {
  if (!CUSTODY_OPTIONS.includes(o.custody)) throw new Error(`custody must be one of ${CUSTODY_OPTIONS.join(', ')}`);
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<courseStructure xmlns="${CMI5_XML_NS}" xmlns:cxm="${CXM_XML_NS}">`,
    `  <course id="${esc(o.id)}">`,
    langstring('title', o.language, o.title, '    '),
    langstring('description', o.language, o.title, '    '),
    `    <cxm:course src="${COURSE_FILE}" specVersion="${SPEC_VERSION}" mcp="${LOCAL_SERVER}/mcp"/>`,
    '  </course>',
    `  <au id="${esc(o.id)}/placement" cxm:key="placement" cxm:role="placement" moveOn="NotApplicable" launchMethod="OwnWindow">`,
    langstring('title', o.language, 'Placement', '    '),
    langstring('description', o.language, 'Find out where to start.', '    '),
    `    <url>${LOCAL_SERVER}/cmi5/launch?au=placement</url>`,
    '  </au>',
    '</courseStructure>',
    '',
  ].join('\n');
  const course = {
    specVersion: SPEC_VERSION,
    flavour: 'authoring',
    version: '0.1.0',
    language: o.language,
    rules: [],
    placement: { intro: '', maxQuestions: 2 },
    custody: o.custody,
    allowPractice: false,
    paths: {},
  };
  return { 'cmi5.xml': xml, [COURSE_FILE]: json(course) };
}

/** The end of the element that starts at `start` (just past its `</block>`), counting nested blocks. */
function blockEnd(xml: string, start: number): number {
  const tag = /<block\b[^>]*?(\/?)>|<\/block\s*>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (m[0].startsWith('</')) depth--;
    else if (m[1] !== '/') depth++;
    if (depth === 0) return m.index + m[0].length;
  }
  throw new Error('cmi5.xml has a block without its closing tag');
}

const indentAt = (xml: string, i: number) => /[ \t]*$/.exec(xml.slice(xml.lastIndexOf('\n', i - 1) + 1, i))![0];

/**
 * Adds a lesson: its AU in the path's block (the block and its course.json path entry are created when missing)
 * and `cxm/lessons/<key>.json`. Returns the whole new file set; throws on a bad or taken key.
 */
export function scaffoldLesson(files: Record<string, string>, o: ScaffoldLessonOptions): Record<string, string> {
  const xml = files['cmi5.xml'];
  const courseText = files[COURSE_FILE];
  if (xml === undefined || courseText === undefined) throw new Error(`the package has no cmi5.xml or ${COURSE_FILE}; scaffold the course first`);
  for (const [what, k] of [['path', o.pathKey], ['lesson', o.key]] as const) {
    if (!KEY_RE.test(k)) throw new Error(`the ${what} key "${k}" is not 1-64 characters of a-z, 0-9 and -, starting with a letter or digit`);
  }
  const parsed = parseCmi5Xml(xml);
  if (!('structure' in parsed)) throw new Error('cmi5.xml cannot be read; run cxm validate and fix it first');
  const { course: c, aus, blocks } = parsed.structure;
  if (aus.some((a) => a.key === o.key) || blocks.some((b) => b.key === o.key)) throw new Error(`the key "${o.key}" is already used by a block or AU`);
  if (aus.some((a) => a.key === o.pathKey)) throw new Error(`the key "${o.pathKey}" is already used by an AU`);
  const lessonFile = `cxm/lessons/${o.key}.json`;
  if (files[lessonFile] !== undefined) throw new Error(`${lessonFile} already exists`);

  const course = JSON.parse(courseText) as { language?: string; paths?: Record<string, unknown> };
  const lang = typeof course.language === 'string' ? course.language : 'en';
  const placement = aus.find((a) => a.role === 'placement');
  let url: string;
  try {
    const u = new URL(placement?.url ?? `${LOCAL_SERVER}/cmi5/launch`);
    u.searchParams.set('au', o.key);
    url = u.href;
  } catch {
    url = `${LOCAL_SERVER}/cmi5/launch?au=${encodeURIComponent(o.key)}`;
  }

  const au = (pad: string) =>
    [
      `${pad}<au id="${esc(c.id)}/lessons/${esc(o.key)}" cxm:key="${esc(o.key)}" moveOn="Completed" launchMethod="OwnWindow">`,
      langstring('title', lang, o.title, pad + '  '),
      langstring('description', lang, o.title, pad + '  '),
      `${pad}  <url>${esc(url)}</url>`,
      `${pad}  <cxm:lesson src="${esc(lessonFile)}"/>`,
      `${pad}</au>`,
      '',
    ].join('\n');

  let nextXml: string;
  let nextCourse = courseText;
  const open = [...xml.matchAll(/<block\b[^>]*>/g)].find((m) => new RegExp(`\\s[\\w.-]+:key="${o.pathKey}"`).test(m[0]));
  if (open) {
    // AUs go before the block's cxm:path, which sits at the tail of the block.
    const start = open.index;
    const end = blockEnd(xml, start);
    const close = xml.lastIndexOf('</block', end);
    const path = xml.lastIndexOf('<cxm:path', close);
    const at = path > start ? path : close;
    const lineStart = xml.lastIndexOf('\n', at - 1) + 1;
    nextXml = xml.slice(0, lineStart) + au(indentAt(xml, start) + '  ') + xml.slice(lineStart);
  } else {
    const close = xml.lastIndexOf('</courseStructure');
    if (close < 0) throw new Error('cmi5.xml has no closing </courseStructure>');
    const lineStart = xml.lastIndexOf('\n', close - 1) + 1;
    const block = [
      `  <block id="${esc(c.id)}/paths/${esc(o.pathKey)}" cxm:key="${esc(o.pathKey)}">`,
      langstring('title', lang, o.pathKey, '    '),
      langstring('description', lang, o.pathKey, '    '),
      au('    ') + `    <cxm:path src="${COURSE_FILE}#/paths/${esc(o.pathKey)}"/>`,
      '  </block>',
      '',
    ].join('\n');
    nextXml = xml.slice(0, lineStart) + block + xml.slice(lineStart);
    nextCourse = json({ ...course, paths: { ...(course.paths ?? {}), [o.pathKey]: { tagline: '', placementHints: '' } } });
  }

  const lesson = { minutes: 0, sources: [], beats: [{ key: 'first-idea', goal: '', content: '' }] };
  return { ...files, 'cmi5.xml': nextXml, [COURSE_FILE]: nextCourse, [lessonFile]: json(lesson) };
}
