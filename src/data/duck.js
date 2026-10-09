// DuckDB-WASM wrapper: load a file into a table, run SQL, profile a table.
import * as duckdb from '@duckdb/duckdb-wasm';
import { withStarts, pickRowGroups, rowRanges, sliceRanges } from './sample.js';
import { columnsInSql, splitGroups } from './workset.js';
import { DOWNLOAD_OVERHEAD, MEMORY_EXPANSION } from './memory.js';

// Arrow type ids (apache-arrow Type enum; stable across versions).
const T_DECIMAL = 7, T_DATE = 8, T_TIMESTAMP = 10;

// Symptoms of a failed extension download inside duckdb-wasm.
const EXT_FAIL_RE = /null function|signature mismatch|^unreachable$|extension|Failed to (download|fetch)|NetworkError/i;

// Remote Parquet with more rows than this is queried through a sample (whole row groups, see sample.js):
// scanning a whole column of a multi-GB file means GBs of range requests, which a browser tab can't finish.
export const REMOTE_ROW_CAP = 5_000_000;

export const quoteIdent = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const quoteStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const READERS = {
  csv: (f) => `read_csv_auto(${quoteStr(f)})`,
  tsv: (f) => `read_csv_auto(${quoteStr(f)}, delim='\\t')`,
  json: (f) => `read_json_auto(${quoteStr(f)})`,
  ndjson: (f) => `read_json_auto(${quoteStr(f)}, format='newline_delimited')`,
  parquet: (f) => `read_parquet(${quoteStr(f)})`,
};

export function kindOf(duckType) {
  const t = String(duckType).toUpperCase();
  if (t.startsWith('INTERVAL')) return 'nominal';
  if (/^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?|DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC)\b/.test(t)) return 'quantitative';
  if (/^(DATE|TIMESTAMP)/.test(t)) return 'temporal';
  if (t === 'BOOLEAN') return 'boolean';
  return 'nominal';
}

// Dates (and midnight timestamps) as YYYY-MM-DD so category axes stay readable.
function isoOf(d, typeId) {
  if (isNaN(d)) return null;
  const s = d.toISOString();
  return typeId === T_DATE || s.endsWith('T00:00:00.000Z') ? s.slice(0, 10) : s;
}

// Convert one Arrow cell to a plain JSON-friendly JS value.
function toPlain(v, typeId) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    if (typeId === T_TIMESTAMP || typeId === T_DATE) return isoOf(new Date(Number(v)), typeId);
    return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString();
  }
  if (v instanceof Date) return isoOf(v, typeId);
  if (typeof v === 'number') {
    if (typeId === T_TIMESTAMP || typeId === T_DATE) {
      return isoOf(new Date(v), typeId);
    }
    return Number.isFinite(v) ? v : null; // NaN/Infinity aren't JSON-safe
  }
  if (typeId === T_DECIMAL) return Number(String(v)); // only hit if castDecimalToDouble is off
  if (typeof v === 'object') {
    if (typeof v.toJSON === 'function') v = v.toJSON(); // Arrow Struct/Map rows
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v, (x) => toPlain(x));
    if (v && typeof v[Symbol.iterator] === 'function') {
      return Array.from(v, (x) => toPlain(x)); // Arrow Vector (LIST)
    }
    const out = {};
    for (const k of Object.keys(v)) out[k] = toPlain(v[k]);
    return out;
  }
  return v;
}

// Arrow record batches (a streamed result) -> { columns, rows } of plain JS values.
function arrowToPlain(schema, batches) {
  const fields = schema.fields;
  const columns = fields.map((f) => ({ name: f.name, type: String(f.type) }));
  // Date64 (unit=ms) is how duckdb-wasm may ship TIMESTAMP; treat it as a timestamp.
  const typeIds = fields.map((f) => (f.type.typeId === T_DATE && f.type.unit === 1 ? T_TIMESTAMP : f.type.typeId));
  const rows = [];
  for (const batch of batches) {
    const vectors = fields.map((_, j) => batch.getChildAt(j));
    for (let i = 0; i < batch.numRows; i++) {
      const row = {};
      for (let j = 0; j < fields.length; j++) row[fields[j].name] = toPlain(vectors[j]?.get(i), typeIds[j]);
      rows.push(row);
    }
  }
  return { columns, rows };
}

const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

// DuckDB instances ("lanes") used for a remote Parquet file. Each lane is its own Web Worker, so queries on different
// lanes truly run in parallel: their range requests overlap instead of waiting on each other. Every lane opens the same
// URL under the same file name and gets the same view, so any query can run on any lane.
// Downloaded tables stay on lane 0: their queries take milliseconds and copying the data would cost memory.
export const REMOTE_LANES = 4;
const RESULT_CACHE_SIZE = 64; // query results kept (by SQL) until the data changes
const DB_CONFIG = { query: { castDecimalToDouble: true, castTimestampToDate: true } };

export class Duck {
  constructor(db, conn, worker, bundle) {
    this.db = db;
    this.conn = conn;
    this.worker = worker;
    this._bundle = bundle;
    // lane 0 is this instance; query() runs one statement at a time per lane
    this._lanes = [{ id: 0, db, conn, queue: Promise.resolve(), pending: 0, ready: true }];
    this._pool = null; // { table, vfs, url, viewSql, size } while a remote file is attached
    this._gen = 0; // bumped whenever data changes: keys the result cache
    this.memoryBudgetMB = 0; // working-set guard (0 = none); set by the app from the memory check
    this.workingSetKeep = null; // Set of columns the current charts use: kept when the working set has to shrink
  }

  static async create({ baseUrl = './duckdb/' } = {}) {
    const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/', globalThis.location?.href).href;
    const bundles = {
      mvp: { mainModule: base + 'duckdb-mvp.wasm', mainWorker: base + 'duckdb-browser-mvp.worker.js' },
      eh: { mainModule: base + 'duckdb-eh.wasm', mainWorker: base + 'duckdb-browser-eh.worker.js' },
    };
    const bundle = await duckdb.selectBundle(bundles);
    const worker = new Worker(bundle.mainWorker);
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    await db.open({ query: { castDecimalToDouble: true, castTimestampToDate: true } });
    const conn = await db.connect();
    return new Duck(db, conn, worker, bundle);
  }

  // A fresh DuckDB instance in its own worker.
  async _newLane(id) {
    const worker = new Worker(this._bundle.mainWorker);
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(this._bundle.mainModule, this._bundle.pthreadWorker);
    await db.open(DB_CONFIG);
    return { id, db, worker, conn: await db.connect(), queue: Promise.resolve(), pending: 0, ready: false };
  }

  // Bring lanes 1..size-1 up to the current remote view, in the background. Queries use each lane once it's ready.
  // Each lane is created once (_laneStarts) and its setups are chained, so overlapping attach/resample calls apply in order.
  _spreadToLanes(size) {
    const pool = this._pool;
    // lanes still hold the previous view: out of rotation until they switch (lane 0 already has the new one)
    for (const l of this._lanes) if (l.id !== 0) l.ready = false;
    if (!this._bundle || !pool || size < 2) return Promise.resolve();
    this._laneStarts ||= [];
    this._laneSetups ||= [];
    const jobs = [];
    for (let i = 1; i < size; i++) {
      this._warmLane(i);
      // A lane is ready once the file is registered. Its view (a ~1 s footer pass per sample slice) is created only
      // when a query needs it (see _pump): working-set builds read the file directly and don't.
      const setup = async () => {
        const lane = await this._laneStarts[i];
        if (this._pool !== pool) return; // superseded by a newer attach / resample
        await lane.queue; // let a running query on this lane finish (or cancel) first
        lane.ready = false;
        if (lane.vfs !== pool.vfs) {
          if (lane.vfs) await lane.db.dropFile(lane.vfs).catch(() => {});
          await lane.db.registerFileURL(pool.vfs, pool.url, duckdb.DuckDBDataProtocol.HTTP, false);
          lane.vfs = pool.vfs;
          lane.view = null;
        }
        if (this._pool === pool) { lane.ready = true; this._pump(); }
      };
      this._laneSetups[i] = (this._laneSetups[i] || Promise.resolve()).then(setup).catch(() => { /* a lane that fails just isn't used */ });
      jobs.push(this._laneSetups[i]);
    }
    return (this._lanesSettled = Promise.all(jobs));
  }

  // Start lane i's worker if it isn't running yet (lanes start in any order; no holes in _lanes).
  _warmLane(i) {
    this._laneStarts ||= [];
    this._laneStarts[i] ||= this._newLane(i).then((lane) => { this._lanes.push(lane); return lane; });
    return this._laneStarts[i];
  }

  /** Resolves when the background lanes for the current remote file are up (for tests and measurements). */
  lanesReady() { return this._lanesSettled || Promise.resolve(); }

  /** How many lanes can take queries right now. */
  get readyLanes() { return this._lanes.filter((l) => l.ready).length; }

  // Wait for every lane's queued queries to finish (or be cancelled).
  async _drain() {
    while (this._jobs?.length || this._lanes.some((l) => l.pending)) {
      await Promise.all(this._lanes.map((l) => l.queue));
      if (this._jobs?.length && !this._lanes.some((l) => l.pending)) this._pump();
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // Free a name held by either a table or a view (and a remote file behind it) so it can be reused as either.
  async _dropName(t) {
    this._gen++;
    if (this._pool?.table === t) { // the pooled remote view goes away: stop routing queries to the other lanes
      this._pool = null;
      for (const l of this._lanes) if (l.id !== 0) l.ready = false;
    }
    for (const kind of ['VIEW', 'TABLE']) {
      try { await this.conn.query(`DROP ${kind} IF EXISTS ${quoteIdent(t)}`); } catch { /* it's the other kind */ }
    }
    const rem = this._remote?.[t];
    if (rem) {
      if (rem.ws) await this.conn.query(`DROP TABLE IF EXISTS ${quoteIdent(rem.ws.name)}`).catch(() => {});
      await this.conn.query(`DROP VIEW IF EXISTS ${quoteIdent(`${t}__remote`)}`).catch(() => {});
      await this.db.dropFile(rem.vfs).catch(() => {});
      delete this._remote[t];
    }
  }

  /**
   * Query a remote Parquet file in place: a view over HTTP range reads instead of an in-memory table.
   * Only the footer is read here; each query then fetches just the column chunks it touches.
   * Files over rowCap rows are queried through a sample of whole row groups: `sample` is
   * { mode: 'spread' | 'window', rows, offset } (default: spread across the file, rowCap rows). totalRows is the file's count.
   */
  async attachUrl({ url, tableName, fileName, rowCap = REMOTE_ROW_CAP, sample, lanes = REMOTE_LANES }) {
    await this._drain(); // queued chart queries share the connections: let them finish (or cancel) first
    if (this._bundle) for (let i = 1; i < lanes; i++) this._warmLane(i).catch(() => {}); // workers start while lane 0 reads the footer
    const t = tableName || 'data';
    await this._dropName(t);
    const vfsName = `${t}_${Date.now()}.parquet`;
    await this.db.registerFileURL(vfsName, url, duckdb.DuckDBDataProtocol.HTTP, false);
    const rem = { vfs: vfsName };
    try {
      // the first read is the footer: its size (one footer read per worker) goes into working-set download estimates
      await this.db.collectFileStatistics(vfsName, true).catch(() => {});
      rem.totalRows = Number((await this.conn.query(`SELECT count(*)::DOUBLE FROM read_parquet(${quoteStr(vfsName)})`)).getChildAt(0).get(0));
      rem.footerMB = await this.db.exportFileStatistics(vfsName).then((st) => (st.totalFileReadsCold + st.totalFileReadsAhead) / 1e6).catch(() => 0);
      // row groups: what a sample is made of, and how a working-set build is split across workers
      const rg = await this._runOn(this._lanes[0],
        `SELECT DISTINCT row_group_id AS id, row_group_num_rows::DOUBLE AS rows FROM parquet_metadata(${quoteStr(vfsName)}) ORDER BY 1`, {});
      rem.allGroups = withStarts(rg.rows);
      if (rem.totalRows > rowCap) rem.groups = rem.allGroups;
      await this._remoteView(t, rem, sample || { mode: 'spread', rows: rowCap });
      rem.columns = (await this._runOn(this._lanes[0], `DESCRIBE ${quoteIdent(`${t}__remote`)}`, {})).rows.map((r) => r.column_name);
    } catch (e) {
      await this.db.dropFile(vfsName).catch(() => {});
      throw new Error(`Could not read ${fileName || url} as parquet: ${e?.message || e}`);
    }
    Object.assign(rem, { url, lanes, table: t });
    (this._remote ||= {})[t] = rem;
    this._pool = { table: t, vfs: vfsName, url, viewSql: rem.viewSql, size: lanes };
    this._spreadToLanes(lanes);
    return { tableName: t, rowCount: rem.rowCount, totalRows: rem.totalRows, sample: rem.sample };
  }

  /** Point a sampled remote table at a different sample (see attachUrl). Only footer metadata is read. Drops any working set. */
  async resample(tableName, sample) {
    await this._drain();
    const rem = this._remote?.[tableName];
    if (!rem?.groups) throw new Error(`"${tableName}" is not a sampled remote file`);
    if (rem.ws) await this._dropWorkingSet(rem);
    await this._remoteView(tableName, rem, sample);
    this._pool = { table: tableName, vfs: rem.vfs, url: rem.url, viewSql: rem.viewSql, size: rem.lanes ?? REMOTE_LANES };
    this._spreadToLanes(this._pool.size);
    return { tableName, rowCount: rem.rowCount, totalRows: rem.totalRows, sample: rem.sample };
  }

  // (Re)create the view for a remote file: all of it, or the sampled row groups as file_row_number ranges.
  // One SELECT per range joined by UNION ALL: DuckDB 1.1 prunes row groups for a single range, not for ORs.
  // Lane 0 also keeps <t>__remote, the same view under a fixed name: the working set is built from it, and
  // queries that need columns outside the working set can still read the file through it.
  async _remoteView(t, rem, sample) {
    this._gen++;
    let body = `SELECT * FROM read_parquet(${quoteStr(rem.vfs)})`;
    rem.rowCount = rem.totalRows;
    rem.rgIds = null;
    rem.sample = null;
    rem.picked = rem.allGroups;
    if (rem.groups) {
      const picked = pickRowGroups(rem.groups, sample);
      const ranges = rowRanges(picked);
      const src = `read_parquet(${quoteStr(rem.vfs)}, file_row_number=true)`;
      body = ranges.map(([a, b]) => `SELECT * EXCLUDE (file_row_number) FROM ${src} WHERE file_row_number >= ${a} AND file_row_number < ${b}`).join(' UNION ALL ');
      rem.rowCount = picked.reduce((n, g) => n + g.rows, 0);
      rem.rgIds = picked.map((g) => g.id);
      rem.picked = picked;
      const last = picked[picked.length - 1];
      rem.sample = { mode: sample.mode || 'spread', rows: sample.rows, slices: ranges.length, firstRow: picked[0].start, endRow: last.start + last.rows };
    }
    rem.viewSql = `CREATE OR REPLACE VIEW ${quoteIdent(t)} AS ${body}`;
    await this.conn.query(rem.viewSql);
    await this.conn.query(`CREATE OR REPLACE VIEW ${quoteIdent(`${t}__remote`)} AS ${body}`);
  }

  // ---------- working set ----------
  // The columns a dashboard needs, copied out of the remote sample once (in parallel across the lanes) into an
  // in-memory table on lane 0. Lane 0's view <t> then reads it, so queries over those columns run locally. Each row
  // keeps its file row number (__row) so columns added later line up. Fast mode = a working set of every column.

  /** The working set of remote table t: { columns, rowCount } or null. */
  workingSet(t) {
    const ws = this._remote?.[t]?.ws;
    return ws ? { columns: [...ws.columns], rowCount: ws.rowCount } : null;
  }

  /** All columns of remote table t (null for other tables). */
  remoteColumns(t) { return this._remote?.[t]?.columns?.slice() ?? null; }

  /** Columns `sql` needs that t's working set lacks: [] means it can run on the working set; null if there is none. */
  missingColumns(t, sql) {
    const rem = this._remote?.[t];
    if (!rem?.ws) return null;
    return columnsInSql(sql, rem.columns, t).filter((c) => !rem.ws.columns.has(c));
  }

  /**
   * Estimated memory (MB) of a working set with these columns of t's current sample, from the footer's compressed
   * sizes (see memory.js for the factors). bytesPerRow comes from the remote profile.
   */
  estimateWorkingSetMB(t, columns) {
    const rem = this._remote?.[t];
    const bpr = rem?.bytesPerRow || {};
    const compressed = columns.reduce((n, c) => n + (bpr[c] || 0), 0) * (rem?.rowCount || 0) / 1e6;
    return { downloadMB: compressed * DOWNLOAD_OVERHEAD, memoryMB: compressed * DOWNLOAD_OVERHEAD * MEMORY_EXPANSION };
  }

  /** Expected download of a working-set build: the column chunks plus one footer read per worker taking part. */
  workingSetDownloadMB(t, columns, workers = this._lanes.filter((l) => l.id === 0 || (l.ready && l.vfs === this._remote?.[t]?.vfs)).length) {
    const rem = this._remote?.[t];
    return this.estimateWorkingSetMB(t, columns).downloadMB + (rem?.footerMB || 0) * Math.min(workers, rem?.picked?.length || 1);
  }

  /** Memory DuckDB (lane 0) holds right now, in MB. */
  async memoryMB() {
    const r = await this._runOn(this._lanes[0], 'SELECT memory_usage FROM pragma_database_size()', {});
    const m = /([\d.]+)\s*(bytes|KiB|MiB|GiB|TiB)/.exec(r.rows[0]?.memory_usage || '');
    const k = { bytes: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024, TiB: 1048576 };
    return m ? Number(m[1]) * k[m[2]] : 0;
  }

  /**
   * Build t's working set with these columns (replacing any existing one). Rows are split across the ready lanes
   * (parallel = false: lane 0 only). onProgress({ readMB }) reports MB downloaded so far; signal cancels.
   * memoryBudgetMB: if DuckDB holds more than this afterwards, the working set is dropped and an error with
   * name 'MemoryError' is thrown (memory-pressure guard). Resolves to { columns, rowCount, ms, readMB, combineMs, lanes }.
   */
  async buildWorkingSet(t, columns, { signal, onProgress, parallel = true, memoryBudgetMB = this.memoryBudgetMB } = {}) {
    const rem = this._remote?.[t];
    if (!rem) throw new Error(`"${t}" is not a remote file`);
    await this._drain();
    if (rem.ws) await this._dropWorkingSet(rem);
    const cols = rem.columns.filter((c) => columns.includes(c));
    const name = `${t}__ws`;
    const t0 = performance.now();
    const stats = await this._copyColumns(rem, name, cols, { signal, onProgress, parallel });
    rem.ws = { name, columns: new Set(cols), rowCount: rem.rowCount };
    await this._runOn(this._lanes[0], `CREATE OR REPLACE VIEW ${quoteIdent(t)} AS SELECT * EXCLUDE (__row) FROM ${quoteIdent(name)}`, {});
    this._gen++;
    await this._guardMemory(rem, memoryBudgetMB);
    this._pump();
    return { columns: cols, rowCount: rem.rowCount, ms: Math.round(performance.now() - t0), ...stats };
  }

  /**
   * Add columns to t's working set (same rows, joined on __row). memoryBudgetMB: if the larger working set would not
   * fit, columns not in `keep` are dropped first (shrink); if it still doesn't fit, nothing is added and false is
   * returned, so the caller reads the file instead. Resolves true when the columns were added.
   */
  async extendWorkingSet(t, columns, { signal, onProgress, keep = this.workingSetKeep, memoryBudgetMB = this.memoryBudgetMB } = {}) {
    const rem = this._remote?.[t];
    if (!rem?.ws) throw new Error(`"${t}" has no working set`);
    const add = rem.columns.filter((c) => columns.includes(c) && !rem.ws.columns.has(c));
    if (!add.length) return true;
    if (memoryBudgetMB) {
      const fits = () => this.estimateWorkingSetMB(t, [...rem.ws.columns, ...add]).memoryMB <= memoryBudgetMB;
      if (!fits()) { // shrink: drop columns nobody needs right now
        const spare = [...rem.ws.columns].filter((c) => !(keep && keep.has?.(c)) && !columns.includes(c));
        while (spare.length && !fits()) {
          const c = spare.pop();
          await this._runOn(this._lanes[0], `ALTER TABLE ${quoteIdent(rem.ws.name)} DROP COLUMN ${quoteIdent(c)}`, {});
          rem.ws.columns.delete(c);
          this._gen++;
        }
        if (!fits()) { this._emitWorkingSet({ type: 'extend', phase: 'refused', columns: add, t }); return false; }
      }
    }
    this._emitWorkingSet({ type: 'extend', phase: 'start', columns: add, t });
    try {
      const x = `${t}__wsx`;
      await this._copyColumns(rem, x, add, { signal, onProgress, parallel: true });
      const lane0 = this._lanes[0];
      await this._runOn(lane0, `CREATE OR REPLACE TABLE ${quoteIdent(rem.ws.name)} AS SELECT * FROM ${quoteIdent(rem.ws.name)} JOIN ${quoteIdent(x)} USING (__row)`, { signal });
      await this._runOn(lane0, `DROP TABLE IF EXISTS ${quoteIdent(x)}`, {});
      await this._runOn(lane0, `CREATE OR REPLACE VIEW ${quoteIdent(t)} AS SELECT * EXCLUDE (__row) FROM ${quoteIdent(rem.ws.name)}`, {});
      for (const c of add) rem.ws.columns.add(c);
      this._gen++;
      await this._guardMemory(rem, memoryBudgetMB);
      this._emitWorkingSet({ type: 'extend', phase: 'done', columns: add, t });
      return true;
    } catch (e) {
      this._emitWorkingSet({ type: 'extend', phase: 'error', columns: add, t, error: e?.message || String(e) });
      throw e;
    }
  }

  /** Drop t's working set: queries read the file again (light mode). */
  async clearWorkingSet(t) {
    const rem = this._remote?.[t];
    if (rem?.ws) { await this._drain(); await this._dropWorkingSet(rem); }
  }

  async _dropWorkingSet(rem) {
    const lane0 = this._lanes[0];
    await this._runOn(lane0, rem.viewSql, {}); // lane 0's view reads the file again
    await this._runOn(lane0, `DROP TABLE IF EXISTS ${quoteIdent(rem.ws.name)}`, {});
    rem.ws = null;
    this._gen++;
  }

  // Memory-pressure guard: abandon a working set that ended up larger than the budget.
  async _guardMemory(rem, budgetMB) {
    if (!budgetMB) return;
    const used = await this.memoryMB().catch(() => 0);
    if (used > budgetMB) {
      await this._dropWorkingSet(rem);
      throw Object.assign(new Error(`The working set needed ${Math.round(used)} MB, over this browser's ${Math.round(budgetMB)} MB budget`), { name: 'MemoryError' });
    }
  }

  _emitWorkingSet(ev) { try { this.onWorkingSet?.(ev); } catch { /* listener errors are not ours */ } }

  /**
   * Copy __row + cols of rem's current sample into table `target` on lane 0. The rows are cut into units (a sample
   * slice, or a few row groups) and each lane pulls the next unit when it's free: lane 0 inserts its units straight
   * into the table; other lanes write theirs to an in-memory Parquet file whose bytes lane 0 then inserts (exact types,
   * compact transfer). onProgress({ fraction }) after each unit: workers can't answer while busy reading, so
   * finished units are the only live progress signal.
   */
  async _copyColumns(rem, target, cols, { signal, onProgress, parallel }) {
    const lane0 = this._lanes[0];
    const others = parallel ? this._lanes.filter((l) => l.id !== 0 && l.ready && l.vfs === rem.vfs) : [];
    const lanes = [lane0, ...others];
    // at least two units per lane so the load evens out; each unit is whole row groups
    const units = splitGroups(rem.picked, Math.max(lanes.length * 2, 1));
    const src = `read_parquet(${quoteStr(rem.vfs)}, file_row_number=true)`;
    const select = ['file_row_number AS __row', ...cols.map(quoteIdent)].join(', ');
    const unitSql = (unit) => rowRanges(unit)
      .map(([a, b]) => `SELECT ${select} FROM ${src} WHERE file_row_number >= ${a} AND file_row_number < ${b}`).join(' UNION ALL ');
    const totalRows = units.reduce((n, u) => n + u.reduce((m, g) => m + g.rows, 0), 0) || 1;
    let doneRows = 0;
    const done = (unit) => {
      doneRows += unit.reduce((m, g) => m + g.rows, 0);
      onProgress?.({ fraction: doneRows / totalRows });
    };
    const tag = `${target}_${Date.now()}`;
    let combineMs = 0;
    let next = 0;
    const used = new Set();
    try {
      // an empty table with the right types (reads only the footer)
      await this._runOn(lane0, `CREATE OR REPLACE TABLE ${quoteIdent(target)} AS SELECT ${select} FROM ${src} LIMIT 0`, { signal });
      const work = async (lane) => {
        for (let k = next++; k < units.length; k = next++) {
          used.add(lane.id);
          const unit = units[k];
          if (lane === lane0) {
            await this._runOn(lane0, `INSERT INTO ${quoteIdent(target)} ${unitSql(unit)}`, { signal });
          } else {
            const file = `${tag}_u${k}.parquet`;
            await this._runOn(lane, `COPY (${unitSql(unit)}) TO ${quoteStr(file)} (FORMAT parquet)`, { signal });
            const bytes = await lane.db.copyFileToBuffer(file);
            await lane.db.dropFile(file).catch(() => {});
            const t0 = performance.now();
            await lane0.db.registerFileBuffer(file, bytes);
            try {
              await this._runOn(lane0, `INSERT INTO ${quoteIdent(target)} SELECT * FROM read_parquet(${quoteStr(file)})`, { signal });
            } finally {
              await lane0.db.dropFile(file).catch(() => {});
            }
            combineMs += performance.now() - t0;
          }
          done(unit);
        }
      };
      await Promise.all(lanes.map(work));
    } catch (e) {
      await this._runOn(lane0, `DROP TABLE IF EXISTS ${quoteIdent(target)}`, {}).catch(() => {});
      throw e;
    }
    return { lanes: lanes.length, parts: used.size, units: units.length, combineMs: Math.round(combineMs) };
  }


  /** Fast mode: a working set of every column (see buildWorkingSet). */
  async materialize(tableName, opts = {}) {
    const rem = this._remote?.[tableName];
    if (!rem) throw new Error(`"${tableName}" is not a remote file`);
    if (!this.isCached(tableName)) await this.buildWorkingSet(tableName, rem.columns, opts);
    return { tableName, rowCount: rem.rowCount, cached: rem.ws.name };
  }

  /** Is every column of tableName in its working set (fast mode)? */
  isCached(tableName) {
    const rem = this._remote?.[tableName];
    return !!rem?.ws && rem.columns.every((c) => rem.ws.columns.has(c));
  }

  async loadFile({ bytes, parts, format, tableName, fileName }) {
    await this._drain();
    if (parts) return this._loadParts({ parts, format, tableName, fileName });
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes); // accept ArrayBuffer too
    const reader = READERS[format];
    if (!reader) throw new Error(`Unsupported format: ${format}`);
    const t = tableName || 'data';
    await this._dropName(t);
    const label = fileName || `${t}.${format}`;
    const isJson = format === 'json' || format === 'ndjson';
    if (isJson && this._noJsonExt) {
      await this._loadJsonViaCsv(bytes, format, t, label);
    } else {
      const vfsName = `${t}_${Date.now()}.${format === 'ndjson' ? 'jsonl' : format}`;
      // registerFileBuffer transfers the buffer to the worker; copy so the caller's bytes stay usable.
      await this.db.registerFileBuffer(vfsName, bytes.slice());
      try {
        await this.conn.query(`CREATE OR REPLACE TABLE ${quoteIdent(t)} AS SELECT * FROM ${reader(vfsName)}`);
      } catch (e) {
        // read_json_auto needs the json extension, fetched at runtime from extensions.duckdb.org.
        // If that is blocked/offline, parse in JS and load through the CSV reader instead.
        const extFailed = EXT_FAIL_RE.test(String(e?.message || e));
        if (format === 'parquet' && extFailed) {
          throw new Error(`Parquet support needs DuckDB's parquet extension from extensions.duckdb.org, which could not be loaded (offline or blocked?). Details: ${e?.message || e}`);
        }
        if (!isJson || !extFailed) throw new Error(`Could not parse ${label} as ${format}: ${e?.message || e}`);
        this._noJsonExt = true;
        await this._loadJsonViaCsv(bytes, format, t, label);
      } finally {
        await this.db.dropFile(vfsName).catch(() => {});
      }
    }
    const res = await this.conn.query(`SELECT count(*)::DOUBLE AS n FROM ${quoteIdent(t)}`);
    return { tableName: t, rowCount: Number(res.getChildAt(0).get(0)) };
  }

  // Several files of one format (e.g. an hf:// glob) as one table: UNION ALL BY NAME, so columns added in later
  // files are kept (NULL elsewhere), plus a source_file column with each row's path.
  async _loadParts({ parts, format, tableName, fileName }) {
    const reader = READERS[format];
    if (!reader) throw new Error(`Unsupported format: ${format}`);
    const t = tableName || 'data';
    await this._dropName(t);
    const ext = format === 'ndjson' ? 'jsonl' : format;
    const names = parts.map((_, i) => `${t}_${Date.now()}_${i}.${ext}`);
    try {
      for (let i = 0; i < parts.length; i++) await this.db.registerFileBuffer(names[i], new Uint8Array(parts[i].bytes).slice());
      const selects = parts.map((p, i) => `SELECT *, ${quoteStr(p.path)} AS source_file FROM ${reader(names[i])}`);
      await this.conn.query(`CREATE OR REPLACE TABLE ${quoteIdent(t)} AS ${selects.join(' UNION ALL BY NAME ')}`);
    } catch (e) {
      throw new Error(`Could not combine the ${parts.length} ${fileName || format} files: ${e?.message || e}`);
    } finally {
      for (const n of names) await this.db.dropFile(n).catch(() => {});
    }
    const res = await this.conn.query(`SELECT count(*)::DOUBLE AS n FROM ${quoteIdent(t)}`);
    return { tableName: t, rowCount: Number(res.getChildAt(0).get(0)) };
  }

  // JSON fallback: rows -> CSV (nested values as JSON text) -> read_csv_auto for type sniffing.
  async _loadJsonViaCsv(bytes, format, t, label) {
    let rows;
    try {
      const text = new TextDecoder().decode(bytes);
      rows = format === 'ndjson'
        ? text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
        : JSON.parse(text);
    } catch (e) {
      throw new Error(`Could not parse ${label} as ${format}: ${e?.message || e}`);
    }
    if (!Array.isArray(rows)) {
      // {"data":[...]} style wrappers: use the first array-valued property, else a single row.
      const arr = rows && typeof rows === 'object' && Object.values(rows).find(Array.isArray);
      rows = arr || [rows];
    }
    rows = rows.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r }));
    if (!rows.length) throw new Error(`${label} contains no rows.`);

    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const cell = (v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const csv = [keys.map(cell).join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join('\n');
    const name = `${t}_${Date.now()}_fallback.csv`;
    await this.db.registerFileText(name, csv);
    try {
      await this.conn.query(
        `CREATE OR REPLACE TABLE ${quoteIdent(t)} AS SELECT * FROM read_csv_auto(${quoteStr(name)}, header=true, sample_size=-1)`
      );
    } catch (e) {
      throw new Error(`Could not load ${label} as ${format}: ${e?.message || e}`);
    } finally {
      await this.db.dropFile(name).catch(() => {});
    }
  }

  /**
   * Run SQL; resolves to { columns, rows }. Each DuckDB worker ("lane") runs one query at a time. Queries on the attached
   * remote file go to the least busy ready lane, so up to REMOTE_LANES run in parallel; everything else uses lane 0.
   * With a working set, queries over its columns run on lane 0 against it; a query that needs other columns first
   * extends the working set (autoExtend, within the memory budget) or else reads the file on the other lanes.
   * Results are cached by SQL until the data changes (cache: false skips it); identical queries in flight are shared.
   * signal (AbortSignal): drops the query if it's still queued, or cancels it mid-run; rejects with an AbortError.
   * onStart(laneId): called when the query leaves the queue and starts running (not for cache hits).
   */
  query(sql, { limit = 5000, signal, onStart, cache = true, autoExtend = true } = {}) {
    let text = String(sql).trim().replace(/;\s*$/, '').trim();
    const original = text; // column analysis uses this: the LIMIT wrapper below reads as SELECT *
    if (limit != null && /^(select|with|from|values|\()/i.test(text) && !text.includes(';')) {
      // newline before ')' so a trailing "-- comment" can't swallow it
      text = `SELECT * FROM (\n${text}\n) AS _q LIMIT ${Math.max(0, Math.floor(limit))}`;
    }
    if (!cache || !/^(select|with|from|values|\(|describe|pragma)/i.test(text)) return this._route(text, original, { signal, onStart, autoExtend });
    const key = `${this._gen}\u0000${text}`;
    const results = (this._results ||= new Map());
    const hit = results.get(key);
    if (hit) { results.delete(key); results.set(key, hit); return hit; } // LRU touch
    const p = this._route(text, original, { signal, onStart, autoExtend });
    results.set(key, p);
    p.catch(() => results.delete(key)); // failures and cancels are not cached
    while (results.size > RESULT_CACHE_SIZE) results.delete(results.keys().next().value);
    return p;
  }

  /**
   * Rows [offset, offset + limit) of table t in a stable order, for browsing: { rows, columns }. columns: names to select
   * (null = all); sort: { column, dir: 'asc' | 'desc' } or null. Unlike query() this reads only what the page needs:
   *  - a remote table's natural order is file order, with or without a working set, so rows don't move when one is
   *    built; a page is read by file_row_number (row groups are skipped, not scanned up to the offset)
   *  - sorting breaks ties by file row, so pages don't overlap or skip rows
   *  - it uses the working set when it holds every column involved, else reads the file, and never extends the working set
   */
  async pageRows(t, { columns = null, sort = null, offset = 0, limit = 200, signal, onStart } = {}) {
    const rem = this._remote?.[t];
    const dir = sort?.dir === 'desc' ? 'DESC' : 'ASC';
    if (!rem) { // downloaded tables keep insertion order
      const sel = columns ? columns.map(quoteIdent).join(', ') : '*';
      const order = sort ? ` ORDER BY ${quoteIdent(sort.column)} ${dir} NULLS LAST` : '';
      return this.query(`SELECT ${sel} FROM ${quoteIdent(t)}${order} LIMIT ${limit} OFFSET ${offset}`, { limit: null, autoExtend: false, signal, onStart });
    }
    const names = columns || rem.columns;
    const sel = names.map(quoteIdent).join(', ');
    const sortSql = sort ? ` ORDER BY ${quoteIdent(sort.column)} ${dir} NULLS LAST, __k LIMIT ${limit} OFFSET ${offset}` : ' ORDER BY __k';
    const inner = (src, key, ranges) => {
      const pick = [...new Set([...names, ...(sort ? [sort.column] : [])])].map(quoteIdent).join(', ');
      return ranges.map(([a, b]) => `SELECT ${pick}, ${key} AS __k FROM ${src} WHERE ${key} >= ${a} AND ${key} < ${b}`).join(' UNION ALL ');
    };
    const sample = rowRanges(rem.picked);
    const ranges = sort ? sample : sliceRanges(sample, offset, limit);
    if (!ranges.length) return { columns: names.map((name) => ({ name, type: '' })), rows: [] };
    const fromFile = () => this._enqueue(`SELECT ${sel} FROM (${inner(`read_parquet(${quoteStr(rem.vfs)}, file_row_number=true)`, 'file_row_number', ranges)})${sortSql}`, { signal, onStart });
    const ws = rem.ws;
    if (ws && names.concat(sort ? [sort.column] : []).every((c) => ws.columns.has(c))) {
      // the working set holds __row (the file row number) beside its columns
      const sql = sort
        ? `SELECT ${sel} FROM ${quoteIdent(ws.name)} ORDER BY ${quoteIdent(sort.column)} ${dir} NULLS LAST, __row LIMIT ${limit} OFFSET ${offset}`
        : `SELECT ${sel} FROM (${inner(quoteIdent(ws.name), '__row', ranges)})${sortSql}`;
      return this._runOn(this._lanes[0], sql, { signal, onStart }).catch((e) => {
        if (e?.name === 'AbortError' || rem.ws) throw e;
        return fromFile(); // the working set was cleared meanwhile
      });
    }
    return fromFile();
  }

  // Decide where a query runs: lane 0, the working set (after extending it if needed), or the pool of lanes.
  async _route(text, original, { signal, onStart, autoExtend }) {
    const pool = this._pool;
    if (!(pool && text.includes(pool.table))) return this._runOn(this._lanes[0], text, { signal, onStart });
    const rem = this._remote?.[pool.table];
    if (rem?.ws) {
      let missing = columnsInSql(original, rem.columns, pool.table).filter((c) => !rem.ws.columns.has(c));
      if (missing.length && autoExtend && await this.extendWorkingSet(pool.table, missing, { signal }).catch((e) => {
        if (e?.name === 'AbortError') throw e;
        return false; // couldn't extend (memory, error): read the file instead
      })) missing = [];
      if (!missing.length) return this._runOn(this._lanes[0], text, { signal, onStart });
      // lane 0's view is the working set: read the file on the other lanes, or on lane 0 through <t>__remote
      if (!this._lanes.some((l) => l.id !== 0 && l.ready)) {
        const viaRemote = text.replace(new RegExp(`"${pool.table}"|\\b${pool.table}\\b(?!__)`, 'g'), quoteIdent(`${pool.table}__remote`));
        return this._runOn(this._lanes[0], viaRemote, { signal, onStart });
      }
      return this._enqueue(text, { signal, onStart, remoteOnly: true });
    }
    return this._enqueue(text, { signal, onStart });
  }

  // Pooled: wait in a shared queue; the first lane that is ready and idle takes it (lanes come up in the background).
  _enqueue(text, { signal, onStart, remoteOnly = false }) {
    return new Promise((resolve, reject) => {
      const job = { text, signal, onStart, remoteOnly, resolve, reject };
      const drop = () => {
        const i = (this._jobs || []).indexOf(job);
        if (i >= 0) { this._jobs.splice(i, 1); reject(abortError()); }
      };
      signal?.addEventListener('abort', drop, { once: true });
      job.drop = drop;
      (this._jobs ||= []).push(job);
      queueMicrotask(() => this._pump()); // a dispatch problem must not reject this call while the job stays queued
    });
  }

  // Hand waiting pooled queries to idle, ready lanes (remote-only jobs skip lane 0, whose view may be the working set).
  _pump() {
    for (let i = 0; this._jobs && i < this._jobs.length;) {
      const job = this._jobs[i];
      const lane = this._lanes.find((l) => l.ready && l.pending === 0 && !(job.remoteOnly && l.id === 0));
      if (!lane) { i++; continue; }
      this._jobs.splice(i, 1);
      job.signal?.removeEventListener('abort', job.drop);
      const pool = this._pool;
      if (lane.id !== 0 && pool && lane.view !== pool.viewSql) { // first query on this lane for this view: create it
        lane.view = pool.viewSql;
        this._runOn(lane, pool.viewSql, {}).catch(() => { lane.view = null; });
      }
      this._runOn(lane, job.text, job).then(job.resolve, job.reject);
    }
  }

  // Run on one lane, after whatever is already queued there.
  _runOn(lane, text, { signal, onStart }) {
    const run = async () => {
      if (signal?.aborted) throw abortError();
      onStart?.(lane.id);
      // send() runs the query as a pending query the worker polls, so cancelSent() can interrupt it (query() can't)
      let cancelled = false;
      const cancel = () => { cancelled = true; lane.conn.cancelSent().catch(() => {}); };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const reader = await lane.conn.send(text);
        await reader.open?.();
        const schema = reader.schema; // read before iterating: it is cleared once the stream ends
        const batches = [];
        for await (const batch of reader) batches.push(batch);
        if (cancelled) throw abortError();
        return arrowToPlain(schema || batches[0]?.schema, batches);
      } catch (e) {
        throw cancelled || signal?.aborted ? abortError() : e;
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    };
    lane.pending++;
    this._lastLane = lane.id; // for tests and ?debug
    const p = lane.queue.then(run, run).finally(() => {
      lane.pending--;
      queueMicrotask(() => this._pump()); // outside this query's promise: a dispatch problem can't fail a finished query
    });
    lane.queue = p.catch(() => {});
    return p;
  }


  async profile(tableName) {
    if (this._remote?.[tableName]) return this._profileRemote(tableName, this._remote[tableName]);
    const t = quoteIdent(tableName);
    const desc = (await this.query(`DESCRIBE ${t}`, { limit: null })).rows;
    const cols = desc.map((r) => ({ name: r.column_name, type: r.column_type, kind: kindOf(r.column_type) }));

    // One aggregate pass for all columns.
    const parts = ['count(*)::DOUBLE AS "__n"'];
    cols.forEach((c, i) => {
      const q = quoteIdent(c.name);
      parts.push(`count(${q})::DOUBLE AS "nn${i}"`, `approx_count_distinct(${q})::DOUBLE AS "d${i}"`);
      if (c.kind === 'quantitative') {
        parts.push(`min(${q})::DOUBLE AS "mn${i}"`, `max(${q})::DOUBLE AS "mx${i}"`, `avg(${q})::DOUBLE AS "av${i}"`);
      } else if (c.kind === 'temporal') {
        parts.push(`min(${q}) AS "mn${i}"`, `max(${q}) AS "mx${i}"`);
      } else {
        parts.push(`min(${q}::VARCHAR) AS "mn${i}"`, `max(${q}::VARCHAR) AS "mx${i}"`);
      }
    });
    const agg = (await this.query(`SELECT ${parts.join(', ')} FROM ${t}`, { limit: null })).rows[0] || {};
    const rowCount = agg.__n || 0;

    const columns = cols.map((c, i) => {
      const nonNull = agg[`nn${i}`] || 0;
      const col = {
        name: c.name,
        type: c.type,
        kind: c.kind,
        nullPct: rowCount ? Math.round(((rowCount - nonNull) / rowCount) * 10000) / 100 : 0,
        distinct: Math.min(agg[`d${i}`] || 0, nonNull),
        min: agg[`mn${i}`] ?? null,
        max: agg[`mx${i}`] ?? null,
      };
      if (c.kind === 'quantitative') col.mean = agg[`av${i}`] ?? null;
      return col;
    });

    // Top values for low-cardinality nominal columns, in one UNION ALL query.
    const topIdx = columns
      .map((c, i) => (c.kind === 'nominal' && c.distinct > 0 && c.distinct <= 50 ? i : -1))
      .filter((i) => i >= 0);
    if (topIdx.length) {
      const sub = topIdx.map((i) => {
        const q = quoteIdent(columns[i].name);
        return `(SELECT ${i} AS ci, ${q}::VARCHAR AS v, count(*)::DOUBLE AS n FROM ${t} WHERE ${q} IS NOT NULL GROUP BY 2 ORDER BY 3 DESC, 2 LIMIT 5)`;
      });
      const top = (await this.query(sub.join(' UNION ALL '), { limit: null })).rows;
      for (const i of topIdx) columns[i].topValues = [];
      for (const r of top) columns[r.ci].topValues.push({ value: r.v, count: r.n });
      for (const i of topIdx) columns[i].topValues.sort((a, b) => b.count - a.count);
    }

    const sample = (await this.query(`SELECT * FROM ${t}`, { limit: 5 })).rows;
    return { table: tableName, rowCount, columns, sample };
  }

  // Remote Parquet: profile from the footer alone (row count, nulls, min/max per column), reading no column data.
  // Any scan here costs seconds (each column is split into chunks across the file, one round trip each), and
  // a sample of whole rows makes DuckDB read ahead across every column, so there are no distinct counts,
  // top values or sample rows. bytesPerRow (compressed size) stands in for cardinality in heuristicCharts.
  // A sampled file (see attachUrl) is profiled from its sampled row groups only, so ranges match the charts.
  async _profileRemote(tableName, rem) {
    const { vfs, rowCount, totalRows, rgIds, sample } = rem;
    // the file's columns (lane 0's <t> may be a working set with only some of them)
    const desc = (await this._runOn(this._lanes[0], `DESCRIBE ${quoteIdent(`${tableName}__remote`)}`, {})).rows;
    const cols = desc.map((r) => ({ name: r.column_name, type: r.column_type, kind: kindOf(r.column_type) }));

    const parts = ['count(*) AS "__entries"'];
    cols.forEach((c, i) => {
      const where = `FILTER (WHERE path_in_schema = ${quoteStr(c.name)})`;
      const cast = (s) => (c.kind === 'quantitative' ? `TRY_CAST(${s} AS DOUBLE)` : c.kind === 'nominal' ? s : `TRY_CAST(${s} AS ${c.type})`);
      parts.push(
        `(sum(total_compressed_size) ${where})::DOUBLE AS "b${i}"`,
        `(sum(stats_null_count) ${where})::DOUBLE AS "nu${i}"`,
        // some writers store cumulative null counts; a group claiming more nulls than rows means don't trust them
        `(max(stats_null_count - row_group_num_rows) ${where} > 0) AS "bad${i}"`,
        `min(${cast('stats_min_value')}) ${where} AS "mn${i}"`,
        `max(${cast('stats_max_value')}) ${where} AS "mx${i}"`,
      );
    });
    const where = rgIds ? ` WHERE row_group_id IN (${rgIds.join(', ')})` : '';
    const meta = (await this._runOn(this._lanes[0], `SELECT ${parts.join(', ')} FROM parquet_metadata(${quoteStr(vfs)})${where}`, {})).rows[0] || {};
    const statRows = rowCount; // = rows in the row groups the stats came from (samples are whole row groups)
    const columns = cols.map((c, i) => {
      const min = meta[`mn${i}`] ?? null;
      const max = meta[`mx${i}`] ?? null;
      return {
        name: c.name,
        type: c.type,
        kind: c.kind,
        nullPct: statRows && meta[`nu${i}`] != null && !meta[`bad${i}`] ? Math.round((meta[`nu${i}`] / statRows) * 10000) / 100 : null,
        distinct: min != null && min === max ? 1 : null,
        min,
        max,
        bytesPerRow: statRows && meta[`b${i}`] != null ? meta[`b${i}`] / statRows : null,
      };
    });
    rem.bytesPerRow = Object.fromEntries(columns.map((c) => [c.name, c.bytesPerRow || 0])); // for working-set estimates
    const profile = { table: tableName, rowCount, columns, sample: [], remote: true };
    if (sample) Object.assign(profile, { totalRows, sampleInfo: sample });
    return profile;
  }

  async close() {
    for (const lane of this._lanes) {
      try { await lane.conn?.close(); } catch {}
      try { await lane.db?.terminate(); } catch {}
    }
  }
}
