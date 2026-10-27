// SPDX-License-Identifier: Apache-2.0
// Interfaces between the session engine and whoever holds the record, launches, authenticates and issues badges.
import type { CustodyOption } from './model.ts';
import type { LearnerState } from './state.ts';
import type { ContextTemplate, XapiAgent, XapiStatement } from './xapi/types.ts';

export interface LearnerRef {
  kind: 'official' | 'practice';
  subject: string;
  actor: XapiAgent;
  handle?: string;
  launchId?: string;
}

export interface RecordLinks {
  holder: string;
  view?: string;
  export?: string;
  delete?: string;
  policy?: string;
}

export interface RecordView {
  official: boolean;
  statements: XapiStatement[];
  receipt?: { id: string; verb: string; object: string; timestamp: string }[];
  complete: boolean;
  note: string;
}

export interface Custody {
  readonly option: CustodyOption;
  readonly official: boolean;
  load(l: LearnerRef): Promise<{ state?: LearnerState; etag?: string }>;
  /** Throws `StoreConflictError` when another call saved since `etag` was read. */
  save(l: LearnerRef, state: LearnerState, etag?: string): Promise<{ etag: string }>;
  /** Throws `StoreError` when the record holder does not accept the statements. */
  deliver(l: LearnerRef, statements: XapiStatement[]): Promise<void>;
  record(l: LearnerRef): Promise<RecordView>;
  links(l: LearnerRef): RecordLinks;
}

/** One cmi5 launch held by the bridge (option 1). Timestamps are ISO 8601 strings. */
export interface LaunchContext {
  launchId: string;
  endpoint: string;
  authToken: string;
  tokenFetchedAt: string;
  actor: XapiAgent;
  registration: string;
  activityId: string;
  auId: string;
  auKey: string;
  contextTemplate: ContextTemplate;
  launchMode: 'Normal' | 'Browse' | 'Review';
  moveOn: 'Passed' | 'Completed' | 'CompletedAndPassed' | 'CompletedOrPassed' | 'NotApplicable';
  returnURL?: string;
  sessionId: string;
  initializedAt: string;
  terminatedAt?: string;
  pairingCode: string;
  pairingExpiresAt: string;
  pairedSubject?: string;
}

export interface LaunchStore {
  put(c: LaunchContext): Promise<void>;
  get(launchId: string): Promise<LaunchContext | undefined>;
  byPairingCode(code: string): Promise<LaunchContext | undefined>;
  latestFor(endpoint: string, actorKey: string, registration: string): Promise<LaunchContext | undefined>;
  update(launchId: string, patch: Partial<LaunchContext>): Promise<void>;
}

export interface AuthServer {
  routes(req: Request): Promise<Response | undefined>;
  authenticate(req: Request): Promise<LearnerRef | Response>;
  browserLearner(req: Request): Promise<LearnerRef | undefined>;
}

export interface BadgeSummary {
  badgeId: string;
  name: string;
  earnedAt: string;
  claimed: boolean;
}

export interface Award {
  badgeId: string;
  registration: string;
  earningStatementId: string;
  /** How many waived (tested-out) lessons counted towards this award. */
  testedOut: number;
}

export interface BadgeService {
  summaries(l: LearnerRef): Promise<BadgeSummary[]>;
  claimPage: string;
  onAwards(l: LearnerRef, awards: Award[]): Promise<void>;
}
