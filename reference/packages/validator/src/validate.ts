// SPDX-License-Identifier: Apache-2.0
// `validatePackage`: the loader's checks plus XSD, behavioural and lint checks, all in one pass.
import { CourseJsonSchema, DistributionLessonJsonSchema, LessonJsonSchema, loadPackage, parseCmi5Xml } from '@course-xapi-mcp/core/package';
import type { LessonJson, PackageFiles } from '@course-xapi-mcp/core/package';
import type { ValidationIssue } from '@course-xapi-mcp/core';
import { behaviourIssues } from './behaviour.ts';
import { lintIssues } from './lint.ts';
import { xsdIssues } from './xsd.ts';

export type Flavour = 'authoring' | 'distribution';

/** A lesson JSON that passed its schema, with where it sits in the package. */
export interface LessonDoc {
  key: string;
  file: string;
  /** JSON Pointer of the lesson inside `file`; '' for the whole file. */
  base: string;
  lesson: LessonJson;
}

export interface CourseDoc {
  file: string;
  base: string;
  rules: string[];
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

const CMI5_FILE = 'cmi5.xml';
const decoder = new TextDecoder('utf-8');

function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  if (!pointer.startsWith('/')) return undefined;
  let cur = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Reads the JSON a `src` points at. Failures are left to the loader, which reports them. */
function readSrc(files: PackageFiles, src: string): { file: string; base: string; value: unknown } | undefined {
  const hash = src.indexOf('#');
  const file = hash < 0 ? src : src.slice(0, hash);
  const bytes = files[file];
  if (!bytes) return undefined;
  try {
    const base = hash < 0 ? '' : decodeURIComponent(src.slice(hash + 1));
    return { file, base, value: resolvePointer(JSON.parse(decoder.decode(bytes)), base) };
  } catch {
    return undefined;
  }
}

/** The course rules, flavour and every schema-valid lesson, read independently of the loader's cross-reference errors. */
function readContent(files: PackageFiles, flavour: Flavour | undefined): { flavour: Flavour; course?: CourseDoc; lessons: LessonDoc[] } {
  const xml = files[CMI5_FILE];
  if (!xml) return { flavour: flavour ?? 'authoring', lessons: [] };
  const parsed = parseCmi5Xml(decoder.decode(xml));
  if (!('structure' in parsed)) return { flavour: flavour ?? 'authoring', lessons: [] };
  const { course: c, aus } = parsed.structure;

  let course: CourseDoc | undefined;
  let declared: Flavour = 'authoring';
  const ref = c.cxm ? readSrc(files, c.cxm.src) : undefined;
  if (ref) {
    const raw = ref.value as { flavour?: unknown; rules?: unknown } | undefined;
    if (raw?.flavour === 'distribution') declared = 'distribution';
    const ok = CourseJsonSchema.safeParse(ref.value);
    course = { file: ref.file, base: ref.base, rules: ok.success ? (ok.data.rules ?? []) : [] };
  }
  const as = flavour ?? declared;
  const schema = (declared === 'distribution' ? DistributionLessonJsonSchema : LessonJsonSchema) as typeof LessonJsonSchema;

  const lessons: LessonDoc[] = [];
  const seen = new Set<string>();
  for (const a of aus) {
    if (a.role === 'placement' || a.lessonSrc === undefined || a.key === undefined || seen.has(a.key)) continue;
    seen.add(a.key);
    const lref = readSrc(files, a.lessonSrc);
    const ok = lref && schema.safeParse(lref.value);
    if (lref && ok?.success) lessons.push({ key: a.key, file: lref.file, base: lref.base, lesson: ok.data });
  }
  return { flavour: as, ...(course ? { course } : {}), lessons };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Rebuilds an issue with its keys in the fixed output order. */
function ordered(i: ValidationIssue): ValidationIssue {
  return {
    code: i.code,
    severity: i.severity,
    file: i.file,
    ...(i.xpath !== undefined ? { xpath: i.xpath } : {}),
    ...(i.pointer !== undefined ? { pointer: i.pointer } : {}),
    message: i.message,
    fix: i.fix,
    help: i.help,
  };
}

/** Sorts issues by file, location, code and message, and fixes their key order. */
export function sortIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return issues
    .map(ordered)
    .sort((a, b) => cmp(a.file, b.file) || cmp(a.xpath ?? a.pointer ?? '', b.xpath ?? b.pointer ?? '') || cmp(a.code, b.code) || cmp(a.message, b.message));
}

/**
 * Validates a package. `flavour` is the flavour to validate as; by default the one course.json declares.
 * A distribution package is accepted here (CXM-PKG-034 is a server rule); its secret fields are CXM-PKG-014.
 */
export async function validatePackage(files: PackageFiles, o: { flavour?: Flavour } = {}): Promise<ValidationResult> {
  const loaded = loadPackage(files, { allowDistribution: true });
  const issues = [...loaded.issues];
  // A cmi5.xml the loader cannot read at all (CXM-PKG-001) is not worth an XSD pass.
  if (files[CMI5_FILE] && !issues.some((i) => i.code === 'CXM-PKG-001')) issues.push(...(await xsdIssues(decoder.decode(files[CMI5_FILE]))));
  const content = readContent(files, o.flavour);
  issues.push(...behaviourIssues(content.lessons, content.flavour), ...lintIssues(content.course, content.lessons));
  const sorted = sortIssues(issues);
  return { valid: !sorted.some((i) => i.severity === 'error'), issues: sorted };
}
