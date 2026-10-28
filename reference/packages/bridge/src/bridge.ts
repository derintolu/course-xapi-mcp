// SPDX-License-Identifier: Apache-2.0
// The cmi5 launch bridge (custody option 1): takes the LMS launch, fetches the token server-side, sends `initialized`,
// hands the learner on to their agent, and ends sessions with `terminated` before the token is likely to expire.
import { randomUUID } from 'node:crypto';
import {
  actorKey,
  ADL_VERBS,
  CMI5,
  DEFAULTS,
  SPEC_VERSION,
  StoreError,
  type ContextTemplate,
  type CourseModel,
  type LaunchContext,
  type LaunchStore,
  type XapiAgent,
  type XapiStatement,
} from '@course-xapi-mcp/core';
import { buildDefined, isoDuration, type Cmi5Context } from '@course-xapi-mcp/core/xapi';
import { Cmi5FetchError, createLrsClient, fetchAuthToken, LrsError, type LrsClient } from '@course-xapi-mcp/lrs-client';
import { errorPage, launchPage, PAGE_CSP } from './page.ts';
import { newPairingCode } from './pairing.ts';

export interface BridgeOptions {
  course: CourseModel;
  /** The course's MCP URL, shown to the learner. */
  mcpUrl: string;
  launches: LaunchStore;
  /** Milliseconds since the epoch. Default `Date.now`. */
  now?: () => number;
  uuid?: () => string;
  /** Used for the cmi5 fetch URL and the LMS's LRS. */
  fetch?: typeof fetch;
  /**
   * Runs `fn` while no tool call for this launch's learner is in flight (the course server's per-learner lock).
   * `sweep` checks and terminates a launch inside it, so it never sends `terminated` while a call is still writing
   * to the session. Default: no lock.
   */
  lock?: <T>(c: LaunchContext, fn: () => Promise<T>) => Promise<T>;
  /**
   * Called with the statements the bridge itself sent for a launch (`initialized` at launch, `terminated` when it ends a
   * session), after the record holder took them, so the custody can list them in the receipt. A failure at launch is
   * ignored; one at termination fails that attempt, and the next sweep resends the same `terminated` and reports again.
   */
  onSent?: (c: LaunchContext, statements: XapiStatement[]) => Promise<void>;
}

export interface Bridge {
  /** Handles `GET /cmi5/launch`; any other path answers undefined. */
  fetch(req: Request): Promise<Response | undefined>;
  /** Terminates live launches that are idle or near the token cap; returns how many it terminated. */
  sweep(): Promise<number>;
  /** Sends `terminated` for a live launch, or resends one not yet confirmed. No-op when it already ended or was superseded. Throws when sending fails; the launch stays ended. */
  terminate(launchId: string): Promise<void>;
}

export const LAUNCH_PATH = '/cmi5/launch';
export const LAUNCH_COOKIE = 'cxm_launch';
/** Cookie lifetime in seconds: as long as a pairing code. */
const COOKIE_MAX_AGE = DEFAULTS.pairingTtlMs / 1000;

const LAUNCH_MODES = ['Normal', 'Browse', 'Review'] as const;
const MOVE_ONS = ['Passed', 'Completed', 'CompletedAndPassed', 'CompletedOrPassed', 'NotApplicable'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isLoopback = (hostname: string) =>
  hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || hostname === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(hostname);

class LaunchRefused extends Error {
  readonly status: number;
  readonly heading: string;
  readonly detail?: string;
  constructor(status: number, heading: string, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.heading = heading;
    this.detail = detail;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * https, or http on a loopback host (local development and tests). Loopback hosts are accepted only when the bridge itself
 * runs on loopback, so a launch link cannot make a public bridge probe its own machine.
 */
function safeUrl(raw: string | null, bridgeOnLoopback: boolean): URL | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.username || u.password) return undefined;
  if (isLoopback(u.hostname)) return bridgeOnLoopback && (u.protocol === 'https:' || u.protocol === 'http:') ? u : undefined;
  return u.protocol === 'https:' ? u : undefined;
}

function parseActor(raw: string | null): XapiAgent | undefined {
  if (!raw) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(v)) return undefined;
  if (v.objectType !== undefined && v.objectType !== 'Agent') return undefined;
  if (v.account !== undefined) {
    const a = v.account;
    if (!isRecord(a) || typeof a.homePage !== 'string' || typeof a.name !== 'string' || !a.name) return undefined;
    try {
      new URL(a.homePage);
    } catch {
      return undefined;
    }
  }
  for (const k of ['mbox', 'mbox_sha1sum', 'openid', 'name'] as const) if (v[k] !== undefined && typeof v[k] !== 'string') return undefined;
  const agent = v as XapiAgent;
  try {
    actorKey(agent);
  } catch {
    return undefined;
  }
  return agent;
}

const bad = (message: string) => new LaunchRefused(400, 'This launch link is not valid', message, 'Go back to your learning platform and launch the lesson again.');

function refusedByRecordHolder(err: unknown): LaunchRefused {
  if (err instanceof Cmi5FetchError) {
    const why =
      err.code === '1'
        ? 'This launch link has already been used.'
        : err.code === '2'
          ? 'Your learning platform did not recognise this launch.'
          : 'Your learning platform refused this launch.';
    return new LaunchRefused(403, 'This lesson could not start', `${why} Go back to your learning platform and launch the lesson again.`, err.message);
  }
  if (err instanceof LaunchRefused) return err;
  const detail = err instanceof LrsError ? err.message : undefined;
  return new LaunchRefused(502, 'This lesson could not start', 'Your learning platform did not answer as expected. Try launching the lesson again in a minute.', detail);
}

/** Reads `LMS.LaunchData` (cmi5 §10.2) and checks it belongs to this AU. */
function parseLaunchData(body: unknown, auId: string): Pick<LaunchContext, 'contextTemplate' | 'launchMode' | 'moveOn' | 'returnURL' | 'sessionId'> {
  const notValid = (why: string) => new LaunchRefused(502, 'This lesson could not start', 'Your learning platform sent launch data this course cannot use.', why);
  if (!isRecord(body)) throw notValid('LMS.LaunchData is missing');
  const t = body.contextTemplate;
  if (!isRecord(t)) throw notValid('LMS.LaunchData has no contextTemplate');
  const sessionId = isRecord(t.extensions) ? t.extensions[CMI5.extSessionId] : undefined;
  if (typeof sessionId !== 'string' || !sessionId) throw notValid('the contextTemplate has no session id');
  const grouping = isRecord(t.contextActivities) ? t.contextActivities.grouping : undefined;
  if (!Array.isArray(grouping) || !grouping.some((a) => isRecord(a) && a.id === auId)) {
    throw notValid('the contextTemplate grouping does not name this lesson');
  }
  const launchMode = body.launchMode;
  if (!LAUNCH_MODES.includes(launchMode as never)) throw notValid('LMS.LaunchData has no valid launchMode');
  const moveOn = body.moveOn;
  if (!MOVE_ONS.includes(moveOn as never)) throw notValid('LMS.LaunchData has no valid moveOn');
  const out: ReturnType<typeof parseLaunchData> = {
    contextTemplate: t as ContextTemplate,
    launchMode: launchMode as LaunchContext['launchMode'],
    moveOn: moveOn as LaunchContext['moveOn'],
    sessionId,
  };
  if (typeof body.returnURL === 'string') out.returnURL = body.returnURL;
  return out;
}

const html = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': PAGE_CSP,
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });

/**
 * The authority on the first `launched` the LRS stored for this session: the LMS's, because the LMS sends it before
 * it hands out the launch URL. By `stored` when the LRS gives it, otherwise by the LRS's own order (newest stored
 * first, xAPI's default). Undefined when the read fails or the LRS records no authority: the launch still starts.
 */
async function launchedAuthority(lrs: LrsClient, k: { actor: XapiAgent; registration: string; activityId: string; sessionId: string }): Promise<Record<string, unknown> | undefined> {
  try {
    const list = await lrs.getStatements({ agent: k.actor, registration: k.registration, verb: ADL_VERBS.launched, activity: k.activityId });
    const ours = list.filter((s) => s.context?.extensions?.[CMI5.extSessionId] === k.sessionId);
    const storedAt = (s: XapiStatement) => (s as XapiStatement & { stored?: string }).stored;
    const first = ours.length > 0 && ours.every((s) => storedAt(s)) ? [...ours].sort((a, b) => Date.parse(storedAt(a)!) - Date.parse(storedAt(b)!))[0] : ours.at(-1);
    const authority = (first as (XapiStatement & { authority?: unknown }) | undefined)?.authority;
    return authority && typeof authority === 'object' && !Array.isArray(authority) ? structuredClone(authority as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function createBridge(o: BridgeOptions): Bridge {
  const now = o.now ?? Date.now;
  const uuid = o.uuid ?? randomUUID;
  const f = o.fetch ?? fetch;
  const store = o.launches;
  const lock = o.lock ?? (<T>(_c: LaunchContext, fn: () => Promise<T>) => fn());
  /** Launches this bridge started that have not ended yet: the ones `sweep` looks at. */
  const live = new Set<string>();
  const ending = new Set<string>();
  /**
   * `terminated` statements built but not yet confirmed by the record holder. A failed send may still have been stored,
   * so the launch stays ended and the same statement (same id and timestamp) is retried; the LRS dedupes by id.
   */
  const pending = new Map<string, { launch: LaunchContext; endpoint: string; token: string; statement: XapiStatement }>();

  const iso = (ms: number) => new Date(ms).toISOString();
  const client = (endpoint: string, token: string): LrsClient => createLrsClient({ endpoint, auth: { type: 'token', value: token }, fetch: f });

  function au(key: string): { auId: string; title: string } | undefined {
    if (Object.hasOwn(o.course.lessons, key)) return o.course.lessons[key];
    if (o.course.placement.key === key) return o.course.placement;
    return undefined;
  }

  function statementContext(c: LaunchContext): Cmi5Context {
    return {
      actor: c.actor,
      registration: c.registration,
      sessionId: c.sessionId,
      courseId: o.course.id,
      language: o.course.language,
      rulesVersion: SPEC_VERSION,
      custody: 'lms-launched',
      practice: false,
      contextTemplate: c.contextTemplate,
    };
  }

  async function uniquePairingCode(): Promise<string> {
    for (;;) {
      const code = newPairingCode();
      const holder = await store.byPairingCode(code);
      if (!holder || Date.parse(holder.pairingExpiresAt) <= now()) return code;
    }
  }

  async function launch(url: URL): Promise<Response> {
    const q = url.searchParams;
    const key = q.get('au') ?? '';
    const target = au(key);
    if (!target) throw bad('The lesson in this link is not part of this course.');
    const onLoopback = isLoopback(url.hostname);
    const endpoint = safeUrl(q.get('endpoint'), onLoopback);
    if (!endpoint) throw bad('The record store address in this link is not allowed.');
    const fetchUrl = safeUrl(q.get('fetch'), onLoopback);
    if (!fetchUrl) throw bad('The token address in this link is not allowed.');
    const actor = parseActor(q.get('actor'));
    if (!actor) throw bad('The learner in this link is not valid.');
    const registration = q.get('registration') ?? '';
    if (!UUID.test(registration)) throw bad('The registration in this link is not valid.');
    const activityId = q.get('activityId') ?? '';
    if (!URL.canParse(activityId)) throw bad('The activity in this link is not valid.');

    try {
      const token = await fetchAuthToken(fetchUrl.href, f);
      const tokenFetchedAt = now();
      const lrs = client(endpoint.href, token);
      const state = await lrs.getState({ activityId, agent: actor, registration, stateId: 'LMS.LaunchData' });
      const data = parseLaunchData(state?.body, target.auId);
      // Read for cmi5 conformance (§11); the course has one language, so nothing here changes what is sent.
      await lrs.getAgentProfile(actor, 'cmi5LearnerPreferences');
      const lmsAuthority = await launchedAuthority(lrs, { actor, registration, activityId, sessionId: data.sessionId });

      const initializedAt = Math.max(now(), tokenFetchedAt);
      const ctx: LaunchContext = {
        launchId: uuid(),
        endpoint: endpoint.href,
        authToken: token,
        tokenFetchedAt: iso(tokenFetchedAt),
        actor,
        registration,
        activityId,
        auId: target.auId,
        auKey: key,
        ...data,
        initializedAt: iso(initializedAt),
        pairingCode: await uniquePairingCode(),
        pairingExpiresAt: iso(initializedAt + DEFAULTS.pairingTtlMs),
        ...(lmsAuthority ? { lmsAuthority } : {}),
      };
      const initialized = buildDefined(statementContext(ctx), 'initialized', { au: { publisherId: ctx.auId, activityId: ctx.activityId } }, { id: uuid(), timestamp: ctx.initializedAt });
      await lrs.putStatement(initialized);

      const previous = await store.latestFor(ctx.endpoint, actorKey(actor), registration, key);
      await store.put(ctx);
      live.add(ctx.launchId);
      await o.onSent?.(ctx, [initialized]).catch(() => undefined); // the launch itself succeeded
      if (previous && !previous.terminatedAt && !previous.supersededAt) {
        await store.update(previous.launchId, { supersededAt: ctx.initializedAt });
        live.delete(previous.launchId);
      }

      const secure = onLoopback ? '' : '; Secure';
      return html(launchPage({ courseTitle: o.course.title, lessonTitle: target.title, mcpUrl: o.mcpUrl, pairingCode: ctx.pairingCode }), 200, {
        'set-cookie': `${LAUNCH_COOKIE}=${ctx.launchId}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`,
      });
    } catch (err) {
      throw refusedByRecordHolder(err);
    }
  }

  async function terminate(launchId: string): Promise<boolean> {
    if (ending.has(launchId)) return false;
    ending.add(launchId);
    try {
      let p = pending.get(launchId);
      if (!p) {
        const c = await store.get(launchId);
        if (!c) throw new StoreError('unknown launch ' + launchId);
        if (c.terminatedAt || c.supersededAt) {
          live.delete(launchId);
          return false;
        }
        // Never before the session's last activity, so `terminated` stays the last statement.
        const at = Math.max(now(), c.lastActivityAt ? Date.parse(c.lastActivityAt) + 1 : 0);
        const terminatedAt = iso(at);
        const statement = buildDefined(statementContext(c), 'terminated', { au: { publisherId: c.auId, activityId: c.activityId } }, {
          id: uuid(),
          timestamp: terminatedAt,
          duration: isoDuration(Math.max(0, at - Date.parse(c.initializedAt))),
        });
        p = { launch: c, endpoint: c.endpoint, token: c.authToken, statement };
        pending.set(launchId, p);
        // Claim the end before sending, so the engine stops writing to this launch; it stays claimed if the send fails.
        await store.update(launchId, { terminatedAt });
      }
      await client(p.endpoint, p.token).putStatement(p.statement);
      await o.onSent?.(p.launch, [p.statement]);
      pending.delete(launchId);
      live.delete(launchId);
      return true;
    } finally {
      ending.delete(launchId);
    }
  }

  return {
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== LAUNCH_PATH) return undefined;
      if (req.method !== 'GET') return new Response('GET only', { status: 405, headers: { allow: 'GET' } });
      try {
        return await launch(url);
      } catch (err) {
        const r = err instanceof LaunchRefused ? err : refusedByRecordHolder(err);
        return html(errorPage({ heading: r.heading, message: r.message, detail: r.detail }), r.status);
      }
    },

    async sweep() {
      let n = 0;
      const t = now();
      for (const id of [...live]) {
        if (pending.has(id)) {
          try {
            if (await terminate(id)) n++;
          } catch {
            // Still not confirmed; the next sweep sends the same statement again.
          }
          continue;
        }
        const seen = await store.get(id);
        if (!seen || seen.terminatedAt || seen.supersededAt) {
          live.delete(id);
          continue;
        }
        const due = (c: LaunchContext) =>
          t - Date.parse(c.lastActivityAt ?? c.initializedAt) >= DEFAULTS.sessionIdleMs || t - Date.parse(c.tokenFetchedAt) >= DEFAULTS.lmsSessionMaxMs;
        if (!due(seen)) continue;
        try {
          // Decide again under the learner's lock: a tool call that just finished may have used or ended the session.
          const ended = await lock(seen, async () => {
            const c = await store.get(id);
            if (!c || c.terminatedAt || c.supersededAt || !due(c)) return false;
            return terminate(id);
          });
          if (ended) n++;
        } catch {
          // The record holder did not take it; the next sweep tries again.
        }
      }
      return n;
    },

    async terminate(launchId) {
      await terminate(launchId);
    },
  };
}
