// SPDX-License-Identifier: Apache-2.0
// Checks that every requirement ID in spec/draft/*.md has one entry in
// conformance/requirements/draft.yaml and vice versa. Usage: npm run requirements [-- --strict]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const CLASS_OF_PREFIX: Record<string, string> = {
  PKG: 'package',
  SRV: 'server',
  CUS: 'custody',
  BRG: 'bridge',
  BDG: 'badges',
  SEC: 'security',
};
const ID = /^CXM-(PKG|SRV|CUS|BRG|BDG|SEC)-\d{3}$/;
const STATUSES = new Set(['pending', 'tested', 'excluded']);

interface Entry {
  id?: unknown;
  class?: unknown;
  text?: unknown;
  source?: unknown;
  status?: unknown;
  test?: unknown;
  exclusion?: unknown;
}

// GitHub-style heading anchor: lower case, punctuation dropped, spaces to hyphens.
function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}

export function checkRequirements(o: { strict: boolean; root?: string }): string[] {
  const root = o.root ?? new URL('../', import.meta.url).pathname;
  const specDir = join(root, 'spec/draft');
  const yamlPath = join(root, 'conformance/requirements/draft.yaml');
  const problems: string[] = [];

  // IDs in the spec text, with the file each appears in, and each file's heading anchors.
  const inText = new Map<string, string>();
  const anchors = new Map<string, Set<string>>();
  const specFiles = existsSync(specDir) ? readdirSync(specDir).filter((f) => f.endsWith('.md')).sort() : [];
  for (const name of specFiles) {
    const file = `spec/draft/${name}`;
    const text = readFileSync(join(specDir, name), 'utf8');
    anchors.set(file, new Set([...text.matchAll(/^#{1,6} +(.+)$/gm)].map((m) => slug(m[1]))));
    for (const m of text.matchAll(/\[(CXM-[A-Z]+-\d+)\]/g)) {
      const id = m[1];
      if (!ID.test(id)) problems.push(`${file}: malformed requirement ID ${id}`);
      else if (inText.has(id)) problems.push(`${id}: duplicate in spec text (${inText.get(id)}, ${file})`);
      else inText.set(id, file);
    }
  }

  const raw: unknown = existsSync(yamlPath) ? parse(readFileSync(yamlPath, 'utf8')) : [];
  if (!Array.isArray(raw)) return [...problems, 'conformance/requirements/draft.yaml: not a list'];
  const seen = new Set<string>();
  for (const e of raw as Entry[]) {
    const id = typeof e?.id === 'string' ? e.id : undefined;
    if (!id || !ID.test(id)) {
      problems.push(`draft.yaml: entry with malformed id ${JSON.stringify(e?.id)}`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${id}: duplicate entry in draft.yaml`);
      continue;
    }
    seen.add(id);
    const expectedClass = CLASS_OF_PREFIX[id.split('-')[1]];
    if (e.class !== expectedClass) problems.push(`${id}: class ${JSON.stringify(e.class)}, expected ${expectedClass}`);
    if (typeof e.text !== 'string' || !e.text.trim()) problems.push(`${id}: no text`);
    if (!inText.has(id)) problems.push(`${id}: in draft.yaml but not in spec/draft/*.md`);
    const [srcFile, anchor] = typeof e.source === 'string' ? e.source.split('#') : [];
    if (inText.has(id) && srcFile !== inText.get(id)) problems.push(`${id}: source ${JSON.stringify(e.source)} does not name ${inText.get(id)}`);
    else if (srcFile && !anchors.get(srcFile)?.has(anchor ?? '')) problems.push(`${id}: source anchor ${JSON.stringify(e.source)} not found`);
    if (typeof e.status !== 'string' || !STATUSES.has(e.status)) {
      problems.push(`${id}: status ${JSON.stringify(e.status)} is not pending, tested or excluded`);
    } else if (e.status === 'tested') {
      const testPath = typeof e.test === 'string' ? join(root, e.test) : undefined;
      if (!testPath || !existsSync(testPath)) problems.push(`${id}: tested, but test file ${JSON.stringify(e.test)} not found`);
      else if (!readFileSync(testPath, 'utf8').includes(`[${id}]`)) problems.push(`${id}: tested, but ${e.test} does not contain [${id}]`);
    } else if (e.status === 'excluded') {
      if (typeof e.exclusion !== 'string' || !e.exclusion.trim()) problems.push(`${id}: excluded without a reason`);
    } else if (o.strict) {
      problems.push(`${id}: pending (strict)`);
    }
  }
  for (const [id, file] of inText) if (!seen.has(id)) problems.push(`${id}: in ${file} but not in draft.yaml`);
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const strict = process.argv.includes('--strict');
  const problems = checkRequirements({ strict });
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log(`requirements: OK${strict ? ' (strict)' : ''}`);
}
