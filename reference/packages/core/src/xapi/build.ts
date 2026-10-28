// SPDX-License-Identifier: Apache-2.0
// Builders for cmi5-shaped statements (design §10.3; cmi5 §9.4, §9.5, §9.6).
import { CMI5, CXM_ACTIVITY_TYPES, CXM_EXT, OB_XAPI, PRACTICE_CATEGORY, PROFILE_VERSION_IRI } from '../constants.ts';
import type { CustodyOption } from '../model.ts';
import { ACTIVITY_TYPE, CMI5_ACTIVITY_TYPES, DURATION_VERBS, OUTCOME_VERBS, VERB_IRI } from './templates.ts';
import type {
  Activity,
  ActivityKind,
  ActivityRef,
  AllowedVerb,
  ContextTemplate,
  DefinedVerb,
  XapiAgent,
  XapiContext,
  XapiContextActivities,
  XapiResult,
  XapiStatement,
} from './types.ts';

/** Everything a statement needs to know about the learner, registration, AU session and record holder. */
export interface Cmi5Context {
  actor: XapiAgent;
  registration: string;
  sessionId: string;
  /** The course activity id; the second grouping activity on every statement. */
  courseId: string;
  language: string;
  rulesVersion: string;
  custody: CustodyOption;
  practice: boolean;
  platform?: string;
  /** The cmi5 contextTemplate from `LMS.LaunchData` (option 1), or the one the server builds in options 2 and 3. */
  contextTemplate?: ContextTemplate;
}

/** The AU as cmi5 names it: the publisher id from the course structure and the launch activityId. */
export interface AuTarget {
  publisherId: string;
  activityId: string;
}

export type DefinedTarget = { au: AuTarget } | { blockId: string } | { courseId: string };

export interface DefinedOptions {
  id: string;
  timestamp: string;
  /** ISO 8601; required on completed, passed, failed, terminated and abandoned. */
  duration?: string;
  /** Required on waived. */
  reason?: 'Tested Out' | 'Administrative';
  success?: boolean;
  completion?: boolean;
  /** Result extensions. */
  extensions?: Record<string, unknown>;
}

const act = (id: string): ActivityRef => ({ objectType: 'Activity', id });

function addUnique(list: ActivityRef[], more: ActivityRef[] | undefined): ActivityRef[] {
  for (const a of more ?? []) if (!list.some((x) => x.id === a.id)) list.push({ ...a, objectType: 'Activity' });
  return list;
}

/** The context of an `earned` statement: its session id only when it is sent inside an open AU session. */
export type EarnedContext = Omit<Cmi5Context, 'sessionId'> & { sessionId?: string };

function baseContext(c: EarnedContext, grouping: string[], category: string[], parent?: string): XapiContext {
  const t = c.contextTemplate;
  const tSession = t?.extensions?.[CMI5.extSessionId];
  if (tSession !== undefined && tSession !== c.sessionId) {
    throw new Error(`the contextTemplate session id ${String(tSession)} differs from the session id ${c.sessionId}`);
  }
  const ca: XapiContextActivities = {};
  const parents = addUnique(parent ? [act(parent)] : [], t?.contextActivities?.parent);
  if (parents.length) ca.parent = parents;
  ca.grouping = addUnique(addUnique([], grouping.map(act)), t?.contextActivities?.grouping);
  ca.category = addUnique(addUnique([], category.map(act)), t?.contextActivities?.category);
  if (c.practice) addUnique(ca.category, [act(PRACTICE_CATEGORY)]);
  const other = addUnique([], t?.contextActivities?.other);
  if (other.length) ca.other = other;

  const ctx: XapiContext = {
    registration: c.registration,
    language: c.language,
    contextActivities: ca,
    extensions: {
      ...t?.extensions,
      ...(c.sessionId !== undefined ? { [CMI5.extSessionId]: c.sessionId } : {}),
      [CXM_EXT['rules-version']]: c.rulesVersion,
      [CXM_EXT.custody]: c.custody,
    },
  };
  if (c.platform) ctx.platform = c.platform;
  return ctx;
}

function statement(c: EarnedContext, verb: DefinedVerb | AllowedVerb, object: Activity | ActivityRef, context: XapiContext, o: { id: string; timestamp: string }, result?: XapiResult): XapiStatement {
  const s: XapiStatement = {
    id: o.id,
    actor: structuredClone(c.actor),
    verb: { id: VERB_IRI[verb], display: { [c.language]: verb } },
    object,
    context,
    timestamp: o.timestamp,
  };
  if (result && Object.keys(result).length) s.result = result;
  return s;
}

const FORCED: Partial<Record<DefinedVerb, { success?: boolean; completion?: boolean }>> = {
  passed: { success: true },
  failed: { success: false },
  completed: { completion: true },
  waived: { success: true, completion: true },
};

/** A cmi5 defined statement. The object is the AU activityId, or the block or course for `satisfied`. */
export function buildDefined(c: Cmi5Context, verb: DefinedVerb, target: DefinedTarget, o: DefinedOptions): XapiStatement {
  let object: ActivityRef;
  const grouping: string[] = [];
  if ('au' in target) {
    if (verb === 'satisfied') throw new Error('"satisfied" takes a block or course object, not an AU');
    object = act(target.au.activityId);
    grouping.push(target.au.publisherId);
  } else {
    if (verb !== 'satisfied') throw new Error(`"${verb}" takes the AU as its object`);
    const [id, type] = 'blockId' in target ? [target.blockId, CMI5_ACTIVITY_TYPES.block] : [target.courseId, CMI5_ACTIVITY_TYPES.course];
    // cmi5 9.4: block and course objects carry their cmi5 activity type; they have no name to give.
    const typed = { objectType: 'Activity' as const, id, definition: { type } };
    object = typed;
  }
  grouping.push(c.courseId);

  const forced = FORCED[verb] ?? {};
  for (const k of ['success', 'completion'] as const) {
    if (forced[k] !== undefined && o[k] !== undefined && o[k] !== forced[k]) throw new Error(`"${verb}" needs result.${k} ${forced[k]}`);
  }
  if (DURATION_VERBS.includes(verb) && !o.duration) throw new Error(`"${verb}" needs a duration`);
  if (verb === 'waived' && !o.reason) throw new Error('"waived" needs a reason');

  const result: XapiResult = {};
  const success = forced.success ?? o.success;
  const completion = forced.completion ?? o.completion;
  if (success !== undefined) result.success = success;
  if (completion !== undefined) result.completion = completion;
  if (o.duration) result.duration = o.duration;
  const extensions = { ...(o.reason ? { [CMI5.extReason]: o.reason } : {}), ...o.extensions };
  if (Object.keys(extensions).length) result.extensions = extensions;

  const category: string[] = [CMI5.categoryCmi5];
  if (success !== undefined || completion !== undefined) category.push(CMI5.categoryMoveOn);
  return statement(c, verb, object, baseContext(c, grouping, category), o, result);
}

function stripCmi5Categories(s: XapiStatement): XapiStatement {
  const ca = s.context.contextActivities!;
  ca.category = ca.category!.filter((a) => a.id !== CMI5.categoryCmi5 && a.id !== CMI5.categoryMoveOn);
  return s;
}

/** A cmi5 allowed statement about an activity inside the AU; the parent is the AU activityId. */
export function buildAllowed(
  c: Cmi5Context,
  verb: AllowedVerb,
  object: { id: string; kind: ActivityKind; name: string },
  parent: AuTarget,
  o: { id: string; timestamp: string; result?: XapiResult },
): XapiStatement {
  if (verb === 'earned') throw new Error('"earned" statements are built with buildEarned');
  const type = ACTIVITY_TYPE[object.kind];
  if (!type) throw new Error(`no activity type for an object of kind "${object.kind}"`);
  const activity: Activity = { objectType: 'Activity', id: object.id, definition: { type, name: { [c.language]: object.name } } };
  const context = baseContext(c, [parent.publisherId, c.courseId], [PROFILE_VERSION_IRI], parent.activityId);
  return stripCmi5Categories(statement(c, verb, activity, context, o, o.result));
}

/**
 * The Open Badges `earned` statement, pointing at the statement that earned the badge and at the credential.
 * `earned` is the issuer's statement, not the AU's: it carries the cmi5 session id (and the session's contextTemplate)
 * only when `c.sessionId` is given, for an `earned` sent inside an open AU session.
 */
export function buildEarned(
  c: EarnedContext,
  achievement: { id: string; name: string },
  credentialId: string,
  earningStatementId: string,
  o: { id: string; timestamp: string },
): XapiStatement {
  const activity: Activity = { objectType: 'Activity', id: achievement.id, definition: { type: CXM_ACTIVITY_TYPES.achievement, name: { [c.language]: achievement.name } } };
  const context = baseContext(c, [c.courseId], [PROFILE_VERSION_IRI]);
  context.statement = { objectType: 'StatementRef', id: earningStatementId };
  const result: XapiResult = { extensions: { [OB_XAPI.badgeAssertion]: { '@id': credentialId } } };
  return stripCmi5Categories(statement(c, 'earned', activity, context, o, result));
}
