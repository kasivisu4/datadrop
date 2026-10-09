// Browser e2e for src/data/duck.js: builds the harness, serves it, drives Chromium with Playwright.
// Run: node tests/duck.e2e.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'duck-harness/out');

async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    return createRequire('/opt/npm-tools/node_modules/')('playwright');
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.map': 'application/json' };

// Static server for the harness, plus /fixtures/*: PUT stores a body in memory, GET serves it with
// HTTP Range support (206 + content-range), the way R2/S3/raw.githubusercontent.com do.
const fixtures = new Map();
function serve(dir) {
  const server = createServer(async (req, res) => {
    const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.replace(/\\/g, '/').startsWith('/fixtures/')) {
      if (req.method === 'PUT') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        fixtures.set(p, Buffer.concat(chunks));
        res.writeHead(201); res.end(); return;
      }
      const body = fixtures.get(p);
      if (!body) { res.writeHead(404); res.end(); return; }
      fixtures.reads = (fixtures.reads || 0) + 1;
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const head = { 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' };
      if (req.method === 'HEAD') { res.writeHead(200, { ...head, 'content-length': body.length }); res.end(); return; }
      if (!m) { res.writeHead(200, { ...head, 'content-length': body.length }); res.end(body); return; }
      const start = Number(m[1]);
      const end = Math.min(m[2] ? Number(m[2]) : body.length - 1, body.length - 1);
      fixtures.rangeBytes = (fixtures.rangeBytes || 0) + (end - start + 1);
      res.writeHead(206, { ...head, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${body.length}` });
      res.end(body.subarray(start, end + 1));
      return;
    }
    let file = join(dir, p);
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

await import('./build-duck-harness.mjs');
const server = await serve(outDir);
const base = `http://127.0.0.1:${server.address().port}/`;
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  // The container reaches GitHub only through an authenticated proxy that Chromium can't use,
  // so relay GitHub requests through Node's fetch (the request itself is still made live).
  await page.route(/^https:\/\/(raw|media)\.githubusercontent\.com\//, async (route) => {
    const r = await fetch(route.request().url());
    route.fulfill({
      status: r.status,
      headers: { 'access-control-allow-origin': '*', 'content-type': r.headers.get('content-type') || 'text/plain' },
      body: Buffer.from(await r.arrayBuffer()),
    });
  });

  await page.goto(base);
  await page.waitForFunction(() => window.__result || window.__error, null, { timeout: 90000 });
  const err = await page.evaluate(() => window.__error);
  if (err) throw new Error('harness failed: ' + err);
  const r = await page.evaluate(() => window.__result);

  console.log('load:', r.load);
  console.log('profile.columns:', JSON.stringify(r.profile.columns, null, 1));
  console.log('profile.sample[0]:', r.profile.sample[0]);
  console.log('group rows (first 3):', r.group.rows.slice(0, 3), 'columns:', r.group.columns);
  console.log('json profile:', JSON.stringify(r.jsonProfile.columns));
  console.log('json types row0:', r.jsonTypes.rows[0], r.jsonTypes.columns);
  console.log('parquet:', r.parquetLoad, 'ndjson:', r.ndjson, 'tsv:', r.tsv, r.tsvCols);
  console.log('sqlError:', r.sqlError);

  // CSV
  assert.equal(r.load.tableName, 't_2014_apple_stock');
  assert.ok(r.load.rowCount > 200);
  assert.ok(r.bytesIntact, 'caller bytes must not be detached');
  assert.equal(r.profile.rowCount, r.load.rowCount);
  const [dateCol, closeCol] = r.profile.columns;
  assert.equal(dateCol.name, 'AAPL_x');
  assert.equal(dateCol.kind, 'temporal');
  assert.match(dateCol.min, /^2014-01-02/);
  assert.equal(closeCol.kind, 'quantitative');
  assert.ok(closeCol.mean > 50 && closeCol.mean < 200);
  assert.equal(closeCol.nullPct, 0);
  assert.equal(r.profile.sample.length, 5);
  assert.match(r.profile.sample[0].AAPL_x, /^\d{4}-\d\d-\d\d/);
  assert.ok(r.group.rows.length >= 6);
  assert.equal(typeof r.group.rows[0].n, 'number');
  assert.equal(typeof r.group.rows[0].avg_close, 'number');
  assert.deepEqual(r.group.columns.map((c) => c.name), ['month', 'avg_close', 'n']);
  assert.equal(r.limited, 3);

  // JSON
  assert.equal(r.jsonLoad.rowCount, 3);
  const jc = Object.fromEntries(r.jsonProfile.columns.map((c) => [c.name, c]));
  assert.equal(jc.city.kind, 'nominal');
  assert.deepEqual(jc.city.topValues[0], { value: 'Tampa', count: 2 });
  assert.equal(jc.ok.kind, 'boolean');
  assert.equal(jc.amount.kind, 'quantitative');
  assert.ok(Math.abs(jc.amount.nullPct - 33.33) < 0.01);
  assert.equal(jc.d.kind, 'temporal');
  const row0 = r.jsonTypes.rows[0];
  assert.equal(row0.big, '9007199254740993'); // unsafe BigInt -> string
  assert.equal(r.jsonTypes.rows[1].big, 1);    // safe BigInt -> number
  assert.equal(row0.dec, 12.34);
  assert.equal(row0.ts, '2024-05-06T07:08:09.000Z');
  assert.equal(row0.d, '2024-01-02');
  assert.deepEqual(row0.lst, [1, 2]);
  assert.deepEqual(row0.st, { a: 1 });

  // Parquet / NDJSON / TSV / errors
  if (r.parquetLoad) {
    assert.equal(r.parquetError, undefined, `parquet block failed part-way: ${r.parquetError}`);
    assert.equal(r.parquetLoad.rowCount, r.load.rowCount);
    // Remote Parquet, queried in place over Range requests
    console.log('remote:', JSON.stringify(r.remote), 'range bytes:', fixtures.rangeBytes, 'of', r.remote?.sizeBytes);
    assert.ok(r.remote, 'remote parquet ran');
    assert.equal(r.remote.resolved.format, 'parquet');
    assert.equal(r.remote.sizeBytes, r.remote.resolved.sizeBytes);
    assert.equal(r.remote.load.rowCount, r.load.rowCount);
    assert.equal(r.remote.profile.remote, true);
    assert.equal(r.remote.profile.rowCount, r.load.rowCount);
    assert.deepEqual(r.remote.profile.sample, [], 'no sample rows: they would read every column');
    const rc = Object.fromEntries(r.remote.profile.columns.map((c) => [c.name, c]));
    assert.equal(rc.AAPL_y.kind, 'quantitative');
    assert.equal(rc.AAPL_y.min, r.localMinMax.mn, 'min from footer stats');
    assert.equal(rc.AAPL_y.max, r.localMinMax.mx, 'max from footer stats');
    assert.equal(rc.AAPL_y.nullPct, 0);
    assert.ok(rc.AAPL_y.bytesPerRow > 0);
    assert.deepEqual(r.remote.query, r.localQuery, 'same answer as the downloaded table');
    assert.ok(fixtures.rangeBytes > 0, 'read through Range requests');
    assert.equal(r.remote.csvResolved, null, 'non-parquet falls back to a full download');
    const cp = r.remote.capped;
    console.log('sampled:', JSON.stringify({ load: cp.load, spread: cp.spread, first: cp.first, next: cp.next }));
    assert.equal(cp.load.totalRows, 10240);
    assert.equal(cp.load.rowCount, 4096, 'two whole row groups');
    assert.deepEqual(cp.load.sample, { mode: 'spread', rows: 4096, slices: 2, firstRow: 2048, endRow: 8192 });
    assert.deepEqual(cp.spread, { n: 4096, lo: 2048, hi: 8191 }, 'spread picks groups 1 and 3 of 0..4');
    assert.equal(cp.profile.rowCount, 4096);
    assert.equal(cp.profile.totalRows, 10240, 'profile keeps the file total for the UI and prompt');
    const pi = cp.profile.columns.find((c) => c.name === 'i');
    assert.deepEqual([pi.min, pi.max], [2048, 8191], 'footer stats from the sampled groups only');
    assert.equal(cp.profile.columns.find((c) => c.name === 'maybe').nullPct, 25, 'null % over the sampled rows (was 309% once)');
    assert.deepEqual(cp.first, { n: 4096, lo: 0, hi: 4095 }, 'first rows');
    assert.deepEqual(cp.next, { n: 4096, lo: 4096, hi: 8191 }, 'next rows');
    assert.equal(cp.nextProfile.sampleInfo.mode, 'window');
    console.log('lanes:', JSON.stringify(cp.lanes));
    assert.equal(cp.lanes.ready, 4, 'all lanes up');
    assert.deepEqual(cp.lanes.lanesUsed, [0, 1, 2, 3], 'four concurrent queries land on four lanes');
    assert.ok(cp.lanes.same, 'every lane gives the same answer');
    const w = cp.ws;
    console.log('workingset:', JSON.stringify({ single: w.single, parallel: w.parallel, events: w.events, cache: w.cache, guard: [w.guardEvents, w.guardColumns, w.guardBuild] }));
    assert.equal(w.remote.n, 6144);
    assert.deepEqual(w.single.columns, ['a', 'b']);
    assert.equal(w.single.lanes, 1);
    assert.deepEqual(w.local, { sa: w.remote.sa, sb: w.remote.sb }, 'working set = the sample, on those columns');
    assert.deepEqual(w.lanesLocal, [0], 'working-set queries run on lane 0');
    assert.deepEqual(w.columnsAfterLocal, ['a', 'b'], 'a query over a and b did not grow the working set');
    assert.deepEqual(w.missing, ['c']);
    assert.equal(w.parallel.units, 3, 'a 3-group sample is 3 units of work');
    assert.ok(w.parallel.parts >= 2, `units spread over lanes (${w.parallel.parts})`);
    assert.deepEqual(w.progress, [33, 67, 100], 'progress after each unit');
    assert.deepEqual(w.parallelLocal, { sa: w.remote.sa, sb: w.remote.sb, n: 6144 }, 'parallel build: same rows, none duplicated or lost');
    assert.deepEqual(w.extended, w.remote, 'auto-extended working set answers like the file');
    assert.deepEqual(w.columnsAfter, ['a', 'b', 'c', 'd']);
    assert.deepEqual(w.events, ['extend:start:c,d', 'extend:done:c,d']);
    assert.deepEqual(w.cache, { same: true, ran: 2, inflightShared: true }, 'result cache: repeat and in-flight duplicates do not run');
    assert.equal(w.afterClear.ws, null);
    assert.equal(w.afterClear.ran, 3, 'clearing the working set invalidates cached results');
    assert.equal(w.afterClear.again.s, w.remote.sd);
    assert.deepEqual(w.guardQuery, { sb: w.remote.sb }, 'over budget: the query reads the file instead');
    assert.deepEqual(w.guardEvents, ['extend:refused:b']);
    assert.deepEqual(w.guardColumns, ['a'], 'kept columns stay');
    assert.equal(w.guardBuild, 'MemoryError', 'an oversized build is abandoned');
    assert.equal(w.afterGuard, null);
    const gr = cp.grid;
    console.log('grid:', JSON.stringify(gr));
    assert.deepEqual(gr.summary.file, [6144, 6144, gr.summary.ws[2], gr.summary.ws[3], true], 'pages of 200 cover every row exactly once, in file order (read from the file)');
    assert.deepEqual(gr.summary.ws.slice(0, 2), [6144, 6144], 'pages cover every row exactly once (working set)');
    assert.equal(gr.sameRowsFileAndWs, true, 'same rows in the same order from the file and from the working set, so building one while scrolling is invisible');
    assert.equal(gr.sameAfterClear, true, 'and after clearing it');
    assert.deepEqual(gr.lanes, [0], 'pages over working-set columns run on lane 0');
    assert.deepEqual(gr.summary.sorted, [6144, 6144, 10239, 0, true], 'sorted pages: no row twice or missing across page boundaries');
    assert.deepEqual(gr.summary.ties, [6144, 6144, true], 'sorting by a column full of ties: ties break by file row, pages stay whole (file)');
    assert.deepEqual(gr.summary.tiesWs, [6144, 6144, true], '... and the working set gives the identical order');
    assert.equal(gr.summary.outside[0], 200);
    assert.deepEqual(gr.colsAfter, gr.cols, 'showing a column in the grid never grows the working set');
    assert.deepEqual(gr.columns, ['a', 'b', 'c', 'd'], 'the record view reads every column');
    assert.equal(gr.recordMatchesPage, true, 'record = the row at that offset');
    assert.equal(gr.recordSortedMatches, true, 'sorted record = the sorted row at that offset');
    assert.equal(gr.past, 0, 'a page past the end is empty');
    assert.equal(gr.last, 144, 'the last page holds what is left (6144 = 30 x 200 + 144)');
    assert.deepEqual(gr.summary.local, [450, 449, [449, 448, 447]], 'a downloaded table pages and sorts too');
    const m = cp.materialize;
    console.log('materialize:', JSON.stringify(m));
    assert.equal(m.mat.cached, 'capq__ws', 'fast mode = a working set of every column');
    assert.deepEqual(m.afterMat, m.before, 'the cache holds exactly the sample');
    assert.deepEqual(m.lanes, [0], 'cached queries run on lane 0');
    assert.equal(m.cachedTables, 1);
    assert.equal(m.readyWhileCached, 4, 'lanes stay up: they read the file for columns outside a working set');
    assert.equal(m.cachedAfterResample, false, 'a new sample drops the cache');
    assert.equal(m.readyAfterResample, 4, 'lanes come back for the remote view');
    assert.deepEqual(m.afterResample, { lo: 4096, hi: 8191 });
    assert.ok(cp.lanes.early.length >= 2, `queries sent before lanes were up still spread out: ${cp.lanes.early}`);
    assert.ok(cp.lanes.parallel < cp.lanes.single * 2.5, `4 queries in parallel (${cp.lanes.parallel} ms) vs 1 alone (${cp.lanes.single} ms): not serial`);
    assert.deepEqual(cp.lanes.afterResample, ['0-4095', '0-4095', '0-4095', '0-4095'], 'resample reaches every lane');
    assert.equal(r.remote.profile.totalRows, undefined, 'uncapped profile has no totalRows');
    assert.equal(r.remote.replaced, r.load.rowCount, 'a table can replace the remote view under the same name');
  } else {
    // Only a missing parquet extension (offline / blocked download) may skip this block; any other error is a failure.
    assert.match(r.parquetError, /extension|Failed to (download|fetch)|NetworkError/i, `parquet block failed: ${r.parquetError}`);
    console.log('NOTE: parquet skipped, extension not reachable:', r.parquetError.slice(0, 120));
  }
  assert.ok(r.badParquetError, 'garbage parquet must reject');
  console.log('bad parquet error:', r.badParquetError.slice(0, 160));
  assert.equal(r.parts.rowCount, 3, 'parts combined');
  assert.deepEqual(r.partsRows.map((x) => [x.a, x.c, x.source_file]),
    [[1, null, 'release/w1/w.csv'], [2, null, 'release/w1/w.csv'], [3, true, 'release/w2/w.csv']], 'union by name + source_file');
  assert.equal(r.ndjson.rowCount, 2);
  assert.equal(r.tsv.rowCount, 2);
  assert.deepEqual(r.tsvCols.map((c) => c.name), ['x', 'y']);
  assert.match(r.sqlError, /nope/);
  console.log('cancel:', JSON.stringify(r.cancel));
  assert.equal(r.cancel.running, 'AbortError', 'running query cancelled');
  assert.ok(r.cancel.runningMs < 5000, `cancel took effect quickly (${r.cancel.runningMs} ms)`);
  assert.equal(r.cancel.waiting, 'AbortError', 'queued query dropped');
  assert.equal(r.cancel.queuedStarted, false, 'dropped query never started');
  assert.equal(r.cancel.after, 42, 'connection usable after a cancel');
  console.log('\nALL DUCK E2E ASSERTIONS PASSED');
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
