// SPDX-License-Identifier: Apache-2.0
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AuthServer, CourseModel, Custody, LearnerRef } from '@course-xapi-mcp/core';
import { loadPackage, readDir } from '@course-xapi-mcp/core/package';
import { createCourseServer, createPracticeCustody, createServerKeptCustody, MemoryServerStore, type CourseServer, type PracticeCustody } from '../src/index.ts';

export const PUBLIC_URL = 'https://course.example.org';
const EXAMPLE = new URL('../../../../examples/json-basics/', import.meta.url).pathname;

let example: CourseModel | undefined;
/** The json-basics example package, loaded once. */
export async function loadExample(): Promise<CourseModel> {
  if (!example) {
    const r = loadPackage(await readDir(EXAMPLE));
    if (!r.ok) throw new Error(r.issues.map((i) => `${i.code} ${i.message}`).join('\n'));
    example = r.course;
  }
  return structuredClone(example);
}

/** The bearer token a test learner uses, and the subject the stub authorization server maps it to. */
export const TOKEN = 'tok-alice-0123456789';
export const SUBJECT = 'subject-alice-9f3e2b';

/** A stand-in for `AuthServer.authenticate`: one valid bearer token per subject; anything else is a 401. */
export function stubAuthenticate(course: CourseModel, tokens: Record<string, string> = { [TOKEN]: SUBJECT }): AuthServer['authenticate'] {
  return async (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
    const subject = m ? tokens[m[1]!] : undefined;
    if (subject) return { kind: 'official', subject, actor: { objectType: 'Agent', account: { homePage: course.id, name: subject } } } satisfies LearnerRef;
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp", scope="cxm:learn"` },
    });
  };
}

export interface Setup {
  course: CourseModel;
  app: CourseServer;
  practice: PracticeCustody;
  store?: MemoryServerStore;
}

/** A course server for the example: custody `practice` (practice on /mcp) or `server-kept` (official /mcp and /mcp/practice). */
export async function makeServer(kind: 'practice' | 'server-kept', o: { wrap?: (c: Custody) => Custody; wrapPractice?: (c: PracticeCustody) => PracticeCustody } = {}): Promise<Setup> {
  const course = await loadExample();
  const practice = (o.wrapPractice ?? ((c) => c))(createPracticeCustody({ courseId: course.id }));
  if (kind === 'practice') {
    const app = createCourseServer({ course: { ...course, custody: 'practice', allowPractice: false, badges: [], badgeIssuer: undefined }, custody: practice, publicUrl: PUBLIC_URL });
    return { course, app, practice };
  }
  const store = new MemoryServerStore();
  const custody = (o.wrap ?? ((c) => c))(createServerKeptCustody({ store, publicUrl: PUBLIC_URL, courseTitle: course.title }));
  const app = createCourseServer({ course, custody, practice, authenticate: stubAuthenticate(course), publicUrl: PUBLIC_URL });
  return { course, app, practice, store };
}

export type Era = 'legacy' | 'modern';

export interface Session {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; data: any; raw: any }>;
}

/** An SDK client wired straight to the server's `mcp` handler (no network). */
export async function connect(era: Era, app: CourseServer, path: '/mcp' | '/mcp/practice' = '/mcp', token?: string): Promise<Session> {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost' + path), {
    fetch: (url, init) => {
      const req = new Request(url, init);
      if (token) req.headers.set('authorization', `Bearer ${token}`);
      return app.mcp(req, path);
    },
  });
  const client = new Client({ name: 'cxm-test-client', version: '0.0.0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), data: r.structuredContent as any, raw: r };
  };
  return { client, call };
}

/** A copy of the config file with the planted bug fixed, and one that also passes the checkpoint checks. */
export const FIXED = '{\n  "name": "demo",\n  "port": 8080,\n  "debug": false\n}\n';
export const WITH_TIMEOUT = '{\n  "name": "demo",\n  "port": 8080,\n  "debug": false,\n  "timeout": 30\n}\n';

/**
 * Teaches the whole example path. `h` adds the practice handle to every call when given.
 * Returns every result, in order, with the tool name.
 */
export async function teachExample(call: Session['call'], h: Record<string, unknown> = {}) {
  const seen: { name: string; r: Awaited<ReturnType<Session['call']>> }[] = [];
  const step = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, { ...h, ...args });
    seen.push({ name, r });
    if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.data ?? r.raw)}`);
    return r;
  };
  await step('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New to JSON.' });
  await step('next_beat');
  await step('next_beat', { learner_reply: '"42" is a string.' });
  await step('next_beat', { learner_reply: 'No: the trailing comma is an error.' });
  await step('submit_checkpoint', { response: 'One is a number, one is a string; a server may reject the string.' });
  await step('choose_branch', { branch: 'ready', rationale: 'Names both types and a reason.' });
  await step('next_beat');
  await step('next_beat', { learner_reply: 'A string, so a program may treat it as true.' });
  await step('check_code', { file: 'config.json', content: FIXED });
  await step('next_beat');
  await step('submit_checkpoint', { response: 'A number, because the program compares it.', files: { 'config.json': WITH_TIMEOUT } });
  await step('choose_branch', { branch: 'done', rationale: 'Checks pass and the reason is right.' });
  return seen;
}
