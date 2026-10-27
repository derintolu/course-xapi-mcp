// SPDX-License-Identifier: Apache-2.0
// A small typed CourseModel for the session engine tests: a placement AU, path p (a, b, c) and path q (q1).
import type { CourseModel } from '../../src/model.ts';

export const COURSE_ID = 'https://course-xapi-mcp.sqwrlz.com/examples/engine-test';
const au = (key: string) => `${COURSE_ID}/lessons/${key}`;

export const BUG_EXPLANATION = 'The port was written as a quoted string, so a program reading it as a number fails.';
export const FIX_VALUE = '"port":8080';

export const course: CourseModel = {
  specVersion: '0.2',
  flavour: 'authoring',
  id: COURSE_ID,
  title: 'Engine test course',
  description: 'A course for the session engine tests.',
  mcp: 'https://mcp.example.org/mcp',
  version: '1.0.0',
  language: 'en',
  license: 'Apache-2.0',
  rules: [],
  placement: { key: 'placement', auId: `${COURSE_ID}/placement`, url: 'https://mcp.example.org/cmi5/launch?au=placement', title: 'Placement', intro: 'Find your start.', maxQuestions: 3 },
  custody: 'server-kept',
  allowPractice: true,
  badges: [],
  paths: {
    p: { key: 'p', blockId: `${COURSE_ID}/paths/p`, title: 'Path P', tagline: 'The main path', status: 'live', lessons: ['a', 'b', 'c'] },
    q: { key: 'q', blockId: `${COURSE_ID}/paths/q`, title: 'Path Q', tagline: 'A second path', status: 'live', lessons: ['q1'] },
  },
  lessons: {
    a: {
      key: 'a',
      auId: au('a'),
      pathKey: 'p',
      title: 'Lesson A',
      description: 'Free-text checkpoint.',
      url: 'https://mcp.example.org/cmi5/launch?au=a',
      moveOn: 'CompletedAndPassed',
      minutes: 5,
      sources: [{ title: 'Spec', url: 'https://example.org/spec' }],
      beats: [
        { key: 'a1', goal: 'Meet values', content: 'Values have types.' },
        { key: 'a2', goal: 'Predict', content: 'Quotes make strings.', question: 'Is "42" a number?' },
      ],
      checkpoint: {
        key: 'cp',
        kind: 'free-text',
        question: 'Why does the type matter?',
        rubric: 'Names both types and a reason.',
        branches: [
          { key: 'ready', when: 'Names both types and a reason', success: true, to: 'b', message: 'On to B.' },
          { key: 'review', when: 'Mixes the types up', success: false, to: 'a', message: 'Once more from the top.' },
          { key: 'skip', when: 'Already knows B well', success: true, to: 'c', message: 'Straight to C.' },
        ],
      },
    },
    b: {
      key: 'b',
      auId: au('b'),
      pathKey: 'p',
      title: 'Lesson B',
      description: 'Bug and code checkpoint.',
      url: 'https://mcp.example.org/cmi5/launch?au=b',
      moveOn: 'CompletedAndPassed',
      minutes: 10,
      sources: [],
      beats: [{ key: 'b1', goal: 'Read config', content: 'Configs are JSON.' }],
      starterFiles: { 'config.json': '{"port":"8080"}' },
      bug: {
        key: 'port',
        file: 'config.json',
        code: '{"port":"8080"}',
        hint: 'Look at the types.',
        explanation: BUG_EXPLANATION,
        fixChecks: [{ type: 'contains', file: 'config.json', value: FIX_VALUE, message: 'port is a number' }],
      },
      checkpoint: {
        key: 'cp',
        kind: 'code',
        question: 'Add a timeout of 30 and say why it is a number.',
        rubric: 'Explains the comparison with elapsed time.',
        file: 'config.json',
        checks: [{ type: 'json', file: 'config.json', pointer: '/timeout', equals: 30, message: 'timeout is the number 30' }],
        branches: [
          { key: 'fixed', when: 'Checks pass and the reason is right', success: true, to: 'c', message: 'Well done.' },
          { key: 'back', when: 'Needs the basics again', success: false, to: 'a', message: 'Back to A for a moment.' },
        ],
        maxAttempts: 2,
      },
    },
    c: {
      key: 'c',
      auId: au('c'),
      pathKey: 'p',
      title: 'Lesson C',
      description: 'No checkpoint.',
      url: 'https://mcp.example.org/cmi5/launch?au=c',
      moveOn: 'Completed',
      minutes: 3,
      sources: [],
      beats: [{ key: 'c1', goal: 'Wrap up', content: 'That is all.' }],
    },
    q1: {
      key: 'q1',
      auId: au('q1'),
      pathKey: 'q',
      title: 'Lesson Q1',
      description: 'The only lesson of path q.',
      url: 'https://mcp.example.org/cmi5/launch?au=q1',
      moveOn: 'Completed',
      minutes: 3,
      sources: [],
      beats: [{ key: 'q1a', goal: 'Hello', content: 'Hello from q.' }],
    },
  },
};

/** A deep copy with `mutate` applied, for course-update tests. */
export function variant(mutate: (c: CourseModel) => void): CourseModel {
  const c = structuredClone(course);
  mutate(c);
  return c;
}
