// SPDX-License-Identifier: Apache-2.0
// Validator issue catalog. Codes equal the CXM-PKG requirement ids; 0xx errors, 1xx info, 2xx warnings.
import { ERROR_HELP_BASE } from './constants.ts';

export type Severity = 'error' | 'warning' | 'info';

export interface IssueEntry {
  severity: Severity;
  title: string;
  fix: string;
}

const e = (title: string, fix: string): IssueEntry => ({ severity: 'error', title, fix });
const w = (title: string, fix: string): IssueEntry => ({ severity: 'warning', title, fix });
const i = (title: string, fix: string): IssueEntry => ({ severity: 'info', title, fix });

const catalog = {
  'CXM-PKG-001': e('ZIP unreadable, or no cmi5.xml at the root', 'Rebuild the ZIP with cmi5.xml at its root, not inside a folder.'),
  'CXM-PKG-002': e('cmi5.xml not valid against the cmi5 XSD', 'Correct cmi5.xml at the reported line so it validates against the cmi5 CourseStructure.xsd.'),
  'CXM-PKG-003': e('cxm: elements or attributes not valid against cxm.xsd', 'Correct the cxm: element or attribute so it matches cxm.xsd, and keep extension elements at the tail positions cmi5 allows.'),
  'CXM-PKG-004': e('no cxm:course, or specVersion major not supported', 'Add <cxm:course src="cxm/course.json" specVersion="..."/> to the course element with a supported specVersion.'),
  'CXM-PKG-005': e('a src reference points at a missing file or JSON Pointer', 'Point src at a file that exists in the package, and at a JSON Pointer that resolves in it.'),
  'CXM-PKG-006': e('cxm/course.json violates course.schema.json', 'Edit cxm/course.json at the reported pointer so it validates against course.schema.json.'),
  'CXM-PKG-007': e('a lesson JSON violates lesson.schema.json', 'Edit the lesson JSON at the reported pointer so it validates against lesson.schema.json.'),
  'CXM-PKG-008': e('duplicate cxm:key', 'Give every block and AU a cxm:key that no other block or AU uses.'),
  'CXM-PKG-009': e('cxm:key missing on a block or AU, or not [a-z0-9-]{1,64}', 'Add a cxm:key of 1-64 characters from a-z, 0-9 and - to the block or AU.'),
  'CXM-PKG-010': e('branch to is not a lesson key', 'Set the branch to field to the cxm:key of a lesson in the package, or to null.'),
  'CXM-PKG-011': e('branch to is in a different path', 'Point the branch at a lesson in the same path (block) as the checkpoint, or at null.'),
  'CXM-PKG-012': e("a live path's block has no AU", 'Add at least one lesson AU to the block, or mark the path coming-soon and remove the block.'),
  'CXM-PKG-013': e('moveOn is not CompletedAndPassed with a checkpoint / Completed without one', 'Set the AU moveOn to CompletedAndPassed when the lesson has a checkpoint and to Completed when it has none.'),
  'CXM-PKG-014': e('secret field in a distribution package', 'Remove the bug explanation, fix checks and reference solution from the distribution package; build it with the validator.'),
  'CXM-PKG-015': e('placement AU missing, not first, not NotApplicable, or more than one', 'Declare exactly one placement AU (cxm:role="placement"), first in the course, with moveOn="NotApplicable".'),
  'CXM-PKG-016': e('course.json#/paths and the blocks disagree (live path without block, block without path entry, coming-soon path with a block)', 'Give every live path one block and every block a path entry, and leave coming-soon paths out of cmi5.xml.'),
  'CXM-PKG-017': e('checkpoint has duplicate branch keys or no success: true branch', 'Make branch keys unique within the checkpoint and add at least one branch with success: true.'),
  'CXM-PKG-018': e('code checkpoint lacks file, checks or a success: false branch', 'Give the code checkpoint a file, at least one check and a branch with success: false.'),
  'CXM-PKG-019': e('duplicate beat keys in a lesson', 'Give every beat in the lesson a key no other beat in that lesson uses.'),
  'CXM-PKG-020': e('invalid file name', 'Use a relative POSIX path with no empty, "." or ".." segment, no backslash and no segment starting with a space.'),
  'CXM-PKG-021': e('a regex check does not compile', 'Correct the regex pattern or its flags (only i, m, s and u) so it compiles as a JavaScript RegExp.'),
  'CXM-PKG-022': e('a check passes on the starter files', 'Tighten the check so it fails on the starter files; a check that already passes proves nothing.'),
  'CXM-PKG-023': e('a check fails on the reference solution', 'Fix the check or the reference solution so the check passes on referenceSolution.files.'),
  'CXM-PKG-024': e('a fix check passes on the bug code', 'Tighten the fix check so it fails on the planted bug code.'),
  'CXM-PKG-025': e('a fix check fails on referenceSolution.bugFix', 'Fix the fix check or referenceSolution.bugFix so the check passes on the fixed code.'),
  'CXM-PKG-026': e('a success: false branch targets a lesson after the current one', 'Point the success: false branch at the current lesson, an earlier one in the path, or null.'),
  'CXM-PKG-027': e('authoring package: code checkpoint or bug without referenceSolution', 'Add referenceSolution (files, and bugFix when the lesson has a bug) to the lesson in the authoring package.'),
  'CXM-PKG-028': e('AU url is not https (http://127.0.0.1 and http://localhost allowed)', 'Use an https URL for the AU url; plain http is allowed only for 127.0.0.1 and localhost.'),
  'CXM-PKG-029': e('an AU, block or course id is not an absolute IRI, or two are equal', 'Give the course, every block and every AU a distinct absolute IRI as its id.'),
  'CXM-PKG-030': e('language not RFC 5646, or version not semver', 'Use an RFC 5646 language tag such as "en" and a semver version such as "1.0.0".'),
  'CXM-PKG-031': e('badges declared with custody practice, or allowPractice: true with custody practice', 'Remove badges or choose an official custody option, and drop allowPractice when custody is practice.'),
  'CXM-PKG-032': e('badge invalid: for missing/unknown for au-moveon/block-satisfied, present for course-satisfied/any-path, or id not https', 'Set for to a known lesson or path key only for au-moveon and block-satisfied, and give the badge an https id.'),
  'CXM-PKG-033': e('badges declared without badgeIssuer', 'Add badgeIssuer with signer and claimPage to course.json, or remove the badges.'),
  'CXM-PKG-034': e('the server was given a distribution package', 'Load the authoring package (*-authoring.zip) into the server; the distribution package is for LMSs.'),
  'CXM-PKG-100': i('unknown foreign extension element/attribute or extensions key (ignored)', 'No action needed unless the extension was meant for this server; check its namespace or key spelling.'),
  'CXM-PKG-201': w("two branches' when texts overlap (word-set Jaccard >= 0.8)", 'Reword the branch when texts so each describes a clearly different learner answer.'),
  'CXM-PKG-202': w('regex with nested quantifiers (catastrophic backtracking risk)', 'Rewrite the pattern without a quantifier inside a quantified group, for example (a+)+.'),
  'CXM-PKG-203': w('beat content over 250 words', 'Split the beat into shorter beats of at most 250 words each.'),
  'CXM-PKG-204': w('content or rules address the agent out of scope', 'Remove instructions to the agent from content and rules beyond teaching this course; the core rules govern the agent.'),
  'CXM-PKG-205': w('lesson has no sources', 'Add at least one source (title and url) the lesson content is based on.'),
  'CXM-PKG-206': w('specVersion minor newer than supported', 'Check the package against the spec version this server supports, or upgrade the server.'),
} satisfies Record<string, IssueEntry>;

export type IssueCode = keyof typeof catalog;

export const ISSUE_CATALOG: Readonly<Record<IssueCode, IssueEntry>> = catalog;

export interface ValidationIssue {
  code: IssueCode;
  severity: Severity;
  file: string;
  xpath?: string;
  pointer?: string;
  message: string;
  fix: string;
  help: string;
}

export function makeIssue(code: IssueCode, at: { file: string; xpath?: string; pointer?: string }, message: string, fix?: string): ValidationIssue {
  const entry = ISSUE_CATALOG[code];
  return {
    code,
    severity: entry.severity,
    file: at.file,
    ...(at.xpath !== undefined ? { xpath: at.xpath } : {}),
    ...(at.pointer !== undefined ? { pointer: at.pointer } : {}),
    message,
    fix: fix ?? entry.fix,
    help: ERROR_HELP_BASE + code,
  };
}
