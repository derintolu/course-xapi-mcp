// SPDX-License-Identifier: Apache-2.0
import { StoreConflictError, StoreError, type XapiAgent, type XapiStatement } from '@course-xapi-mcp/core';

export type XapiVersion = '1.0.3' | '2.0.0';

export type LrsAuth = { type: 'basic'; key: string; secret: string } | { type: 'token'; value: string };

export interface StateKey {
  activityId: string;
  agent: XapiAgent;
  registration?: string;
  stateId: string;
}

export interface StatementQuery {
  agent?: XapiAgent;
  verb?: string;
  activity?: string;
  registration?: string;
  since?: string;
  limit?: number;
}

export interface LrsClient {
  version(): Promise<XapiVersion>;
  putStatement(s: XapiStatement): Promise<void>;
  postStatements(list: XapiStatement[]): Promise<void>;
  getStatements(q: StatementQuery): Promise<XapiStatement[]>;
  getState(k: StateKey): Promise<{ body: unknown; etag?: string } | undefined>;
  putState(k: StateKey, body: unknown, cond?: { ifMatch?: string; ifNoneMatch?: '*' }): Promise<{ etag?: string }>;
  getAgentProfile(agent: XapiAgent, profileId: string): Promise<unknown | undefined>;
}

/** An LRS call failed. status 0 means no HTTP response arrived. The message never includes credentials. */
export class LrsError extends StoreError {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LrsError';
    this.status = status;
  }
}

const UNREACHABLE = 'the record holder is not responding; try again shortly';

export function createLrsClient(o: {
  endpoint: string;
  auth: LrsAuth;
  version?: XapiVersion | 'auto';
  fetch?: typeof fetch;
  timeoutMs?: number;
}): LrsClient {
  const base = o.endpoint.endsWith('/') ? o.endpoint : `${o.endpoint}/`;
  const baseUrl = new URL(base);
  const timeoutMs = o.timeoutMs ?? 10000;
  const wanted = o.version ?? 'auto';
  const authorization =
    o.auth.type === 'basic'
      ? `Basic ${Buffer.from(`${o.auth.key}:${o.auth.secret}`).toString('base64')}`
      : `Basic ${o.auth.value}`;

  let resolved: Promise<XapiVersion> | undefined = wanted === 'auto' ? undefined : Promise.resolve(wanted);

  async function send(url: string, init: { method: string; headers?: Record<string, string>; body?: string }, ver: string): Promise<Response> {
    const f = o.fetch ?? fetch;
    try {
      return await f(url, {
        method: init.method,
        headers: { 'X-Experience-API-Version': ver, Authorization: authorization, ...init.headers },
        body: init.body,
        // Never follow a redirect: it would carry the credential to wherever it points.
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new LrsError(0, UNREACHABLE);
    }
  }

  function fail(res: Response): LrsError {
    return new LrsError(res.status, `the record holder rejected the request (HTTP ${res.status})`);
  }

  async function readJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new LrsError(res.status, 'the record holder sent a reply that could not be read');
    }
  }

  function version(): Promise<XapiVersion> {
    resolved ??= (async () => {
      const res = await send(new URL('about', baseUrl).href, { method: 'GET' }, '1.0.3');
      if (!res.ok) throw fail(res);
      const j = (await readJson(res)) as { version?: unknown };
      return Array.isArray(j.version) && j.version.includes('2.0.0') ? '2.0.0' : '1.0.3';
    })();
    // A failed negotiation is retried on the next call.
    resolved.catch(() => {
      if (wanted === 'auto') resolved = undefined;
    });
    return resolved;
  }

  async function call(path: string, params: Record<string, string | undefined>, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
    const ver = await version();
    const u = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return send(u.href, init, ver);
  }

  const putStatement = async (s: XapiStatement): Promise<void> => {
    const res = await call('statements', { statementId: s.id }, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    });
    // 409: the LRS already holds this id.
    if (res.status === 204 || res.status === 409 || res.ok) return;
    throw fail(res);
  };

  const stateParams = (k: StateKey) => ({
    activityId: k.activityId,
    agent: JSON.stringify(k.agent),
    registration: k.registration,
    stateId: k.stateId,
  });

  return {
    version,
    putStatement,
    async postStatements(list) {
      if (list.length === 0) return;
      const res = await call('statements', {}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(list),
      });
      if (res.ok) return;
      if (res.status === 409) {
        for (const s of list) await putStatement(s);
        return;
      }
      throw fail(res);
    },
    async getStatements(q) {
      const out: XapiStatement[] = [];
      let res = await call('statements', {
        agent: q.agent && JSON.stringify(q.agent),
        verb: q.verb,
        activity: q.activity,
        registration: q.registration,
        since: q.since,
        limit: q.limit === undefined ? undefined : String(q.limit),
      }, { method: 'GET' });
      const ver = await version();
      for (let page = 0; ; page++) {
        if (!res.ok) throw fail(res);
        const j = (await readJson(res)) as { statements?: XapiStatement[]; more?: string };
        out.push(...(j.statements ?? []));
        if (!j.more) return out;
        const next = new URL(j.more, baseUrl);
        // Never send credentials to a host other than the configured LRS.
        if (next.origin !== baseUrl.origin || page >= 1000) throw new LrsError(res.status, 'the record holder sent an unusable paging link');
        res = await send(next.href, { method: 'GET' }, ver);
      }
    },
    async getState(k) {
      const res = await call('activities/state', stateParams(k), { method: 'GET' });
      if (res.status === 404) return undefined;
      if (!res.ok) throw fail(res);
      const etag = res.headers.get('ETag') ?? undefined;
      const body = await readJson(res);
      return etag === undefined ? { body } : { body, etag };
    },
    async putState(k, body, cond) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cond?.ifMatch !== undefined) headers['If-Match'] = cond.ifMatch;
      if (cond?.ifNoneMatch !== undefined) headers['If-None-Match'] = cond.ifNoneMatch;
      const res = await call('activities/state', stateParams(k), { method: 'PUT', headers, body: JSON.stringify(body) });
      if (res.status === 412) throw new StoreConflictError();
      if (!res.ok) throw fail(res);
      const etag = res.headers.get('ETag') ?? undefined;
      return etag === undefined ? {} : { etag };
    },
    async getAgentProfile(agent, profileId) {
      const res = await call('agents/profile', { agent: JSON.stringify(agent), profileId }, { method: 'GET' });
      if (res.status === 404) return undefined;
      if (!res.ok) throw fail(res);
      return readJson(res);
    },
  };
}
