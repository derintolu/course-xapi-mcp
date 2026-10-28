// SPDX-License-Identifier: Apache-2.0
// Requests to hosts that someone else names (a launch link's LMS, a client id metadata document): public addresses
// only, checked again when the socket connects, so a name that resolves differently the second time (DNS rebinding)
// still cannot reach a private address. Redirects are never followed.
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

/** Addresses these requests must never reach: private, loopback, link-local, shared, reserved, multicast. */
const NON_PUBLIC = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) NON_PUBLIC.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  // ::/96 covers ::, ::1 and IPv4-compatible forms such as ::127.0.0.1; ::ffff:0:0:0/96 is IPv4-translated;
  // 64:ff9b::/96 and 64:ff9b:1::/48 are NAT64; 2002::/16 is 6to4; fec0::/10 is deprecated site-local.
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) NON_PUBLIC.addSubnet(net, bits, 'ipv6');

/** This machine: loopback and unspecified addresses, IPv4-mapped forms included (BlockList maps them to the IPv4 rules). */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addSubnet('0.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::', 'ipv6');
LOOPBACK.addAddress('::1', 'ipv6');
LOOPBACK.addSubnet('::7f00:0', 104, 'ipv6');

const family = (address: string) => (isIP(address) === 4 ? 'ipv4' : 'ipv6');

export function isPublicAddress(address: string): boolean {
  return isIP(address) !== 0 && !NON_PUBLIC.check(address, family(address));
}

export function isLoopbackAddress(address: string): boolean {
  return isIP(address) !== 0 && LOOPBACK.check(address, family(address));
}

/** The IP address a URL host name spells, without IPv6 brackets; undefined for a DNS name. */
export function literalAddress(hostname: string): string | undefined {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return isIP(bare) ? bare : undefined;
}

/** A URL host name for this machine: localhost or *.localhost (with or without the root dot), or a loopback or unspecified address. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const address = literalAddress(h);
  if (address) return isLoopbackAddress(address);
  return h === 'localhost' || h.endsWith('.localhost');
}

export type ResolveHost = (hostname: string) => Promise<string[]>;

export const resolveWithDns: ResolveHost = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * A socket `lookup` that resolves through `resolveHost` and refuses the connection unless every address is allowed
 * (default: public). Because it runs when the socket connects, a rebinding name cannot reach a refused address.
 */
export function guardedLookup(resolveHost: ResolveHost, allowed: (address: string) => boolean = isPublicAddress): LookupFunction {
  return (hostname, options, callback) => {
    resolveHost(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || !addresses.every(allowed)) {
          callback(Object.assign(new Error('refusing a non-public address for ' + hostname), { code: 'ENOTFOUND' }), '', 0);
        } else if (options.all) {
          (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, addresses.map((a) => ({ address: a, family: isIP(a) })));
        } else {
          callback(null, addresses[0], isIP(addresses[0]));
        }
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 0),
    );
  };
}

export interface GuardedFetchOptions {
  /** Resolves host names, before connecting and again at connect time (default: DNS). */
  resolveHost?: ResolveHost;
  /** Also allow loopback addresses (a deployment on this machine talking to an LMS on this machine). */
  allowLoopback?: boolean;
  /** Replaces the network (tests): the host is checked first, then this fetch is called, with redirects refused. */
  fetch?: typeof fetch;
}

const refused = () => new TypeError('refusing to send a request to that address');
const NULL_BODY = new Set([204, 205, 304]);

/** One request over node:http(s) with the guarded lookup. A redirect is answered as is (`manual`) or refused. */
function request(url: URL, init: RequestInit, lookupFn: LookupFunction): Promise<Response> {
  return new Promise((resolve, reject) => {
    const body = init.body ?? undefined;
    if (body !== undefined && typeof body !== 'string') return reject(new TypeError('only string request bodies are supported'));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    const method = (init.method ?? 'GET').toUpperCase();
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { method, headers, lookup: lookupFn, signal: init.signal ?? undefined }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && init.redirect !== 'manual') {
        res.destroy();
        return reject(new TypeError('refusing to follow a redirect'));
      }
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) for (const one of [v].flat()) h.append(k, one);
      const empty = NULL_BODY.has(status) || method === 'HEAD';
      if (empty) res.resume();
      try {
        resolve(new Response(empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, headers: h }));
      } catch (e) {
        res.destroy();
        reject(e);
      }
    });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * A fetch for URLs someone else chose: http(s) without credentials, to public addresses only (and loopback ones with
 * `allowLoopback`), never following a redirect (`redirect: 'manual'` returns it; anything else refuses it). Takes a
 * URL and an init; a Request's own method, headers and body are not read.
 */
export function createGuardedFetch(o: GuardedFetchOptions = {}): typeof fetch {
  const resolveHost = o.resolveHost ?? resolveWithDns;
  const allowed = (a: string) => isPublicAddress(a) || (!!o.allowLoopback && isLoopbackAddress(a));
  const lookupFn = guardedLookup(resolveHost, allowed);
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) throw refused();
    // Literals never reach the socket lookup, so they are checked here; names are checked again when connecting.
    const address = literalAddress(url.hostname);
    if (address !== undefined && !allowed(address)) throw refused();
    if (!o.fetch) return request(url, init, lookupFn);
    if (address === undefined) {
      const addresses = await resolveHost(url.hostname).catch(() => []);
      if (addresses.length === 0 || !addresses.every(allowed)) throw refused();
    }
    return o.fetch(url.href, { ...init, redirect: init.redirect === 'manual' ? 'manual' : 'error' });
  }) as typeof fetch;
}
