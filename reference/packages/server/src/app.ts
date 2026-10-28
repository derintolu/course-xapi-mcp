// SPDX-License-Identifier: Apache-2.0
// The whole reference server behind one fetch handler: Origin and Host guards, the authorization server, the
// cmi5 launch bridge, badge routes, the record pages, the MCP endpoints and a description at `/`.
// `createAppFromConfig` builds every part from an `AppConfig` for one course package.
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MemoryLaunchStore,
  RULES_URI,
  type AuthServer,
  type BadgeService,
  type CourseModel,
  type Custody,
  type LaunchStore,
  type LearnerRef,
  type XapiStatement,
} from '@course-xapi-mcp/core';
import { loadPackage, readDir, readZip } from '@course-xapi-mcp/core/package';
import { createBridge, startSweeper, type Bridge } from '@course-xapi-mcp/bridge';
import type { ResolveHost } from '@course-xapi-mcp/lrs-client';
import { createAuthServer, launchSubject } from './auth/auth-server.ts';
import { isLoopbackHost } from './auth/clients.ts';
import { createOidcFederation } from './auth/oidc.ts';
import { custodyErrors, DEFAULT_RETENTION, type AppConfig } from './config.ts';
import { createAuthorLrsCustody } from './custody/author-lrs.ts';
import { createLmsLaunchedCustody } from './custody/lms-launched.ts';
import { withLearnerLock } from './custody/mutex.ts';
import { createPracticeCustody, type PracticeCustody } from './custody/practice.ts';
import { createServerKeptCustody } from './custody/server-kept.ts';
import { DirectoryPracticeStore, MemoryPracticeStore, MemoryServerStore, type ServerStore } from './custody/stores.ts';
import { createRecordPages } from './record-pages.ts';
import { createCourseServer } from './server.ts';

/** The badge issuing service (Task 28): what the course server, the route chain and the record delete form use. */
export type AppBadges = BadgeService & {
  routes(req: Request): Promise<Response | undefined>;
  /** Revokes every credential issued to this learner subject; returns how many. */
  revokeLearner(subject: string): Promise<number>;
  /** The record holder accepted these statements (a tool call's delivery, inside the learner's lock): confirms the awards they earned. */
  onDelivered?(l: LearnerRef, statementIds: string[]): Promise<void>;
  /** Option 1: the issuer record (`earned` statements and credential ids) that `get_record` appends. */
  records?(l: LearnerRef): Promise<{ statements: XapiStatement[]; credentials: string[] }>;
};

export interface AppOptions {
  course: CourseModel;
  /** The origin learners and agents reach the server at. */
  publicUrl: string;
  custody: Custody;
  /** Behind `/mcp/practice` (or `/mcp` when custody is practice). */
  practice?: PracticeCustody;
  /** The authorization server (options 1-3). */
  auth?: AuthServer;
  /** The cmi5 launch bridge (option 1). */
  bridge?: Bridge;
  /** Option 3: the store the record delete form erases from. */
  serverStore?: ServerStore;
  badges?: AppBadges;
  /** Browser origins allowed besides `publicUrl`'s own; a request with any other Origin header gets 403. */
  allowedOrigins?: string[];
  /** When set, a request whose Host header is not listed gets 403 (for loopback binds, against DNS rebinding). */
  allowedHosts?: string[];
  /** The text of `/record/policy`. */
  retention?: string;
  /** ISO 8601 clock, for tests. */
  now?: () => string;
  /** Runs on `close`, after the MCP endpoints close (stops the bridge sweeper). */
  onClose?: () => void | Promise<void>;
}

export interface App {
  fetch(req: Request): Promise<Response>;
  close(): Promise<void>;
}

const MCP_PATHS = new Set(['/mcp', '/mcp/practice']);
const forbidden = (why: string) => new Response(why, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export function createApp(o: AppOptions): App {
  const { course, custody } = o;
  const publicUrl = new URL(o.publicUrl).origin;
  const option = custody.option;
  if (option !== 'practice' && !o.auth) throw new TypeError(`custody ${option} needs the authorization server`);
  if (option === 'lms-launched' && !o.bridge) throw new TypeError('custody lms-launched needs the launch bridge');
  const server = createCourseServer({ course, custody, practice: o.practice, authenticate: o.auth?.authenticate, badges: o.badges, publicUrl, now: o.now });
  const records = o.auth
    ? createRecordPages({ course, custody, auth: o.auth, serverStore: o.serverStore, revokeLearner: o.badges?.revokeLearner, retention: o.retention ?? DEFAULT_RETENTION })
    : async () => undefined;
  const origins = new Set([publicUrl, ...(o.allowedOrigins ?? [])]);
  const hosts = o.allowedHosts && new Set(o.allowedHosts.map((h) => h.toLowerCase()));
  const practiceUrl = option === 'practice' ? publicUrl + '/mcp' : course.allowPractice ? publicUrl + '/mcp/practice' : undefined;
  const description = {
    name: `course-xapi-mcp:${course.id.replace(/\/+$/, '').split('/').pop()}`,
    course: { id: course.id, title: course.title, version: course.version },
    custody: option,
    official: custody.official,
    mcp: option === 'practice' ? undefined : publicUrl + '/mcp',
    practice: practiceUrl,
    rules: RULES_URI,
  };

  async function route(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    // A form posted from this server's own pages carries `Origin: null` (they send no referrer); those forms have
    // their own defences (SameSite cookies, CSRF tokens). The MCP endpoints refuse it like any foreign origin.
    const origin = req.headers.get('origin');
    if (origin !== null && !origins.has(origin) && !(origin === 'null' && !MCP_PATHS.has(path))) return forbidden('Forbidden origin');
    if (hosts && !hosts.has((req.headers.get('host') ?? '').toLowerCase())) return forbidden('Forbidden host');

    const handled = (await o.auth?.routes(req)) ?? (await o.badges?.routes(req)) ?? (await o.bridge?.fetch(req)) ?? (await records(req));
    if (handled) return handled;
    if (path === '/mcp' || path === '/mcp/practice') return server.mcp(req, path);
    if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) return Response.json(description);
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  return {
    fetch: route,
    async close() {
      await server.close();
      await o.onClose?.();
    },
  };
}

const SERVER_KEPT_ON_DISK =
  'CXM_DATA_DIR cannot be used with custody server-kept yet: accounts are held in memory, so after a restart learners could not sign in to reach or delete the records kept on disk. Unset CXM_DATA_DIR to keep records in memory.';

/** A package that does not load, or a configuration the package's custody cannot run with. */
export class ConfigError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join('\n'));
    this.errors = errors;
  }
}

/** Reads and loads the course package at `path`: a directory, or a ZIP file. */
export async function loadCourse(path: string): Promise<CourseModel> {
  const isDir = (await stat(path).catch(() => undefined))?.isDirectory();
  if (isDir === undefined) throw new ConfigError([`CXM_PACKAGE: no directory or ZIP file at ${path}`]);
  let files;
  if (isDir) files = await readDir(path);
  else {
    const zip = readZip(new Uint8Array(await readFile(path)));
    if ('code' in zip) throw new ConfigError([`${zip.code} ${path}: ${zip.message}`]);
    files = zip;
  }
  const loaded = loadPackage(files);
  if (!loaded.ok) throw new ConfigError(loaded.issues.map((i) => `${i.code} ${i.file}: ${i.message}`));
  return loaded.course;
}

/** What a badge service is built from, inside `createAppFromConfig`. */
export interface BadgeParts {
  config: AppConfig;
  course: CourseModel;
  publicUrl: string;
  custody: Custody;
  auth?: AuthServer;
  launches?: LaunchStore;
  /** Milliseconds since the epoch (tests). */
  now?: () => number;
}

export interface FromConfigOptions {
  /** The course, instead of loading `config.packagePath` (tests override its custody this way). */
  course?: CourseModel;
  /** Builds the badge service from the parts this function made (Task 28); undefined when the course server does not sign. */
  badges?: (parts: BadgeParts) => AppBadges | undefined | Promise<AppBadges | undefined>;
  /** Replaces fetch for the LRS, the LMS and cmi5 token requests (tests). The OpenID Provider uses the global fetch. */
  lrsFetch?: typeof fetch;
  /** Resolves the LMS's host names for the bridge and option 1 custody (tests; default DNS). */
  resolveHost?: ResolveHost;
  /** Milliseconds since the epoch, for every part (tests). */
  now?: () => number;
  /** How often the bridge looks for idle option-1 sessions to end. Default 60 s. */
  sweepEveryMs?: number;
}

/** Builds the server for one course package from the configuration: stores, custody, sign-in, bridge and pages. */
export async function createAppFromConfig(config: AppConfig, o: FromConfigOptions = {}): Promise<App & { course: CourseModel }> {
  const course = o.course ?? (await loadCourse(config.packagePath));
  const missing = custodyErrors(config, course.custody);
  if (missing.length) throw new ConfigError(missing);
  // Until a directory AuthStore exists, accounts live in memory: after a restart nobody could sign in to reach, or
  // delete, a server-kept record kept on disk (R61).
  if (config.dataDir && course.custody === 'server-kept') throw new ConfigError([SERVER_KEPT_ON_DISK]);
  const { publicUrl } = config;
  const now = o.now;
  const iso = now && (() => new Date(now()).toISOString());

  const dir = config.dataDir;
  if (dir) await mkdir(join(dir, 'practice'), { recursive: true });
  const practiceStore = dir ? new DirectoryPracticeStore(join(dir, 'practice'), undefined, now) : new MemoryPracticeStore(undefined, now);
  const practice = course.custody === 'practice' || course.allowPractice ? createPracticeCustody({ store: practiceStore, courseId: course.id }) : undefined;

  const authFor = (mode: 'accounts' | 'federated' | 'launch-paired', extra: Partial<Parameters<typeof createAuthServer>[0]> = {}) =>
    createAuthServer({ publicUrl, course, signingKey: config.signingKey, mode, now, ...extra });

  let custody: Custody;
  let auth: AuthServer | undefined;
  let serverStore: ServerStore | undefined;
  let launches: LaunchStore | undefined;
  let bridge: Bridge | undefined;
  let stopSweeper: (() => void) | undefined;
  switch (course.custody) {
    case 'practice':
      custody = practice!;
      break;
    case 'server-kept':
      // Memory only: CXM_DATA_DIR is refused with this custody above.
      serverStore = new MemoryServerStore();
      custody = createServerKeptCustody({ store: serverStore, publicUrl, courseTitle: course.title });
      auth = authFor('accounts');
      break;
    case 'author-lrs': {
      custody = createAuthorLrsCustody({ course, lrs: config.lrs!, publicUrl, recordHolderUrl: config.recordHolderUrl, fetch: o.lrsFetch });
      const federation = await createOidcFederation({ ...config.oidc!, redirectUri: publicUrl + '/oauth/callback' });
      auth = authFor('federated', { federation });
      break;
    }
    case 'lms-launched': {
      launches = new MemoryLaunchStore();
      const lms = createLmsLaunchedCustody({ course, launches, recordHolderUrl: config.recordHolderUrl, fetch: o.lrsFetch, resolveHost: o.resolveHost });
      custody = lms;
      auth = authFor('launch-paired', { launches });
      // The bridge sends `initialized` and the sweeper's `terminated` itself; the custody lists them in the receipt.
      bridge = createBridge({
        course,
        mcpUrl: publicUrl + '/mcp',
        launches,
        now,
        fetch: o.lrsFetch,
        resolveHost: o.resolveHost,
        lmsOrigins: config.lmsOrigins,
        lock: (c, fn) => withLearnerLock(launchSubject(c), fn),
        onSent: (c, statements) => lms.recordSent(c, statements),
      });
      stopSweeper = startSweeper(bridge, o.sweepEveryMs);
      break;
    }
  }

  const badges = await o.badges?.({ config, course, publicUrl, custody, auth, launches, now });
  const host = new URL(publicUrl);
  const allowedHosts = isLoopbackHost(host.hostname) ? [host.host, `127.0.0.1:${config.port}`, `localhost:${config.port}`] : undefined;
  const app = createApp({
    course,
    publicUrl,
    custody,
    practice: course.custody === 'practice' ? undefined : practice,
    auth,
    bridge,
    serverStore,
    badges,
    allowedOrigins: config.allowedOrigins,
    allowedHosts,
    retention: config.retention,
    now: iso,
    onClose: stopSweeper,
  });
  return { ...app, course };
}
