import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server; let port;
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });

before(async () => {
  port = await freePort();
  server = spawn(process.execPath, [path.join(root, 'serve.mjs'), path.join(root, 'tests/ui-stubs/dist')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => server.stdout.once('data', r));
});
after(() => server.kill());

const get = (p, headers = {}, method = 'GET') => new Promise((ok, fail) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', fail);
  req.end();
});

test('the page is still served as before', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.body, /<title>DataDrop/);
  assert.equal((await get('/nope.js')).status, 404);
});

test('probe: the app can tell the local relay exists (HEAD, no body, a marker header)', async () => {
  const r = await get('/__relay?probe=1', {}, 'HEAD');
  assert.equal(r.status, 204);
  assert.equal(r.headers['x-datadrop-relay'], 'local');
});

test('only https addresses and only a proper ?url=', async () => {
  assert.equal((await get('/__relay')).status, 400);
  assert.equal((await get('/__relay?url=' + encodeURIComponent('http://example.com/x.parquet'))).status, 400);
  assert.equal((await get('/__relay?url=' + encodeURIComponent('file:///etc/passwd'))).status, 400);
});

test('it answers this machine\'s own pages only: another site\'s Origin is refused', async () => {
  const r = await get('/__relay?url=' + encodeURIComponent('https://example.com/'), { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.match(r.body, /this machine only/);
  const same = await get('/__relay?probe=1', { origin: `http://127.0.0.1:${port}` });
  assert.equal(same.status, 204, 'the page it serves is allowed');
});

test('LIVE (skipped offline): a Range request for the NYC taxi file through the relay: 206 and the Parquet magic bytes', async (t) => {
  const url = 'https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_2023-01.parquet';
  let r;
  try { r = await get('/__relay?url=' + encodeURIComponent(url), { range: 'bytes=0-3' }); } catch { return t.skip('offline'); }
  if (r.status === 502 || r.status === 504 || r.status === 500) return t.skip('upstream unreachable');
  assert.equal(r.status, 206);
  assert.equal(r.body, 'PAR1');
  assert.match(r.headers['content-range'], /^bytes 0-3\/\d+$/);
});
