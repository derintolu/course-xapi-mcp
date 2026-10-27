// SPDX-License-Identifier: Apache-2.0
import { ERROR_HELP_BASE, ISSUE_CATALOG } from '@course-xapi-mcp/core';
import type { IssueCode, Severity } from '@course-xapi-mcp/core';

export interface CodeExplanation {
  code: IssueCode;
  severity: Severity;
  title: string;
  fix: string;
  help: string;
}

/** The catalog entry for a validator code, or undefined when the code is unknown. */
export function explainCode(code: string): CodeExplanation | undefined {
  if (!Object.hasOwn(ISSUE_CATALOG, code)) return undefined;
  const c = code as IssueCode;
  const e = ISSUE_CATALOG[c];
  return { code: c, severity: e.severity, title: e.title, fix: e.fix, help: ERROR_HELP_BASE + c };
}
