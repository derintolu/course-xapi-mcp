// SPDX-License-Identifier: Apache-2.0
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createGuardedFetch, isLoopbackHost, isPublicAddress } from '../src/index.ts';

const PUBLIC_IP = '93.184.216.34';

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

/** A loopback HTTP server that records each request; `/moved` answers a redirect to `/target`. */
async function local() {
  const seen: { method: string; path: string; body: string; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ method: req.method!, path: req.url!, body, authorization: req.headers.authorization });
      if (req.url === '/moved') {
        res.writeHead(302, { location: '/target' });
        res.end();
      } else if (req.url === '/empty') {
        res.writeHead(204, { etag: '"e1"' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' });
        res.end(JSON.stringify({ ok: true, method: req.method }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, seen };
}

describe('host names that name this machine', () => {
  it('include every spelling of localhost and of loopback or unspecified addresses', () => {
    for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'a.localhost', 'a.localhost.', '127.0.0.1', '127.1.2.3', '0.0.0.0', '[::1]', '[::]', '[::ffff:7f00:1]', '[::ffff:127.0.0.1]']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of ['example.com', 'localhost.example', '10.0.0.1', '[::ffff:a00:1]', '[fd00::1]', '93.184.216.34']) expect(isLoopbackHost(h), h).toBe(false);
  });

  it('public addresses exclude private, shared, link-local, loopback and mapped forms of them', () => {
    expect(isPublicAddress(PUBLIC_IP)).toBe(true);
    for (const a of ['10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '127.0.0.1', '::1', '::ffff:10.0.0.1', 'fd00::1', 'fe80::1']) expect(isPublicAddress(a), a).toBe(false);
  });
});

describe('the guarded fetch over the network', () => {
  it('refuses a name that resolves to a loopback address unless loopback is allowed, before connecting', async () => {
    const lms = await local();
    const toLoopback = async () => ['127.0.0.1'];
    const strict = createGuardedFetch({ resolveHost: toLoopback });
    await expect(strict(`http://lms.rebind.test:${lms.port}/xapi/about`)).rejects.toThrow();
    expect(lms.seen).toEqual([]);
    const loose = createGuardedFetch({ resolveHost: toLoopback, allowLoopback: true });
    const res = await loose(`http://lms.rebind.test:${lms.port}/xapi/about`);
    expect(res.status).toBe(200);
    expect(lms.seen).toHaveLength(1);
  });

  it('refuses private and loopback literals without a lookup', async () => {
    const lms = await local();
    let lookups = 0;
    const f = createGuardedFetch({ resolveHost: async () => (lookups++, [PUBLIC_IP]) });
    for (const url of [`http://127.0.0.1:${lms.port}/`, 'http://10.0.0.1/', 'http://[::ffff:7f00:1]/', 'http://169.254.169.254/latest']) await expect(f(url), url).rejects.toThrow();
    expect(lookups).toBe(0);
    expect(lms.seen).toEqual([]);
  });

  it('sends the method, headers and body, and answers bodiless statuses and ETags as fetch does', async () => {
    const lms = await local();
    const f = createGuardedFetch({ allowLoopback: true });
    const res = await f(`http://127.0.0.1:${lms.port}/xapi/statements`, { method: 'PUT', headers: { authorization: 'Basic abc', 'content-type': 'application/json' }, body: '{"a":1}', redirect: 'error' });
    expect(await res.json()).toEqual({ ok: true, method: 'PUT' });
    expect(res.headers.get('etag')).toBe('"v1"');
    expect(lms.seen[0]).toMatchObject({ method: 'PUT', path: '/xapi/statements', body: '{"a":1}', authorization: 'Basic abc' });
    const empty = await f(`http://127.0.0.1:${lms.port}/empty`, { method: 'PUT', body: '{}' });
    expect(empty.status).toBe(204);
    expect(empty.headers.get('etag')).toBe('"e1"');
  });

  it('never follows a redirect', async () => {
    const lms = await local();
    const f = createGuardedFetch({ allowLoopback: true });
    await expect(f(`http://127.0.0.1:${lms.port}/moved`, { redirect: 'error' })).rejects.toThrow();
    await expect(f(`http://127.0.0.1:${lms.port}/moved`)).rejects.toThrow();
    expect((await f(`http://127.0.0.1:${lms.port}/moved`, { redirect: 'manual' })).status).toBe(302);
    expect(lms.seen.map((s) => s.path)).toEqual(['/moved', '/moved', '/moved']);
  });

  it('refuses other schemes and URLs with credentials', async () => {
    const f = createGuardedFetch({ allowLoopback: true, resolveHost: async () => [PUBLIC_IP] });
    for (const url of ['ftp://lms.example/x', 'file:///etc/passwd', 'https://user:pass@lms.example/x']) await expect(f(url), url).rejects.toThrow();
  });
});

describe('the guarded fetch over an injected fetch (tests)', () => {
  it('checks the host first and refuses redirects', async () => {
    const seen: { url: string; redirect?: RequestRedirect }[] = [];
    const inner = (async (input: string | URL | Request, init?: RequestInit) => (seen.push({ url: String(input), redirect: init?.redirect }), new Response('{}'))) as typeof fetch;
    const f = createGuardedFetch({ fetch: inner, resolveHost: async (h) => (h === 'private.example' ? ['10.9.8.7'] : [PUBLIC_IP]) });
    await expect(f('https://private.example/xapi')).rejects.toThrow();
    await expect(f('https://10.0.0.1/xapi')).rejects.toThrow();
    expect(seen).toEqual([]);
    await f('https://lms.example/xapi', { method: 'POST' });
    expect(seen).toEqual([{ url: 'https://lms.example/xapi', redirect: 'error' }]);
  });
});
