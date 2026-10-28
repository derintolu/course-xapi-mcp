// SPDX-License-Identifier: Apache-2.0
// The reference binary's configuration, read from environment variables. Nothing here starts anything:
// `loadConfig` checks the variables and `createAppFromConfig` (app.ts) builds the server from the result.
import { generateKeyPairSync } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { JWK } from 'jose';
import type { CustodyOption } from '@course-xapi-mcp/core';
import type { XapiVersion } from '@course-xapi-mcp/lrs-client';

export const DEFAULT_RETENTION = 'Records are kept until you delete them.';
const DEFAULT_PORT = 8787;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const XAPI_VERSIONS: XapiVersion[] = ['1.0.3', '2.0.0'];
/** What custody author-lrs needs: the author's LRS and the author's OpenID Provider (the client secret is optional). */
const AUTHOR_LRS_VARS = ['CXM_LRS_ENDPOINT', 'CXM_LRS_KEY', 'CXM_LRS_SECRET', 'CXM_OIDC_ISSUER', 'CXM_OIDC_CLIENT_ID'];

export interface AppConfig {
  /** The course package: a directory or a ZIP file. */
  packagePath: string;
  /** The origin learners and agents reach the server at, with no trailing slash. */
  publicUrl: string;
  port: number;
  /** Where directory stores keep practice copies and badge issuer data; memory stores when unset. Refused with custody server-kept until accounts are kept on disk too (R61). */
  dataDir?: string;
  /** The author's LRS (custody author-lrs). Set only when all three variables are. */
  lrs?: { endpoint: string; key: string; secret: string; version?: XapiVersion };
  /** The author's OpenID Provider (custody author-lrs). Set only when issuer and client id are. */
  oidc?: { issuer: string; clientId: string; clientSecret?: string };
  /** Ed25519 private JWK that signs access tokens. */
  signingKey: JWK;
  /** `CXM_BADGE_KEY`: the Ed25519 Multikey that signs badges (its id and controller come from the public URL). */
  badgeKey?: BadgeKey;
  badgeIssuerName?: string;
  /** Browser origins allowed besides the public URL's own. */
  allowedOrigins: string[];
  /** The text of `/record/policy`. */
  retention: string;
  /** `CXM_RECORD_HOLDER_URL`: where the learner asks the record holder (the LMS, the author's LRS) to delete their record (options 1 and 2). */
  recordHolderUrl?: string;
  /** Which of the author-lrs variables are not set (custody is only known once the package is read). */
  unset: string[];
  /** Things the operator should know, such as a signing key generated for this process only. */
  warnings: string[];
}

export interface BadgeKey {
  publicKeyMultibase: string;
  secretKeyMultibase: string;
}

type Env = Record<string, string | undefined>;

const set = (v: string | undefined) => (v !== undefined && v.trim() !== '' ? v.trim() : undefined);

/** A URL as it may be echoed in an error: without user name or password. */
const redact = (raw: string) => raw.replace(/^([^:/?#]*:\/\/)[^/?#]*@/, '$1***@');

function originOf(raw: string, name: string, errors: string[]): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    errors.push(`${name} is not a URL: ${redact(raw)}`);
    return undefined;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) {
    errors.push(`${name} must be an http(s) origin with no path, query or credentials: ${redact(raw)}`);
    return undefined;
  }
  return u.origin;
}

/** An http(s) URL with no user name or password: it is shown to learners and agents. */
function recordHolderUrlOf(raw: string, errors: string[]): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    errors.push(`CXM_RECORD_HOLDER_URL is not a URL: ${redact(raw)}`);
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    errors.push(`CXM_RECORD_HOLDER_URL must be an http(s) URL: ${redact(raw)}`);
    return undefined;
  }
  if (u.username || u.password) {
    errors.push(`CXM_RECORD_HOLDER_URL must not contain credentials: ${redact(raw)}`);
    return undefined;
  }
  return u.href;
}

function signingKeyOf(raw: string, errors: string[]): JWK | undefined {
  let k: unknown;
  try {
    k = JSON.parse(raw);
  } catch {
    errors.push('CXM_SIGNING_KEY is not JSON (give an Ed25519 private JWK)');
    return undefined;
  }
  const j = k as Partial<JWK>;
  if (!j || typeof j !== 'object' || j.kty !== 'OKP' || j.crv !== 'Ed25519' || typeof j.x !== 'string' || typeof j.d !== 'string') {
    errors.push('CXM_SIGNING_KEY must be an Ed25519 private JWK (kty OKP, crv Ed25519, with x and d)');
    return undefined;
  }
  return j as JWK;
}

/** Never echoes the value: it holds a private key. */
function badgeKeyOf(raw: string, errors: string[]): BadgeKey | undefined {
  const fail = () => void errors.push('CXM_BADGE_KEY must be JSON with the Ed25519 Multikey strings publicKeyMultibase and secretKeyMultibase');
  let k: unknown;
  try {
    k = JSON.parse(raw);
  } catch {
    return fail();
  }
  const j = k as Partial<BadgeKey> | null;
  const multibase = (v: unknown) => typeof v === 'string' && /^z[1-9A-HJ-NP-Za-km-z]+$/.test(v);
  if (!j || typeof j !== 'object' || Array.isArray(j) || !multibase(j.publicKeyMultibase) || !multibase(j.secretKeyMultibase)) return fail();
  return { publicKeyMultibase: j.publicKeyMultibase!, secretKeyMultibase: j.secretKeyMultibase! };
}

/** The variables a custody option needs that the configuration lacks, one message per variable. */
export function custodyErrors(config: AppConfig, custody: CustodyOption): string[] {
  if (custody !== 'author-lrs') return [];
  const missing = (names: string[]) => names.map((n) => `${n} is required for custody ${custody}`);
  return missing(AUTHOR_LRS_VARS.filter((n) => config.unset.includes(n)));
}

/**
 * Reads the configuration from `env`. With `custody` (known once the package is read), also requires the
 * variables that custody needs: author-lrs needs the three LRS variables and the OIDC issuer and client id.
 */
export function loadConfig(env: Env, o: { custody?: CustodyOption } = {}): AppConfig | { errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const portRaw = set(env.PORT);
  const port = portRaw === undefined ? DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`PORT must be a port number from 1 to 65535: ${portRaw}`);

  const publicRaw = set(env.CXM_PUBLIC_URL);
  const publicUrl = publicRaw === undefined ? `http://127.0.0.1:${port}` : originOf(publicRaw, 'CXM_PUBLIC_URL', errors);

  // A relative path is read from where the command was typed (npm sets INIT_CWD), the default from the repository.
  const pkgRaw = set(env.CXM_PACKAGE);
  const packagePath = pkgRaw === undefined ? resolve(REPO_ROOT, 'examples/json-basics') : isAbsolute(pkgRaw) ? pkgRaw : resolve(env.INIT_CWD ?? process.cwd(), pkgRaw);
  const dataRaw = set(env.CXM_DATA_DIR);
  const dataDir = dataRaw === undefined ? undefined : isAbsolute(dataRaw) ? dataRaw : resolve(env.INIT_CWD ?? process.cwd(), dataRaw);

  const [endpoint, key, secret] = [set(env.CXM_LRS_ENDPOINT), set(env.CXM_LRS_KEY), set(env.CXM_LRS_SECRET)];
  const versionRaw = set(env.CXM_LRS_VERSION);
  if (versionRaw !== undefined && !XAPI_VERSIONS.includes(versionRaw as XapiVersion)) errors.push(`CXM_LRS_VERSION must be 1.0.3 or 2.0.0: ${versionRaw}`);
  if (endpoint !== undefined) {
    try {
      const u = new URL(endpoint);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') errors.push(`CXM_LRS_ENDPOINT must be an http(s) URL: ${redact(endpoint)}`);
    } catch {
      errors.push(`CXM_LRS_ENDPOINT is not a URL: ${redact(endpoint)}`);
    }
  }
  const lrs = endpoint && key && secret ? { endpoint, key, secret, ...(versionRaw ? { version: versionRaw as XapiVersion } : {}) } : undefined;

  const [issuer, clientId, clientSecret] = [set(env.CXM_OIDC_ISSUER), set(env.CXM_OIDC_CLIENT_ID), set(env.CXM_OIDC_CLIENT_SECRET)];
  if (issuer !== undefined && !URL.canParse(issuer)) errors.push(`CXM_OIDC_ISSUER is not a URL: ${redact(issuer)}`);
  const oidc = issuer && clientId ? { issuer, clientId, ...(clientSecret ? { clientSecret } : {}) } : undefined;

  const keyRaw = set(env.CXM_SIGNING_KEY);
  let signingKey = keyRaw === undefined ? undefined : signingKeyOf(keyRaw, errors);
  if (keyRaw === undefined) {
    signingKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as JWK;
    warnings.push('CXM_SIGNING_KEY is not set: generated a signing key for this process only, so access tokens stop working when it restarts.');
  }

  const badgeRaw = set(env.CXM_BADGE_KEY);
  const badgeKey = badgeRaw === undefined ? undefined : badgeKeyOf(badgeRaw, errors);

  const holderRaw = set(env.CXM_RECORD_HOLDER_URL);
  const recordHolderUrl = holderRaw === undefined ? undefined : recordHolderUrlOf(holderRaw, errors);

  const allowedOrigins: string[] = [];
  for (const raw of (env.CXM_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const origin = originOf(raw, 'CXM_ALLOWED_ORIGINS', errors);
    if (origin) allowedOrigins.push(origin);
  }

  if (errors.length || !publicUrl || !signingKey) return { errors };
  const config: AppConfig = {
    packagePath,
    publicUrl,
    port,
    ...(dataDir ? { dataDir } : {}),
    ...(lrs ? { lrs } : {}),
    ...(oidc ? { oidc } : {}),
    signingKey,
    ...(badgeKey ? { badgeKey } : {}),
    ...(set(env.CXM_BADGE_ISSUER_NAME) ? { badgeIssuerName: set(env.CXM_BADGE_ISSUER_NAME) } : {}),
    allowedOrigins,
    retention: set(env.CXM_RETENTION) ?? DEFAULT_RETENTION,
    ...(recordHolderUrl ? { recordHolderUrl } : {}),
    unset: AUTHOR_LRS_VARS.filter((n) => set(env[n]) === undefined),
    warnings,
  };
  if (o.custody) {
    const missing = custodyErrors(config, o.custody);
    if (missing.length) return { errors: missing };
  }
  return config;
}
