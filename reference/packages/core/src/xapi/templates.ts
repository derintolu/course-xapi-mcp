// SPDX-License-Identifier: Apache-2.0
// The (verb, object type) pairs the course-xapi-mcp profile allows, and the IRIs behind each name.
import { ADL_VERBS, CXM_ACTIVITY_TYPES, CXM_VERBS, OB_XAPI } from '../constants.ts';
import type { ActivityKind, AllowedVerb, DefinedVerb } from './types.ts';

export type TemplateKind = 'defined' | 'allowed' | 'badge';

export interface Template {
  verb: DefinedVerb | AllowedVerb;
  object: ActivityKind;
  kind: TemplateKind;
}

const defined = (verb: DefinedVerb, object: ActivityKind = 'au'): Template => ({ verb, object, kind: 'defined' });
const allowed = (verb: AllowedVerb, object: ActivityKind): Template => ({ verb, object, kind: 'allowed' });

/** One entry per statement template in the profile. */
export const TEMPLATES: Template[] = [
  defined('launched'),
  defined('initialized'),
  defined('completed'),
  defined('passed'),
  defined('failed'),
  defined('terminated'),
  defined('abandoned'),
  defined('waived'),
  defined('satisfied', 'block'),
  defined('satisfied', 'course'),
  allowed('placed', 'path'),
  allowed('experienced', 'beat'),
  allowed('answered', 'beat'),
  allowed('answered', 'checkpoint'),
  allowed('passed', 'checkpoint'),
  allowed('failed', 'checkpoint'),
  allowed('branched', 'checkpoint'),
  allowed('passed', 'file'),
  allowed('failed', 'file'),
  allowed('caught', 'planted-bug'),
  allowed('revealed', 'planted-bug'),
  { verb: 'earned', object: 'achievement', kind: 'badge' },
];

export const CMI5_ACTIVITY_TYPES = {
  block: 'https://w3id.org/xapi/cmi5/activitytype/block',
  course: 'https://w3id.org/xapi/cmi5/activitytype/course',
} as const;

/** The activity type IRI for each object kind. AU objects carry no type: cmi5 identifies them by the launch activityId. */
export const ACTIVITY_TYPE: Partial<Record<ActivityKind, string>> = { ...CMI5_ACTIVITY_TYPES, ...CXM_ACTIVITY_TYPES };

export const VERB_IRI: Record<DefinedVerb | AllowedVerb, string> = {
  ...ADL_VERBS,
  ...CXM_VERBS,
  earned: OB_XAPI.earned,
};

/** Defined verbs whose result carries success or completion, so the statement carries the moveOn category. */
export const OUTCOME_VERBS: readonly DefinedVerb[] = ['completed', 'passed', 'failed', 'waived'];

/** Defined verbs that require `result.duration` (cmi5 9.5.4). */
export const DURATION_VERBS: readonly DefinedVerb[] = ['completed', 'passed', 'failed', 'terminated', 'abandoned'];

/** Defined verbs the LMS role issues (cmi5 9.3): not part of an AU's own session order. */
export const LMS_VERBS: readonly DefinedVerb[] = ['launched', 'waived', 'satisfied', 'abandoned'];
