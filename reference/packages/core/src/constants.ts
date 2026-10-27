// SPDX-License-Identifier: Apache-2.0
// Fixed names, IRIs and values shared by every course-xapi-mcp package.

export const SPEC_VERSION = '0.2';
export const SITE = 'https://course-xapi-mcp.sqwrlz.com';
export const EXTENSION_ID = 'com.sqwrlz/course-xapi-mcp';

export const CXM_XML_NS = SITE + '/course/v1';
export const CMI5_XML_NS = 'https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd';

export const PROFILE_ID = SITE + '/xapi';
export const PROFILE_VERSION_IRI = SITE + '/xapi/v0.2';
export const PRACTICE_CATEGORY = SITE + '/xapi/practice';
export const PRACTICE_HOMEPAGE = SITE + '/practice-learner';

const verb = (k: string) => `${SITE}/xapi/verbs/${k}`;
export const CXM_VERBS = {
  placed: verb('placed'),
  branched: verb('branched'),
  caught: verb('caught'),
  revealed: verb('revealed'),
} as const;

const activityType = (k: string) => `${SITE}/xapi/activity-types/${k}`;
export const CXM_ACTIVITY_TYPES = {
  path: activityType('path'),
  beat: activityType('beat'),
  checkpoint: activityType('checkpoint'),
  file: activityType('file'),
  'planted-bug': activityType('planted-bug'),
  achievement: activityType('achievement'),
} as const;

const ext = (k: string) => `${SITE}/xapi/extensions/${k}`;
export const CXM_EXT = {
  branch: ext('branch'),
  to: ext('to'),
  rationale: ext('rationale'),
  checks: ext('checks'),
  'start-lesson': ext('start-lesson'),
  skipped: ext('skipped'),
  'waive-recommended': ext('waive-recommended'),
  'carried-over': ext('carried-over'),
  attempt: ext('attempt'),
  'rules-version': ext('rules-version'),
  custody: ext('custody'),
} as const;

export const CMI5 = {
  categoryCmi5: 'https://w3id.org/xapi/cmi5/context/categories/cmi5',
  categoryMoveOn: 'https://w3id.org/xapi/cmi5/context/categories/moveon',
  extSessionId: 'https://w3id.org/xapi/cmi5/context/extensions/sessionid',
  extReason: 'https://w3id.org/xapi/cmi5/result/extensions/reason',
  extMasteryScore: 'https://w3id.org/xapi/cmi5/context/extensions/masteryscore',
} as const;

const adl = (k: string) => `http://adlnet.gov/expapi/verbs/${k}`;
const adlW3id = (k: string) => `https://w3id.org/xapi/adl/verbs/${k}`;
export const ADL_VERBS = {
  launched: adl('launched'),
  initialized: adl('initialized'),
  completed: adl('completed'),
  passed: adl('passed'),
  failed: adl('failed'),
  terminated: adl('terminated'),
  experienced: adl('experienced'),
  answered: adl('answered'),
  waived: adlW3id('waived'),
  satisfied: adlW3id('satisfied'),
  abandoned: adlW3id('abandoned'),
} as const;

export const OB_XAPI = {
  earned: 'http://specification.openbadges.org/xapi/verbs/earned',
  badgeAssertion: 'http://specification.openbadges.org/xapi/extensions/badgeassertion',
} as const;

/** Activity ids derived from the publisher AU id (the cmi5 `au@id`). */
export const activityIds = {
  au: (auId: string) => auId + '/au',
  beat: (auId: string, key: string) => `${auId}/beats/${key}`,
  checkpoint: (auId: string, key: string) => `${auId}/checkpoints/${key}`,
  file: (auId: string, name: string) => `${auId}/files/${encodeURIComponent(name)}`,
  bug: (auId: string, key: string) => `${auId}/bugs/${key}`,
} as const;

export const URIS = {
  rules: 'course-xapi-mcp://rules/agent',
  course: 'course-xapi-mcp://course',
  recordExport: 'course-xapi-mcp://record/export',
  tutorSkill: 'skill://course-xapi-mcp-tutor/SKILL.md',
  authorSkill: 'skill://course-xapi-mcp-author/SKILL.md',
} as const;

export const PRACTICE_LABEL = 'Practice run: this is not an official record, and it cannot earn badges.';

export const DEFAULTS = {
  /** AU session idle timeout: 30 min. */
  sessionIdleMs: 1_800_000,
  /** Option-1 session cap after the AU token fetch: 50 min. */
  lmsSessionMaxMs: 3_000_000,
  /** Failed fix attempts before a planted bug may be revealed. */
  revealAfter: 3,
  pairingCodeLength: 6,
  pairingAlphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  /** Pairing code lifetime: 10 min, single use. */
  pairingTtlMs: 600_000,
  /** Practice relay TTL: 30 days. */
  practiceTtlMs: 2_592_000_000,
  statusListLength: 131_072,
  accessTokenTtlS: 3600,
  /** Refresh token lifetime: 30 days. */
  refreshTokenTtlS: 2_592_000,
  authCodeTtlS: 60,
} as const;

export const STATE_IDS = {
  learner: 'cxm-learner-state',
  registration: 'cxm-current-registration',
} as const;

export const ERROR_HELP_BASE = SITE + '/errors/';

export const TOOL_NAMES = [
  'get_status',
  'list_paths',
  'start_placement',
  'choose_placement',
  'get_lesson',
  'next_beat',
  'check_code',
  'reveal_bug',
  'submit_checkpoint',
  'choose_branch',
  'end_session',
  'get_record',
  'get_badges',
  'restart_course',
  'resume_practice',
  'delete_practice_record',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
