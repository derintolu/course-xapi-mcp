// SPDX-License-Identifier: Apache-2.0
export {
  CheckSchema,
  CourseJsonSchema,
  LessonJsonSchema,
  DistributionLessonJsonSchema,
  courseJsonSchema,
  lessonJsonSchema,
  COURSE_SCHEMA_ID,
  LESSON_SCHEMA_ID,
} from './schemas.ts';
export type { CourseJson, LessonJson } from './schemas.ts';
export { readZip } from './zip.ts';
export type { PackageFiles } from './zip.ts';
export { parseCmi5Xml } from './cmi5-xml.ts';
export type { Cmi5Structure, Cmi5Au, Cmi5Block } from './cmi5-xml.ts';
export { loadPackage, readDir, SUPPORTED_SPEC_MAJOR, SUPPORTED_SPEC_MINOR } from './load.ts';
export type { LoadResult } from './load.ts';
