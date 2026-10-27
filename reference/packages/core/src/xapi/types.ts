// SPDX-License-Identifier: Apache-2.0
// xAPI shapes used by cmi5-shaped statements. Valid under xAPI 1.0.3 and 2.0.

export interface XapiAccount {
  homePage: string;
  name: string;
}

/**
 * An actor. Actors the course server mints use the account form only (no mbox, mbox_sha1sum, openid or name);
 * option-1 actors are the LMS-supplied agent, copied verbatim, which may use any inverse functional identifier.
 */
export type XapiAgent =
  | { objectType?: 'Agent'; account: XapiAccount }
  | { objectType?: 'Agent'; name?: string; mbox?: string; mbox_sha1sum?: string; openid?: string; account?: XapiAccount };

export interface ActivityRef {
  objectType: 'Activity';
  id: string;
}

export interface Activity extends ActivityRef {
  definition: { type: string; name: Record<string, string>; description?: Record<string, string> };
}

export interface XapiScore {
  scaled?: number;
  raw?: number;
  min?: number;
  max?: number;
}

export interface XapiResult {
  success?: boolean;
  completion?: boolean;
  response?: string;
  /** ISO 8601 duration. */
  duration?: string;
  score?: XapiScore;
  extensions?: Record<string, unknown>;
}

export interface XapiContextActivities {
  parent?: ActivityRef[];
  grouping?: ActivityRef[];
  category?: ActivityRef[];
  other?: ActivityRef[];
}

export interface StatementRef {
  objectType: 'StatementRef';
  id: string;
}

export interface XapiContext {
  registration: string;
  platform?: string;
  language?: string;
  contextActivities?: XapiContextActivities;
  extensions?: Record<string, unknown>;
  statement?: StatementRef;
}

export interface XapiVerb {
  id: string;
  display: Record<string, string>;
}

export interface XapiStatement {
  id: string;
  actor: XapiAgent;
  verb: XapiVerb;
  object: Activity | ActivityRef;
  result?: XapiResult;
  context: XapiContext;
  timestamp: string;
}

/** The cmi5 contextTemplate the LMS supplies (or the server builds in options 2 and 3). */
export interface ContextTemplate {
  contextActivities?: XapiContextActivities;
  extensions?: Record<string, unknown>;
}

/** cmi5 defined verbs. */
export type DefinedVerb = 'launched' | 'initialized' | 'completed' | 'passed' | 'failed' | 'terminated' | 'waived' | 'satisfied' | 'abandoned';

/** cmi5 allowed verbs the course server or badge issuer writes. */
export type AllowedVerb = 'experienced' | 'answered' | 'passed' | 'failed' | 'placed' | 'branched' | 'caught' | 'revealed' | 'earned';

export type ActivityKind = 'course' | 'block' | 'au' | 'path' | 'beat' | 'checkpoint' | 'file' | 'planted-bug' | 'achievement';
