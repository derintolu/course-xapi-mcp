// SPDX-License-Identifier: Apache-2.0
import { unzipSync } from 'fflate';
import { makeIssue } from '../issues.ts';
import type { ValidationIssue } from '../issues.ts';

/** Package files by path relative to the package root, `/`-separated. */
export type PackageFiles = Record<string, Uint8Array>;

function unsafe(name: string): boolean {
  if (name.startsWith('/') || name.includes('\\') || /^[a-zA-Z]:/.test(name)) return true;
  return name.split('/').some((seg) => seg === '..');
}

/** Reads a ZIP into package files. Directory entries are dropped. */
export function readZip(bytes: Uint8Array): PackageFiles | ValidationIssue {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    return makeIssue('CXM-PKG-001', { file: '' }, `The ZIP cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const files: PackageFiles = {};
  for (const [name, data] of Object.entries(entries)) {
    if (unsafe(name)) {
      return makeIssue('CXM-PKG-001', { file: name }, `The ZIP entry "${name}" is an absolute path or contains "..".`, 'Rebuild the ZIP with only relative entries that stay inside the package.');
    }
    if (name.endsWith('/')) continue;
    files[name] = data;
  }
  return files;
}
