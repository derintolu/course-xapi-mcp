// SPDX-License-Identifier: Apache-2.0
// Behavioural checks against the starter files, the planted bug and the reference solution (design §12),
// and the secret-field rules of the two package flavours: CXM-PKG-014, 022-025, 027.
import { makeIssue, runChecks } from '@course-xapi-mcp/core';
import type { Check, IssueCode, ValidationIssue } from '@course-xapi-mcp/core';
import type { LessonDoc } from './validate.ts';

/** True when the check can run at all; a regex that does not compile is CXM-PKG-021, not a behavioural failure. */
function runnable(c: Check): boolean {
  if (c.type !== 'regex') return true;
  try {
    new RegExp(c.pattern, c.flags);
    return true;
  } catch {
    return false;
  }
}

/** Runs one check alone on a set of files. */
const passes = (c: Check, files: Record<string, string>) => runChecks([c] as Parameters<typeof runChecks>[0], files).passed;

export function behaviourIssues(lessons: LessonDoc[], flavour: 'authoring' | 'distribution'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const { key, file, base, lesson } of lessons) {
    const add = (code: IssueCode, pointer: string, message: string) => issues.push(makeIssue(code, { file, pointer: base + pointer || '/' }, message));
    const checks = (lesson.checkpoint?.checks ?? []) as Check[];
    const bug = lesson.bug;
    const solution = lesson.referenceSolution;

    checks.forEach((c, i) => {
      if (!runnable(c)) return;
      if (passes(c, lesson.starterFiles ?? {})) add('CXM-PKG-022', `/checkpoint/checks/${i}`, `Check ${i} of lesson "${key}" already passes on the starter files.`);
      if (solution && !passes(c, solution.files)) add('CXM-PKG-023', `/checkpoint/checks/${i}`, `Check ${i} of lesson "${key}" fails on referenceSolution.files.`);
    });
    if (bug?.fixChecks) {
      (bug.fixChecks as Check[]).forEach((c, i) => {
        if (!runnable(c)) return;
        if (passes(c, { [bug.file]: bug.code })) add('CXM-PKG-024', `/bug/fixChecks/${i}`, `Fix check ${i} of lesson "${key}" already passes on the planted bug code.`);
        if (solution?.bugFix !== undefined && !passes(c, { [bug.file]: solution.bugFix })) {
          add('CXM-PKG-025', `/bug/fixChecks/${i}`, `Fix check ${i} of lesson "${key}" fails on referenceSolution.bugFix.`);
        }
      });
    }

    if (flavour === 'distribution') {
      if (bug?.explanation !== undefined) add('CXM-PKG-014', '/bug/explanation', `The distribution package keeps the secret bug explanation of lesson "${key}".`);
      if (bug?.fixChecks !== undefined) add('CXM-PKG-014', '/bug/fixChecks', `The distribution package keeps the secret fix checks of lesson "${key}".`);
      if (solution !== undefined) add('CXM-PKG-014', '/referenceSolution', `The distribution package keeps the secret reference solution of lesson "${key}".`);
    } else {
      const code = lesson.checkpoint?.kind === 'code';
      if ((code || bug) && !solution) add('CXM-PKG-027', '', `Lesson "${key}" has ${code ? 'a code checkpoint' : 'a planted bug'} but no referenceSolution.`);
      else if (bug && solution && solution.bugFix === undefined) add('CXM-PKG-027', '/referenceSolution', `Lesson "${key}" has a planted bug but referenceSolution has no bugFix.`);
    }
  }
  return issues;
}
