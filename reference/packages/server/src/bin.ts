// SPDX-License-Identifier: Apache-2.0
// The reference course server: serves one course package over HTTP, configured by environment variables
// (see config.ts). With none set it serves the json-basics example on http://127.0.0.1:8787.
//   CXM_PACKAGE=path/to/package PORT=8787 node --experimental-strip-types src/bin.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { isLoopbackHost } from './auth/clients.ts';
import { ConfigError, createAppFromConfig, type App } from './app.ts';
import { loadConfig, type AppConfig } from './config.ts';

function fail(errors: string[]): never {
  console.error(`course-xapi-mcp: cannot start:\n${errors.map((e) => '  ' + e).join('\n')}`);
  process.exit(1);
}

const loaded = loadConfig(process.env);
if ('errors' in loaded) fail(loaded.errors);
const config: AppConfig = loaded;
for (const w of config.warnings) console.warn(`course-xapi-mcp: ${w}`);

let app: App & { course: { title: string; custody: string } };
try {
  app = await createAppFromConfig(config);
} catch (e) {
  if (e instanceof ConfigError) fail(e.errors);
  throw e;
}

/** The request as the app sees it: the URL is always on the public origin, so the Host header cannot change it. */
function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const one of v) headers.append(k, one);
    else if (v !== undefined) headers.set(k, v);
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream);
  return new Request(new URL(req.url ?? '/', config.publicUrl), { method: req.method, headers, body, duplex: 'half' } as RequestInit);
}

async function send(response: Response, res: ServerResponse) {
  const cookies = response.headers.getSetCookie();
  for (const [k, v] of response.headers) if (k !== 'set-cookie') res.setHeader(k, v);
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.writeHead(response.status);
  if (response.body) Readable.fromWeb(response.body as never).pipe(res);
  else res.end();
}

const server = createServer(async (req, res) => {
  try {
    await send(await app.fetch(toRequest(req)), res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Internal error');
  }
});

// On a loopback public URL, listen on loopback only; otherwise on every interface (behind a proxy or in a container).
const host = isLoopbackHost(new URL(config.publicUrl).hostname) ? '127.0.0.1' : undefined;
server.listen(config.port, host, () => {
  console.log(`course-xapi-mcp: "${app.course.title}" (${app.course.custody}) on ${config.publicUrl} (pid ${process.pid})`);
});
const stop = () => {
  server.close(() => void app.close().finally(() => process.exit(0)));
  server.closeAllConnections();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
