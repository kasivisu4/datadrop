// Tiny static server for dist/ (or a dir given as argv[2]). PORT env overrides 5173.
//
// Also a local-only relay at /__relay?url=<https address> for files whose server sends no CORS headers (the NYC taxi
// files): the same code as docs/cors-worker.js. It answers only requests from this machine's own pages, so running
// `npm run serve` never makes you an open proxy for anyone else. The deployed site has no such thing: it is static.
import http from 'node:http';
import { Readable } from 'node:stream';
import worker from './docs/cors-worker.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, process.argv[2] || 'dist');
const port = Number(process.env.PORT) || 5173;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.csv': 'text/csv', '.txt': 'text/plain',
};

const LOOPBACK = /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/;
async function relay(req, res) {
  const same = `http://${req.headers.host}`;
  if (!LOOPBACK.test(req.socket.remoteAddress || '') || (req.headers.origin && req.headers.origin !== same)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('The local relay answers this machine only');
    return;
  }
  if (new URL(req.url, same).searchParams.has('probe')) { res.writeHead(204, { 'x-datadrop-relay': 'local' }).end(); return; }
  const headers = {};
  for (const h of ['range', 'if-range', 'if-none-match', 'if-modified-since']) if (req.headers[h]) headers[h] = req.headers[h];
  const r = await worker.fetch(new Request(same + req.url, { method: req.method, headers }), {});
  const out = Object.fromEntries(r.headers);
  out['x-datadrop-relay'] = 'local';
  res.writeHead(r.status, out);
  if (!r.body) { res.end(); return; }
  const body = Readable.fromWeb(r.body);
  res.on('close', () => body.destroy()); // the page stopped reading (a cancelled query): stop pulling the file
  body.on('error', () => res.destroy());
  body.pipe(res);
}

http.createServer(async (req, res) => {
  try {
    if (new URL(req.url, 'http://x').pathname === '/__relay') return await relay(req, res);
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(dir, path.normalize(p));
    if (!file.startsWith(dir)) { res.writeHead(403).end('forbidden'); return; }
    let s = await stat(file).catch(() => null);
    if (s?.isDirectory()) { file = path.join(file, 'index.html'); s = await stat(file).catch(() => null); }
    if (!s) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': s.size, 'cache-control': 'no-cache' });
    createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500).end(String(e)); }
}).listen(port, () => console.log(`DataDrop serving ${path.relative(process.cwd(), dir) || dir} at http://localhost:${port}/`));
