// UI test stub for src/data/duck.js — fixed profile + rows, no WASM.
const rows = Array.from({ length: 120 }, (_, i) => {
  const d = new Date(Date.UTC(2014, 0, 2) + i * 86400000);
  return { Date: d.toISOString().slice(0, 10), Close: Math.round((80 + Math.sin(i / 9) * 12 + i * 0.15) * 100) / 100, Volume: 40e6 + (i % 17) * 3e6, Sector: ['Tech', 'Retail', 'Energy', 'Health'][i % 4], Up: i % 3 !== 0 };
});
export const STUB_ROWS = rows;
// the Data tab pages through the table with Duck.pageRows(): 240 rows, a null every 8th long-name value
const gridRow = (i) => ({
  Date: new Date(Date.UTC(2014, 0, 2) + i * 86400000).toISOString().slice(0, 10),
  Close: Math.round((80 + Math.sin(i / 9) * 12 + i * 0.15 - (i % 5 === 0 ? 120 : 0)) * 100) / 100,
  Volume: 40e6 + (i % 17) * 3e6,
  Sector: ['Tech', 'Retail', 'Energy', 'Health'][i % 4],
  Up: i % 3 !== 0,
  a_rather_long_column_name_for_overflow: i % 8 === 0 ? null : `value ${i}`,
});
const GRID = Array.from({ length: 240 }, (_, i) => gridRow(i));
const wait0 = (ms) => new Promise((r) => setTimeout(r, ms));
async function gridPage(table, { columns, sort, offset = 0, limit = 200 } = {}) {
  window.__gridQueries = (window.__gridQueries || []).concat(JSON.stringify({ columns, sort, offset, limit }));
  if (window.__stubGridMs) await wait0(window.__stubGridMs);
  if (window.__stubSlowCol && columns?.includes(window.__stubSlowCol)) await wait0(window.__stubSlowMs || 800); // a column group that takes a while
  if (window.__stubGridFail && offset > 0) throw new Error('boom: the file moved');
  let data = GRID.slice();
  if (sort) {
    const sign = sort.dir === 'desc' ? -1 : 1;
    const c = sort.column;
    data.sort((x, y) => (x[c] == null) - (y[c] == null) || (x[c] == null ? 0 : sign * (x[c] < y[c] ? -1 : x[c] > y[c] ? 1 : 0)));
  }
  data = data.slice(offset, offset + limit);
  const names = columns || Object.keys(GRID[0]);
  return { columns: names.map((name) => ({ name, type: 'VARCHAR' })), rows: data.map((r) => Object.fromEntries(names.map((n) => [n, r[n]]))) };
}
export const STUB_PROFILE = {
  table: 'apple_stock', rowCount: 240, sample: rows.slice(0, 5),
  columns: [
    { name: 'Date', type: 'DATE', kind: 'temporal', nullPct: 0, distinct: 240, min: '2014-01-02T00:00:00.000Z', max: '2014-12-31T00:00:00.000Z' },
    { name: 'Close', type: 'DOUBLE', kind: 'quantitative', nullPct: 0, distinct: 236, min: 71.4, max: 119.0, mean: 95.2 },
    { name: 'Volume', type: 'BIGINT', kind: 'quantitative', nullPct: 1.25, distinct: 230, min: 14479600, max: 266380800 },
    { name: 'Sector', type: 'VARCHAR', kind: 'nominal', nullPct: 0, distinct: 4, min: 'Energy', max: 'Tech', topValues: [{ value: 'Tech', count: 60 }, { value: 'Retail', count: 60 }, { value: 'Energy', count: 60 }] },
    { name: 'Up', type: 'BOOLEAN', kind: 'boolean', nullPct: 0, distinct: 2, min: false, max: true },
    { name: 'a_rather_long_column_name_for_overflow', type: 'VARCHAR', kind: 'nominal', nullPct: 62.5, distinct: 3400 },
  ],
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export class Duck {
  static async create() { await wait(80); return new Duck(); }
  async loadFile({ tableName }) { await wait(40); return { tableName: tableName || 'apple_stock', rowCount: 240 }; }
  pageRows(table, o) { return gridPage(table, o); }
  workingSet() { return window.__stubFast ? { columns: window.__stubFast, rowCount: 5_000_000 } : null; }
  async query(sql) {
    // drill-through: the rows behind one day, and the aggregate that should match the chart (window.__stubDrillOff breaks the match)
    const s = String(sql);
    const day = /CAST\('([^']+)' AS TIMESTAMP\)/.exec(s)?.[1]?.slice(0, 10);
    if (day && /^SELECT COUNT\(\*\) AS n, /.test(s)) {
      const r = rows.find((x) => x.Date === day);
      return { columns: [{ name: 'n' }, { name: 'v' }], rows: [{ n: r ? 1 : 0, v: r ? r.Close + (window.__stubDrillOff ? 1 : 0) : null }] };
    }
    if (day && /^SELECT .+ FROM "apple_stock" WHERE/.test(s)) {
      const names = /^SELECT (.+?) FROM/.exec(s)[1].split(', ').map((x) => x.replace(/^"|"$/g, ''));
      return { columns: names.map((name) => ({ name, type: 'VARCHAR' })), rows: rows.filter((x) => x.Date === day).map((r) => Object.fromEntries(names.map((n) => [n, r[n]]))) };
    }
    // a metric: SELECT <expr> AS value FROM "apple_stock" (an expr containing NOPE fails like a bad column would)
    if (/ AS value FROM "apple_stock"$/.test(s)) {
      if (/NOPE/.test(s)) throw new Error('Binder Error: Referenced column "NOPE" not found in FROM clause!\nCandidate bindings: "Close"');
      return { columns: [{ name: 'value', type: 'DOUBLE' }], rows: [{ value: /COUNT\(\*\)/.test(s) ? 240 : 1234.5 }] };
    }
    return { columns: Object.keys(rows[0]).map((name) => ({ name, type: 'VARCHAR' })), rows }; }
  async profile() { return STUB_PROFILE; }
  remoteColumns() { return null; } // the UI falls back to the profile's columns
}
