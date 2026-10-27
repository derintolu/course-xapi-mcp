// SPDX-License-Identifier: Apache-2.0
// Runs the example course as a practice-only server on 127.0.0.1 for local use and testing (Task 26 replaces this
// with the configurable reference binary).
//   CXM_PACKAGE=path/to/package-dir PORT=8787 node --experimental-strip-types src/bin.ts
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { loadPackage, readDir } from '@course-xapi-mcp/core/package';
import { createPracticeCustody } from './custody/practice.ts';
import { createCourseServer } from './server.ts';

const dir = process.env.CXM_PACKAGE ?? new URL('../../../../examples/json-basics/', import.meta.url).pathname;
const port = Number(process.env.PORT ?? 8787);
const publicUrl = `http://127.0.0.1:${port}`;
const loaded = loadPackage(await readDir(dir));
if (!loaded.ok) {
  console.error(`Invalid package ${dir}:\n${loaded.issues.map((i) => `${i.code} ${i.file}: ${i.message}`).join('\n')}`);
  process.exit(1);
}
const course = { ...loaded.course, custody: 'practice' as const, allowPractice: false, badges: [], badgeIssuer: undefined };
const app = createCourseServer({ course, custody: createPracticeCustody({ courseId: course.id }), publicUrl });
const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];

const server = createServer(async (req, res) => {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream);
  const request = new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body,
    duplex: 'half',
  } as RequestInit);
  const path = new URL(request.url).pathname;
  let response: Response;
  if (!allowedHosts.includes((req.headers.host ?? '').toLowerCase()) || req.headers.origin !== undefined) response = new Response('Forbidden', { status: 403 });
  else if (path === '/mcp') response = await app.mcp(request, '/mcp');
  else if (req.method === 'GET' && path === '/') response = Response.json({ course: course.title, custody: 'practice', mcp: `${publicUrl}/mcp` });
  else response = new Response('Not found', { status: 404 });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) Readable.fromWeb(response.body as never).pipe(res);
  else res.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`course-xapi-mcp: "${course.title}" (practice) on ${publicUrl}/mcp (pid ${process.pid})`);
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
