// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { parseCourse, type Course } from '@course-xapi-mcp/core';
import { createCourseServer } from '../src/index.ts';

export function loadCourse(): Course {
  const raw = JSON.parse(readFileSync(new URL('../../../../examples/json-basics/course.json', import.meta.url), 'utf8'));
  const r = parseCourse(raw);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.course;
}

export type Era = 'legacy' | 'modern';

/** An SDK client wired straight to the server's fetch handler (no network). */
export async function connect(era: Era, app = createCourseServer({ course: loadCourse() })) {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: 'learning-mcp-test', version: '0.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), data: r.structuredContent as any, raw: r };
  };
  return { client, call, app };
}
