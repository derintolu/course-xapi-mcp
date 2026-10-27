// SPDX-License-Identifier: Apache-2.0
// RFC 9728 protected resource metadata and RFC 8414 authorization server metadata.
import { SCOPE } from './tokens.ts';

export const PATHS = {
  resourceMetadata: '/.well-known/oauth-protected-resource/mcp',
  serverMetadata: '/.well-known/oauth-authorization-server',
  register: '/oauth/register',
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  callback: '/oauth/callback',
  login: '/oauth/login',
} as const;

export function resourceMetadata(publicUrl: string) {
  return {
    resource: publicUrl + '/mcp',
    authorization_servers: [publicUrl],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
  };
}

export function serverMetadata(publicUrl: string) {
  return {
    issuer: publicUrl,
    authorization_endpoint: publicUrl + PATHS.authorize,
    token_endpoint: publicUrl + PATHS.token,
    registration_endpoint: publicUrl + PATHS.register,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** The `WWW-Authenticate` value for a request without a valid token. */
export function bearerChallenge(publicUrl: string): string {
  return `Bearer resource_metadata="${publicUrl}${PATHS.resourceMetadata}", scope="${SCOPE}"`;
}
