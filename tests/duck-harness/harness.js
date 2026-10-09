// Browser harness: exercises Duck + github.js end to end; results land on window.__result.
import { Duck } from '../../src/data/duck.js';
import { fetchGitHubFile, tableNameFor, resolveRemoteFile } from '../../src/data/github.js';
import { PAGE_SIZE } from '../../src/ui/gridmodel.js';

async function run() {
  const out = {};
  const duck = await Duck.create({ baseUrl: './duckdb/' });

  // 1. Live CSV from GitHub
  const f = await fetchGitHubFile('https://github.com/plotly/datasets/blob/master/2014_apple_stock.csv');
  const t = tableNameFor(f.source.path);
  out.load = await duck.loadFile({ bytes: f.bytes, format: f.format, tableName: t, fileName: f.fileName });
  out.bytesIntact = f.bytes.length === f.sizeBytes;
  out.profile = await duck.profile(t);
  out.group = await duck.query(
    `SELECT strftime(AAPL_x, '%Y-%m') AS month, avg(AAPL_y) AS avg_close, count(*) AS n FROM ${t} GROUP BY 1 ORDER BY 1;`
  );
  out.limited = (await duck.query(`SELECT * FROM ${t} -- trailing comment`, { limit: 3 })).rows.length;

  window.__step = 'json';
  // 2. Inline JSON array with mixed types
  const json = JSON.stringify([
    { id: 1, city: 'Tampa', amount: 10.5, big: 5, ok: true, d: '2024-01-02' },
    { id: 2, city: 'Bangalore', amount: 20.25, big: 1, ok: false, d: '2024-02-03' },
    { id: 3, city: 'Tampa', amount: null, big: 2, ok: true, d: '2024-03-04' },
  ]);
  out.jsonLoad = await duck.loadFile({ bytes: new TextEncoder().encode(json), format: 'json', tableName: 'j', fileName: 'j.json' });
  out.jsonProfile = await duck.profile('j');
  out.jsonTypes = await duck.query(
    `SELECT id, city, CASE WHEN id = 1 THEN 9007199254740993::BIGINT ELSE big END AS big, 12.34::DECIMAL(10,2) AS dec, TIMESTAMP '2024-05-06 07:08:09' AS ts, d, [1,2] AS lst, {'a': 1} AS st FROM j ORDER BY id`
  );

  window.__step = 'parquet';
  // 3. Parquet round trip: COPY to an in-memory file, read it back, load as a new table
  // Needs the parquet extension (downloaded from extensions.duckdb.org); record failure instead of aborting.
  try {
    await duck.conn.query(`COPY (SELECT * FROM ${t}) TO 'rt.parquet' (FORMAT parquet)`);
    const pq = await duck.db.copyFileToBuffer('rt.parquet');
    out.parquetLoad = await duck.loadFile({ bytes: pq, format: 'parquet', tableName: 'pq', fileName: 'rt.parquet' });

    window.__step = 'remote parquet';
    // 3b. Same file served over HTTP with Range support: attached in place, profiled from the footer only.
    const url = new URL('./fixtures/rt.parquet', location.href).href;
    await fetch(url, { method: 'PUT', body: pq });
    const resolved = await resolveRemoteFile(url);
    const q = (tbl) => `SELECT round(avg(AAPL_y), 4) AS a, count(*) AS n FROM ${tbl} WHERE AAPL_y > 100`;
    out.remote = {
      resolved,
      sizeBytes: pq.length,
      load: await duck.attachUrl({ url: resolved.url, tableName: 'rpq', fileName: resolved.fileName }),
      profile: await duck.profile('rpq'),
      query: (await duck.query(q('rpq'))).rows,
      csvResolved: await resolveRemoteFile(new URL('./fixtures/x.csv', location.href).href),
    };
    out.localQuery = (await duck.query(q('pq'))).rows;
    out.localMinMax = (await duck.query('SELECT min(AAPL_y) AS mn, max(AAPL_y) AS mx FROM pq')).rows[0];
    // a file over the row cap is queried through a sample of whole row groups.
    // Fixture: i = 0..10239 in 5 row groups of 2048 rows.
    await duck.conn.query(`COPY (SELECT range::BIGINT AS i, CASE WHEN range % 4 = 0 THEN NULL ELSE range END AS maybe FROM range(10240)) TO 'rg.parquet' (FORMAT parquet, ROW_GROUP_SIZE 2048)`);
    const rgUrl = new URL('./fixtures/rg.parquet', location.href).href;
    await fetch(rgUrl, { method: 'PUT', body: await duck.db.copyFileToBuffer('rg.parquet') });
    const span = async () => (await duck.query('SELECT count(*) AS n, min(i) AS lo, max(i) AS hi FROM capq')).rows[0];
    const capped = {};
    capped.load = await duck.attachUrl({ url: rgUrl, tableName: 'capq', rowCap: 4096 }); // default: spread
    capped.spread = await span();
    capped.profile = await duck.profile('capq');
    await duck.resample('capq', { mode: 'window', rows: 4096, offset: 0 });
    capped.first = await span();
    await duck.resample('capq', { mode: 'window', rows: 4096, offset: capped.first.hi + 1 });
    capped.next = await span();
    capped.nextProfile = await duck.profile('capq');

    window.__step = 'lanes';
    // Worker pool: queries on the remote view spread over REMOTE_LANES DuckDB workers and run in parallel.
    await duck.lanesReady();
    // lanes create their view on first use: warm each one so the timing below measures parallel queries, not setup
    await Promise.all([0, 1, 2, 3].map(() => duck.query('SELECT count(*) AS n FROM capq', { cache: false })));
    const heavy = 'SELECT sum(hash(i * r)) AS h FROM capq, range(6000) t(r)';
    let t0 = performance.now();
    const one = (await duck.query(heavy, { cache: false })).rows[0].h;
    const single = performance.now() - t0;
    t0 = performance.now();
    const lanesUsed = new Set();
    const par = await Promise.all([0, 1, 2, 3].map(() => duck.query(heavy, { cache: false, onStart: (id) => lanesUsed.add(id) })));
    const parallel = performance.now() - t0;
    await duck.resample('capq', { mode: 'window', rows: 4096, offset: 0 });
    await duck.lanesReady();
    const after = await Promise.all([0, 1, 2, 3].map(() => duck.query('SELECT min(i) AS lo, max(i) AS hi FROM capq', { cache: false })));
    window.__step = 'materialize';
    // Fast mode: cache the sample in memory; queries then run on lane 0 against the copy
    const progress = [];
    const before = (await duck.query('SELECT count(*) AS n, min(i) AS lo, max(i) AS hi FROM capq')).rows[0];
    const mat = await duck.materialize('capq', { onProgress: (p) => progress.push(p.readMB) });
    const matLanes = new Set();
    const afterMat = (await duck.query('SELECT count(*) AS n, min(i) AS lo, max(i) AS hi FROM capq', { onStart: (id) => matLanes.add(id) })).rows[0];
    const cachedTables = (await duck.query("SELECT table_name FROM duckdb_tables() WHERE table_name = 'capq__ws'")).rows.length;
    const readyWhileCached = duck.readyLanes;
    await duck.resample('capq', { mode: 'window', rows: 4096, offset: 4096 });
    await duck.lanesReady();
    capped.materialize = {
      mat, before, afterMat, lanes: [...matLanes], cachedTables, readyWhileCached, progressCalls: progress.length,
      cachedAfterResample: duck.isCached('capq'), readyAfterResample: duck.readyLanes,
      afterResample: (await duck.query('SELECT min(i) AS lo, max(i) AS hi FROM capq')).rows[0],
    };

    window.__step = 'working set';
    // Working set on a 4-column fixture (5 row groups of 2048 rows): a = i, b = i*2, c = 'v' || i, d = i % 7
    await duck.conn.query(`COPY (SELECT range::BIGINT AS a, range * 2 AS b, 'v' || range AS c, range % 7 AS d FROM range(10240)) TO 'wsf.parquet' (FORMAT parquet, ROW_GROUP_SIZE 2048)`);
    const wsUrl = new URL('./fixtures/wsf.parquet', location.href).href;
    await fetch(wsUrl, { method: 'PUT', body: await duck.db.copyFileToBuffer('wsf.parquet') });
    const ws = {};
    const agg = 'SELECT count(*) AS n, sum(a) AS sa, sum(b) AS sb, max(length(c)) AS lc, sum(d) AS sd FROM wsq';
    // step 2: single lane
    await duck.attachUrl({ url: wsUrl, tableName: 'wsq', rowCap: 6144 }); // a 3-group sample
    await duck.profile('wsq');
    await duck.lanesReady();
    ws.remote = (await duck.query(agg, { cache: false })).rows[0];
    ws.single = await duck.buildWorkingSet('wsq', ['a', 'b'], { parallel: false });
    ws.lanesLocal = new Set();
    ws.local = (await duck.query('SELECT sum(a) AS sa, sum(b) AS sb FROM wsq', { cache: false, onStart: (id) => ws.lanesLocal.add(id) })).rows[0];
    ws.lanesLocal = [...ws.lanesLocal];
    ws.missing = duck.missingColumns('wsq', 'SELECT c, count(*) FROM wsq GROUP BY 1');
    ws.columnsAfterLocal = duck.workingSet('wsq').columns; // the LIMIT wrapper (SELECT * FROM (...)) must not pull in every column
    // step 3: parallel build
    ws.progress = [];
    ws.parallel = await duck.buildWorkingSet('wsq', ['a', 'b'], { onProgress: (p) => ws.progress.push(Math.round(p.fraction * 100)) });
    ws.parallelLocal = (await duck.query('SELECT sum(a) AS sa, sum(b) AS sb, count(*) AS n FROM wsq', { cache: false })).rows[0];
    // step 4: a query that needs more columns extends the working set, then runs locally
    const events = [];
    duck.onWorkingSet = (e) => events.push(`${e.type}:${e.phase}:${e.columns.join(',')}`);
    ws.extended = (await duck.query(agg, { cache: false })).rows[0];
    ws.columnsAfter = duck.workingSet('wsq').columns;
    ws.events = events.slice();
    // step 5: result cache: a repeat is the same object without running; data changes invalidate it
    let ran = 0;
    const r1 = await duck.query('SELECT sum(d) AS s FROM wsq', { onStart: () => ran++ });
    const r2 = await duck.query('SELECT sum(d) AS s FROM wsq', { onStart: () => ran++ });
    const [r3, r4] = await Promise.all([0, 1].map(() => duck.query('SELECT max(a) AS m FROM wsq', { onStart: () => ran++ })));
    ws.cache = { same: r1 === r2, ran, inflightShared: r3 === r4 };
    await duck.clearWorkingSet('wsq');
    ws.afterClear = { ws: duck.workingSet('wsq'), again: (await duck.query('SELECT sum(d) AS s FROM wsq', { onStart: () => ran++ })).rows[0], ran };
    // step 6: memory guard: a tiny budget refuses to extend (reads the file instead) and abandons an oversized build
    await duck.buildWorkingSet('wsq', ['a']);
    duck.memoryBudgetMB = 0.0001;
    duck.workingSetKeep = new Set(['a']);
    events.length = 0;
    ws.guardQuery = (await duck.query('SELECT sum(b) AS sb FROM wsq', { cache: false })).rows[0];
    ws.guardEvents = events.slice();
    ws.guardColumns = duck.workingSet('wsq')?.columns;
    ws.guardBuild = await duck.buildWorkingSet('wsq', ['a', 'b', 'c', 'd'], { memoryBudgetMB: 0.001 }).then(() => 'built', (e) => e.name);
    ws.afterGuard = duck.workingSet('wsq');
    duck.memoryBudgetMB = 0; duck.workingSetKeep = null; duck.onWorkingSet = null;
    capped.ws = ws;

    window.__step = 'grid paging';
    // The Data tab: Duck.pageRows pages of 200 in a stable order, over just the visible columns, never extending the working set
    {
      const g = {};
      const pg = (p, { columns = ['a', 'b'], sort = null, onStart } = {}) => duck.pageRows('wsq', { columns, sort, offset: p * PAGE_SIZE, limit: PAGE_SIZE, onStart }).then((r) => r.rows);
      const every = async (o) => { const rows = []; for (let p = 0; p * PAGE_SIZE < 6144; p++) rows.push(...await pg(p, o)); return rows; };
      const sum = (rows, k) => rows.reduce((n, r) => n + r[k], 0);
      const uniq = (rows) => new Set(rows.map((r) => r.a)).size;
      const asc = (rows, k) => rows.every((r, i) => i === 0 || rows[i - 1][k] < r[k]);
      g.file = await every(); // no working set: the file is read, page by page, by file row number
      const fileLane = new Set();
      await pg(1, { onStart: (id) => fileLane.add(id) });
      await duck.buildWorkingSet('wsq', ['a', 'b']);
      const lanes = new Set();
      g.ws = []; for (let p = 0; p * PAGE_SIZE < 6144; p++) g.ws.push(...await pg(p, { onStart: (id) => lanes.add(id) }));
      g.sorted = await every({ sort: { column: 'a', dir: 'desc' } });
      g.ties = await every({ sort: { column: 'd', dir: 'asc' }, columns: ['a', 'd'] }); // d: 7 values over 6144 rows, so thousands of ties; d is outside the working set, so this reads the file
      g.tiesWs = await (async () => { await duck.buildWorkingSet('wsq', ['a', 'b', 'd']); return every({ sort: { column: 'd', dir: 'asc' }, columns: ['a', 'd'] }); })();
      await duck.buildWorkingSet('wsq', ['a', 'b']);
      g.cols = duck.workingSet('wsq').columns;
      const outside = new Set();
      g.outside = await pg(1, { columns: ['c'], onStart: (id) => outside.add(id) });
      g.colsAfter = duck.workingSet('wsq').columns; // showing column c in the grid did not grow the working set
      g.record = (await duck.pageRows('wsq', { columns: null, sort: null, offset: 1234, limit: 1 })).rows[0];
      g.recordSorted = (await duck.pageRows('wsq', { columns: null, sort: { column: 'a', dir: 'desc' }, offset: 5, limit: 1 })).rows[0];
      g.past = (await duck.pageRows('wsq', { columns: ['a'], offset: 6144, limit: 200 })).rows.length;
      g.last = (await pg(30)).length;
      await duck.clearWorkingSet('wsq');
      g.afterClear = await every();
      // a downloaded table (not remote) pages too
      await duck.loadFile({ bytes: new TextEncoder().encode('x,y\n' + Array.from({ length: 450 }, (_, i) => i + ',' + (i % 3)).join('\n')), format: 'csv', tableName: 'localgrid' });
      const local = [];
      for (let p = 0; p < 3; p++) local.push(...(await duck.pageRows('localgrid', { columns: ['x'], offset: p * PAGE_SIZE, limit: PAGE_SIZE })).rows);
      const localDesc = (await duck.pageRows('localgrid', { columns: ['x', 'y'], sort: { column: 'x', dir: 'desc' }, offset: 0, limit: 3 })).rows;
      g.summary = {
        file: [g.file.length, uniq(g.file), sum(g.file, 'a'), sum(g.file, 'b'), asc(g.file, 'a')],
        ws: [g.ws.length, uniq(g.ws), sum(g.ws, 'a'), sum(g.ws, 'b')],
        sorted: [g.sorted.length, uniq(g.sorted), g.sorted[0].a, g.sorted.at(-1).a, g.sorted.every((r, i) => i === 0 || g.sorted[i - 1].a > r.a)],
        ties: [g.ties.length, uniq(g.ties), g.ties.every((r, i) => i === 0 || g.ties[i - 1].d < r.d || (g.ties[i - 1].d === r.d && g.ties[i - 1].a < r.a))],
        tiesWs: [g.tiesWs.length, uniq(g.tiesWs), JSON.stringify(g.tiesWs) === JSON.stringify(g.ties)],
        outside: [g.outside.length, g.outside[0], [...outside]],
        local: [local.length, local[449].x, localDesc.map((r) => r.x)],
      };
      capped.grid = {
        summary: g.summary, fileLanes: [...fileLane], lanes: [...lanes], cols: g.cols, colsAfter: g.colsAfter,
        sameRowsFileAndWs: JSON.stringify(g.file) === JSON.stringify(g.ws), sameAfterClear: JSON.stringify(g.file) === JSON.stringify(g.afterClear),
        recordMatchesPage: g.record.a === g.file[1234].a && g.record.c === 'v' + g.file[1234].a, recordSortedMatches: g.recordSorted.a === g.sorted[5].a,
        columns: Object.keys(g.record), past: g.past, last: g.last,
      };
    }

    // the app's case: queries fired right after attach, before the other lanes are up, still spread out
    await duck.attachUrl({ url: rgUrl, tableName: 'early', rowCap: 4096 });
    const early = new Set();
    await Promise.all([0, 1, 2, 3, 4, 5].map(() => duck.query('SELECT sum(hash(i * r)) AS h FROM early, range(3000) t(r)', { cache: false, onStart: (id) => early.add(id) })));
    capped.lanes = {
      early: [...early].sort(),
      ready: duck.readyLanes, single: Math.round(single), parallel: Math.round(parallel), lanesUsed: [...lanesUsed].sort(),
      same: par.every((r) => r.rows[0].h === one), afterResample: after.map((r) => `${r.rows[0].lo}-${r.rows[0].hi}`),
    };
    out.remote.capped = capped;
    // reusing the name for a downloaded table must replace the view
    out.remote.replaced = (await duck.loadFile({ bytes: pq, format: 'parquet', tableName: 'rpq' })).rowCount;
  } catch (e) {
    out.parquetError = String(e?.message || e);
  }
  // A forced parquet load must fail with a friendly message (or succeed if the extension is reachable).
  try {
    out.badParquet = await duck.loadFile({ bytes: new TextEncoder().encode('not parquet'), format: 'parquet', tableName: 'bad' });
  } catch (e) {
    out.badParquetError = String(e?.message || e);
  }

  window.__step = 'parts';
  // 3c. Several files (hf:// glob) as one table: columns unioned by name, plus source_file
  const enc = (s) => new TextEncoder().encode(s);
  out.parts = await duck.loadFile({ format: 'csv', tableName: 'multi', fileName: 'w.csv', parts: [
    { path: 'release/w1/w.csv', bytes: enc('a,b\n1,x\n2,y\n') },
    { path: 'release/w2/w.csv', bytes: enc('a,b,c\n3,z,true\n') },
  ] });
  out.partsRows = (await duck.query('SELECT a, b, c, source_file FROM multi ORDER BY a')).rows;

  window.__step = 'ndjson/tsv';
  // 4. NDJSON + TSV
  out.ndjson = await duck.loadFile({ bytes: new TextEncoder().encode('{"a":1}\n{"a":2}\n'), format: 'ndjson', tableName: 'nd' });
  out.tsv = await duck.loadFile({ bytes: new TextEncoder().encode('x\ty\n1\tfoo\n2\tbar\n'), format: 'tsv', tableName: 'ts' });
  out.tsvCols = (await duck.query('SELECT * FROM ts')).columns;

  window.__step = 'cancel';
  // 4b. Cancellation: a running query is interrupted; a queued one never starts; the connection stays usable
  {
    const slow = new AbortController();
    const queued = new AbortController();
    let queuedStarted = false;
    const t0 = performance.now();
    const running = duck.query('SELECT sum(hash(i)) AS s FROM range(4000000000) t(i)', { signal: slow.signal });
    const waiting = duck.query('SELECT 1 AS one', { signal: queued.signal, onStart: () => { queuedStarted = true; } });
    queued.abort();
    setTimeout(() => slow.abort(), 300);
    const settle = (p) => p.then(() => 'resolved', (e) => e.name);
    out.cancel = {
      running: await settle(running),
      runningMs: Math.round(performance.now() - t0),
      waiting: await settle(waiting),
      queuedStarted,
      after: (await duck.query('SELECT 42 AS v')).rows[0].v,
    };
  }

  // 5. SQL error surfaces as a rejected promise
  try { await duck.query('SELECT nope FROM j'); out.sqlError = null; } catch (e) { out.sqlError = String(e.message || e); }
  return out;
}

run().then(
  (r) => { window.__result = r; },
  (e) => { window.__error = `[step ${window.__step}] ` + String(e?.stack || e); }
);
