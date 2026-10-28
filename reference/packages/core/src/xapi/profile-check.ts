// SPDX-License-Identifier: Apache-2.0
// Conformance of one statement to the course-xapi-mcp profile templates (design §10.3).
import { CMI5, CXM_EXT, OB_XAPI, PRACTICE_CATEGORY, PRACTICE_HOMEPAGE, PROFILE_VERSION_IRI } from '../constants.ts';
import { CUSTODY_OPTIONS } from '../model.ts';
import { isIsoDuration } from './duration.ts';
import { ACTIVITY_TYPE, DURATION_VERBS, TEMPLATES, VERB_IRI, type Template, type TemplateKind } from './templates.ts';
import type { ActivityKind, DefinedVerb, XapiStatement } from './types.ts';

const MINTED_FORBIDDEN = ['mbox', 'mbox_sha1sum', 'openid', 'name'] as const;

/** The template a statement claims to follow: defined when it carries the cmi5 category, badge for `earned`, else allowed. */
function templateFor(s: XapiStatement, cats: string[]): { t?: Template; kind: TemplateKind; why?: string } {
  const kind: TemplateKind = cats.includes(CMI5.categoryCmi5) ? 'defined' : s.verb?.id === OB_XAPI.earned ? 'badge' : 'allowed';
  const verbs = TEMPLATES.filter((t) => t.kind === kind && VERB_IRI[t.verb] === s.verb?.id);
  if (!verbs.length) return { kind, why: `verb ${s.verb?.id} has no ${kind} template in the course-xapi-mcp profile` };
  const type = (s.object as { definition?: { type?: string } }).definition?.type;
  const objectKind = (Object.keys(ACTIVITY_TYPE) as ActivityKind[]).find((k) => ACTIVITY_TYPE[k] === type);
  const t = verbs.find((v) => (v.object === 'au' ? objectKind === undefined : v.object === objectKind));
  if (!t) return { kind, why: `verb "${verbs[0]!.verb}" may not be used with object type ${type ?? '(none: the AU)'} in a ${kind} statement` };
  return { t, kind };
}

/**
 * Returns a list of problems; empty means the statement conforms to the course-xapi-mcp profile.
 * `lmsActor: true` accepts an LMS-supplied actor (option 1), which is copied verbatim and may use any identifier.
 */
export function checkProfile(s: XapiStatement, o: { lmsActor?: boolean } = {}): string[] {
  const e: string[] = [];
  const ca = s.context?.contextActivities;
  const cats = (ca?.category ?? []).map((a) => a.id);
  const grouping = (ca?.grouping ?? []).map((a) => a.id);
  const practice = cats.includes(PRACTICE_CATEGORY);

  if (!o.lmsActor) {
    const a = s.actor as Record<string, unknown>;
    for (const k of MINTED_FORBIDDEN) if (a?.[k] !== undefined) e.push(`an actor the course server mints must not carry "${k}"`);
    const home = s.actor?.account?.homePage;
    if (practice && home !== PRACTICE_HOMEPAGE) e.push(`a practice actor must use the account homePage ${PRACTICE_HOMEPAGE}`);
    if (!practice && (home === undefined || !grouping.includes(home))) e.push('an actor the course server mints must use the course id as its account homePage');
  }

  if (!s.context?.registration) e.push('context.registration is required');
  const ext = s.context?.extensions ?? {};
  // `earned` is the issuer's statement: it carries the session id only when sent inside an open AU session.
  const earned = s.verb?.id === OB_XAPI.earned && !cats.includes(CMI5.categoryCmi5);
  const session = ext[CMI5.extSessionId];
  if (earned ? session !== undefined && (typeof session !== 'string' || !session) : typeof session !== 'string' || !session) e.push('the cmi5 sessionid context extension is required');
  if (typeof ext[CXM_EXT['rules-version']] !== 'string') e.push('the rules-version context extension is required');
  if (!CUSTODY_OPTIONS.includes(ext[CXM_EXT.custody] as never)) e.push(`the custody context extension must be one of ${CUSTODY_OPTIONS.join(', ')}`);
  if (!grouping.length) e.push('context.contextActivities.grouping must hold the publisher id and the course');

  const { t, kind, why } = templateFor(s, cats);
  if (!t) return [...e, why!];
  const r = s.result;

  if (kind === 'defined') {
    const verb = t.verb as DefinedVerb;
    const outcome = r?.success !== undefined || r?.completion !== undefined;
    if (outcome && !cats.includes(CMI5.categoryMoveOn)) e.push(`defined "${verb}" with success or completion needs the moveOn category`);
    if (!outcome && cats.includes(CMI5.categoryMoveOn)) e.push(`defined "${verb}" without success or completion must not carry the moveOn category`);
    if (cats.includes(PROFILE_VERSION_IRI)) e.push('defined statements carry the cmi5 category, not the profile version category');
    if (DURATION_VERBS.includes(verb) && !isIsoDuration(r?.duration)) e.push(`defined "${verb}" needs result.duration`);
    if ((verb === 'passed' || verb === 'waived') && r?.success !== true) e.push(`defined "${verb}" needs result.success true`);
    if (verb === 'failed' && r?.success !== false) e.push('defined "failed" needs result.success false');
    if ((verb === 'completed' || verb === 'waived') && r?.completion !== true) e.push(`defined "${verb}" needs result.completion true`);
    if (verb === 'waived' && typeof r?.extensions?.[CMI5.extReason] !== 'string') e.push('defined "waived" needs the cmi5 reason result extension');
    return e;
  }

  if (!cats.includes(PROFILE_VERSION_IRI)) e.push(`context.contextActivities.category must include ${PROFILE_VERSION_IRI}`);
  if (cats.includes(CMI5.categoryMoveOn)) e.push('only cmi5 defined statements may carry the moveOn category');

  if (kind === 'badge') {
    const assertion = r?.extensions?.[OB_XAPI.badgeAssertion] as { '@id'?: unknown } | undefined;
    if (typeof assertion?.['@id'] !== 'string') e.push('"earned" needs the badgeassertion result extension with an "@id"');
    if (s.context?.statement?.objectType !== 'StatementRef') e.push('"earned" needs context.statement referring to the earning statement');
    return e;
  }

  if (!ca?.parent?.length) e.push('context.contextActivities.parent must hold the AU activityId');
  const verb = t.verb;
  if ((verb === 'passed' || verb === 'caught') && r?.success !== true) e.push(`"${verb}" needs result.success true`);
  if (verb === 'failed' && r?.success !== false) e.push('"failed" needs result.success false');
  if (verb === 'answered' && typeof r?.response !== 'string') e.push('"answered" needs result.response');
  if (verb === 'branched') {
    const x = r?.extensions ?? {};
    if (typeof x[CXM_EXT.branch] !== 'string' || typeof x[CXM_EXT.rationale] !== 'string' || !(CXM_EXT.to in x)) e.push('"branched" needs the branch, to and rationale result extensions');
  }
  if (verb === 'placed' && typeof r?.extensions?.[CXM_EXT['start-lesson']] !== 'string') e.push('"placed" needs the start-lesson result extension');
  return e;
}
