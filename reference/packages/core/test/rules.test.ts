// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_RULES, RULES_URI, RULES_VERSION, agentInstructions, rulesBlock, tutorSkill } from '../src/index.ts';
import { course as engineCourse } from './fixtures/course-model.ts';

const loadCourse = () => ({ ...engineCourse, rules: ['When the learner writes JSON, ask them to read it back as types.'] });

describe('agent rules', () => {
  it('ship the exact text of spec/draft/agent-rules.md (run scripts/sync-rules.mjs after editing it)', () => {
    expect(AGENT_RULES).toBe(readFileSync(new URL('../../../../spec/draft/agent-rules.md', import.meta.url), 'utf8'));
  });

  it('name their version in the heading', () => {
    expect(AGENT_RULES).toContain(`rules ${RULES_VERSION}`);
  });

  it('are version 0.2 and cover custody, reveal and LMS return, without link_record', () => {
    expect(RULES_VERSION).toBe('0.2');
    expect(AGENT_RULES).toContain('# Teaching rules for agents (course-xapi-mcp rules 0.2)');
    for (const w of ['get_status', 'reveal_bug', 'return-to-lms']) expect(AGENT_RULES).toContain(w);
    expect(AGENT_RULES).not.toContain('link_record');
  });

  it('make the tutor skill a SKILL.md with front matter then the instructions', () => {
    const c = loadCourse();
    const skill = tutorSkill(c);
    expect(skill.startsWith('---\nname: course-xapi-mcp-tutor\n')).toBe(true);
    expect(skill).toMatch(/\ndescription: [^\n]+\n---\n/);
    expect(skill).toContain(agentInstructions(c));
  });

  it('append course rules after the core rules without dropping any', () => {
    const course = loadCourse();
    const text = agentInstructions(course);
    expect(text.startsWith(AGENT_RULES)).toBe(true);
    expect(text).toContain(course.rules![0]);
    expect(rulesBlock(course)).toMatchObject({ version: RULES_VERSION, full: RULES_URI, course: course.rules });
  });
});
