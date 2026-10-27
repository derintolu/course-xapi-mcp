// SPDX-License-Identifier: Apache-2.0
// The in-memory course model, read from a cmi5 package with cxm extensions.

export type CustodyOption = 'lms-launched' | 'author-lrs' | 'server-kept' | 'practice';
export const CUSTODY_OPTIONS = ['lms-launched', 'author-lrs', 'server-kept', 'practice'] as const satisfies readonly CustodyOption[];

export type Check =
  | { type: 'contains' | 'notContains'; file: string; value: string; message: string }
  | { type: 'regex'; file: string; pattern: string; flags?: string; message: string }
  | { type: 'json'; file: string; pointer: string; equals: unknown; message: string };

export interface Source {
  title: string;
  url: string;
}

export interface Beat {
  key: string;
  goal: string;
  content: string;
  question?: string;
}

export interface Branch {
  key: string;
  when: string;
  success: boolean;
  /** A lesson key, or null for "end of path". */
  to: string | null;
  message: string;
}

export interface Checkpoint {
  key: string;
  kind: 'free-text' | 'code';
  question: string;
  rubric: string;
  file?: string;
  checks?: Check[];
  branches: Branch[];
  maxAttempts?: number;
}

/** `explanation` and `fixChecks` are secret until the bug is caught or revealed. */
export interface PlantedBug {
  key: string;
  file: string;
  code: string;
  hint?: string;
  revealAfter?: number | null;
  explanation: string;
  fixChecks: Check[];
}

/** Secret: authoring packages only, used by the validator. */
export interface ReferenceSolution {
  files: Record<string, string>;
  bugFix?: string;
}

export interface LessonModel {
  key: string;
  auId: string;
  pathKey: string;
  title: string;
  description: string;
  url: string;
  moveOn: 'Completed' | 'CompletedAndPassed';
  minutes: number;
  sources: Source[];
  beats: Beat[];
  starterFiles?: Record<string, string>;
  bug?: PlantedBug;
  checkpoint?: Checkpoint;
  referenceSolution?: ReferenceSolution;
}

export interface PathModel {
  key: string;
  /** The cmi5 block id; absent for coming-soon paths. */
  blockId?: string;
  title: string;
  description?: string;
  tagline: string;
  status: 'live' | 'coming-soon';
  lessons: string[];
  placementHints?: string;
}

export interface PlacementModel {
  key: string;
  auId: string;
  url: string;
  title: string;
  intro: string;
  maxQuestions: number;
}

export interface BadgeAlignment {
  targetName: string;
  targetUrl: string;
  targetDescription?: string;
  targetFramework?: string;
  targetCode?: string;
  targetType?: string;
}

export interface BadgeDecl {
  id: string;
  name: string;
  description: string;
  criteria: { narrative: string };
  /** Image URL. */
  image?: string;
  achievementType: string;
  alignment?: BadgeAlignment[];
  awardOn: 'au-moveon' | 'block-satisfied' | 'course-satisfied' | 'any-path';
  /** Lesson key for `au-moveon`, path key for `block-satisfied`; absent otherwise. */
  for?: string;
  countWaived: boolean;
  includeScore: boolean;
}

export interface BadgeIssuerDecl {
  signer: 'record-holder' | 'course-server';
  claimPage: string;
  name?: string;
}

export interface CourseModel {
  specVersion: string;
  flavour: 'authoring' | 'distribution';
  id: string;
  title: string;
  description: string;
  mcp: string;
  version: string;
  language: string;
  license?: string;
  rules: string[];
  placement: PlacementModel;
  custody: CustodyOption;
  allowPractice: boolean;
  badges: BadgeDecl[];
  badgeIssuer?: BadgeIssuerDecl;
  paths: Record<string, PathModel>;
  lessons: Record<string, LessonModel>;
  extensions?: Record<string, unknown>;
}
