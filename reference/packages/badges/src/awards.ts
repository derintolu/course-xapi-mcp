// SPDX-License-Identifier: Apache-2.0
// When a badge is earned: the declared cmi5 event, one award per badge per registration,
// with the waiver and carry-over rules of design §6.3 rule 5.
import type { Award, BadgeDecl, CourseModel, LearnerState, SatisfactionEvent } from '@course-xapi-mcp/core';

type BlockEvent = Extract<SatisfactionEvent, { type: 'block' }>;

export function awardsFor(course: CourseModel, state: LearnerState, events: SatisfactionEvent[]): Award[] {
  const held = new Set(state.awards.map((a) => a.badgeId));
  const out: Award[] = [];
  for (const badge of course.badges) {
    if (held.has(badge.id)) continue;
    const earned = earning(course, state, events, badge);
    if (!earned) continue;
    held.add(badge.id);
    out.push({
      badgeId: badge.id,
      registration: state.registration,
      earningStatementId: earned.statementId,
      testedOut: earned.scope.filter((k) => state.au[k]?.waived === 'Tested Out').length,
    });
  }
  return out;
}

/** The earning statement and the lessons in the badge's scope, or undefined when not earned. */
function earning(
  course: CourseModel,
  state: LearnerState,
  events: SatisfactionEvent[],
  badge: BadgeDecl,
): { statementId: string; scope: string[] } | undefined {
  const carriedOver = (scope: string[]) => scope.some((k) => state.au[k]?.carriedOver);
  const pathLessons = (pathKey: string) => course.paths[pathKey]?.lessons ?? [];
  switch (badge.awardOn) {
    case 'au-moveon': {
      const e = events.find((x) => x.type === 'au' && x.lessonKey === badge.for);
      if (!e || e.type !== 'au' || e.carriedOver || (e.waived && !badge.countWaived)) return undefined;
      const scope = [e.lessonKey];
      return carriedOver(scope) ? undefined : { statementId: e.statementId, scope };
    }
    case 'block-satisfied': {
      const e = events.find((x): x is BlockEvent => x.type === 'block' && x.pathKey === badge.for);
      if (!e) return undefined;
      const scope = pathLessons(e.pathKey);
      return carriedOver(scope) ? undefined : { statementId: e.statementId, scope };
    }
    case 'any-path': {
      const e = events.find((x): x is BlockEvent => x.type === 'block');
      if (!e) return undefined;
      const scope = pathLessons(e.pathKey);
      return carriedOver(scope) ? undefined : { statementId: e.statementId, scope };
    }
    case 'course-satisfied': {
      const e = events.find((x) => x.type === 'course');
      if (!e) return undefined;
      const scope = Object.values(course.paths)
        .filter((p) => p.status === 'live')
        .flatMap((p) => p.lessons);
      return carriedOver(scope) ? undefined : { statementId: e.statementId, scope };
    }
  }
}
