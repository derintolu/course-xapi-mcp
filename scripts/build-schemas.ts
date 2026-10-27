// SPDX-License-Identifier: Apache-2.0
// Writes schema/draft/course.schema.json and lesson.schema.json from the zod schemas.
import { writeFileSync } from 'node:fs';
import { courseJsonSchema, lessonJsonSchema } from '../reference/packages/core/src/package/schemas.ts';

const write = (name: string, schema: unknown) => {
  writeFileSync(new URL(`../schema/draft/${name}`, import.meta.url), JSON.stringify(schema, null, 2) + '\n');
  console.log(`wrote schema/draft/${name}`);
};

write('course.schema.json', courseJsonSchema());
write('lesson.schema.json', lessonJsonSchema());
