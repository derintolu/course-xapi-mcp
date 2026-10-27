// SPDX-License-Identifier: Apache-2.0
// The worked examples used by the authoring guide stay valid and stay in step with each other.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readDir } from '@course-xapi-mcp/core/package';
import { validatePackage } from '../../reference/packages/validator/src/index.ts';

const root = new URL('../../', import.meta.url).pathname;
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const auIds = (xml: string) => [...xml.matchAll(/<au\s[^>]*?\bid="([^"]+)"/g)].map((m) => m[1]!);

describe('examples/cmi5-html', () => {
  it('the converted package validates with no errors or warnings', async () => {
    const r = await validatePackage(await readDir(root + 'examples/cmi5-html/converted'));
    expect(r.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('keeps the AU ids of the original and adds only the placement AU', () => {
    const original = auIds(read('examples/cmi5-html/original/cmi5.xml'));
    const converted = auIds(read('examples/cmi5-html/converted/cmi5.xml'));
    expect(original).toHaveLength(2);
    expect(converted.filter((id) => !id.endsWith('/placement'))).toEqual(original);
  });

  it('keeps the original course and block ids and gives every AU a cxm:key', () => {
    const o = read('examples/cmi5-html/original/cmi5.xml');
    const c = read('examples/cmi5-html/converted/cmi5.xml');
    for (const id of o.matchAll(/<(?:course|block)\s+id="([^"]+)"/g)) expect(c).toContain(`id="${id[1]}"`);
    expect([...c.matchAll(/<au\s/g)]).toHaveLength([...c.matchAll(/<au\s[^>]*cxm:key="/g)].length);
  });
});
