// SPDX-License-Identifier: Apache-2.0
// A minimal OpenID Provider for tests, on a loopback port: discovery, JWKS, an authorize endpoint that
// signs in the current subject at once and returns to the client in query mode, and a token endpoint
// that checks the client secret and PKCE and returns an ID token signed with ES256.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';

/** Ways the provider can go wrong on the next sign-in. */
export type Misbehaviour = 'wrong-nonce' | 'foreign-key' | 'denied' | 'token-error';

export interface FakeIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  close(): Promise<void>;
  setSubject(sub: string): void;
  misbehave(m: Misbehaviour | undefined): void;
  /** The query of the last authorization request the provider received. */
  lastAuthorization(): URLSearchParams | undefined;
}

interface Issued {
  sub: string;
  nonce?: string;
  challenge: string;
  redirectUri: string;
}

const b64url = (b: Buffer) => b.toString('base64url');

async function body(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s;
}

function send(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

export async function startFakeIdp(): Promise<FakeIdp> {
  const key = await generateKeyPair('ES256');
  const foreign = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(key.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const clientId = 'course-server';
  const clientSecret = 'idp-secret-' + b64url(randomBytes(16));
  const codes = new Map<string, Issued>();
  let subject = 'idp-user-1';
  let mode: Misbehaviour | undefined;
  let last: URLSearchParams | undefined;
  let issuer = '';

  async function idToken(i: Issued, signer: CryptoKey): Promise<string> {
    const claims: Record<string, unknown> = {};
    if (i.nonce !== undefined) claims.nonce = mode === 'wrong-nonce' ? 'not-the-nonce' : i.nonce;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setSubject(i.sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signer);
  }

  async function token(req: IncomingMessage, res: ServerResponse) {
    const p = new URLSearchParams(await body(req));
    let id = p.get('client_id');
    let secret = p.get('client_secret');
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    if (basic) {
      const [u, s] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent);
      id = u;
      secret = s;
    }
    if (mode === 'token-error') {
      // Worst case: a provider that echoes what it was sent.
      return send(res, 401, { error: 'invalid_client', error_description: `client ${id} with secret ${secret} is not allowed` });
    }
    if (id !== clientId || secret !== clientSecret) return send(res, 401, { error: 'invalid_client' });
    if (p.get('grant_type') !== 'authorization_code') return send(res, 400, { error: 'unsupported_grant_type' });
    const i = codes.get(p.get('code') ?? '');
    codes.delete(p.get('code') ?? '');
    if (!i || i.redirectUri !== p.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant' });
    const verifier = p.get('code_verifier') ?? '';
    if (b64url(createHash('sha256').update(verifier).digest()) !== i.challenge) return send(res, 400, { error: 'invalid_grant' });
    send(res, 200, {
      access_token: b64url(randomBytes(16)),
      token_type: 'Bearer',
      expires_in: 300,
      id_token: await idToken(i, mode === 'foreign-key' ? foreign.privateKey : key.privateKey),
    });
  }

  function authorize(url: URL, res: ServerResponse) {
    const q = url.searchParams;
    last = q;
    const redirectUri = q.get('redirect_uri') ?? '';
    if (q.get('client_id') !== clientId || !redirectUri) return send(res, 400, { error: 'invalid_request' });
    const back = new URL(redirectUri);
    const state = q.get('state');
    if (state !== null) back.searchParams.set('state', state);
    back.searchParams.set('iss', issuer);
    const ok = q.get('response_type') === 'code' && q.get('code_challenge_method') === 'S256' && (q.get('scope') ?? '').split(' ').includes('openid');
    if (!ok || mode === 'denied') {
      back.searchParams.set('error', ok ? 'access_denied' : 'invalid_request');
    } else {
      const code = b64url(randomBytes(16));
      codes.set(code, { sub: subject, nonce: q.get('nonce') ?? undefined, challenge: q.get('code_challenge') ?? '', redirectUri });
      back.searchParams.set('code', code);
    }
    res.writeHead(302, { location: back.href });
    res.end();
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /.well-known/openid-configuration') {
      return send(res, 200, {
        issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (route === 'GET /jwks') return send(res, 200, { keys: [jwk] });
    if (route === 'GET /authorize') return authorize(url, res);
    if (route === 'POST /token') return void token(req, res).catch(() => send(res, 500, { error: 'server_error' }));
    send(res, 404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    setSubject: (sub) => {
      subject = sub;
    },
    misbehave: (m) => {
      mode = m;
    },
    lastAuthorization: () => last,
  };
}
