// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_RULES,
  EXTENSION_ID,
  LIMITS,
  MemoryLaunchStore,
  PRACTICE_LABEL,
  RULES_URI,
  RULES_VERSION,
  StoreError,
  TOOL_NAMES,
  URIS,
  tutorSkill,
  type Custody,
  type LearnerRef,
  type XapiStatement,
} from '@course-xapi-mcp/core';
import { checkCmi5Order, checkProfile, validateStatement } from '@course-xapi-mcp/core/xapi';
import { createBridge } from '@course-xapi-mcp/bridge';
import { createLmsSim, createTestLrs } from '@course-xapi-mcp/conformance';
import {
  createAuthorLrsCustody,
  createCourseServer,
  createLmsLaunchedCustody,
  createPracticeCustody,
  launchSubject,
  withLearnerLock,
  type PracticeCustody,
} from '../src/index.ts';
import { toolInputJsonSchema, toolOutputJsonSchema } from '../src/tool-schemas.ts';
import { PUBLIC_URL, SUBJECT, TOKEN, connect, loadExample, makeServer, stubAuthenticate, teachExample, type Era, type Session } from './helpers.ts';

const RETRY = 'the record was changed by another call at the same time; call this tool again';
const HOLDER_DOWN = 'the record holder is not responding; try again shortly';
const READ_ONLY = ['get_status', 'list_paths', 'get_lesson', 'get_record', 'get_badges'];

let open: Session[] = [];
afterEach(async () => {
  await Promise.all(open.map((s) => s.client.close()));
  open = [];
});
async function session(era: Era, app: Parameters<typeof connect>[1], path: '/mcp' | '/mcp/practice' = '/mcp', token?: string) {
  const s = await connect(era, app, path, token);
  open.push(s);
  return s;
}

/** A practice client on the practice-custody example, with a fresh handle. */
async function practiceRun(era: Era) {
  const setup = await makeServer('practice');
  const s = await session(era, setup.app);
  const start = await s.call('start_placement');
  return { ...setup, ...s, handle: start.data.handle as string, start };
}

/** An official client (server-kept custody, stub authorization) that has started placement. */
async function officialRun(era: Era, o: Parameters<typeof makeServer>[1] = {}) {
  const setup = await makeServer('server-kept', o);
  const s = await session(era, setup.app, '/mcp', TOKEN);
  const start = await s.call('start_placement');
  return { ...setup, ...s, start };
}

const allStatementsAreValid = (statements: XapiStatement[]) => {
  for (const s of statements) {
    expect(validateStatement(s), s.id).toEqual([]);
    expect(checkProfile(s), s.id).toEqual([]);
  }
  expect(checkCmi5Order(statements)).toEqual([]);
};

describe.each(['legacy', 'modern'] as const)('course server over MCP (%s era)', (era) => {
  it('lists the 16 tools in order with honest annotations', async () => {
    for (const path of ['/mcp', '/mcp/practice'] as const) {
      const { app } = await makeServer('server-kept');
      const { client } = await session(era, app, path, TOKEN);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
      for (const t of tools) {
        expect(t.annotations?.openWorldHint, t.name).toBe(false);
        expect(t.annotations?.readOnlyHint, t.name).toBe(READ_ONLY.includes(t.name));
        if (READ_ONLY.includes(t.name)) expect(t.annotations?.idempotentHint, t.name).toBe(true);
        expect(t.annotations?.destructiveHint, t.name).toBe(t.name === 'delete_practice_record');
        expect(t.outputSchema, t.name).toBeTruthy();
      }
    }
  });

  it('declares com.sqwrlz/course-xapi-mcp with the settings object', async () => {
    const { app, course } = await makeServer('server-kept');
    const official = await session(era, app, '/mcp', TOKEN);
    expect(official.client.getServerCapabilities()?.extensions?.[EXTENSION_ID]).toEqual({
      version: '0.2',
      course: course.id,
      custody: 'server-kept',
      official: true,
      allowPractice: true,
      badges: true,
      rulesVersion: '0.2',
      authoring: 'https://course-xapi-mcp.sqwrlz.com/spec/draft/package/',
    });
    expect(official.client.getServerVersion()?.name).toBe('course-xapi-mcp:json-basics');
    const practice = await session(era, app, '/mcp/practice');
    expect(practice.client.getServerCapabilities()?.extensions?.[EXTENSION_ID]).toMatchObject({ custody: 'practice', official: false, badges: false });
    const own = await makeServer('practice');
    expect((await session(era, own.app)).client.getServerCapabilities()?.extensions?.[EXTENSION_ID]).toMatchObject({ custody: 'practice', official: false, allowPractice: false, badges: false });
  });

  it('works for a client that does not declare the extension', async () => {
    const { call, handle } = await practiceRun(era);
    const status = await call('get_status', { handle });
    expect(status.isError).toBe(false);
    expect(status.data.next_tools).toEqual(['choose_placement']);
    expect(JSON.parse(status.raw.content[0].text)).toEqual(status.data);
    expect((await call('list_paths')).data.paths.map((p: any) => p.key)).toEqual(['json']);
  });

  it('sends rules as instructions, resource, prompt, digest and the tutor skill', async () => {
    const { app, course } = await makeServer('server-kept');
    const { client, call } = await session(era, app, '/mcp', TOKEN);
    const instructions = client.getInstructions()!;
    expect(instructions.startsWith(AGENT_RULES)).toBe(true);
    expect(instructions).toContain(course.rules[0]);
    expect(instructions).toMatch(/get_status/);
    const rules = await client.readResource({ uri: RULES_URI });
    expect((rules.contents[0] as any).text).toContain(`rules ${RULES_VERSION}`);
    const skill = await client.readResource({ uri: URIS.tutorSkill });
    expect(skill.contents[0]).toMatchObject({ mimeType: 'text/markdown', text: tutorSkill(course) });
    const outline = JSON.parse(((await client.readResource({ uri: URIS.course })).contents[0] as any).text);
    expect(outline.paths[0].lessons.map((l: any) => l.key)).toEqual(['what-is-json', 'fix-the-config']);
    expect(JSON.stringify(outline)).not.toContain(course.lessons['fix-the-config']!.bug!.explanation);
    const prompt = await client.getPrompt({ name: 'tutor' });
    expect(JSON.stringify(prompt.messages)).toContain('get_status');
    expect(JSON.stringify(prompt.messages)).toContain('learner_input');
    expect((await call('list_paths')).data.rules).toEqual({ version: RULES_VERSION, digest: expect.any(Array), course: course.rules, full: RULES_URI });
  });

  it('carries rules and cxm on every result, including errors', async () => {
    const { call } = await officialRun(era);
    const results = [
      await call('get_status'),
      await call('list_paths'),
      await call('get_lesson', { lessonKey: 'what-is-json' }),
      await call('get_lesson', { lessonKey: 'nope' }),
      await call('choose_branch', { branch: 'ready', rationale: 'Too early.' }),
      await call('resume_practice', {}),
    ];
    expect(results.map((r) => r.isError)).toEqual([false, false, false, true, true, true]);
    for (const r of results) {
      expect(r.data.rules.version).toBe(RULES_VERSION);
      expect(r.data.cxm).toMatchObject({ custody: 'server-kept', official: true });
      expect(r.data.cxm.label).toBeUndefined();
      expect(JSON.parse(r.raw.content[0].text)).toEqual(r.data);
    }
    expect(results[0]!.data.cxm).toMatchObject({ lesson: 'placement' });
  });

  it('practice: every result has official false and the label; get_badges is refused', async () => {
    const { call, handle, start } = await practiceRun(era);
    expect(handle).toMatch(/^cxp_[A-Za-z0-9_-]{32}$/);
    const results = [start, await call('get_status', { handle }), await call('list_paths'), await call('next_beat', { handle }), await call('get_badges')];
    for (const r of results) expect(r.data.cxm).toMatchObject({ custody: 'practice', official: false, label: PRACTICE_LABEL });
    expect(results[4]!.isError).toBe(true);
    expect(results[4]!.data.error).toMatch(/practice/);
    expect(results[1]!.data).toMatchObject({ custody: 'practice', official: false, holder: 'nobody: practice run' });
  });

  it('official: an unauthenticated call returns 401 with WWW-Authenticate', async () => {
    const { app } = await makeServer('server-kept');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    for (const auth of [undefined, 'Bearer wrong']) {
      const res = await app.mcp(new Request('http://localhost/mcp', { method: 'POST', headers: { ...headers, ...(auth ? { authorization: auth } : {}) }, body }), '/mcp');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp", scope="cxm:learn"`);
    }
    // The practice endpoint needs no authorization.
    const practice = await app.mcp(new Request('http://localhost/mcp/practice', { method: 'POST', headers, body }), '/mcp/practice');
    expect(practice.status).not.toBe(401);
  });

  it('teaches the whole example course; every statement passes validateStatement, checkProfile and checkCmi5Order', async () => {
    const practice = await practiceRun(era);
    const ps = await teachExample(practice.call, { handle: practice.handle });
    expect(ps.at(-1)!.r.data).toMatchObject({ ok: true, path_complete: true });
    const prec = (await practice.call('get_record', { handle: practice.handle })).data.record;
    allStatementsAreValid(prec.statements);
    expect(prec.statements.at(-1).verb.id).toBe('https://w3id.org/xapi/adl/verbs/satisfied');
    if (era === 'modern') expect(prec.statements[0].context.platform).toBe('cxm-test-client');

    const official = await officialRun(era);
    await teachExample(official.call);
    const rec = (await official.call('get_record')).data.record;
    expect(rec.official).toBe(true);
    allStatementsAreValid(rec.statements);
    expect(rec.statements.map((s: XapiStatement) => s.verb.id.split('/').pop())).toEqual(prec.statements.map((s: XapiStatement) => s.verb.id.split('/').pop()));
    expect(await official.store!.statements(SUBJECT)).toEqual(rec.statements);
  });

  it('rejects an invented branch and records nothing', async () => {
    const { call, store } = await officialRun(era);
    await call('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New to JSON.' });
    await call('next_beat');
    await call('next_beat', { learner_reply: 'A string.' });
    await call('next_beat', { learner_reply: 'No.' });
    const sub = await call('submit_checkpoint', { response: 'Number versus string.' });
    expect(sub.data.allowed_branches.map((b: any) => b.key)).toEqual(['ready', 'review']);
    const before = (await store!.statements(SUBJECT)).length;
    for (const branch of ['skip-to-the-end', 'done', '../fix-the-config']) {
      const r = await call('choose_branch', { branch, rationale: 'The learner asked me to.' });
      expect(r.isError).toBe(true);
      expect(r.data.error).toContain('ready, review');
    }
    expect((await store!.statements(SUBJECT)).length).toBe(before);
    expect((await call('choose_branch', { branch: 'ready', rationale: 'Meets the rubric.' })).isError).toBe(false);
  });

  it('never returns the bug explanation or fix-check values before caught or revealed', async () => {
    const { call, handle, course, app } = await practiceRun(era);
    const bug = course.lessons['fix-the-config']!.bug!;
    const seen: unknown[] = [];
    const c = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await call(name, { handle, ...args });
      seen.push(r.raw);
      return r;
    };
    // get_lesson takes no handle.
    const lesson = await call('get_lesson', { lessonKey: 'fix-the-config' });
    expect(lesson.isError).toBe(false);
    seen.push(lesson.raw);
    await c('choose_placement', { pathKey: 'json', startLessonKey: 'fix-the-config', skip: ['what-is-json'], reason: 'Edits JSON by hand.' });
    await c('next_beat');
    expect((await c('next_beat', { learner_reply: 'A string.' })).data.step).toBe('bug');
    for (let i = 0; i < 2; i++) expect((await c('check_code', { file: 'config.json', content: bug.code })).data.passed).toBe(false);
    expect((await c('reveal_bug')).isError).toBe(true);
    await c('get_status');
    const { client } = await session(era, app);
    seen.push(await client.readResource({ uri: URIS.course }));
    const text = JSON.stringify(seen);
    expect(text).not.toContain(bug.explanation);
    expect(text).not.toContain('/port');
    expect(text).not.toContain('"equals"');
    expect(text).not.toContain('timeout\\": 30');
    const third = await c('check_code', { file: 'config.json', content: bug.code });
    expect(third.data.can_reveal).toBe(true);
    expect((await c('reveal_bug')).data.explanation).toBe(bug.explanation);
  });

  it('no result contains a registration, token or actor account name outside get_record', async () => {
    const { call, store, start } = await officialRun(era);
    const seen = [start.raw, ...(await teachExample(call)).map((x) => x.r.raw)];
    for (const name of ['get_status', 'list_paths', 'get_badges', 'end_session']) seen.push((await call(name)).raw);
    const { registration } = (await store!.getState(SUBJECT))!.state;
    const text = JSON.stringify(seen);
    for (const secret of [registration, TOKEN, SUBJECT]) expect(text).not.toContain(secret);
    const record = JSON.stringify((await call('get_record')).raw);
    expect(record).toContain(registration);
    expect(record).toContain(SUBJECT);

    const practice = await practiceRun(era);
    const pseen = [practice.start.raw, ...(await teachExample(practice.call, { handle: practice.handle })).map((x) => x.r.raw)];
    const exported = (await practice.call('get_record', { handle: practice.handle })).data.record.statements as XapiStatement[];
    const ptext = JSON.stringify(pseen);
    expect(ptext).not.toContain(exported[0]!.context.registration!);
    expect(ptext).not.toContain((exported[0]!.actor as any).account.name);
    expect(JSON.stringify(exported)).not.toContain(practice.handle);
  });

  it('two parallel next_beat calls for one learner produce one advance and no duplicate statements', async () => {
    // A slow record store, so the two calls overlap.
    const slow = (c: Custody): Custody => ({ ...c, load: async (l) => (await new Promise((r) => setTimeout(r, 20)), c.load(l)) });
    const { call, store } = await officialRun(era, { wrap: slow });
    await call('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New to JSON.' });
    const rs = await Promise.all([call('next_beat'), call('next_beat')]);
    expect(rs.filter((r) => !r.isError)).toHaveLength(1);
    expect(rs.filter((r) => r.isError).map((r) => r.data.error)).toEqual([RETRY]);
    const statements = await store!.statements(SUBJECT);
    expect(new Set(statements.map((s) => s.id)).size).toBe(statements.length);
    expect(statements.filter((s) => s.verb.id.endsWith('/experienced'))).toHaveLength(1);
    expect((await call('get_status')).data.position).toMatchObject({ lessonKey: 'what-is-json', phase: 'beats' });
  });

  it('a deliver failure returns delivery pending and the next call redelivers the outbox once', async () => {
    let failures = 0;
    const delivered: string[] = [];
    const flaky = (c: Custody): Custody => ({
      ...c,
      deliver: async (l, statements) => {
        if (failures > 0) {
          failures--;
          throw new StoreError('the record holder did not answer');
        }
        delivered.push(...statements.map((s) => s.id));
        return c.deliver(l, statements);
      },
    });
    const { call, store } = await officialRun(era, { wrap: flaky });
    failures = 1;
    const placed = await call('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New to JSON.' });
    expect(placed.isError).toBe(false);
    expect(placed.data.delivery).toBe('pending');
    const pending = (await store!.getState(SUBJECT))!.state.outbox.map((s) => s.id);
    expect(pending.length).toBeGreaterThan(0);
    expect((await store!.statements(SUBJECT)).map((s) => s.id)).not.toContain(pending[0]);

    // The holder is still down: the redelivery fails, and nothing else changes.
    failures = 1;
    const before = await store!.getState(SUBJECT);
    const down = await call('next_beat');
    expect(down).toMatchObject({ isError: true, data: { error: HOLDER_DOWN } });
    expect(await store!.getState(SUBJECT)).toEqual(before);

    const beat = await call('next_beat');
    expect(beat.isError).toBe(false);
    expect(beat.data.delivery).toBe('delivered');
    await call('next_beat', { learner_reply: 'A string.' });
    const stored = (await store!.statements(SUBJECT)).map((s) => s.id);
    for (const id of pending) {
      expect(delivered.filter((x) => x === id)).toHaveLength(1);
      expect(stored.filter((x) => x === id)).toHaveLength(1);
    }
    expect(new Set(delivered).size).toBe(delivered.length);
    expect((await store!.getState(SUBJECT))!.state.outbox).toEqual([]);
  });

  it('a redelivery that races another process answers the retry message and keeps the other advance', async () => {
    let failures = 0;
    let other: (() => Promise<void>) | undefined;
    const racing = (c: Custody): Custody => ({
      ...c,
      deliver: async (l, statements) => {
        if (failures > 0) {
          failures--;
          throw new StoreError('the record holder did not answer');
        }
        await c.deliver(l, statements);
        // Another server process advances the learner while this call is redelivering.
        if (other) await other().finally(() => (other = undefined));
      },
    });
    const { call, store } = await officialRun(era, { wrap: racing });
    failures = 1;
    expect((await call('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New to JSON.' })).data.delivery).toBe('pending');
    let advanced: unknown;
    other = async () => {
      const got = (await store!.getState(SUBJECT))!;
      const next = { ...got.state, outbox: [], updatedAt: new Date(Date.parse(got.state.updatedAt) + 5000).toISOString(), cursor: { ...got.state.cursor!, beat: 1, awaitingReply: true } };
      await store!.putState(SUBJECT, next, got.etag);
      advanced = next;
    };
    const r = await call('next_beat');
    expect(r).toMatchObject({ isError: true, data: { error: RETRY } });
    expect((await store!.getState(SUBJECT))!.state).toEqual(advanced);
  });

  it('practice: a deliver failure returns delivery pending; the next call redelivers once and clears the outbox', async () => {
    let failures = 0;
    const flaky = (c: PracticeCustody): PracticeCustody => ({
      ...c,
      deliver: async (l, statements) => {
        if (failures > 0) {
          failures--;
          throw new StoreError('the relay did not answer');
        }
        return c.deliver(l, statements);
      },
    });
    const setup = await makeServer('practice', { wrapPractice: flaky });
    const { call } = await session(era, setup.app);
    const handle = (await call('start_placement')).data.handle;
    const copy = async () => (await setup.practice.exportCopy(handle))!;
    expect((await copy()).state.outbox).toEqual([]);
    failures = 1;
    const placed = await call('choose_placement', { handle, pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New to JSON.' });
    expect(placed.data.delivery).toBe('pending');
    const pending = (await copy()).state.outbox.map((s) => s.id);
    expect(pending.length).toBeGreaterThan(0);
    const beat = await call('next_beat', { handle });
    expect(beat).toMatchObject({ isError: false, data: { delivery: 'delivered' } });
    const after = await copy();
    expect(after.state.outbox).toEqual([]);
    const ids = after.statements.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of pending) expect(ids).toContain(id);
    // A failing step after a redelivery is an engine error, not a spurious conflict.
    failures = 0;
    expect((await call('choose_branch', { handle, branch: 'ready', rationale: 'Too early.' })).data.error).toMatch(/submit_checkpoint/);
  });

  it('an unexpected failure is a tool error with rules and cxm that never shows the inner message', async () => {
    const broken = (c: Custody): Custody => ({ ...c, links: () => { throw new Error('secret detail'); } });
    const { call } = await officialRun(era, { wrap: broken });
    const r = await call('get_status');
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ ok: false, cxm: { custody: 'server-kept', official: true }, rules: { version: RULES_VERSION } });
    expect(JSON.stringify(r.raw)).not.toContain('secret detail');
  });

  it('get_status gives an official learner the deletion link as deleteLink, and the record link in links', async () => {
    const withLinks = (c: Custody): Custody => ({ ...c, links: () => ({ holder: 'Some LMS', delete: 'https://holder.example/delete', record: 'https://holder.example/record' }) });
    const { call } = await officialRun(era, { wrap: withLinks });
    const { data } = await call('get_status');
    expect(data).toMatchObject({ deleteLink: 'https://holder.example/delete', links: { delete: 'https://holder.example/delete', record: 'https://holder.example/record' } });
    expect(data.deleteNote).toBeUndefined();
  });

  it('get_status with no deletion link says so: deleteLink null and a note naming the record holder', async () => {
    const noLinks = (c: Custody): Custody => ({ ...c, links: () => ({ holder: 'Some LMS', record: 'https://holder.example/record' }) });
    const { call } = await officialRun(era, { wrap: noLinks });
    const { data } = await call('get_status');
    expect(data.deleteLink).toBeNull();
    expect(data.deleteNote).toMatch(/ask Some LMS to delete their record/);
    expect(data.links.record).toBe('https://holder.example/record');
  });

  it('get_status on the practice endpoint has no deleteLink or deleteNote', async () => {
    const { call, handle } = await practiceRun(era);
    const { data } = await call('get_status', { handle });
    expect(data).not.toHaveProperty('deleteLink');
    expect(data).not.toHaveProperty('deleteNote');
  });

  it('the get_status output schema describes deleteLink (a URI string or null) and deleteNote', () => {
    const props = (toolOutputJsonSchema('get_status') as { properties: Record<string, unknown>; additionalProperties: unknown }).properties;
    expect(props.deleteLink).toEqual({ type: ['string', 'null'], format: 'uri' });
    expect(props.deleteNote).toEqual({ type: 'string' });
    expect((toolOutputJsonSchema('get_status') as { additionalProperties: unknown }).additionalProperties).toBe(true);
    expect(JSON.parse(readFileSync(new URL('../../../../schema/draft/tools/get_status.output.schema.json', import.meta.url), 'utf8')).properties.deleteLink).toEqual(props.deleteLink);
  });

  it('resume_practice refuses an official export and a learning-mcp record', async () => {
    const { app, course } = await makeServer('server-kept');
    const official = await session(era, app, '/mcp', TOKEN);
    await official.call('start_placement');
    const officialExport = (await official.call('get_record')).data.record;
    const practice = await session(era, app, '/mcp/practice');
    for (const record of [officialExport, { format: 'learning-mcp/record', version: 1, statements: [] }]) {
      const r = await practice.call('resume_practice', { record: JSON.stringify(record) });
      expect(r.isError).toBe(true);
      expect(r.data.error).toBe('this is not a course-xapi-mcp practice copy');
    }
    expect((await practice.call('resume_practice', { record: '{not json' })).isError).toBe(true);
    expect((await official.call('resume_practice', {})).data.error).toMatch(/practice endpoint/);

    // A practice copy continues under a new handle, still as practice.
    const handle = (await practice.call('start_placement')).data.handle;
    await practice.call('choose_placement', { handle, pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New.' });
    const got = await practice.call('get_record', { handle });
    const resource = got.raw.content.find((c: any) => c.type === 'resource').resource;
    expect(resource.uri).toBe(URIS.recordExport);
    const resumed = await practice.call('resume_practice', { record: resource.text });
    expect(resumed.data).toMatchObject({ ok: true, placed: true });
    expect(resumed.data.handle).not.toBe(handle);
    const next = await practice.call('next_beat', { handle: resumed.data.handle });
    expect(next.data).toMatchObject({ step: 'beat', lesson: { key: 'what-is-json' } });
    expect((await practice.call('delete_practice_record', { handle })).data.deleted).toBe(true);
    expect((await practice.call('next_beat', { handle })).isError).toBe(true);
    expect(course.allowPractice).toBe(true);
  });

  it('a returning learner on another client resumes the same registration', async () => {
    const { call, app, store } = await officialRun(era);
    await call('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New to JSON.' });
    await call('next_beat');
    const other = await session(era === 'legacy' ? 'modern' : 'legacy', app, '/mcp', TOKEN);
    expect((await other.call('get_status')).data.position).toEqual({ pathKey: 'json', lessonKey: 'what-is-json', phase: 'beats' });
    expect((await other.call('next_beat', { learner_reply: '"42" is a string.' })).data.position).toEqual({ beat: 2, of: 2 });
    const regs = new Set((await store!.statements(SUBJECT)).map((s) => s.context.registration));
    expect(regs.size).toBe(1);
  });

  it('rejects oversized input at the schema', async () => {
    const { call, store } = await officialRun(era);
    await call('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New to JSON.' });
    const before = (await store!.statements(SUBJECT)).length;
    for (const [name, args] of [
      ['next_beat', { learner_reply: 'x'.repeat(LIMITS.text + 1) }],
      ['check_code', { file: 'config.json', content: 'x'.repeat(LIMITS.file + 1) }],
      ['choose_branch', { branch: 'ready', rationale: 'x'.repeat(LIMITS.rationale + 1) }],
      ['get_lesson', { lessonKey: 'x'.repeat(65) }],
      ['submit_checkpoint', { response: 'x', files: Object.fromEntries(Array.from({ length: LIMITS.files + 1 }, (_, i) => [`f${i}.json`, '{}'])) }],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.data.error, name).toMatch(/validation/i);
      // The SDK's own validation error still carries the rules and the cxm block.
      expect(r.data.rules.version, name).toBe(RULES_VERSION);
      expect(r.data.cxm, name).toMatchObject({ custody: 'server-kept', official: true });
      expect(JSON.parse(r.raw.content[0].text)).toEqual(r.data);
    }
    expect((await store!.statements(SUBJECT)).length).toBe(before);
  });

  it('tool schemas in schema/draft/tools match the server (run npm run schemas)', async () => {
    const file = (name: string) => JSON.parse(readFileSync(new URL(`../../../../schema/draft/tools/${name}`, import.meta.url), 'utf8'));
    const { app } = await makeServer('server-kept');
    for (const [path, kind] of [['/mcp', 'official'], ['/mcp/practice', 'practice']] as const) {
      const { client } = await session(era, app, path, TOKEN);
      for (const t of (await client.listTools()).tools) {
        const dir = kind === 'practice' ? 'practice/' : '';
        expect(t.inputSchema, `${kind} ${t.name}`).toEqual(file(`${dir}${t.name}.input.schema.json`));
        expect(toolInputJsonSchema(t.name as never, kind)).toEqual(file(`${dir}${t.name}.input.schema.json`));
        expect(t.outputSchema, t.name).toEqual(file(`${t.name}.output.schema.json`));
        expect(toolOutputJsonSchema(t.name as never)).toEqual(file(`${t.name}.output.schema.json`));
      }
    }
    // Only the practice endpoint's resume_practice takes a record.
    expect(JSON.stringify(file('resume_practice.input.schema.json'))).not.toContain('"record"');
    expect(file('practice/resume_practice.input.schema.json').properties.record.maxLength).toBe(4_000_000);
  });
});

describe('course server construction', () => {
  it('[CXM-PKG-034] the server refuses a distribution package', async () => {
    const { app: _ignored, practice, course } = await makeServer('practice');
    expect(() => createCourseServer({ course: { ...course, flavour: 'distribution' }, custody: practice, publicUrl: PUBLIC_URL })).toThrow(/CXM-PKG-034/);
  });

  it('serves /mcp/practice only when the course allows practice', async () => {
    const own = await makeServer('practice');
    expect((await own.app.mcp(new Request('http://localhost/mcp/practice', { method: 'POST', body: '{}' }), '/mcp/practice')).status).toBe(404);
  });
});

describe('option 1: lessons launched from the LMS', () => {
  const LRS_URL = 'http://127.0.0.1:9/xapi';
  async function setup() {
    const course = { ...(await loadExample()), custody: 'lms-launched' as const, allowPractice: false };
    const lrs = createTestLrs();
    const f = ((input: RequestInfo | URL, init?: RequestInit) => lrs.fetch(new Request(input, init))) as typeof fetch;
    const auOf = (key: string) => (key === 'placement' ? course.placement : course.lessons[key]!);
    const sim = createLmsSim({
      lrs,
      lrsUrl: LRS_URL,
      courseId: course.id,
      aus: ['placement', 'what-is-json', 'fix-the-config'].map((k) => ({ auId: auOf(k).auId, url: auOf(k).url, moveOn: k === 'placement' ? ('NotApplicable' as const) : ('CompletedAndPassed' as const) })),
    });
    const launches = new MemoryLaunchStore();
    // Wall-clock time a second ahead of the simulator's own stamps, so statements stay ordered however slow the run.
    let offset = 1000;
    const ms = () => Date.now() + offset;
    const clock = { ms, iso: () => new Date(ms()).toISOString(), advance: (by: number) => (offset += by) };
    const bridge = createBridge({ course, mcpUrl: PUBLIC_URL + '/mcp', launches, now: clock.ms, fetch: f, lock: (c, fn) => withLearnerLock(launchSubject(c), fn) });
    const custody = createLmsLaunchedCustody({ course, launches, fetch: f });
    // The token is the launch id; a real authorization server pairs it (Task 17).
    const authenticate = async (req: Request): Promise<LearnerRef | Response> => {
      const id = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
      const c = id ? await launches.get(id) : undefined;
      if (!c) return new Response('{}', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
      return { kind: 'official', subject: launchSubject(c), actor: c.actor, launchId: c.launchId };
    };
    let delay = 0;
    const slow: typeof custody = { ...custody, load: async (l) => (delay && (await new Promise((r) => setTimeout(r, delay))), custody.load(l)) };
    const app = createCourseServer({ course, custody: slow, authenticate, publicUrl: PUBLIC_URL, now: clock.iso });
    const launch = async (key: string, o: { returnURL?: string; registration?: string } = {}) => {
      const l = await sim.launch(auOf(key).auId, { returnURL: 'https://lms.example/course', ...o });
      const res = (await bridge.fetch(new Request(l.launchUrl)))!;
      expect(res.status).toBe(200);
      return { ...l, launchId: /cxm_launch=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]! };
    };
    return { course, lrs, sim, bridge, launches, app, launch, clock, setDelay: (ms: number) => (delay = ms) };
  }

  it('sends the learner back to the LMS for the next lesson; statements land in the LMS in cmi5 order', async () => {
    const { app, launch, sim, lrs, launches } = await setup();
    const placement = await launch('placement');
    const seen: unknown[] = [];
    const watch = (s: Session): Session => ({ ...s, call: async (n, a) => { const r = await s.call(n, a); seen.push(r.raw); return r; } });
    const p = watch(await session('modern', app, '/mcp', placement.launchId));
    expect((await p.call('get_status')).data).toMatchObject({ custody: 'lms-launched', official: true, holder: 'your LMS' });
    await p.call('start_placement');
    const placed = await p.call('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New to JSON.' });
    expect(placed.data).toMatchObject({ ok: true, next: { type: 'return-to-lms', lessonKey: 'what-is-json' }, returnURL: 'https://lms.example/course' });
    expect((await p.call('restart_course')).data.error).toMatch(/LMS/);

    const lesson = await launch('what-is-json', { registration: placement.registration });
    const s = watch(await session('modern', app, '/mcp', lesson.launchId));
    expect((await s.call('next_beat')).data.step).toBe('beat');
    await s.call('get_status');
    await s.call('end_session');
    expect(sim.problems()).toEqual([]);
    expect(lrs.statements().every((st) => st.context.registration === placement.registration)).toBe(true);
    // No registration, LMS token, LMS endpoint or LMS actor account name in any result.
    const text = JSON.stringify(seen);
    const c = (await launches.get(lesson.launchId))!;
    for (const secret of [placement.registration, c.authToken, LRS_URL, (c.actor as any).account.name]) expect(text).not.toContain(secret);
  });

  it('a relaunch makes the older window answer "relaunched elsewhere"; an ended launch answers return-to-lms', async () => {
    const { app, launch, bridge, lrs } = await setup();
    const first = await launch('placement');
    const a = await session('modern', app, '/mcp', first.launchId);
    await a.call('start_placement');
    const second = await launch('placement', { registration: first.registration });
    const stale = await a.call('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New.' });
    expect(stale.data.error).toBe('this lesson was relaunched elsewhere; continue in the newest window or launch it again from your LMS');
    expect(stale.data.cxm).toMatchObject({ custody: 'lms-launched' });

    const b = await session('modern', app, '/mcp', second.launchId);
    await bridge.terminate(second.launchId);
    const count = lrs.statements().length;
    const ended = await b.call('start_placement');
    expect(ended.data).toMatchObject({ ok: true, step: 'return-to-lms', next: { type: 'return-to-lms' }, returnURL: 'https://lms.example/course' });
    expect(lrs.statements().length).toBe(count);
  });

  it('the sweeper waits for a tool call in flight and does not end a session that call keeps active', async () => {
    const { app, launch, bridge, lrs, clock, setDelay, sim } = await setup();
    const l = await launch('placement');
    const s = await session('modern', app, '/mcp', l.launchId);
    await s.call('start_placement');
    clock.advance(31 * 60_000);
    setDelay(30);
    const call = s.call('choose_placement', { pathKey: 'json', startLessonKey: 'what-is-json', skip: [], reason: 'New.' });
    await new Promise((r) => setTimeout(r, 10));
    const swept = await bridge.sweep();
    const r = await call;
    // The call ran first and ended the placement session itself; the sweeper then found nothing to end.
    expect(r.data).toMatchObject({ ok: true, delivery: 'delivered' });
    expect(swept).toBe(0);
    expect(lrs.statements().filter((st) => st.verb.id.endsWith('/terminated'))).toHaveLength(1);
    expect(sim.problems()).toEqual([]);
  });
});

describe('option 2: the author\'s LRS', () => {
  it('keeps the record under the actor author-lrs assigns, and no result leaks it, the registration or the LRS credentials', async () => {
    const course = await loadExample();
    const credentials = { key: 'lrs-key-7Qe2', secret: 'lrs-secret-Zk91' };
    const lrs = createTestLrs({ credentials: [credentials] });
    const f = ((input: RequestInfo | URL, init?: RequestInit) => lrs.fetch(new Request(input, init))) as typeof fetch;
    const assignActor = async (subject: string) => ({ objectType: 'Agent' as const, account: { homePage: course.id, name: `mapped-${subject}` } });
    const custody = createAuthorLrsCustody({ course, lrs: { endpoint: 'http://lrs.test/xapi', ...credentials }, publicUrl: PUBLIC_URL, assignActor, fetch: f });
    const app = createCourseServer({ course, custody, practice: createPracticeCustody({ courseId: course.id }), authenticate: stubAuthenticate(course), publicUrl: PUBLIC_URL });
    const s = await session('modern', app, '/mcp', TOKEN);
    const seen: unknown[] = [(await s.call('get_status')).raw, (await s.call('start_placement')).raw, ...(await teachExample(s.call)).map((x) => x.r.raw), (await s.call('get_status')).raw];

    const statements = lrs.statements();
    expect(statements.length).toBeGreaterThan(10);
    for (const st of statements) expect(st.actor).toEqual(await assignActor(SUBJECT));
    allStatementsAreValid(statements);
    const record = (await s.call('get_record')).data.record;
    expect(record.statements.map((st: XapiStatement) => st.id).sort()).toEqual(statements.map((st) => st.id).sort());

    const text = JSON.stringify(seen);
    for (const secret of [statements[0]!.context.registration!, SUBJECT, `mapped-${SUBJECT}`, credentials.key, credentials.secret, 'lrs.test']) expect(text).not.toContain(secret);
  });

  it('an LRS that names its credential in the authority (as many do) never shows it to the agent: get_record and the export leave authority and stored out', async () => {
    const course = await loadExample();
    const credentials = { key: 'lrs-key-Auth7', secret: 'lrs-secret-Auth7' };
    const lrs = createTestLrs({ credentials: [credentials] });
    // Like an LRS that sets the authority to the Basic credential's key and the client's mbox, and stamps `stored`.
    const authority = { objectType: 'Agent', account: { homePage: 'https://lrs.test', name: credentials.key }, mbox: 'mailto:lrs-client-Auth7@lrs.test' };
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await lrs.fetch(new Request(input, init));
      const u = new URL(new Request(input, init).url);
      if ((init?.method ?? 'GET') !== 'GET' || !u.pathname.endsWith('/statements') || !res.ok) return res;
      const body = (await res.json()) as { statements: XapiStatement[] };
      body.statements = body.statements.map((s) => ({ ...s, authority, stored: '2026-10-27T00:00:00.000Z' }));
      return Response.json(body, { headers: res.headers });
    }) as typeof fetch;
    const assignActor = async (subject: string) => ({ objectType: 'Agent' as const, account: { homePage: course.id, name: `mapped-${subject}` } });
    const custody = createAuthorLrsCustody({ course, lrs: { endpoint: 'http://lrs.test/xapi', ...credentials }, publicUrl: PUBLIC_URL, assignActor, fetch: f });
    const app = createCourseServer({ course, custody, practice: createPracticeCustody({ courseId: course.id }), authenticate: stubAuthenticate(course), publicUrl: PUBLIC_URL });
    const s = await session('modern', app, '/mcp', TOKEN);
    await s.call('start_placement');
    await teachExample(s.call);
    // The custody itself still sees who wrote what (badges need it).
    expect((await custody.record({ kind: 'official', subject: SUBJECT, actor: await assignActor(SUBJECT) })).statements[0]).toHaveProperty('authority');

    const record = await s.call('get_record');
    expect(record.isError).toBe(false);
    expect(record.data.record.statements.length).toBeGreaterThan(10);
    const exported = await s.client.readResource({ uri: URIS.recordExport });
    for (const shown of [JSON.stringify(record.raw), JSON.stringify(exported)]) {
      for (const leak of [credentials.key, 'lrs-client-Auth7', '"authority"', '"stored"']) expect(shown).not.toContain(leak);
    }
  });
});
