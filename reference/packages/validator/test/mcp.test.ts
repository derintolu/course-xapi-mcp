// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { URIS } from '@course-xapi-mcp/core';
import { readDir } from '@course-xapi-mcp/core/package';
import { createValidatorMcp, explainCode, validatePackage } from '../src/index.ts';

const SKILL = fileURLToPath(new URL('../../../../docs/authoring/SKILL.md', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/cxm.mjs', import.meta.url));
const dir = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const dec = new TextDecoder();
const asText = (files: Record<string, Uint8Array>) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, dec.decode(v)]));

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createValidatorMcp().connect(b);
  client = new Client({ name: 'validator-test', version: '0.0.0' });
  await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client!.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), data: r.structuredContent, text: r.content[0]?.text as string };
  };
  return { client, call };
}

describe('validator MCP server', () => {
  it('lists validate_package, explain_error and scaffold', async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['explain_error', 'scaffold', 'validate_package']);
  });

  it.each(['../../../../examples/json-basics/', './fixtures/packages/au-no-url/', './fixtures/packages/regex-nested/'])('validate_package on %s returns what the library returns', async (rel) => {
    const files = await readDir(dir(rel));
    const { call } = await connect();
    const want = await validatePackage(files);
    const byFiles = await call('validate_package', { files: asText(files) });
    expect(byFiles.isError).toBe(false);
    expect(byFiles.data).toEqual(want);
    expect(JSON.parse(byFiles.text)).toEqual(want);
    const byZip = await call('validate_package', { zipBase64: Buffer.from(zipSync(files)).toString('base64') });
    expect(byZip.data).toEqual(want);
  });

  it('validate_package reports an unreadable ZIP as CXM-PKG-001 and wants exactly one input', async () => {
    const { call } = await connect();
    const r = await call('validate_package', { zipBase64: Buffer.from('not a zip').toString('base64') });
    expect(r.data.valid).toBe(false);
    expect(r.data.issues[0].code).toBe('CXM-PKG-001');
    expect((await call('validate_package', {})).isError).toBe(true);
    expect((await call('validate_package', { files: {}, zipBase64: '' })).isError).toBe(true);
  });

  it('explain_error explains a known code and is an error result for an unknown one', async () => {
    const { call } = await connect();
    const known = await call('explain_error', { code: 'CXM-PKG-013' });
    expect(known.isError).toBe(false);
    expect(known.data).toEqual(explainCode('CXM-PKG-013'));
    const unknown = await call('explain_error', { code: 'CXM-PKG-999' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('unknown code CXM-PKG-999');
  });

  it('scaffold makes a course, then a lesson, and refuses a taken key', async () => {
    const { call } = await connect();
    const course = await call('scaffold', { kind: 'course', id: 'https://example.org/c', title: 'C' });
    expect(Object.keys(course.data.files).sort()).toEqual(['cmi5.xml', 'cxm/course.json']);
    const lesson = await call('scaffold', { kind: 'lesson', files: course.data.files, pathKey: 'p', key: 'l1', title: 'L1' });
    expect(Object.keys(lesson.data.files).sort()).toEqual(['cmi5.xml', 'cxm/course.json', 'cxm/lessons/l1.json']);
    const again = await call('scaffold', { kind: 'lesson', files: lesson.data.files, pathKey: 'p', key: 'l1', title: 'L1' });
    expect(again.isError).toBe(true);
    expect((await call('scaffold', { kind: 'course', title: 'no id' })).isError).toBe(true);
  });

  it('serves the author skill, equal to docs/authoring/SKILL.md', async () => {
    const { client } = await connect();
    expect((await client.listResources()).resources.map((r) => r.uri)).toContain(URIS.authorSkill);
    const r = await client.readResource({ uri: URIS.authorSkill });
    expect(r.contents).toHaveLength(1);
    expect(r.contents[0]).toMatchObject({ uri: URIS.authorSkill, mimeType: 'text/markdown', text: readFileSync(SKILL, 'utf8') });
  });
});

describe('cxm mcp', () => {
  it('serves the same tools over stdio', async () => {
    client = new Client({ name: 'validator-stdio-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], stderr: 'pipe' }));
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['explain_error', 'scaffold', 'validate_package']);
    const r: any = await client.callTool({ name: 'explain_error', arguments: { code: 'CXM-PKG-001' } });
    expect(r.structuredContent.code).toBe('CXM-PKG-001');
  });
});
