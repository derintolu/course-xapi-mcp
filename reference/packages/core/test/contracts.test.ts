// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  CXM_ACTIVITY_TYPES,
  CXM_EXT,
  CXM_VERBS,
  CXM_XML_NS,
  ERROR_HELP_BASE,
  PRACTICE_CATEGORY,
  PRACTICE_HOMEPAGE,
  PROFILE_ID,
  PROFILE_VERSION_IRI,
  SITE,
  TOOL_NAMES,
  activityIds,
} from '../src/constants.ts';
import { ISSUE_CATALOG, makeIssue } from '../src/issues.ts';

const allIris = (): string[] => [
  CXM_XML_NS,
  PROFILE_ID,
  PROFILE_VERSION_IRI,
  PRACTICE_CATEGORY,
  PRACTICE_HOMEPAGE,
  ERROR_HELP_BASE,
  ...Object.values(CXM_VERBS),
  ...Object.values(CXM_ACTIVITY_TYPES),
  ...Object.values(CXM_EXT),
];

describe('shared contracts', () => {
  it('puts every cxm IRI under the site', () => {
    for (const v of allIris()) expect(v.startsWith(SITE + '/')).toBe(true);
  });
  it('derives activity ids from the publisher AU id', () => {
    expect(activityIds.au('https://e.org/c/l1')).toBe('https://e.org/c/l1/au');
    expect(activityIds.file('https://e.org/c/l1', 'a b.json')).toBe('https://e.org/c/l1/files/a%20b.json');
  });
  it('has unique issue codes in the reserved ranges, each with a fix', () => {
    for (const [code, e] of Object.entries(ISSUE_CATALOG)) {
      expect(code).toMatch(/^CXM-PKG-(0\d\d|1\d\d|2\d\d)$/);
      expect(e.fix.length).toBeGreaterThan(10);
    }
    expect(makeIssue('CXM-PKG-014', { file: 'cxm/lessons/a.json', pointer: '/bug/explanation' }, 'm').help).toBe(SITE + '/errors/CXM-PKG-014');
  });
  it('lists 16 tools in order', () =>
    expect(TOOL_NAMES).toEqual([
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
    ]));
});
