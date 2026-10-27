// SPDX-License-Identifier: Apache-2.0
// The `cxm` command line: `cxm validate <dir|zip> [--json]` and `cxm explain <code>`.
import { readFile, stat } from 'node:fs/promises';
import { readDir, readZip } from '@course-xapi-mcp/core/package';
import type { PackageFiles } from '@course-xapi-mcp/core/package';
import type { ValidationIssue } from '@course-xapi-mcp/core';
import { explainCode } from './explain.ts';
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

/** Runs the command line and returns the exit code. */
export async function runCli(argv: string[], io: CliIo = stdio): Promise<number> {
  const [command, ...args] = argv;
  if (command === 'validate') return validateCommand(args, io);
  if (command === 'explain') return explainCommand(args, io);
  if (command === 'help' || command === '--help') {
    io.out(USAGE);
    return EXIT_VALID;
  }
  io.err(USAGE);
  return EXIT_USAGE;
}
