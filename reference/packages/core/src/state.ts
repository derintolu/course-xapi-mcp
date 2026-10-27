// SPDX-License-Identifier: Apache-2.0
// Learner state the custody adapter keeps between tool calls. Timestamps are ISO 8601 strings.
import type { XapiStatement } from './xapi/types.ts';

export type Phase = 'beats' | 'bug' | 'checkpoint' | 'branch' | 'review' | 'done';

export interface Placement {
  pathKey: string;
  startLessonKey: string;
  skip: string[];
  reason: string;
}

export interface Cursor {
  pathKey: string;
  lessonKey: string;
  beat: number;
  phase: Phase;
  awaitingReply?: boolean;
  review?: { lessonKey: string; beat: number };
}

/** An open cmi5 AU session. `id` is the cmi5 session id. */
export interface AuSession {
  id: string;
  auKey: string;
  startedAt: string;
  lastActivityAt: string;
  attempts: number;
  launchId?: string;
  /** The AU's publisher id, kept so the session can still be terminated after a course update removes its lesson. */
  auId?: string;
}

export interface AuProgress {
  completed: boolean;
  passed: boolean;
  failed: boolean;
  waived?: 'Tested Out' | 'Administrative';
  carriedOver: boolean;
  fixAttempts: number;
  bug?: 'caught' | 'revealed';
}

export interface PendingCheckpoint {
  lessonKey: string;
  checkpointKey: string;
  checksPassed: boolean | null;
  allowed: string[];
}

export interface LearnerState {
  v: 1;
  courseVersion: string;
  registration: string;
  createdAt: string;
  updatedAt: string;
  placement?: Placement;
  cursor?: Cursor;
  session?: AuSession;
  au: Record<string, AuProgress>;
  satisfied: { blocks: string[]; course: boolean };
  files: Record<string, string>;
  pending?: PendingCheckpoint;
  /** Statements built but not yet accepted by the record holder; redelivered by statement id. */
  outbox: XapiStatement[];
  awards: { badgeId: string; statementId: string }[];
}

export type SatisfactionEvent =
  | { type: 'au'; lessonKey: string; statementId: string; waived: boolean; carriedOver: boolean }
  | { type: 'block'; pathKey: string; statementId: string }
  | { type: 'course'; statementId: string };
