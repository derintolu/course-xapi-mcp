// SPDX-License-Identifier: Apache-2.0
// Course server startup class: starts the course server with CXM_SERVER_COMMAND, once with the distribution build of
// the conformance course and once with its authoring package, and checks that it refuses the first and serves the
// second. `{package}` in the command is the package directory (shell-quoted) and `{port}` a free loopback port;
// CXM_SERVER_URL is the MCP endpoint, with `{port}` in it.
import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

const COMMAND = process.env.CXM_SERVER_COMMAND;
const URL_TEMPLATE = process.env.CXM_SERVER_URL;
if (!COMMAND || !URL_TEMPLATE) {
  throw new Error('Set CXM_SERVER_COMMAND, a shell command that starts the course server on {package} at {port}, and CXM_SERVER_URL, its MCP endpoint with {port}; e.g. CXM_SERVER_COMMAND="CXM_PACKAGE={package} PORT={port} CXM_PUBLIC_URL=http://127.0.0.1:{port} node --experimental-strip-types reference/packages/server/src/bin.ts" CXM_SERVER_URL="http://127.0.0.1:{port}/mcp" npm run conformance -- conformance/startup');
}
const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;
const AUTHORING = FIXTURES + 'course';
const DISTRIBUTION = FIXTURES + 'course-distribution';
const STARTUP_MS = 20_000;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

interface Started {
  stop: (signal: NodeJS.Signals) => void;
  url: string;
  output: () => string;
  exited: Promise<number | null>;
}

async function start(pkg: string): Promise<Started> {
  const port = String(await freePort());
  const command = COMMAND!.replaceAll('{package}', quote(pkg)).replaceAll('{port}', port);
  // Its own process group, so stopping it stops whatever the command started.
  const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const stop = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      // already gone
    }
  };
  return { stop, url: URL_TEMPLATE!.replaceAll('{port}', port), output: () => out, exited };
}

/** Any HTTP response from the endpoint, or undefined when nothing answers. */
async function probe(url: string): Promise<number | undefined> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}', signal: AbortSignal.timeout(1_000) });
    await r.body?.cancel();
    return r.status;
  } catch {
    return undefined;
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('course server startup', () => {
  it('[CXM-PKG-034] refuses a distribution package: exits non-zero with an error naming it, and serves no MCP endpoint', async () => {
    const s = await start(DISTRIBUTION);
    let answered: number | undefined;
    let code: number | null | 'running' = 'running';
    void s.exited.then((c) => (code = c));
    const deadline = Date.now() + STARTUP_MS;
    while (code === 'running' && Date.now() < deadline) {
      answered ??= await probe(s.url);
      await pause(100);
    }
    s.stop('SIGKILL');
    expect(code, `still running after ${STARTUP_MS} ms:\n${s.output()}`).not.toBe('running');
    expect(code, s.output()).not.toBe(0);
    expect(code, s.output()).not.toBeNull();
    expect(s.output()).toMatch(/CXM-PKG-034|distribution package/i);
    expect(answered, `the MCP endpoint answered ${answered}`).toBeUndefined();
    expect(await probe(s.url)).toBeUndefined();
  }, STARTUP_MS + 5_000);

  it('[CXM-PKG-034] starts with an authoring package and serves the MCP endpoint', async () => {
    const s = await start(AUTHORING);
    let exited = false;
    void s.exited.then(() => (exited = true));
    try {
      let status: number | undefined;
      const deadline = Date.now() + STARTUP_MS;
      while (status === undefined && !exited && Date.now() < deadline) {
        status = await probe(s.url);
        if (status === undefined) await pause(100);
      }
      expect(exited, `exited:\n${s.output()}`).toBe(false);
      expect(status, s.output()).toBeDefined();
      expect(status!, s.output()).toBeLessThan(500);
    } finally {
      s.stop('SIGTERM');
      await Promise.race([s.exited, pause(5_000)]);
      s.stop('SIGKILL');
    }
  }, STARTUP_MS + 10_000);
});
