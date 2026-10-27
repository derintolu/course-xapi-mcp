// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_RULES, RULES_VERSION, agentInstructions, rulesBlock } from '../src/index.ts';
import { loadCourse } from './fixtures.ts';

describe('agent rules', () => {
  it('ship the exact text of rules/AGENT_RULES.md (run scripts/sync-rules.mjs after editing it)', () => {
    expect(AGENT_RULES).toBe(readFileSync(new URL('../../../../rules/AGENT_RULES.md', import.meta.url), 'utf8'));
  });

  it('name their version in the heading', () => {
    expect(AGENT_RULES).toContain(`rules ${RULES_VERSION}`);
  });

  it('append course rules after the core rules without dropping any', () => {
    const course = loadCourse();
    const text = agentInstructions(course);
    expect(text.startsWith(AGENT_RULES)).toBe(true);
    expect(text).toContain(course.rules![0]);
    expect(rulesBlock(course)).toMatchObject({ version: RULES_VERSION, full: 'learning-mcp://rules/agent', course: course.rules });
  });
});
