// UI test stub for src/agents/pipeline.js — emits trace events with small delays, returns 3 cards.
import { STUB_PROFILE, STUB_ROWS } from '../data/duck.js';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function step(onTrace, agent, startMsg, doneMsg, ms = 70, detail) {
  const t = performance.now();
  onTrace?.({ agent, status: 'start', message: startMsg });
  await wait(ms);
  onTrace?.({ agent, status: 'done', message: doneMsg, ms: performance.now() - t, detail });
}
export function heuristicCharts() { return []; }

async function runStub(card, onTrace, { signal, onStart }) {
  if (signal?.aborted) return { ...card, rows: [], spec: null, error: undefined, cancelled: true };
  onStart?.();
  const t = performance.now();
  onTrace?.({ agent: 'executor', status: 'start', message: `Running ${card.id}` });
  const aborted = await new Promise((res) => {
    const timer = setTimeout(() => res(false), window.__stubChartDelay ?? 60);
    signal?.addEventListener('abort', () => { clearTimeout(timer); res(true); }, { once: true });
  });
  if (aborted) {
    onTrace?.({ agent: 'executor', status: 'error', message: 'Cancelled', ms: performance.now() - t });
    return { ...card, rows: [], spec: null, error: undefined, cancelled: true };
  }
  onTrace?.(card.error ? { agent: 'executor', status: 'error', message: card.error, ms: performance.now() - t } : { agent: 'executor', status: 'done', message: `${card.rows.length} rows`, ms: performance.now() - t });
  return card;
}

function stubCards() {
  const monthly = Object.values(STUB_ROWS.reduce((a, r) => { const m = r.Date.slice(0, 7); (a[m] ||= { month: m + '-01', avg_close: 0, n: 0 }); a[m].avg_close += r.Close; a[m].n++; return a; }, {}))
    .map((x) => ({ month: x.month, avg_close: Math.round((x.avg_close / x.n) * 100) / 100 }));
  return [
    { id: 'c1', title: 'Closing price over time', question: 'How did the close price move through 2014?', layout: { section: 'trends', size: 'l', priority: 1 },
      sql: 'SELECT "Date", "Close" FROM apple_stock ORDER BY "Date"',
      spec: { mark: { type: 'line', point: true, tooltip: true }, encoding: { x: { field: 'Date', type: 'temporal', title: null }, y: { field: 'Close', type: 'quantitative', scale: { zero: false } } } },
      rows: STUB_ROWS.map((r) => ({ Date: r.Date, Close: r.Close })), columns: [{ name: 'Date', type: 'DATE' }, { name: 'Close', type: 'DOUBLE' }],
      explain: { how: 'Averages Close for each day of Date.', coverage: 'Uses all 240 rows.', assumptions: ['Averaged, not added up: Close is a level (a balance, price or rate), so a total would be meaningless.'], source: 'rules' },
      drill: { table: 'apple_stock', base: 'TRY_CAST("Date" AS TIMESTAMP) IS NOT NULL', dims: [{ kind: 'bucket', expr: "date_trunc('day', TRY_CAST(\"Date\" AS TIMESTAMP))", field: 'Date', label: 'Date (day)' }], measure: { fn: 'AVG', column: 'Close', field: 'Close' } } },
    { id: 'c2', title: 'Monthly average close', question: 'Average close by month', layout: { section: 'trends', size: 'm', priority: 2 },
      sql: 'SELECT date_trunc(\'month\', "Date") AS month, avg("Close") AS avg_close\nFROM apple_stock\nGROUP BY 1\nORDER BY 1',
      spec: null, fallback: true, rows: monthly, columns: [{ name: 'month', type: 'DATE' }, { name: 'avg_close', type: 'DOUBLE' }] },
    { id: 'c3', title: 'Revenue by sector', question: 'Which sector earns the most revenue?', layout: { section: 'breakdowns', size: 'm', priority: 1 },
      sql: 'SELECT "Sector", sum("Revenue") AS revenue FROM apple_stock GROUP BY 1 ORDER BY 2 DESC',
      error: 'Binder Error: Referenced column "Revenue" not found in FROM clause!\nCandidate bindings: "Volume"', spec: null, rows: [], columns: [] },
  ];
}
export function createPipeline({ llm, duck }) {
  let workingSet = null;
  window.__stubMetricCalls = (window.__stubMetricCalls || 0);
  window.__stubPipelines = (window.__stubPipelines || 0) + 1;
  let profile = null;
  return {
    async load(input, onTrace) {
      await duck.loadFile({ ...input, tableName: 'apple_stock' });
      await step(onTrace, 'profiler', 'Profiling apple_stock', `6 columns, ${STUB_PROFILE.rowCount} rows`, 60);
      // a file named "big…" stands in for a sampled 6.1B-row remote Parquet file (~130 MB to cache, ~915 MB of memory:
      // green on 32 GB, yellow on 4 GB, red on 2 GB and on phones without memory signals)
      profile = /big/.test(input?.fileName || '')
        ? { ...STUB_PROFILE, rowCount: 5_000_000, totalRows: 6_100_000_000, remote: true,
            sampleInfo: { mode: 'spread', rows: 5_000_000, slices: 5, firstRow: 0, endRow: 6_100_000_000 },
            columns: STUB_PROFILE.columns.map((c) => ({ ...c, bytesPerRow: 3 })) }
        : window.__stubBank // a transactions-like table, for the Review suggestion
          ? { ...STUB_PROFILE, columns: [
              { name: 'txn_id', type: 'VARCHAR', kind: 'nominal', nullPct: 0, distinct: 239 },
              { name: 'account_number', type: 'BIGINT', kind: 'quantitative', nullPct: 0, distinct: 7, min: 4010, max: 4090 },
              { name: 'Date', type: 'DATE', kind: 'temporal', nullPct: 0, distinct: 240, min: '2014-01-02', max: '2014-12-31' },
              { name: 'Close', type: 'DOUBLE', kind: 'quantitative', nullPct: 0, distinct: 236, min: 71.4, max: 119, mean: 95.2 },
              { name: 'amount', type: 'DOUBLE', kind: 'quantitative', nullPct: 0, distinct: 200, min: -50, max: 500 },
              { name: 'status', type: 'VARCHAR', kind: 'nominal', nullPct: 0, distinct: 4, topValues: [{ value: 'completed', count: 100 }] },
            ] }
        : window.__stubWide // a 40-column table, for the Data tab's first-30-columns behaviour
          ? { ...STUB_PROFILE, columns: Array.from({ length: 40 }, (_, i) => ({ name: 'c' + i, type: 'BIGINT', kind: 'quantitative', nullPct: 0, distinct: 100, min: 0, max: 99 })) }
          : STUB_PROFILE;
      return { profile, tableName: 'apple_stock' };
    },
    // Working set: reports progress over window.__stubCacheMs (default 300 ms), honours the signal.
    async buildWorkingSet(columns, onTrace, { signal, onProgress } = {}) {
      window.__stubWorkingSet = columns.slice();
      const ms = window.__stubCacheMs ?? 300;
      for (let i = 1; i <= 5; i++) {
        await wait(ms / 5);
        if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        onProgress?.({ fraction: i / 5 });
      }
      workingSet = columns.slice();
      onTrace?.({ agent: 'workset', status: 'done', message: `${columns.length} columns in memory`, ms });
      return { columns, rowCount: profile.rowCount, parts: 4 };
    },
    async clearWorkingSet() { workingSet = null; },
    setMetrics(list) { window.__stubMetrics = list; window.__stubMetricCalls++; },
    async materialize(onTrace, { signal, onProgress } = {}) {
      const ms = window.__stubCacheMs ?? 300;
      for (let i = 1; i <= 5; i++) {
        await wait(ms / 5);
        if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        onProgress?.({ readMB: i * 17 });
      }
      onTrace?.({ agent: 'cache', status: 'done', message: 'rows cached', ms });
      return { tableName: 'apple_stock', rowCount: profile.rowCount, cached: 'apple_stock__cache' };
    },
    // Streams like the real pipeline: onPlans first, then one chart at a time (onStart / onCard), each cancellable.
    // Per-chart time: window.__stubChartDelay ms (default 60), so tests can watch placeholders and cancel.
    async suggest(onTrace, { onPlans, beforeRun, onStart, onCard, signalFor } = {}) {
      await step(onTrace, llm ? 'planner' : 'heuristics', 'Planning charts', '3 charts planned', 120, { charts: 3 });
      const cards = stubCards();
      const plans = cards.map(({ id, title, question, sql, layout }) => ({ id, title, question, sql, layout }));
      onPlans?.(plans);
      if (beforeRun) { try { await beforeRun(plans); } catch { /* charts still run */ } }
      const out = [];
      for (const card of cards) out.push(await runStub(card, onTrace, { signal: signalFor?.(card.id), onStart: () => onStart?.(card.id) }).then((c) => { onCard?.(c); return c; }));
      return out;
    },
    async run(plan, onTrace, { signal, onStart } = {}) {
      return runStub(stubCards().find((c) => c.id === plan.id) || stubCards()[0], onTrace, { signal, onStart });
    },
    async ask(question, onTrace) {
      await step(onTrace, 'sql', `Writing SQL for “${question}”`, 'SELECT … GROUP BY "Sector"', 120);
      // like Duck: a question over columns outside the working set extends it first
      if (workingSet && !workingSet.includes('Volume')) {
        duck.onWorkingSet?.({ type: 'extend', phase: 'start', columns: ['Volume'] });
        await wait(window.__stubExtendMs ?? 300);
        workingSet.push('Volume');
        duck.onWorkingSet?.({ type: 'extend', phase: 'done', columns: ['Volume'] });
      }
      await step(onTrace, 'executor', 'Running query', '4 rows', 50);
      await step(onTrace, 'viz', 'Choosing a chart', 'bar: Sector × total_volume', 80);
      await step(onTrace, 'validator', 'Validating spec', 'ok', 20);
      const by = {}; for (const r of STUB_ROWS) by[r.Sector] = (by[r.Sector] || 0) + r.Volume;
      const rows = Object.entries(by).map(([Sector, total_volume]) => ({ Sector, total_volume })).sort((a, b) => b.total_volume - a.total_volume);
      return { id: 'q' + Date.now(), title: 'Total volume by sector', question,
        sql: 'SELECT "Sector", sum("Volume") AS total_volume\nFROM apple_stock\nGROUP BY 1\nORDER BY 2 DESC',
        spec: { mark: { type: 'bar', tooltip: true }, encoding: { y: { field: 'Sector', type: 'nominal', sort: '-x', title: null }, x: { field: 'total_volume', type: 'quantitative', title: 'Total volume' }, color: { field: 'Sector', type: 'nominal', legend: null } } },
        explain: { how: 'Adds up the volume for each sector and shows the biggest first.', coverage: 'Uses all 240 rows.', assumptions: ['"Trades the most" is taken to mean the largest total volume.'], source: 'ai' },
        rows, columns: [{ name: 'Sector', type: 'VARCHAR' }, { name: 'total_volume', type: 'BIGINT' }] };
    },
  };
}
