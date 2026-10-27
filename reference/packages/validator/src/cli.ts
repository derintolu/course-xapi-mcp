// SPDX-License-Identifier: Apache-2.0
// The `cxm` command line: validate, explain, init, add-lesson, build, convert and mcp.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CUSTODY_OPTIONS } from '@course-xapi-mcp/core';
import type { CustodyOption, ValidationIssue } from '@course-xapi-mcp/core';
import { readDir, readZip } from '@course-xapi-mcp/core/package';
import type { PackageFiles } from '@course-xapi-mcp/core/package';
import { buildPackages } from './build.ts';
import { convertLegacyCourse } from './convert.ts';
import { explainCode } from './explain.ts';
import { scaffoldCourse, scaffoldLesson } from './scaffold.ts';
import { validatePackage } from './validate.ts';
import type { ValidationResult } from './validate.ts';

export interface CliIo {
  out(s: string): void;
  err(s: string): void;
}

const stdio: CliIo = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };

const USAGE = `Usage:
  cxm validate <dir|zip> [--json]   validate a course package; exit 0 when valid, 1 with errors
  cxm explain <code>                show what a validator code means and how to fix it
  cxm init <dir> --id <iri> --title <title> [--custody <custody>]
                                    start a course package in a new or empty folder
  cxm add-lesson <dir> --path <key> --key <key> --title <title>
                                    add a lesson (and its path when new) to a package folder
  cxm build <dir|zip> [--out <dir>] build <name>-authoring.zip and <name>-lms.zip; exit 1 with errors
  cxm convert <course.json> <out-dir> --iri <iri> --mcp <url> --launch <url> --custody <custody>
                                    convert a legacy single-file course into a package folder
  cxm mcp                           serve the validator as an MCP server over stdio

Exit 2 on a usage error: a missing or unreadable path, an unknown command, flag or code.
`;

const EXIT_VALID = 0;
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;

/** One issue per line: `CODE severity file location: message. Fix: fix`. */
export function formatIssue(i: ValidationIssue, fallbackFile: string): string {
  const where = [i.file || fallbackFile, i.xpath ?? i.pointer].filter((s) => s !== undefined && s !== '').join(' ');
  return `${i.code} ${i.severity} ${where}: ${i.message.replace(/\.$/, '')}. Fix: ${i.fix}`;
}

async function readPackage(target: string): Promise<PackageFiles | ValidationIssue | undefined> {
  let s;
  try {
    s = await stat(target);
  } catch {
    return undefined;
  }
  if (s.isDirectory()) return readDir(target);
  return readZip(new Uint8Array(await readFile(target)));
}

async function validateCommand(args: string[], io: CliIo): Promise<number> {
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  if (rest.length !== 1 || rest[0]!.startsWith('-')) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const target = rest[0]!;
  const files = await readPackage(target);
  if (files === undefined) {
    io.err(`cxm: cannot read ${target}\n`);
    return EXIT_USAGE;
  }
  const result: ValidationResult = 'code' in files && typeof files.code === 'string' ? { valid: false, issues: [files as ValidationIssue] } : await validatePackage(files as PackageFiles);
  if (json) io.out(JSON.stringify(result, null, 2) + '\n');
  else for (const i of result.issues) io.out(formatIssue(i, target) + '\n');
  return result.valid ? EXIT_VALID : EXIT_INVALID;
}

function explainCommand(args: string[], io: CliIo): number {
  if (args.length !== 1) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const e = explainCode(args[0]!);
  if (!e) {
    io.err(`cxm: unknown code ${args[0]}\n`);
    return EXIT_USAGE;
  }
  io.out(`${e.code} (${e.severity}): ${e.title}\nFix: ${e.fix}\nHelp: ${e.help}\n`);
  return EXIT_VALID;
}

/** Splits arguments into positionals and `--name value` flags; undefined when a flag is unknown, repeated or has no value. */
function parseArgs(args: string[], names: readonly string[]): { pos: string[]; flags: Record<string, string> } | undefined {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const name = a.slice(2);
    const value = args[++i];
    if (!names.includes(name) || name in flags || value === undefined || value.startsWith('--')) return undefined;
    flags[name] = value;
  }
  return { pos, flags };
}

const isCustody = (s: string): s is CustodyOption => (CUSTODY_OPTIONS as readonly string[]).includes(s);

async function writeFiles(dir: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [name, data] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

/** The package folder as text files. */
async function readTextDir(dir: string): Promise<Record<string, string>> {
  const decoder = new TextDecoder('utf-8');
  return Object.fromEntries(Object.entries(await readDir(dir)).map(([k, v]) => [k, decoder.decode(v)]));
}

async function initCommand(args: string[], io: CliIo): Promise<number> {
  const p = parseArgs(args, ['id', 'title', 'custody']);
  if (!p || p.pos.length !== 1 || p.flags.id === undefined || p.flags.title === undefined) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const custody = p.flags.custody ?? 'server-kept';
  if (!isCustody(custody)) {
    io.err(`cxm: --custody must be one of ${CUSTODY_OPTIONS.join(', ')}\n`);
    return EXIT_USAGE;
  }
  const dir = p.pos[0]!;
  const existing = await readdir(dir).catch(() => [] as string[]);
  if (existing.some((f) => f !== '.DS_Store')) {
    io.err(`cxm: ${dir} is not empty; init needs a new or empty folder\n`);
    return EXIT_USAGE;
  }
  await writeFiles(dir, scaffoldCourse({ id: p.flags.id, title: p.flags.title, language: 'en', custody }));
  io.out(`Started ${dir}. Next: cxm add-lesson ${dir} --path <key> --key <key> --title <title>, then cxm validate ${dir}\n`);
  return EXIT_VALID;
}

async function addLessonCommand(args: string[], io: CliIo): Promise<number> {
  const p = parseArgs(args, ['path', 'key', 'title']);
  if (!p || p.pos.length !== 1 || p.flags.path === undefined || p.flags.key === undefined || p.flags.title === undefined) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const dir = p.pos[0]!;
  if (!(await stat(dir).catch(() => undefined))?.isDirectory()) {
    io.err(`cxm: cannot read ${dir}\n`);
    return EXIT_USAGE;
  }
  const before = await readTextDir(dir);
  let after: Record<string, string>;
  try {
    after = scaffoldLesson(before, { pathKey: p.flags.path, key: p.flags.key, title: p.flags.title });
  } catch (e) {
    io.err(`cxm: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_USAGE;
  }
  await writeFiles(dir, Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k] !== v)));
  io.out(`Added cxm/lessons/${p.flags.key}.json. Next: cxm validate ${dir}\n`);
  return EXIT_VALID;
}

async function buildCommand(args: string[], io: CliIo): Promise<number> {
  const p = parseArgs(args, ['out']);
  if (!p || p.pos.length !== 1) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const target = p.pos[0]!;
  const files = await readPackage(target);
  if (files === undefined) {
    io.err(`cxm: cannot read ${target}\n`);
    return EXIT_USAGE;
  }
  if ('code' in files && typeof files.code === 'string') {
    io.out(formatIssue(files as ValidationIssue, target) + '\n');
    return EXIT_INVALID;
  }
  const name = basename(resolve(target)).replace(/\.zip$/i, '').replace(/-authoring$/, '');
  // A build into the package folder itself must not pack its earlier output (the authoring ZIP holds every secret).
  const input = { ...(files as PackageFiles) };
  delete input[`${name}-authoring.zip`];
  delete input[`${name}-lms.zip`];
  const r = await buildPackages(input, name);
  if ('issues' in r) {
    for (const i of r.issues) io.out(formatIssue(i, target) + '\n');
    return EXIT_INVALID;
  }
  const out = p.flags.out ?? '.';
  await mkdir(out, { recursive: true });
  for (const z of [r.authoring, r.distribution]) {
    await writeFile(join(out, z.file), z.bytes);
    io.out(`${join(out, z.file)} ${z.etag}\n`);
  }
  return EXIT_VALID;
}

async function convertCommand(args: string[], io: CliIo): Promise<number> {
  const p = parseArgs(args, ['iri', 'mcp', 'launch', 'custody']);
  const f = p?.flags;
  if (!p || !f || p.pos.length !== 2 || f.iri === undefined || f.mcp === undefined || f.launch === undefined || f.custody === undefined) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  if (!isCustody(f.custody)) {
    io.err(`cxm: --custody must be one of ${CUSTODY_OPTIONS.join(', ')}\n`);
    return EXIT_USAGE;
  }
  const [source, outDir] = p.pos as [string, string];
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(source, 'utf8'));
  } catch (e) {
    io.err(`cxm: cannot read ${source} as JSON: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_USAGE;
  }
  const r = convertLegacyCourse(raw, { courseIri: f.iri, mcpUrl: f.mcp, launchBase: f.launch, custody: f.custody });
  if (!r.ok) {
    for (const e of r.errors) io.out(`${source}: ${e}\n`);
    return EXIT_INVALID;
  }
  await writeFiles(outDir, r.files);
  io.out(`Wrote ${outDir}. Next: cxm validate ${outDir}\n`);
  return EXIT_VALID;
}

async function mcpCommand(args: string[], io: CliIo): Promise<number> {
  if (args.length !== 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  const { createValidatorMcp } = await import('./mcp.ts');
  serveStdio(createValidatorMcp);
  return EXIT_VALID;
}

/** Runs the command line and returns the exit code. */
export async function runCli(argv: string[], io: CliIo = stdio): Promise<number> {
  const [command, ...args] = argv;
  if (command === 'validate') return validateCommand(args, io);
  if (command === 'explain') return explainCommand(args, io);
  if (command === 'init') return initCommand(args, io);
  if (command === 'add-lesson') return addLessonCommand(args, io);
  if (command === 'build') return buildCommand(args, io);
  if (command === 'convert') return convertCommand(args, io);
  if (command === 'mcp') return mcpCommand(args, io);
  if (command === 'help' || command === '--help') {
    io.out(USAGE);
    return EXIT_VALID;
  }
  io.err(USAGE);
  return EXIT_USAGE;
}
