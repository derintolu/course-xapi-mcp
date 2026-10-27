// SPDX-License-Identifier: Apache-2.0
// The validator as an MCP server, for agents converting a course: validate_package, explain_error, scaffold,
// and the author skill as a resource. It reads nothing from disk and keeps no state.
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { CUSTODY_OPTIONS, URIS } from '@course-xapi-mcp/core';
import type { ValidationIssue } from '@course-xapi-mcp/core';
import { readZip } from '@course-xapi-mcp/core/package';
import type { PackageFiles } from '@course-xapi-mcp/core/package';
import { AUTHOR_SKILL } from './author-skill.generated.ts';
import { explainCode } from './explain.ts';
import { scaffoldCourse, scaffoldLesson } from './scaffold.ts';
import { validatePackage } from './validate.ts';
import type { ValidationResult } from './validate.ts';

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const ok = (body: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body });
const fail = (error: string): ToolResult => ({ content: [{ type: 'text', text: error }], isError: true });

const encoder = new TextEncoder();

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const filesArg = z.record(z.string(), z.string()).describe('Package files by path relative to the package root ("cmi5.xml", "cxm/course.json", ...), as text.');

/** A new validator MCP server; pass this function to serveStdio or createMcpHandler as the factory. */
export function createValidatorMcp(): McpServer {
  const server = new McpServer(
    { name: 'course-xapi-mcp-validator', version: '0.2.0' },
    {
      instructions:
        'Validates and scaffolds course-xapi-mcp course packages. Read the author skill resource first. ' +
        'Loop: validate_package, fix the first error, validate again; call explain_error when a fix is not enough.',
    },
  );

  server.registerTool(
    'validate_package',
    {
      title: 'validate package',
      description: 'Validate a course package given as text files or as a base64 ZIP. Returns {valid, issues}; each issue has code, file, xpath or pointer, message, fix and help.',
      inputSchema: z.object({
        files: filesArg.optional(),
        zipBase64: z.string().optional().describe('The package ZIP, base64-encoded, with cmi5.xml at its root.'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ files, zipBase64 }) => {
      if ((files === undefined) === (zipBase64 === undefined)) return fail('give exactly one of files or zipBase64');
      let pkg: PackageFiles | ValidationIssue;
      if (files !== undefined) pkg = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, encoder.encode(v)]));
      else {
        try {
          pkg = readZip(fromBase64(zipBase64!));
        } catch {
          return fail('zipBase64 is not valid base64');
        }
      }
      const result: ValidationResult = 'code' in pkg && typeof pkg.code === 'string' ? { valid: false, issues: [pkg as ValidationIssue] } : await validatePackage(pkg as PackageFiles);
      return ok({ ...result });
    },
  );

  server.registerTool(
    'explain_error',
    {
      title: 'explain error',
      description: 'What a validator code (for example CXM-PKG-013) means and how to fix it.',
      inputSchema: z.object({ code: z.string().max(32) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ code }) => {
      const e = explainCode(code);
      return e ? ok({ ...e }) : fail(`unknown code ${code}; codes look like CXM-PKG-013`);
    },
  );

  server.registerTool(
    'scaffold',
    {
      title: 'scaffold',
      description:
        'Starter files. kind "course" takes id (the course IRI), title, language (default "en") and custody (default "server-kept"). ' +
        'kind "lesson" takes files (the current package), pathKey, key and title, and returns the whole new file set. ' +
        'Empty fields are for you to fill in; validate_package lists them.',
      inputSchema: z.object({
        kind: z.enum(['course', 'lesson']),
        id: z.string().optional(),
        title: z.string().min(1),
        language: z.string().optional(),
        custody: z.enum(CUSTODY_OPTIONS).optional(),
        files: filesArg.optional(),
        pathKey: z.string().optional(),
        key: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        if (a.kind === 'course') {
          if (a.id === undefined) return fail('kind "course" needs id, the course IRI');
          return ok({ files: scaffoldCourse({ id: a.id, title: a.title, language: a.language ?? 'en', custody: a.custody ?? 'server-kept' }) });
        }
        if (a.files === undefined || a.pathKey === undefined || a.key === undefined) return fail('kind "lesson" needs files, pathKey and key');
        return ok({ files: scaffoldLesson(a.files, { pathKey: a.pathKey, key: a.key, title: a.title }) });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerResource(
    'author-skill',
    URIS.authorSkill,
    { title: 'Author skill', description: 'How to convert a course into a course-xapi-mcp package and validate it.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: AUTHOR_SKILL }] }),
  );

  return server;
}
