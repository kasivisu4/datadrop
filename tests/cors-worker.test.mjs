import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import worker from '../docs/cors-worker.js';

// an origin that sends NO CORS headers and supports Range, like the NYC taxi CloudFront
const DATA = Buffer.from('PAR1' + 'x'.repeat(996) + 'PAR1');
let origin;
let hits;
before(async () => {
  hits = [];
  origin = http.createServer((req, res) => {
    hits.push({ method: req.method, range: req.headers.range, auth: req.headers.authorization, cookie: req.headers.cookie });
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const a = Number(m[1]); const b = m[2] ? Number(m[2]) : DATA.length - 1;
      res.writeHead(206, { 'content-type': 'binary/octet-stream', 'content-range': `bytes ${a}-${b}/${DATA.length}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes', 'set-cookie': 'a=b' });
      res.end(req.method === 'HEAD' ? undefined : DATA.subarray(a, b + 1));
    } else {
      res.writeHead(200, { 'content-type': 'binary/octet-stream', 'content-length': DATA.length, 'accept-ranges': 'bytes' });
      res.end(req.method === 'HEAD' ? undefined : DATA);
    }
  });
  await new Promise((ok) => origin.listen(0, '127.0.0.1', ok));
});
after(() => origin.close());

// the worker only relays https; for these tests point it at the local http origin by swapping the protocol check's input:
// a worker call with an https URL whose fetch we intercept and send to the local server
const realFetch = globalThis.fetch;
const via = (path = '/f.parquet') => `https://files.example.org${path}`;
before(() => {
  globalThis.fetch = (u, init) => realFetch(String(u).replace('https://files.example.org', `http://127.0.0.1:${origin.address().port}`), init);
});
after(() => { globalThis.fetch = realFetch; });

const call = (target, init = {}, env = {}) => worker.fetch(new Request(`https://relay.example/?url=${encodeURIComponent(target)}`, init), env);

test('relays a Range request: 206, the right bytes, content-range exposed, CORS added', async () => {
  const r = await call(via(), { headers: { range: 'bytes=0-3' } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), 'PAR1');
  assert.equal(r.headers.get('content-range'), 'bytes 0-3/1004');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-expose-headers'), /content-range/);
  assert.equal(hits.at(-1).range, 'bytes=0-3');
});

test('relays a whole file and a HEAD (size for the size check)', async () => {
  const full = await call(via());
  assert.equal(full.status, 200);
  assert.equal((await full.arrayBuffer()).byteLength, 1004);
  const head = await call(via(), { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '1004');
  assert.equal(head.headers.get('access-control-allow-origin'), '*');
  assert.equal(await head.text(), '');
});

test('answers the browser\'s preflight', async () => {
  const r = await worker.fetch(new Request('https://relay.example/?url=x', { method: 'OPTIONS', headers: { origin: 'https://kasivisu4.github.io', 'access-control-request-headers': 'range' } }));
  assert.equal(r.status, 204);
  assert.match(r.headers.get('access-control-allow-headers'), /range/);
  assert.match(r.headers.get('access-control-allow-methods'), /GET/);
});

test('forwards only Range-type headers: never cookies or authorization; drops the origin\'s set-cookie', async () => {
  const r = await call(via(), { headers: { range: 'bytes=0-1', authorization: 'Bearer secret', cookie: 'session=1' } });
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(hits.at(-1).auth, undefined);
  assert.equal(hits.at(-1).cookie, undefined);
});

test('safe by default: https only, GET/HEAD only, a bad address is a plain 400', async () => {
  assert.equal((await call('http://files.example.org/f')).status, 400);
  assert.equal((await call('file:///etc/passwd')).status, 400);
  assert.equal((await worker.fetch(new Request('https://relay.example/'))).status, 400);
  assert.equal((await call(via(), { method: 'POST', body: 'x' })).status, 405);
  const bad = await call('not a url');
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('access-control-allow-origin'), '*', 'errors are readable by the page too');
});

test('ALLOWED_HOSTS limits what the relay will fetch; ALLOWED_ORIGIN limits who may call it', async () => {
  const env = { ALLOWED_HOSTS: 'files.example.org, other.example.org', ALLOWED_ORIGIN: 'https://kasivisu4.github.io' };
  const ok = await call(via(), { headers: { range: 'bytes=0-3' } }, env);
  assert.equal(ok.status, 206);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://kasivisu4.github.io');
  const no = await call('https://evil.example.com/x', {}, env);
  assert.equal(no.status, 403);
  assert.match(await no.text(), /evil\.example\.com is not in ALLOWED_HOSTS/);
});
