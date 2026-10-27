// SPDX-License-Identifier: Apache-2.0
// A small static file server for site/dist, bound to 127.0.0.1 only. Usage: node --experimental-strip-types site/serve.ts [dir] [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/schema+json',
  '.jsonld': 'application/ld+json',
  '.xsd': 'application/xml',
};

export function serve(dir: string, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const base = normalize(dir);
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
      let file = normalize(join(base, pathname));
      if (file !== base && !file.startsWith(base + sep)) throw Object.assign(new Error('outside'), { code: 'ENOENT' });
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ url: `http://127.0.0.1:${p}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? fileURLToPath(new URL('./dist', import.meta.url));
  const { url } = await serve(dir, Number(process.argv[3] ?? 0));
  console.log(`serving ${dir} at ${url} (pid ${process.pid})`);
}
