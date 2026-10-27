// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url).pathname;
const SKIP = new Set(['node_modules', 'dist', '.git']);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function sourceFiles(dirs: string[]): string[] {
  return dirs.flatMap((d) => walk(join(root, d))).filter((f) => /\.(ts|mjs|js)$/.test(f));
}

function packageJsons(): { name: string; license: string }[] {
  const files = [join(root, 'package.json'), ...walk(join(root, 'reference')).filter((f) => f.endsWith('/package.json'))];
  return files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
}

const SPDX = '// SPDX-License-Identifier: Apache-2.0';

/** The line that must be the SPDX line: the first, or the second when the first is a shebang. */
function spdxLine(text: string): string | undefined {
  const lines = text.split('\n');
  return lines[0]!.startsWith('#!') ? lines[1] : lines[0];
}

describe('licence', () => {
  it('every source file starts with the Apache-2.0 SPDX line', () => {
    for (const f of sourceFiles(['reference', 'scripts', 'conformance', 'site'])) {
      expect(spdxLine(readFileSync(f, 'utf8')), f).toBe(SPDX);
    }
  });
  it('accepts the SPDX line second only after a shebang', () => {
    expect(spdxLine(`${SPDX}\ncode`)).toBe(SPDX);
    expect(spdxLine(`#!/usr/bin/env node\n${SPDX}\ncode`)).toBe(SPDX);
    expect(spdxLine(`// a comment\n${SPDX}\ncode`)).not.toBe(SPDX);
    expect(spdxLine(`#!/usr/bin/env node\ncode\n${SPDX}`)).not.toBe(SPDX);
  });
  it('every package.json is Apache-2.0', () => {
    for (const p of packageJsons()) expect(p.license, p.name).toBe('Apache-2.0');
  });
  it('LICENSE is Apache-2.0 and the CC licence file is gone', () => {
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain('Apache License\n                           Version 2.0, January 2004');
    expect(existsSync(join(root, 'LICENSE-CC-BY-SA-4.0'))).toBe(false);
  });
});
