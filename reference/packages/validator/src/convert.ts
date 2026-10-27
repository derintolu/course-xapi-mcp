// SPDX-License-Identifier: Apache-2.0
// Converts a legacy single-file course.json into the files of a cmi5 package.
import { CMI5_XML_NS, CXM_XML_NS, SPEC_VERSION, parseCourse } from '@course-xapi-mcp/core';
import type { Course, CustodyOption } from '@course-xapi-mcp/core';

export interface ConvertOptions {
  courseIri: string;
  mcpUrl: string;
  launchBase: string;
  custody: CustodyOption;
  allowPractice?: boolean;
}

export type ConvertResult = { ok: true; files: Record<string, string> } | { ok: false; errors: string[] };

const REVEAL_AFTER = 3;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lang = (tag: string, text: string, pad: string) => `${pad}<${tag}><langstring lang="en">${esc(text)}</langstring></${tag}>`;
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/** Renames the legacy `id` field to `key`, keeping `key` first. */
const keyed = <T extends { id: string }>({ id, ...rest }: T) => ({ key: id, ...rest });

function lessonJson(l: Course['lessons'][string]): Record<string, unknown> {
  const { id: _id, pathId: _pathId, title: _title, ...rest } = l;
  const out: Record<string, unknown> = { ...rest, beats: l.beats.map(keyed) };
  if (l.checkpoint) {
    const { id, branches, ...cp } = l.checkpoint;
    out.checkpoint = { key: id, ...cp, branches: branches.map(keyed) };
  }
  if (l.bug) out.bug = { ...keyed(l.bug), revealAfter: REVEAL_AFTER };
  return out;
}

export function convertLegacyCourse(raw: unknown, o: ConvertOptions): ConvertResult {
  const parsed = parseCourse(raw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const c = parsed.course;
  const au = (key: string) => `${o.launchBase}?au=${encodeURIComponent(key)}`;

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<courseStructure xmlns="${CMI5_XML_NS}" xmlns:cxm="${CXM_XML_NS}">`,
    `  <course id="${esc(o.courseIri)}">`,
    lang('title', c.title, '    '),
    lang('description', c.description, '    '),
    `    <cxm:course src="cxm/course.json" specVersion="${SPEC_VERSION}" mcp="${esc(o.mcpUrl)}"/>`,
    '  </course>',
    `  <au id="${esc(o.courseIri)}/placement" cxm:key="placement" cxm:role="placement" moveOn="NotApplicable" launchMethod="OwnWindow">`,
    lang('title', 'Placement', '    '),
    lang('description', 'Find out where to start.', '    '),
    `    <url>${esc(au('placement'))}</url>`,
    '  </au>',
  ];
  const files: Record<string, string> = {};
  const paths: Record<string, unknown> = {};
  for (const [pk, p] of Object.entries(c.paths)) {
    paths[pk] = { tagline: p.tagline, ...(p.placementHints ? { placementHints: p.placementHints } : {}) };
    lines.push(
      `  <block id="${esc(o.courseIri)}/paths/${esc(pk)}" cxm:key="${esc(pk)}">`,
      lang('title', p.title, '    '),
      lang('description', p.tagline, '    '),
    );
    for (const lk of p.lessons) {
      const l = c.lessons[lk]!;
      lines.push(
        `    <au id="${esc(o.courseIri)}/lessons/${esc(lk)}" cxm:key="${esc(lk)}" moveOn="${l.checkpoint ? 'CompletedAndPassed' : 'Completed'}" launchMethod="OwnWindow">`,
        lang('title', l.title, '      '),
        lang('description', l.title, '      '),
        `      <url>${esc(au(lk))}</url>`,
        `      <cxm:lesson src="cxm/lessons/${esc(lk)}.json"/>`,
        '    </au>',
      );
      files[`cxm/lessons/${lk}.json`] = json(lessonJson(l));
    }
    lines.push(`    <cxm:path src="cxm/course.json#/paths/${esc(pk)}"/>`, '  </block>');
  }
  lines.push('</courseStructure>', '');
  files['cmi5.xml'] = lines.join('\n');
  files['cxm/course.json'] = json({
    specVersion: SPEC_VERSION,
    flavour: 'authoring',
    version: c.version,
    language: c.language,
    ...(c.license ? { license: c.license } : {}),
    ...(c.rules?.length ? { rules: c.rules } : {}),
    placement: c.placement,
    custody: o.custody,
    allowPractice: o.allowPractice ?? false,
    paths,
  });
  return { ok: true, files };
}
