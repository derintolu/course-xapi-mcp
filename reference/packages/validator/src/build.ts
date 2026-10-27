// SPDX-License-Identifier: Apache-2.0
// Builds the two ZIPs of a valid authoring package: `<name>-authoring.zip` (everything, for the course server)
// and `<name>-lms.zip` (the distribution package for LMSs, without the secret fields). Both are deterministic.
import { Zip, ZipDeflate } from 'fflate';
import { parseCmi5Xml, resolvePointer } from '@course-xapi-mcp/core/package';
import type { PackageFiles } from '@course-xapi-mcp/core/package';
import { makeIssue } from '@course-xapi-mcp/core';
import type { ValidationIssue } from '@course-xapi-mcp/core';
import { validatePackage } from './validate.ts';

export interface BuiltZip {
  file: string;
  bytes: Uint8Array;
  /** `"sha256-<base64url of the SHA-256 of bytes>"`, quotes included. */
  etag: string;
}

export type BuildResult = { authoring: BuiltZip; distribution: BuiltZip } | { issues: ValidationIssue[] };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// fflate writes DOS times from the local-time fields of the Date, so build it from local fields:
// every entry then reads 1980-01-01 00:00:00 whatever the build machine's time zone.
const DOS_EPOCH = new Date(1980, 0, 1, 0, 0, 0);
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/** A ZIP of `files`: entries sorted by name, fixed mtime, fixed compression, no extra fields. */
export function deterministicZip(files: PackageFiles): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    chunks.push(chunk);
  });
  for (const name of Object.keys(files).sort(cmp)) {
    const entry = new ZipDeflate(name, { level: 6 });
    entry.mtime = DOS_EPOCH;
    zip.add(entry);
    entry.push(files[name]!, true);
  }
  zip.end();
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function etagOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return `"sha256-${base64url(digest)}"`;
}

/** Splits a `src` into its file and JSON Pointer. */
function splitSrc(src: string): { file: string; pointer: string } {
  const hash = src.indexOf('#');
  return hash < 0 ? { file: src, pointer: '' } : { file: src.slice(0, hash), pointer: decodeURIComponent(src.slice(hash + 1)) };
}

/**
 * The distribution package: the same files, with `flavour: 'distribution'` in course.json and
 * `bug.explanation`, `bug.fixChecks` and `referenceSolution` removed from every lesson.
 * Only the JSON files that change are rewritten. Runs on a package that already validated.
 */
function distributionFiles(files: PackageFiles): PackageFiles {
  const parsed = parseCmi5Xml(decoder.decode(files['cmi5.xml']!));
  if (!('structure' in parsed)) throw new Error('cmi5.xml did not parse after validation');
  const { course, aus } = parsed.structure;
  const docs = new Map<string, unknown>();
  const doc = (file: string) => {
    if (!docs.has(file)) docs.set(file, JSON.parse(decoder.decode(files[file]!)));
    return docs.get(file);
  };
  const at = (src: string) => {
    const { file, pointer } = splitSrc(src);
    const hit = resolvePointer(doc(file), pointer);
    if (!hit.found) throw new Error(`${src} did not resolve after validation`);
    return hit.value as Record<string, unknown>;
  };

  at(course.cxm!.src).flavour = 'distribution';
  for (const a of aus) {
    if (a.lessonSrc === undefined) continue;
    const lesson = at(a.lessonSrc);
    delete lesson.referenceSolution;
    const bug = lesson.bug as Record<string, unknown> | undefined;
    if (bug) {
      delete bug.explanation;
      delete bug.fixChecks;
    }
  }
  const out: PackageFiles = { ...files };
  for (const [file, value] of docs) out[file] = encoder.encode(json(value));
  return out;
}

/** The JSON value a `src` points at in a package that already validated. */
function valueAt(files: PackageFiles, src: string): unknown {
  const { file, pointer } = splitSrc(src);
  const hit = resolvePointer(JSON.parse(decoder.decode(files[file]!)), pointer);
  return hit.found ? hit.value : undefined;
}

async function built(file: string, files: PackageFiles): Promise<BuiltZip> {
  const bytes = deterministicZip(files);
  return { file, bytes, etag: await etagOf(bytes) };
}

/**
 * Builds `<name>-authoring.zip` and `<name>-lms.zip` from an authoring package.
 * Refuses, returning the issues, when the package has errors or is already a distribution package.
 */
export async function buildPackages(files: PackageFiles, name: string): Promise<BuildResult> {
  const result = await validatePackage(files);
  if (!result.valid) return { issues: result.issues };
  const parsed = parseCmi5Xml(decoder.decode(files['cmi5.xml']!));
  const src = 'structure' in parsed ? parsed.structure.course.cxm?.src : undefined;
  if (src !== undefined && (valueAt(files, src) as { flavour?: unknown } | undefined)?.flavour === 'distribution') {
    return {
      issues: [
        makeIssue(
          'CXM-PKG-034',
          { file: splitSrc(src).file, pointer: '/flavour' },
          'This is a distribution package; build from the authoring package instead.',
          'Run the build on the authoring package (the folder, or *-authoring.zip); never edit or rebuild the distribution package by hand.',
        ),
      ],
    };
  }
  return { authoring: await built(`${name}-authoring.zip`, files), distribution: await built(`${name}-lms.zip`, distributionFiles(files)) };
}
