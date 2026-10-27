// SPDX-License-Identifier: Apache-2.0
// Runs a course server on 127.0.0.1 for local use and testing.
//   COURSE=path/to/course.json PORT=8787 RECORDS_DIR=.records node --experimental-strip-types src/bin.ts
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { parseCourse } from '@course-xapi-mcp/core';
import { createCourseServer } from './server.ts';
import { DirectoryStore } from './dir-store.ts';

const coursePath = process.env.COURSE ?? new URL('../../../../examples/legacy/json-basics.course.json', import.meta.url).pathname;
const port = Number(process.env.PORT ?? 8787);
const parsed = parseCourse(JSON.parse(readFileSync(coursePath, 'utf8')));
if (!parsed.ok) {
  console.error(`Invalid course ${coursePath}:\n${parsed.errors.join('\n')}`);
  process.exit(1);
}

const app = createCourseServer({
  course: parsed.course,
  store: process.env.RECORDS_DIR ? new DirectoryStore(process.env.RECORDS_DIR) : undefined,
  allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
});

const server = createServer(async (req, res) => {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream);
  const request = new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body,
    duplex: 'half',
  } as RequestInit);
  const response = await app.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) Readable.fromWeb(response.body as never).pipe(res);
  else res.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`learning-mcp: "${parsed.course.title}" on http://127.0.0.1:${port}/mcp (pid ${process.pid})`);
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
