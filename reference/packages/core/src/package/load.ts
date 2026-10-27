// SPDX-License-Identifier: Apache-2.0
// Loads a package's files into a CourseModel, reporting every problem in one pass.
import type { ZodError } from 'zod';
import { EXTENSION_ID, SITE } from '../constants.ts';
import { makeIssue } from '../issues.ts';
import type { IssueCode, ValidationIssue } from '../issues.ts';
import type { Beat, BadgeDecl, CourseModel, LessonModel, PathModel } from '../model.ts';
import { parseCmi5Xml } from './cmi5-xml.ts';
import type { Cmi5Au, Cmi5Block, Cmi5Structure } from './cmi5-xml.ts';
import { CourseJsonSchema, DistributionLessonJsonSchema, LessonJsonSchema } from './schemas.ts';
import type { CourseJson, LessonJson } from './schemas.ts';
import type { PackageFiles } from './zip.ts';

export const SUPPORTED_SPEC_MAJOR = 0;
export const SUPPORTED_SPEC_MINOR = 2;

const CMI5_FILE = 'cmi5.xml';

export type LoadResult =
  | { ok: true; course: CourseModel; issues: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] };

/** Reads a package directory (Node only). */
export async function readDir(dir: string): Promise<PackageFiles> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const files: PackageFiles = {};
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile() && entry.name !== '.DS_Store') files[next] = new Uint8Array(await fs.readFile(path.join(dir, next)));
    }
  };
  await walk('');
  return files;
}

// ---- JSON Pointer ---------------------------------------------------------

/** Decodes a URI fragment; undefined when the percent-encoding is malformed. */
function decodeFragment(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

const escapePointer = (s: string | number | symbol) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
const toPointer = (path: readonly (string | number | symbol)[]) => path.map((p) => '/' + escapePointer(p)).join('');

function resolvePointer(doc: unknown, pointer: string): { found: true; value: unknown } | { found: false } {
  if (pointer === '') return { found: true, value: doc };
  if (!pointer.startsWith('/')) return { found: false };
  let cur = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur) && /^(0|[1-9]\d*)$/.test(seg) && Number(seg) < cur.length) cur = cur[Number(seg)];
    else if (cur !== null && typeof cur === 'object' && !Array.isArray(cur) && Object.hasOwn(cur, seg)) cur = (cur as Record<string, unknown>)[seg];
    else return { found: false };
  }
  return { found: true, value: cur };
}

// ---- helpers --------------------------------------------------------------

const decoder = new TextDecoder('utf-8');
const KEY_RE = /^[a-z0-9-]{1,64}$/;

function isAbsoluteIri(s: string): boolean {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/.test(s)) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

function urlOk(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
}

interface Ref {
  /** Package path of the referenced file. */
  file: string;
  /** Fragment pointer, '' when none. */
  pointer: string;
  value: unknown;
}

/** zod issues that are really file-name (020) or language/version (030) problems. */
function zodCode(issue: ZodError['issues'][number], file: 'course' | 'lesson'): IssueCode {
  const last = issue.path[issue.path.length - 1];
  if (file === 'course' && issue.path.length === 1 && (last === 'language' || last === 'version')) return 'CXM-PKG-030';
  const nested = (issue as { issues?: { message: string }[] }).issues ?? [];
  const msgs = [issue.message, ...nested.map((n) => n.message)];
  if (msgs.some((m) => m.startsWith('file names')) || (last === 'file' && /^(Too (small|big)|String must)/i.test(issue.message))) return 'CXM-PKG-020';
  if (issue.code === 'invalid_key' && issue.path.some((p) => p === 'starterFiles' || p === 'files')) return 'CXM-PKG-020';
  return file === 'course' ? 'CXM-PKG-006' : 'CXM-PKG-007';
}

// ---- loader ---------------------------------------------------------------

export function loadPackage(files: PackageFiles, o: { allowDistribution?: boolean } = {}): LoadResult {
  const issues: ValidationIssue[] = [];
  const done = (): LoadResult => {
    issues.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || cmp(a.xpath ?? a.pointer ?? '', b.xpath ?? b.pointer ?? '') || cmp(a.code, b.code));
    return { ok: false, issues };
  };
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const add = (code: IssueCode, at: { file: string; xpath?: string; pointer?: string }, message: string, fix?: string) => {
    issues.push(makeIssue(code, at, message, fix));
  };

  const xmlBytes = files[CMI5_FILE];
  if (!xmlBytes) {
    add('CXM-PKG-001', { file: CMI5_FILE }, 'The package has no cmi5.xml at its root.');
    return done();
  }
  const xml = decoder.decode(xmlBytes);
  let parsed = parseCmi5Xml(xml);
  if (!('structure' in parsed)) {
    issues.push(...parsed.issues);
    return done();
  }
  let structure: Cmi5Structure = parsed.structure;
  const cxm = structure.course.cxm;
  if (!cxm) {
    add('CXM-PKG-004', { file: CMI5_FILE, xpath: structure.course.xpath }, 'The course element has no cxm:course child.');
    issues.push(...parsed.issues);
    return done();
  }
  const ver = /^(\d+)\.(\d+)$/.exec(cxm.specVersion);
  if (!ver || Number(ver[1]) !== SUPPORTED_SPEC_MAJOR) {
    add(
      'CXM-PKG-004',
      { file: CMI5_FILE, xpath: cxm.xpath },
      `specVersion "${cxm.specVersion}" is not supported; this server reads ${SUPPORTED_SPEC_MAJOR}.x.`,
      `Set specVersion on cxm:course to a ${SUPPORTED_SPEC_MAJOR}.x version, for example "${SUPPORTED_SPEC_MAJOR}.${SUPPORTED_SPEC_MINOR}".`,
    );
    issues.push(...parsed.issues);
    return done();
  }
  if (Number(ver[2]) > SUPPORTED_SPEC_MINOR) {
    add('CXM-PKG-206', { file: CMI5_FILE, xpath: cxm.xpath }, `specVersion "${cxm.specVersion}" is newer than ${SUPPORTED_SPEC_MAJOR}.${SUPPORTED_SPEC_MINOR}; reading it anyway.`);
  }

  // Reads the file a src points at, optionally narrowed by a pointer. Reports 005 when it does not resolve.
  const jsonCache = new Map<string, { ok: true; doc: unknown } | { ok: false; error: string }>();
  const readJson = (file: string) => {
    let hit = jsonCache.get(file);
    if (!hit) {
      try {
        hit = { ok: true, doc: JSON.parse(decoder.decode(files[file]!)) as unknown };
      } catch (err) {
        hit = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      jsonCache.set(file, hit);
    }
    return hit;
  };
  const resolveSrc = (src: string, at: { xpath: string }, what: string, badJson: 'CXM-PKG-006' | 'CXM-PKG-007' | null): Ref | undefined => {
    const hash = src.indexOf('#');
    const file = hash < 0 ? src : src.slice(0, hash);
    const decoded = hash < 0 ? '' : decodeFragment(src.slice(hash + 1));
    const fail = (message: string) => add('CXM-PKG-005', { file: CMI5_FILE, xpath: at.xpath }, `${what}: ${message}`);
    if (decoded === undefined) {
      fail(`pointer in src "${src}" is not valid percent-encoding.`);
      return undefined;
    }
    const pointer = decoded;
    if (file === '' || file.startsWith('/') || file.includes('\\') || file.split('/').some((s) => s === '..' || s === '.' || s === '')) {
      fail(`src "${src}" is not a relative path inside the package.`);
      return undefined;
    }
    if (!files[file]) {
      fail(`src "${src}" points at "${file}", which is not in the package.`);
      return undefined;
    }
    const doc = readJson(file);
    if (!doc.ok) {
      if (badJson) add(badJson, { file }, `${file} is not valid JSON: ${doc.error}`, `Fix the JSON syntax of ${file}.`);
      return undefined;
    }
    const hit = resolvePointer(doc.doc, pointer);
    if (!hit.found) {
      fail(`pointer "${pointer}" does not resolve in ${file}.`);
      return undefined;
    }
    return { file, pointer, value: hit.value };
  };

  // ---- course.json
  let courseRef = resolveSrc(cxm.src, { xpath: cxm.xpath }, 'cxm:course', 'CXM-PKG-006');
  let course: CourseJson | undefined;
  const courseFile = courseRef?.file ?? 'cxm/course.json';
  const parseJson = <T>(ref: Ref, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: ZodError } }, kind: 'course' | 'lesson'): T | undefined => {
    const r = schema.safeParse(ref.value);
    if (r.success) return r.data;
    let usable = true;
    for (const z of r.error.issues) {
      const code = zodCode(z, kind);
      if (code !== 'CXM-PKG-030' && code !== 'CXM-PKG-020') usable = false;
      const pointer = ref.pointer + toPointer(z.path);
      add(code, { file: ref.file, pointer: pointer === '' ? '/' : pointer }, z.message, `Change ${pointer === '' ? '/' : pointer}: ${z.message}`);
    }
    return usable ? (ref.value as T) : undefined;
  };
  if (courseRef) course = parseJson(courseRef, CourseJsonSchema, 'course');
  if (course && typeof (course as { language?: unknown }).language === 'string') {
    const again = parseCmi5Xml(xml, course.language);
    if ('structure' in again) {
      structure = again.structure;
      parsed = again;
    }
  }
  issues.push(...parsed.issues);

  const { aus, blocks } = structure;
  const placeAt = (xpath: string) => ({ file: CMI5_FILE, xpath });

  // ---- ids, keys, urls
  const seenIds = new Map<string, string>();
  const checkId = (id: string, xpath: string, what: string) => {
    if (!isAbsoluteIri(id)) {
      add('CXM-PKG-029', placeAt(xpath), `${what} id "${id}" is not an absolute IRI.`);
      return;
    }
    if (seenIds.has(id)) add('CXM-PKG-029', placeAt(xpath), `${what} id "${id}" is already used at ${seenIds.get(id)}.`);
    else seenIds.set(id, xpath);
  };
  checkId(structure.course.id, structure.course.xpath, 'The course');
  const seenKeys = new Map<string, string>();
  const checkKey = (key: string | undefined, xpath: string, what: string) => {
    if (key === undefined || !KEY_RE.test(key)) {
      add('CXM-PKG-009', placeAt(xpath), key === undefined ? `${what} has no cxm:key.` : `${what} cxm:key "${key}" is not 1-64 characters of a-z, 0-9 and -.`);
      return;
    }
    if (seenKeys.has(key)) add('CXM-PKG-008', placeAt(xpath), `${what} cxm:key "${key}" is already used at ${seenKeys.get(key)}.`);
    else seenKeys.set(key, xpath);
  };
  for (const b of blocks) {
    checkId(b.id, b.xpath, 'A block');
    checkKey(b.key, b.xpath, 'A block');
  }
  for (const a of aus) {
    checkId(a.id, a.xpath, 'An AU');
    checkKey(a.key, a.xpath, 'An AU');
    if (!urlOk(a.url)) add('CXM-PKG-028', placeAt(a.xpath), `The AU url "${a.url}" is not https (plain http is allowed only for 127.0.0.1 and localhost).`);
  }

  // ---- placement
  const placements = aus.filter((a) => a.role === 'placement');
  if (placements.length === 0) add('CXM-PKG-015', placeAt(structure.course.xpath), 'The package has no placement AU (cxm:role="placement").');
  placements.forEach((p, i) => {
    if (i > 0) add('CXM-PKG-015', placeAt(p.xpath), 'More than one placement AU is declared.');
    else if (p.blockXpath !== undefined || p.position !== 0) add('CXM-PKG-015', placeAt(p.xpath), 'The placement AU is not the first element of the course.');
    else if (p.moveOn !== 'NotApplicable') add('CXM-PKG-015', placeAt(p.xpath), `The placement AU has moveOn="${p.moveOn}"; it must be "NotApplicable".`);
  });
  for (const a of aus) {
    if (a.role !== 'placement' && a.blockXpath === undefined) add('CXM-PKG-016', placeAt(a.xpath), 'A lesson AU sits outside any path block.');
  }

  // ---- paths and blocks
  const pathBlocks = blocks.filter((b) => !b.nested);
  const blockAus = new Map<string, Cmi5Au[]>();
  for (const a of aus) if (a.blockXpath !== undefined) (blockAus.get(a.blockXpath) ?? blockAus.set(a.blockXpath, []).get(a.blockXpath)!).push(a);
  const lessonAus = (b: Cmi5Block) => (blockAus.get(b.xpath) ?? []).filter((a) => a.role !== 'placement');
  const blockByKey = new Map<string, Cmi5Block>();
  for (const b of pathBlocks) {
    if (b.key !== undefined && KEY_RE.test(b.key) && !blockByKey.has(b.key)) blockByKey.set(b.key, b);
    if (b.pathSrc === undefined) add('CXM-PKG-016', placeAt(b.xpath), 'The block has no cxm:path child.');
    else if (b.pathXpath !== undefined) resolveSrc(b.pathSrc, { xpath: b.pathXpath }, 'cxm:path', 'CXM-PKG-006');
  }
  const lessonPath = new Map<string, { pathKey: string; index: number; au: Cmi5Au }>();
  for (const b of pathBlocks) {
    lessonAus(b).forEach((a, index) => {
      if (a.key !== undefined && KEY_RE.test(a.key) && b.key !== undefined && !lessonPath.has(a.key)) lessonPath.set(a.key, { pathKey: b.key, index, au: a });
    });
  }
  if (course) {
    for (const b of pathBlocks) {
      if (b.key === undefined || b.pathSrc === undefined) continue;
      const entry = Object.hasOwn(course.paths, b.key) ? course.paths[b.key] : undefined;
      if (!entry) add('CXM-PKG-016', placeAt(b.xpath), `The block "${b.key}" has no entry in ${courseFile}#/paths.`);
      else if ('status' in entry) add('CXM-PKG-016', placeAt(b.xpath), `The path "${b.key}" is coming-soon but has a block in cmi5.xml.`);
      else if (lessonAus(b).length === 0) add('CXM-PKG-012', placeAt(b.xpath), `The block of the live path "${b.key}" has no lesson AU.`);
    }
    for (const [k, entry] of Object.entries(course.paths)) {
      if (!('status' in entry) && !blockByKey.has(k)) add('CXM-PKG-016', { file: courseFile, pointer: `/paths/${escapePointer(k)}` }, `The live path "${k}" has no block in cmi5.xml.`);
    }
  }

  // ---- lessons
  const lessons = new Map<string, LessonJson>();
  for (const a of aus) {
    if (a.role === 'placement' || a.blockXpath === undefined) continue;
    if (a.lessonSrc === undefined || a.lessonXpath === undefined) {
      add('CXM-PKG-005', placeAt(a.xpath), 'The lesson AU has no cxm:lesson child.');
      continue;
    }
    const ref = resolveSrc(a.lessonSrc, { xpath: a.lessonXpath }, 'cxm:lesson', 'CXM-PKG-007');
    if (!ref) continue;
    const data = parseJson(ref, (course?.flavour === 'distribution' ? DistributionLessonJsonSchema : LessonJsonSchema) as typeof LessonJsonSchema, 'lesson');
    if (!data || a.key === undefined) continue;
    if (!lessons.has(a.key)) lessons.set(a.key, data);
    const at = (p: string) => ({ file: ref.file, pointer: ref.pointer + p });
    const pathKey = lessonPath.get(a.key)?.pathKey;

    const beatKeys = new Set<string>();
    data.beats.forEach((b, i) => {
      if (beatKeys.has(b.key)) add('CXM-PKG-019', at(`/beats/${i}/key`), `Beat key "${b.key}" is used more than once in lesson "${a.key}".`);
      beatKeys.add(b.key);
    });

    const regexes = (checks: { type: string; pattern?: string; flags?: string }[], base: string) => {
      checks.forEach((c, i) => {
        if (c.type !== 'regex') return;
        try {
          new RegExp(c.pattern!, c.flags);
        } catch (err) {
          add('CXM-PKG-021', at(`${base}/${i}/pattern`), `The regex /${c.pattern}/${c.flags ?? ''} does not compile: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    };
    if (data.checkpoint?.checks) regexes(data.checkpoint.checks, '/checkpoint/checks');
    if (data.bug?.fixChecks) regexes(data.bug.fixChecks, '/bug/fixChecks');

    const cp = data.checkpoint;
    const expected = cp ? 'CompletedAndPassed' : 'Completed';
    if (a.moveOn !== expected) add('CXM-PKG-013', placeAt(a.xpath), `The lesson "${a.key}" ${cp ? 'has' : 'has no'} checkpoint, so moveOn must be ${expected}, not ${a.moveOn}.`);
    if (!cp) continue;

    const branchKeys = new Set<string>();
    cp.branches.forEach((br, i) => {
      if (branchKeys.has(br.key)) add('CXM-PKG-017', at(`/checkpoint/branches/${i}/key`), `Branch key "${br.key}" is used more than once in the checkpoint of "${a.key}".`);
      branchKeys.add(br.key);
    });
    if (!cp.branches.some((br) => br.success)) add('CXM-PKG-017', at('/checkpoint/branches'), `The checkpoint of "${a.key}" has no branch with success: true.`);
    if (cp.kind === 'code') {
      if (!cp.file) add('CXM-PKG-018', at('/checkpoint'), `The code checkpoint of "${a.key}" has no file.`);
      if (!cp.checks || cp.checks.length === 0) add('CXM-PKG-018', at('/checkpoint'), `The code checkpoint of "${a.key}" has no checks.`);
      if (!cp.branches.some((br) => !br.success)) add('CXM-PKG-018', at('/checkpoint/branches'), `The code checkpoint of "${a.key}" has no branch with success: false.`);
    }
    const me = lessonPath.get(a.key);
    cp.branches.forEach((br, i) => {
      if (br.to === null) return;
      const target = lessonPath.get(br.to);
      const to = at(`/checkpoint/branches/${i}/to`);
      if (!target) add('CXM-PKG-010', to, `Branch "${br.key}" goes to "${br.to}", which is not a lesson key.`);
      else if (!me || target.pathKey !== pathKey) add('CXM-PKG-011', to, `Branch "${br.key}" goes to "${br.to}", which is in the path "${target.pathKey}", not "${pathKey}".`);
      else if (!br.success && target.index > me.index) add('CXM-PKG-026', to, `The success: false branch "${br.key}" goes forward to "${br.to}".`);
    });
  }

  // ---- course-level rules
  if (course) {
    const badges = course.badges ?? [];
    if (course.flavour === 'distribution' && !o.allowDistribution) {
      add('CXM-PKG-034', { file: courseFile, pointer: '/flavour' }, 'This is a distribution package; the server loads authoring packages.');
    }
    if (course.custody === 'practice') {
      if (badges.length > 0) add('CXM-PKG-031', { file: courseFile, pointer: '/badges' }, 'Badges are declared with custody practice.');
      if (course.allowPractice) add('CXM-PKG-031', { file: courseFile, pointer: '/allowPractice' }, 'allowPractice is true with custody practice.');
    }
    badges.forEach((b, i) => {
      const at = (p: string) => ({ file: courseFile, pointer: `/badges/${i}${p}` });
      if (!b.id.startsWith('https://')) add('CXM-PKG-032', at('/id'), `The badge id "${b.id}" is not https.`);
      if (b.awardOn === 'au-moveon') {
        if (b.for === undefined || !lessonPath.has(b.for)) add('CXM-PKG-032', at('/for'), `An au-moveon badge needs "for" to be a lesson key; got ${b.for === undefined ? 'nothing' : `"${b.for}"`}.`);
      } else if (b.awardOn === 'block-satisfied') {
        if (b.for === undefined || !Object.hasOwn(course.paths, b.for)) add('CXM-PKG-032', at('/for'), `A block-satisfied badge needs "for" to be a path key; got ${b.for === undefined ? 'nothing' : `"${b.for}"`}.`);
      } else if (b.for !== undefined) {
        add('CXM-PKG-032', at('/for'), `A ${b.awardOn} badge must not have "for".`);
      }
    });
    if (badges.length > 0 && !course.badgeIssuer) add('CXM-PKG-033', { file: courseFile, pointer: '/badges' }, 'Badges are declared without badgeIssuer.');
    for (const k of Object.keys(course.extensions ?? {})) {
      if (k !== EXTENSION_ID && !k.startsWith(SITE + '/')) add('CXM-PKG-100', { file: courseFile, pointer: `/extensions/${escapePointer(k)}` }, `Unknown extensions key "${k}" is ignored.`);
    }
  }
  for (const [lk, l] of lessons) {
    const ref = lessonPath.get(lk)?.au.lessonSrc;
    const file = ref ? ref.split('#')[0]! : '';
    const base = ref && ref.includes('#') ? (decodeFragment(ref.slice(ref.indexOf('#') + 1)) ?? '') : '';
    for (const k of Object.keys(l.extensions ?? {})) {
      if (k !== EXTENSION_ID && !k.startsWith(SITE + '/')) add('CXM-PKG-100', { file, pointer: `${base}/extensions/${escapePointer(k)}` }, `Unknown extensions key "${k}" is ignored.`);
    }
  }

  if (issues.some((i) => i.severity === 'error') || !course) return done();

  // ---- model
  const placementAu = placements[0]!;
  const lessonModels: Record<string, LessonModel> = {};
  const pathModels: Record<string, PathModel> = {};
  for (const [pk, entry] of Object.entries(course.paths)) {
    if ('status' in entry) {
      pathModels[pk] = { key: pk, title: entry.title, tagline: entry.tagline, status: 'coming-soon', lessons: [] };
      continue;
    }
    const b = blockByKey.get(pk)!;
    const keys: string[] = [];
    for (const a of lessonAus(b)) {
      const l = lessons.get(a.key!)!;
      keys.push(a.key!);
      lessonModels[a.key!] = {
        key: a.key!,
        auId: a.id,
        pathKey: pk,
        title: a.title,
        description: a.description,
        url: a.url,
        moveOn: a.moveOn as LessonModel['moveOn'],
        minutes: l.minutes,
        sources: l.sources ?? [],
        beats: l.beats as Beat[],
        ...(l.starterFiles ? { starterFiles: l.starterFiles } : {}),
        ...(l.bug ? { bug: l.bug as NonNullable<LessonModel['bug']> } : {}),
        ...(l.checkpoint ? { checkpoint: l.checkpoint as NonNullable<LessonModel['checkpoint']> } : {}),
        ...(l.referenceSolution ? { referenceSolution: l.referenceSolution as NonNullable<LessonModel['referenceSolution']> } : {}),
      };
    }
    pathModels[pk] = {
      key: pk,
      blockId: b.id,
      title: b.title,
      ...(b.description ? { description: b.description } : {}),
      tagline: entry.tagline,
      status: 'live',
      lessons: keys,
      ...(entry.placementHints ? { placementHints: entry.placementHints } : {}),
    };
  }
  const model: CourseModel = {
    specVersion: cxm.specVersion,
    flavour: course.flavour,
    id: structure.course.id,
    title: structure.course.title,
    description: structure.course.description,
    mcp: cxm.mcp,
    version: course.version,
    language: course.language,
    ...(course.license ? { license: course.license } : {}),
    rules: course.rules ?? [],
    placement: { key: placementAu.key!, auId: placementAu.id, url: placementAu.url, title: placementAu.title, intro: course.placement.intro, maxQuestions: course.placement.maxQuestions },
    custody: course.custody,
    allowPractice: course.allowPractice,
    badges: (course.badges ?? []) as BadgeDecl[],
    ...(course.badgeIssuer ? { badgeIssuer: course.badgeIssuer } : {}),
    paths: pathModels,
    lessons: lessonModels,
    ...(course.extensions ? { extensions: course.extensions } : {}),
  };
  issues.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || cmp(a.xpath ?? a.pointer ?? '', b.xpath ?? b.pointer ?? ''));
  return { ok: true, course: model, issues };
}
