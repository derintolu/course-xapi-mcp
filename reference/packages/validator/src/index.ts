// SPDX-License-Identifier: Apache-2.0
export { validatePackage, sortIssues } from './validate.ts';
export type { Flavour, ValidationResult } from './validate.ts';
export { explainCode } from './explain.ts';
export type { CodeExplanation } from './explain.ts';
export { hasNestedQuantifier } from '@course-xapi-mcp/core';
export { runCli } from './cli.ts';
export { buildPackages, deterministicZip, etagOf } from './build.ts';
export type { BuildResult, BuiltZip } from './build.ts';
export { scaffoldCourse, scaffoldLesson } from './scaffold.ts';
export type { ScaffoldCourseOptions, ScaffoldLessonOptions } from './scaffold.ts';
export { createValidatorMcp } from './mcp.ts';
export { convertLegacyCourse } from './convert.ts';
export type { ConvertOptions, ConvertResult } from './convert.ts';
