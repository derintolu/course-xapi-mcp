// SPDX-License-Identifier: Apache-2.0
// Writes schema/draft/course.schema.json and lesson.schema.json from the zod schemas, and the tool schemas:
// schema/draft/tools/<tool>.input.schema.json (official endpoint), schema/draft/tools/practice/<tool>.input.schema.json
// (practice endpoint) and schema/draft/tools/<tool>.output.schema.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { TOOL_NAMES } from '../reference/packages/core/src/constants.ts';
import { courseJsonSchema, lessonJsonSchema } from '../reference/packages/core/src/package/schemas.ts';
import { toolInputJsonSchema, toolOutputJsonSchema } from '../reference/packages/server/src/tool-schemas.ts';

const write = (name: string, schema: unknown) => {
  writeFileSync(new URL(`../schema/draft/${name}`, import.meta.url), JSON.stringify(schema, null, 2) + '\n');
  console.log(`wrote schema/draft/${name}`);
};

write('course.schema.json', courseJsonSchema());
write('lesson.schema.json', lessonJsonSchema());

mkdirSync(new URL('../schema/draft/tools/practice/', import.meta.url), { recursive: true });
for (const tool of TOOL_NAMES) {
  write(`tools/${tool}.input.schema.json`, toolInputJsonSchema(tool, 'official'));
  write(`tools/practice/${tool}.input.schema.json`, toolInputJsonSchema(tool, 'practice'));
  write(`tools/${tool}.output.schema.json`, toolOutputJsonSchema(tool));
}
