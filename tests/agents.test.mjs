// node --test tests/agents.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLLM, extractJSON } from '../src/agents/llm.js';
import { schemaContext, plannerPrompt, sqlPrompt } from '../src/agents/prompts.js';
import {
  createPipeline, heuristicCharts, guardSQL, validateSpec, validatorAgent, executorAgent,
  chartPlannerAgent, heuristicSpec,
} from '../src/agents/pipeline.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'node_modules/@duckdb/duckdb-wasm/dist/');

// ------------------------------------------------------------ real DuckDB test adapter (node blocking)

const CSV = [
  'order_date,Region,product,amount,qty',
  '2014-01-05,East,Widget,120.5,3',
  '2014-02-11,West,Gadget,80,1',
  '2014-03-20,East,Gizmo,200,5',
  '2015-01-02,North,Widget,50.25,2',
  '2015-06-30,West,Widget,300,7',
  '2015-07-15,East,Gadget,95,2',
  '2016-02-01,South,Gizmo,410,9',
  '2016-05-09,North,Gadget,60,1',
].join('\n');

function toPlain(v, type) {
  if (v === null || v === undefined) return null;
  const t = String(type).toUpperCase();
  if (t.startsWith('DATE') || t.startsWith('TIMESTAMP')) {
    const d = v instanceof Date ? v : new Date(Number(v));
    return t.startsWith('DATE') && !t.startsWith('DATETIME') ? d.toISOString().slice(0, 10) : d.toISOString();
  }
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (t.startsWith('DECIMAL')) return Number(String(v)) / 1; // tests use DOUBLE, guard anyway
  return v;
}

async function makeDuck() {
  const d = require(path.join(dist, 'duckdb-node-blocking.cjs'));
  const db = await d.createDuckDB({
    mvp: { mainModule: dist + 'duckdb-mvp.wasm', mainWorker: dist + 'duckdb-node-mvp.worker.cjs' },
    eh: { mainModule: dist + 'duckdb-eh.wasm', mainWorker: dist + 'duckdb-node-eh.worker.cjs' },
  }, new d.ConsoleLogger(d.LogLevel.ERROR), d.NODE_RUNTIME);
  await db.instantiate();
  const conn = db.connect();
  const queries = [];
  const duck = {
    queries,
    exec(sql) { conn.query(sql); }, // test setup only
    async loadFile({ bytes, tableName, fileName }) {
      db.registerFileBuffer(fileName, bytes);
      conn.query(`CREATE OR REPLACE TABLE "${tableName}" AS SELECT * FROM read_csv_auto('${fileName}')`);
      const n = conn.query(`SELECT COUNT(*)::INTEGER AS n FROM "${tableName}"`).toArray()[0].toJSON().n;
      return { tableName, rowCount: n };
    },
    async query(sql, { signal, onStart } = {}) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      onStart?.();
      queries.push(sql);
      const desc = conn.query(`DESCRIBE ${sql}`).toArray().map((r) => r.toJSON());
      const columns = desc.map((r) => ({ name: r.column_name, type: r.column_type }));
      const rows = conn.query(sql).toArray().slice(0, 5000).map((r) => {
        const o = r.toJSON();
        const out = {};
        for (const c of columns) out[c.name] = toPlain(o[c.name], c.type);
        return out;
      });
      return { columns, rows };
    },
    async profile(table) {
      const { columns: cols } = await duck.query(`SELECT * FROM "${table}"`);
      const rowCount = (await duck.query(`SELECT COUNT(*)::INTEGER AS n FROM "${table}"`)).rows[0].n;
      const columns = [];
      for (const c of cols) {
        const t = c.type.toUpperCase();
        const kind = /DATE|TIME/.test(t) ? 'temporal' : /INT|DOUBLE|FLOAT|DECIMAL/.test(t) ? 'quantitative' : t === 'BOOLEAN' ? 'boolean' : 'nominal';
        const s = (await duck.query(`SELECT COUNT(DISTINCT "${c.name}")::INTEGER AS d, MIN("${c.name}")::VARCHAR AS mn, MAX("${c.name}")::VARCHAR AS mx, (100.0*COUNT(*) FILTER (WHERE "${c.name}" IS NULL)/COUNT(*))::DOUBLE AS np FROM "${table}"`)).rows[0];
        const col = { name: c.name, type: c.type, kind, nullPct: s.np, distinct: s.d, min: s.mn, max: s.mx };
        if (kind === 'nominal') {
          col.topValues = (await duck.query(`SELECT "${c.name}" AS value, COUNT(*)::INTEGER AS count FROM "${table}" GROUP BY 1 ORDER BY 2 DESC LIMIT 5`)).rows;
        }
        columns.push(col);
      }
      const sample = (await duck.query(`SELECT * FROM "${table}" LIMIT 5`)).rows;
      return { table, rowCount, columns, sample };
    },
  };
  return duck;
}

let duck;
let profile;
const fileInput = () => ({ bytes: new TextEncoder().encode(CSV), format: 'csv', fileName: 'sales_2024.csv' });

before(async () => {
  duck = await makeDuck();
  const p = createPipeline({ llm: null, duck });
  ({ profile } = await p.load(fileInput()));
});

// a mock LLM driven by a routing function on the system prompt
function mockLLM(route) {
  const calls = [];
  const llm = createLLM({
    provider: 'mock',
    mockHandler: async ({ system, messages }) => {
      calls.push({ system, messages });
      const kind = system.includes('fix broken') ? 'repair' : system.includes('dashboards') ? 'planner'
        : system.includes('translate natural-language') ? 'sql' : system.includes('best Vega-Lite') ? 'viz' : 'other';
      return route(kind, { system, messages, calls });
    },
  });
  return { llm, calls };
}

// ------------------------------------------------------------ llm.js

test('extractJSON handles plain, fenced, embedded and trailing commas', () => {
  assert.deepEqual(extractJSON('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJSON('Here you go:\n```json\n{"a":2}\n```\nthanks'), { a: 2 });
  assert.deepEqual(extractJSON('sure! {"a":{"b":[1,2]}} done'), { a: { b: [1, 2] } });
  assert.deepEqual(extractJSON('[1,2,3]'), [1, 2, 3]);
  assert.deepEqual(extractJSON('{"a":[1,2,],}'), { a: [1, 2] });
  assert.throws(() => extractJSON('no json here'), /Could not parse JSON/);
});

test('anthropic request shape and error mapping', async () => {
  let seen;
  const ok = createLLM({
    provider: 'anthropic', apiKey: 'sk-test',
    fetchImpl: async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }), { status: 200 }); },
  });
  assert.equal(await ok.complete({ system: 'S', messages: [{ role: 'user', content: 'u' }] }), 'hi');
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.init.headers['x-api-key'], 'sk-test');
  assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, 'claude-sonnet-4-5');
  assert.equal(body.system, 'S');
  assert.equal(body.max_tokens, 2000);

  const mk = (status) => createLLM({ provider: 'anthropic', apiKey: 'k', fetchImpl: async () => new Response('{"error":{"message":"nope"}}', { status }) });
  await assert.rejects(mk(401).complete({ messages: [] }), /API key rejected/);
  await assert.rejects(mk(429).complete({ messages: [] }), /[Rr]ate limit/);
  const net = createLLM({ provider: 'anthropic', apiKey: 'k', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(net.complete({ messages: [] }), /CORS/);
});

test('openai-compatible puts system first', async () => {
  let body;
  const llm = createLLM({
    provider: 'openai', apiKey: 'k', baseUrl: 'http://x/v1/',
    fetchImpl: async (url, init) => { assert.equal(url, 'http://x/v1/chat/completions'); body = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })); },
  });
  assert.deepEqual(await llm.completeJSON({ system: 'SYS', messages: [{ role: 'user', content: 'q' }] }), { ok: true });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.model, 'gpt-4o-mini');
});

// ------------------------------------------------------------ prompts

test('schema context and prompt rules', () => {
  const ctx = schemaContext(profile);
  assert.match(ctx, /Table "sales_2024" — 8 rows/);
  assert.match(ctx, /"Region" \| VARCHAR \| nominal/);
  assert.match(ctx, /Sample rows/);
  const p = plannerPrompt(profile);
  for (const re of [/DuckDB/, /"sales_2024"/, /double quotes/, /SELECT/, /snake_case/, /500/, /date_trunc/, /CAST/, /Vega-Lite v5/, /"charts"/]) {
    assert.match(p.system, re);
  }
  const s = sqlPrompt(profile, 'q3', [{ question: 'q1', sql: 'S1' }, { question: 'q2', sql: 'S2' }]);
  assert.equal(s.messages.at(-1).content, 'Question: q3');
  assert.ok(s.messages.some((m) => m.content.includes('S2')));
});

// ------------------------------------------------------------ guard

test('SQL guard rejects DROP, multiple statements, non-SELECT', () => {
  assert.equal(guardSQL('SELECT 1;'), 'SELECT 1');
  assert.equal(guardSQL('  -- c\nWITH a AS (SELECT 1) SELECT * FROM a'), 'WITH a AS (SELECT 1) SELECT * FROM a');
  assert.equal(guardSQL(`SELECT 'drop; table' AS "update"`), `SELECT 'drop; table' AS "update"`);
  assert.throws(() => guardSQL('DROP TABLE x'), /Unsafe SQL/);
  assert.throws(() => guardSQL('SELECT 1; DROP TABLE x'), /multiple statements/);
  assert.throws(() => guardSQL('SELECT 1; SELECT 2'), /multiple statements/);
  assert.throws(() => guardSQL('INSERT INTO x VALUES (1)'), /only SELECT/);
  assert.throws(() => guardSQL("WITH a AS (SELECT 1) COPY a TO 'x'"), /COPY/);
  assert.throws(() => guardSQL(''), /empty/);
});

test('executor refuses unsafe SQL without LLM and never runs it', async () => {
  const before = duck.queries.length;
  await assert.rejects(executorAgent({ duck, llm: null, profile, trace() {} }, { sql: 'DROP TABLE "sales_2024"' }), /Unsafe SQL/);
  assert.equal(duck.queries.length, before);
});

// ------------------------------------------------------------ heuristic charts

test('heuristicCharts on sample profile', async () => {
  const plans = heuristicCharts(profile);
  assert.ok(plans.length >= 3 && plans.length <= 4);
  assert.equal(plans[0].spec.mark.type, 'line');
  assert.match(plans[0].sql, /date_trunc\('(month|year)'/);
  assert.ok(plans.some((p) => /COUNT\(\*\) AS row_count/.test(p.sql) && p.spec.mark === 'bar'));
  assert.ok(plans.some((p) => /bin_start/.test(p.sql)));
  // all heuristic SQL runs on real DuckDB and validates without fallback
  for (const p of plans) {
    const r = await duck.query(guardSQL(p.sql));
    assert.ok(r.rows.length > 0, p.title);
    const v = validateSpec(p.spec, r, p.title);
    assert.ok(v.spec && !v.fallback, p.title);
  }
  // histogram covers all rows
  const h = plans.find((p) => /bin_start/.test(p.sql));
  const r = await duck.query(h.sql);
  assert.equal(r.rows.reduce((a, b) => a + b.row_count, 0), 8);
});

test('heuristicCharts on a remote Parquet profile (no distinct counts) ranks text columns by bytes/row', () => {
  // Shape produced by Duck._profileRemote: distinct only when footer min === max, plus bytesPerRow.
  const col = (name, kind, bytesPerRow, extra = {}) => ({ name, type: kind === 'quantitative' ? 'DOUBLE' : 'VARCHAR', kind, nullPct: 0, distinct: null, min: null, max: null, bytesPerRow, ...extra });
  const plans = heuristicCharts({
    table: 'rides', rowCount: 1e6, sample: [], remote: true,
    columns: [
      col('pickup_datetime', 'nominal', 3.1),            // high-cardinality text: must not get the bar chart
      col('rate_code', 'nominal', 0.001, { distinct: 1, min: '1', max: '1' }), // constant
      col('payment_type', 'nominal', 0.39),
      col('store_and_fwd_flag', 'nominal', 0.14),         // smallest non-constant -> chosen
      col('fare_amount', 'quantitative', 2.4, { min: 2.5, max: 200 }),
    ],
  });
  const bar = plans.find((p) => /^Top /.test(p.title));
  assert.equal(bar.title, 'Top store_and_fwd_flag by count');
  assert.ok(plans.some((p) => p.title === 'Distribution of fare_amount'));
});

test('heuristicCharts with no chartable columns gives preview', () => {
  const plans = heuristicCharts({ table: 't', rowCount: 3, columns: [{ name: 'id', type: 'INTEGER', kind: 'quantitative', distinct: 3 }], sample: [] });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].spec, null);
});

// ------------------------------------------------------------ validator

test('validator fixes casing, strips data, sets size', async () => {
  const result = { columns: [{ name: 'Region', type: 'VARCHAR' }, { name: 'total_amount', type: 'DOUBLE' }], rows: [{ Region: 'East', total_amount: 3 }] };
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    data: { values: [] },
    mark: 'bar',
    encoding: {
      x: { field: 'region', type: 'nominal', sort: { field: 'TOTAL_AMOUNT', op: 'sum', order: 'descending' } },
      y: { field: 'total_amount' },
      tooltip: [{ field: 'REGION' }, { field: 'total_amount', type: 'quantitative' }],
    },
  };
  const events = [];
  const v = await validatorAgent({ trace: (e) => events.push(e) }, { spec, result, title: 'T' });
  assert.equal(v.spec.data, undefined);
  assert.equal(v.spec.$schema, undefined);
  assert.equal(v.spec.encoding.x.field, 'Region');
  assert.equal(v.spec.encoding.x.sort.field, 'total_amount');
  assert.equal(v.spec.encoding.tooltip[0].field, 'Region');
  assert.equal(v.spec.encoding.y.type, 'quantitative');
  assert.equal(v.spec.width, 'container');
  assert.equal(v.spec.height, 260);
  assert.deepEqual(v.spec.autosize, { type: 'fit', contains: 'padding' });
  assert.deepEqual(events.map((e) => e.status), ['start', 'done']);
  assert.equal(typeof events[1].ms, 'number');
});

test('validator handles layers + facet fields and escapes dotted names', () => {
  const result = { columns: [{ name: 'a.b', type: 'DOUBLE' }, { name: 'cat', type: 'VARCHAR' }, { name: 'm', type: 'DATE' }], rows: [{ 'a.b': 1, cat: 'x', m: '2014-01-01' }] };
  const v = validateSpec({ facet: { field: 'CAT', type: 'nominal' }, spec: { layer: [{ mark: 'line', encoding: { x: { field: 'm', type: 'temporal' }, y: { field: 'a.b', type: 'quantitative' } } }] } }, result);
  assert.equal(v.spec.facet.field, 'cat');
  assert.equal(v.spec.spec.layer[0].encoding.y.field, 'a\\.b');
  assert.equal(v.spec.width, undefined); // composite: no container width at top level
});

test('validator falls back to heuristic spec and to table', () => {
  const tq = { columns: [{ name: 'month', type: 'DATE' }, { name: 'total', type: 'DOUBLE' }], rows: [{ month: '2014-01-01', total: 1 }, { month: '2014-02-01', total: 2 }] };
  const v1 = validateSpec({ mark: 'bar', encoding: { x: { field: 'nope', type: 'nominal' } } }, tq);
  assert.equal(v1.spec.mark.type, 'line');
  assert.equal(v1.spec.encoding.x.field, 'month');
  assert.equal(v1.spec.encoding.x.type, 'temporal');

  const nq = { columns: [{ name: 'region', type: 'VARCHAR' }, { name: 'n', type: 'BIGINT' }], rows: [{ region: 'a', n: 1 }] };
  const v2 = validateSpec({ encoding: { x: { field: 'region' } } }, nq); // mark missing
  assert.equal(v2.spec.mark, 'bar');
  assert.equal(v2.spec.encoding.x.sort, '-y');

  const qq = { columns: [{ name: 'x', type: 'DOUBLE' }, { name: 'y', type: 'INTEGER' }], rows: [{ x: 1, y: 2 }] };
  assert.equal(validateSpec(null, qq).spec.mark.type, 'point');

  const q = { columns: [{ name: 'x', type: 'DOUBLE' }], rows: [{ x: 1 }, { x: 2 }, { x: 5 }] };
  const hs = validateSpec(null, q).spec;
  assert.equal(hs.mark, 'bar');
  assert.ok(hs.encoding.x.bin);

  const text = { columns: [{ name: 's', type: 'VARCHAR' }, { name: 't', type: 'VARCHAR' }], rows: [{ s: 'a', t: 'b' }] };
  const v5 = validateSpec({ mark: 'bar', encoding: { x: { field: 'zzz' } } }, text);
  assert.equal(v5.fallback, true);
  assert.equal(v5.spec, null);

  const yearish = heuristicSpec({ columns: [{ name: 'year', type: 'BIGINT' }, { name: 'total', type: 'DOUBLE' }], rows: [{ year: 2014, total: 1 }, { year: 2015, total: 2 }] });
  assert.equal(yearish.mark.type, 'line');
  assert.equal(yearish.encoding.x.type, 'ordinal');
});

// ------------------------------------------------------------ planner + repair loop

test('planner parses fenced JSON and limits to 4', async () => {
  const charts = Array.from({ length: 6 }, (_, i) => ({ title: `c${i}`, question: 'q', sql: 'SELECT 1 AS x', spec: { mark: 'bar' } }));
  const { llm } = mockLLM(() => 'Here are the charts:\n```json\n' + JSON.stringify({ charts }) + '\n```');
  const plans = await chartPlannerAgent({ llm, profile, trace() {} });
  assert.equal(plans.length, 4);
  assert.equal(plans[0].title, 'c0');
});

test('repair loop: first SQL fails, repaired works', async () => {
  let repairs = 0;
  const { llm, calls } = mockLLM((kind, { messages }) => {
    if (kind === 'repair') {
      repairs++;
      assert.match(messages[0].content, /DuckDB error/);
      return '{"sql":"SELECT \\"Region\\", SUM(\\"amount\\") AS total_amount FROM \\"sales_2024\\" GROUP BY 1 ORDER BY 2 DESC"}';
    }
    throw new Error('unexpected ' + kind);
  });
  const events = [];
  const res = await executorAgent({ llm, duck, profile, trace: (e) => events.push(e) }, { sql: 'SELECT "Regionz", SUM(amount) FROM "sales_2024" GROUP BY 1' });
  assert.equal(repairs, 1);
  assert.equal(calls.length, 1);
  assert.equal(res.rows.length, 4);
  assert.equal(res.rows[0].Region, 'East');
  assert.match(res.sql, /total_amount/);
  const ex = events.filter((e) => e.agent === 'executor').map((e) => e.status);
  assert.deepEqual(ex, ['start', 'retry', 'done']);
  assert.ok(events.some((e) => e.agent === 'repair' && e.status === 'done' && typeof e.ms === 'number'));
});

test('repair loop gives up after 2 repairs', async () => {
  let repairs = 0;
  const { llm } = mockLLM((kind) => { if (kind === 'repair') { repairs++; return { sql: 'SELECT nope FROM "sales_2024"' }; } throw new Error(kind); });
  const events = [];
  await assert.rejects(
    executorAgent({ llm, duck, profile, trace: (e) => events.push(e) }, { sql: 'SELECT bad FROM "sales_2024"' }),
    (e) => /Query failed/.test(e.message) && e.sql === 'SELECT nope FROM "sales_2024"',
  );
  assert.equal(repairs, 2);
  assert.equal(events.filter((e) => e.agent === 'executor' && e.status === 'retry').length, 2);
  assert.equal(events.at(-1).status, 'error');
});

test('unsafe SQL from LLM gets repaired', async () => {
  const { llm } = mockLLM((kind) => (kind === 'repair' ? { sql: 'SELECT COUNT(*) AS n FROM "sales_2024"' } : null));
  const r = await executorAgent({ llm, duck, profile, trace() {} }, { sql: 'SELECT 1; DROP TABLE "sales_2024"' });
  assert.equal(r.rows[0].n, 8);
  assert.ok(!duck.queries.some((q) => /DROP/i.test(q)));
});

// ------------------------------------------------------------ orchestrator

test('llm=null: suggest uses heuristics, ask throws friendly error', async () => {
  const p = createPipeline({ llm: null, duck });
  const events = [];
  await p.load(fileInput(), (e) => events.push(e));
  assert.ok(events.some((e) => e.agent === 'loader' && e.status === 'done'));
  assert.ok(events.some((e) => e.agent === 'profiler' && e.status === 'done'));
  const cards = await p.suggest((e) => events.push(e));
  assert.ok(cards.length >= 3);
  const ids = new Set(cards.map((c) => c.id));
  assert.equal(ids.size, cards.length);
  for (const c of cards) {
    assert.equal(c.error, undefined, c.title + ': ' + c.error);
    assert.ok(c.spec && c.rows.length && c.columns.length);
  }
  await assert.rejects(p.ask('anything'), /Add an API key in Settings to ask questions/);
});

test('suggest with LLM: parallel, bad chart becomes error card, bad spec fixed', async () => {
  const { llm } = mockLLM((kind) => {
    if (kind === 'planner') {
      return JSON.stringify({
        charts: [
          { title: 'By region', question: 'q', sql: 'SELECT "Region" AS region, SUM("amount") AS total_amount FROM "sales_2024" GROUP BY 1 ORDER BY 2 DESC LIMIT 500', spec: { mark: 'bar', encoding: { x: { field: 'Region', type: 'nominal' }, y: { field: 'total_amount', type: 'quantitative' } } } },
          { title: 'Broken', question: 'q', sql: 'SELECT missing_col FROM "sales_2024"', spec: { mark: 'bar' } },
          { title: 'Yearly', question: 'q', sql: 'SELECT date_trunc(\'year\', "order_date") AS yr, COUNT(*) AS n FROM "sales_2024" GROUP BY 1 ORDER BY 1', spec: { mark: 'line', encoding: { x: { field: 'wrong' }, y: { field: 'n' } } } },
        ],
      });
    }
    if (kind === 'repair') return 'not json at all';
    throw new Error(kind);
  });
  const p = createPipeline({ llm, duck });
  await p.load(fileInput());
  const cards = await p.suggest();
  assert.equal(cards.length, 3);
  assert.equal(cards[0].spec.encoding.x.field, 'region');
  assert.ok(cards[1].error);
  assert.equal(cards[2].error, undefined);
  assert.equal(cards[2].spec.encoding.x.field, 'yr'); // heuristic replacement
  assert.equal(cards[2].rows.length, 3);
});

test('suggest falls back to heuristics when planner fails', async () => {
  const { llm } = mockLLM(() => 'I cannot do that');
  const p = createPipeline({ llm, duck });
  await p.load(fileInput());
  const events = [];
  const cards = await p.suggest((e) => events.push(e));
  assert.ok(cards.length >= 3);
  assert.ok(events.some((e) => e.agent === 'planner' && e.status === 'error'));
});

test('ask() with history supports follow-ups', async () => {
  const { llm, calls } = mockLLM((kind, { messages }) => {
    const last = messages.at(-1).content;
    if (kind === 'sql') {
      if (/2014/.test(last)) {
        // follow-up must see the previous question + SQL in history
        assert.ok(messages.some((m) => m.role === 'user' && m.content === 'Question: revenue by region'));
        assert.ok(messages.some((m) => m.role === 'assistant' && m.content.includes('total_amount')));
        return { sql: 'SELECT "Region" AS region, SUM("amount") AS total_amount FROM "sales_2024" WHERE year(CAST("order_date" AS DATE)) = 2014 GROUP BY 1 ORDER BY 2 DESC LIMIT 500', rationale: 'filter 2014' };
      }
      return '```json\n{"sql":"SELECT \\"Region\\" AS region, SUM(\\"amount\\") AS total_amount FROM \\"sales_2024\\" GROUP BY 1 ORDER BY 2 DESC LIMIT 500","rationale":"sum by region"}\n```';
    }
    if (kind === 'viz') return { title: 'Revenue by region', spec: { mark: 'bar', encoding: { x: { field: 'REGION', type: 'nominal', sort: '-y' }, y: { field: 'total_amount', type: 'quantitative' } } } };
    throw new Error(kind);
  });
  const p = createPipeline({ llm, duck });
  await p.load(fileInput());
  const events = [];
  const c1 = await p.ask('revenue by region', (e) => events.push(e));
  assert.equal(c1.title, 'Revenue by region');
  assert.equal(c1.rows.length, 4);
  assert.equal(c1.spec.encoding.x.field, 'region');
  assert.deepEqual([...new Set(events.map((e) => e.agent))], ['sql', 'executor', 'viz', 'validator']);
  const c2 = await p.ask('now only for 2014');
  assert.equal(c2.rows.length, 2);
  assert.notEqual(c1.id, c2.id);
  assert.equal(p.getHistory().length, 2);
  for (let i = 0; i < 4; i++) await p.ask('revenue by region');
  assert.equal(p.getHistory().length, 4);
  assert.ok(calls.length > 0);
});

test('ask() returns error card when SQL keeps failing', async () => {
  const { llm } = mockLLM((kind) => (kind === 'sql' ? { sql: 'SELECT x FROM nowhere' } : { sql: 'SELECT y FROM nowhere' }));
  const p = createPipeline({ llm, duck });
  await p.load(fileInput());
  const c = await p.ask('broken');
  assert.match(c.error, /Query failed/);
  assert.equal(c.sql, 'SELECT y FROM nowhere');
  assert.equal(p.getHistory().length, 0);
});

test('heuristicCharts picks hour / minute grain for short time spans', () => {
  const prof = (min, max) => ({ table: 't', rowCount: 5e6, sample: [], columns: [
    { name: 'started_at', type: 'TIMESTAMP', kind: 'temporal', nullPct: 0, distinct: null, min, max },
    { name: 'it', type: 'FLOAT', kind: 'quantitative', nullPct: 0, distinct: null, min: 1, max: 9, bytesPerRow: 2 },
  ] });
  // first 5M rows of a huge trace span ~22 hours: day buckets would draw a single point
  assert.match(heuristicCharts(prof('1970-01-01T00:00:00Z', '1970-01-01T22:25:35Z'))[0].sql, /date_trunc\('hour'/);
  assert.match(heuristicCharts(prof('2024-01-01T00:00:00Z', '2024-01-01T01:30:00Z'))[0].sql, /date_trunc\('minute'/);
  assert.match(heuristicCharts(prof('2024-01-01T00:00:00Z', '2024-01-10T00:00:00Z'))[0].sql, /date_trunc\('day'/);
});

// ------------------------------------------------------------ heuristic chart quality

const sum = (rows) => rows.reduce((n, r) => n + r.row_count, 0);
const quantCol = (name) => ({ name, type: 'DOUBLE', kind: 'quantitative', nullPct: 0, distinct: 100, min: 0, max: 1 });

test('histogram uses log bins + symlog axis for heavy tails; density grid over 5000 rows', async () => {
  // v: 99% of values in 0..49, 1% at 100000 (heavy tail). w: uniform 0..36.
  duck.exec(`CREATE OR REPLACE TABLE heavy AS SELECT (CASE WHEN i % 100 = 0 THEN 100000 ELSE i % 50 END)::DOUBLE AS v, (i % 37)::DOUBLE AS w FROM range(6000) t(i)`);
  const plans = heuristicCharts({ table: 'heavy', rowCount: 6000, sample: [], columns: [quantCol('v'), quantCol('w')] });

  const hist = plans.find((p) => p.title === 'Distribution of v');
  const hr = await duck.query(guardSQL(hist.sql));
  assert.equal(hr.rows[0].x_scale, 'log');
  assert.equal(sum(hr.rows), 6000, 'every row lands in a bin');
  assert.ok(hr.rows.length > 5, `log bins spread the mass (${hr.rows.length} bins)`);
  const hs = hist.adapt(hr, hist.spec);
  assert.deepEqual(hs.encoding.x.scale, { type: 'symlog' });
  assert.match(hs.encoding.x.title, /log scale/);
  assert.ok(!validateSpec(hs, hr, hist.title).fallback);

  const dens = plans.find((p) => p.title === 'v vs w');
  assert.equal(dens.spec.mark, 'rect', 'density grid instead of a 500-point scatter');
  const dr = await duck.query(guardSQL(dens.sql));
  assert.equal(sum(dr.rows), 6000, 'density counts every row');
  assert.equal(dr.rows[0].x_scale, 'log');
  assert.equal(dr.rows[0].y_scale, 'linear');
  const ds = dens.adapt(dr, dens.spec);
  assert.deepEqual(ds.encoding.x.scale, { type: 'symlog' });
  assert.equal(ds.encoding.y.scale, undefined);
  assert.ok(!validateSpec(ds, dr, dens.title).fallback);
});

test('linear data keeps linear bins; small tables keep the scatter', async () => {
  duck.exec(`CREATE OR REPLACE TABLE flat AS SELECT (i % 37)::DOUBLE AS w, (i % 11)::DOUBLE AS u FROM range(300) t(i)`);
  const plans = heuristicCharts({ table: 'flat', rowCount: 300, sample: [], columns: [quantCol('w'), quantCol('u')] });
  const hr = await duck.query(guardSQL(plans.find((p) => /^Distribution/.test(p.title)).sql));
  assert.equal(hr.rows[0].x_scale, 'linear');
  assert.equal(sum(hr.rows), 300);
  assert.equal(plans.find((p) => / vs /.test(p.title)).spec.mark.type, 'point');
});

test('top-N bar: top 9 + Other adds up to every row; no Other at 10 or fewer values', async () => {
  duck.exec(`CREATE OR REPLACE TABLE cats AS SELECT 'c' || lpad((i % 15)::VARCHAR, 2, '0') AS k, 'd' || (i % 10) AS j FROM range(150) t(i)`);
  const nom = (name, distinct) => ({ name, type: 'VARCHAR', kind: 'nominal', nullPct: 0, distinct });
  const top = (col, d) => heuristicCharts({ table: 'cats', rowCount: 150, sample: [], columns: [nom(col, d)] }).find((p) => /^Top /.test(p.title));
  const r15 = await duck.query(guardSQL(top('k', 15).sql));
  assert.equal(r15.rows.length, 10);
  assert.deepEqual(r15.rows.at(-1), { k: 'Other', row_count: 60, rank: 10 });
  assert.equal(sum(r15.rows), 150);
  const r10 = await duck.query(guardSQL(top('j', 10).sql));
  assert.equal(r10.rows.length, 10);
  assert.ok(!r10.rows.some((r) => r.j === 'Other'));
});

test('time trend with under 3 periods becomes a note, not a one-point chart', async () => {
  const p = createPipeline({ llm: null, duck });
  await p.load({ bytes: new TextEncoder().encode('ts,v\n2024-01-01 01:00:00,1\n2024-01-01 01:00:30,2\n2024-01-01 01:01:10,3\n'), format: 'csv', fileName: 'short.csv' });
  const cards = await p.suggest();
  const trend = cards.find((c) => / by minute$/.test(c.title));
  assert.ok(trend, cards.map((c) => c.title).join(', '));
  assert.match(trend.note, /No clear time trend: every row falls in 2 minutes/);
  assert.equal(trend.spec, null);
  assert.ok(!trend.error);
});

test('suggest streams: onPlans (ids + layout) first, then onStart/onCard per chart; a cancelled chart is marked, not failed', async () => {
  const p = createPipeline({ llm: null, duck });
  await p.load(fileInput());
  const events = [];
  const ctls = new Map();
  const cards = await p.suggest(undefined, {
    onPlans: (plans) => {
      events.push(['plans', plans.length]);
      for (const pl of plans) { assert.ok(pl.id && pl.sql && pl.layout?.section, 'plan has id, sql, layout'); ctls.set(pl.id, new AbortController()); }
      ctls.get(plans[1].id).abort(); // cancel the second chart before it runs
    },
    signalFor: (id) => ctls.get(id).signal,
    onStart: (id) => events.push(['start', id]),
    onCard: (card) => events.push(['card', card.id, card.cancelled ? 'cancelled' : card.error ? 'error' : 'ok']),
  });
  assert.equal(events[0][0], 'plans', 'plans come first');
  const ids = cards.map((c) => c.id);
  assert.deepEqual(events.filter((e) => e[0] === 'card').map((e) => e[1]).sort(), [...ids].sort(), 'every card reported once');
  assert.equal(cards[1].cancelled, true);
  assert.equal(cards[1].error, undefined, 'cancel is not an error');
  assert.ok(!events.some((e) => e[0] === 'start' && e[1] === ids[1]), 'cancelled chart never started');
  assert.ok(cards.filter((c, i) => i !== 1).every((c) => !c.cancelled && c.layout), 'others ran, with layouts');
  const again = await p.run({ ...cards[1], spec: null, sql: cards[1].sql }, undefined, {});
  assert.ok(!again.cancelled && again.rows.length > 0, 'run() re-runs a single chart');
});

test('planner layout hints are parsed and validated', async () => {
  const llm = createLLM({ provider: 'mock', mockHandler: () => JSON.stringify({ charts: [
    { title: 'A', question: 'a', sql: 'SELECT "Region", COUNT(*) AS n FROM "sales_2024" GROUP BY 1', spec: { mark: 'bar', encoding: { y: { field: 'Region', type: 'nominal' }, x: { field: 'n', type: 'quantitative' } } }, layout: { section: 'overview', size: 'l', priority: 1 } },
    { title: 'B', question: 'b', sql: 'SELECT "Region", COUNT(*) AS n FROM "sales_2024" GROUP BY 1', spec: { mark: 'bar', encoding: { y: { field: 'Region', type: 'nominal' }, x: { field: 'n', type: 'quantitative' } } }, layout: { section: 'bogus' } },
  ] }) });
  const plans = await chartPlannerAgent({ llm, duck, profile, trace: () => {} });
  assert.deepEqual(plans[0].layout, { section: 'overview', size: 'l', priority: 1 });
  assert.deepEqual(plans[1].layout, { section: 'breakdowns', size: 'm', priority: 2 }, 'bad hint repaired from the spec');
});

test('remote profile: a near-constant number is a category, not the measure (chutes trace shape)', () => {
  // bytes/row from the real chutes trace footer: rehash_round 0.0002, function_name 0.22, it 1.9, ot 1.5
  const col = (name, kind, bytesPerRow, type) => ({ name, type: type || (kind === 'quantitative' ? 'FLOAT' : 'VARCHAR'), kind, nullPct: 0, distinct: null, min: kind === 'temporal' ? '1970-03-01T00:00:00Z' : null, max: kind === 'temporal' ? '1970-11-11T00:00:00Z' : null, bytesPerRow });
  const plans = heuristicCharts({ table: 'chutes', rowCount: 5e6, sample: [], remote: true, columns: [
    col('invocation_id', 'quantitative', 1.0, 'BIGINT'), col('function_name', 'nominal', 0.22), col('rehash_round', 'quantitative', 0.0002, 'INTEGER'),
    col('started_at', 'temporal', 2.2, 'TIMESTAMP'), col('it', 'quantitative', 1.9), col('ot', 'quantitative', 1.5),
  ] });
  const titles = plans.map((p) => p.title);
  assert.ok(!titles.some((t) => /rehash_round/.test(t)), titles.join(' | '));
  assert.deepEqual(titles, ['it by month', 'Top function_name by count', 'Distribution of it', 'it vs ot']);
});

// ------------------------------------------------------------ banking-style data: ids are not measures

test('heuristicCharts on bank transactions: account numbers are never summed or binned; amount by status, not balance sums', async () => {
  const statuses = ['completed', 'completed', 'pending', 'declined', 'reversed'];
  const lines = ['txn_id,account_number,posted_at,amount,balance,currency,status,type'];
  let bal = 1000;
  for (let i = 0; i < 300; i++) {
    const credit = i % 5 === 0;
    const amt = credit ? 250 + (i % 7) * 10 : -(5 + (i % 11) * 3.5);
    bal += amt;
    lines.push([`TX${1000 + i}`, 401000000000 + (i % 7) * 1234567, new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 19).replace('T', ' '), amt.toFixed(2), bal.toFixed(2), i % 4 ? 'USD' : 'EUR', statuses[i % 5], credit ? 'credit' : 'debit'].join(','));
  }
  const p = createPipeline({ llm: null, duck });
  const { profile: bank } = await p.load({ bytes: new TextEncoder().encode(lines.join('\n')), format: 'csv', fileName: 'bank_tx.csv' });
  const plans = heuristicCharts(bank);
  const titles = plans.map((x) => x.title);
  assert.deepEqual(titles, ['amount by month', 'Top type by count', 'amount by status', 'Distribution of amount'], titles.join(' | '));
  for (const x of plans) {
    assert.ok(!/SUM\("account_number"\)|CAST\("account_number" AS DOUBLE\)|"account_number" AS (period|bin)/.test(x.sql), `${x.title}: account_number used as a number`);
    assert.ok(!/SUM\("balance"\)/.test(x.sql), `${x.title}: a balance must not be summed`);
    const r = await duck.query(guardSQL(x.sql));
    assert.ok(r.rows.length > 0, x.title);
    const v = validateSpec(x.spec, r, x.title);
    assert.ok(v.spec && !v.fallback, x.title);
  }
  const byStatus = plans.find((x) => x.title === 'amount by status');
  assert.match(byStatus.sql, /SUM\("amount"\)/);
  const r = await duck.query(byStatus.sql);
  assert.deepEqual(r.rows.map((x) => x.status).sort(), ['completed', 'declined', 'pending', 'reversed']);
});

test('heuristicCharts: with only a balance, the trend is an average, titled so', () => {
  const plans = heuristicCharts({ table: 'acct', rowCount: 400, sample: [], columns: [
    { name: 'day', type: 'DATE', kind: 'temporal', distinct: 400, min: '2025-01-01', max: '2026-02-04' },
    { name: 'balance', type: 'DOUBLE', kind: 'quantitative', distinct: 400, min: 10.5, max: 9000.5 },
  ] });
  assert.equal(plans[0].title, 'Average balance by month');
  assert.match(plans[0].sql, /AVG\("balance"\)/);
  assert.equal(plans[0].spec.encoding.y.title, 'average balance');
});

test('heuristicCharts: a few-valued account column is a category, a row key is not', () => {
  const base = { table: 't', rowCount: 500, sample: [] };
  const acct = heuristicCharts({ ...base, columns: [{ name: 'account_number', type: 'BIGINT', kind: 'quantitative', distinct: 7, min: 4010, max: 4090 }] });
  assert.equal(acct[0].title, 'Top account_number by count', 'accounts are a breakdown, cast to text');
  assert.match(acct[0].sql, /CAST\("account_number" AS VARCHAR\)/);
  const key = heuristicCharts({ ...base, columns: [{ name: 'id', type: 'BIGINT', kind: 'quantitative', distinct: 7, min: 1, max: 7 }] });
  assert.equal(key[0].spec, null, 'a bare id gives only the preview table');
});

// ------------------------------------------------------------ drill-through: every bar adds up to the rows behind it

test('drill-through: for every heuristic chart, each mark\'s rows reconcile with the number shown (real DuckDB)', async () => {
  const { drillWhere, drillSql, reconcile } = await import('../src/data/drill.js');
  const statuses = ['completed', 'completed', 'pending', 'declined', 'reversed', 'settled', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6'];
  const lines = ['txn_id,account_number,posted_at,amount,balance,status,type'];
  for (let i = 0; i < 400; i++) lines.push([`T${i}`, 4000 + (i % 7), new Date(Date.UTC(2025, 0, 1) + i * 86400000 * 0.9).toISOString().slice(0, 19).replace('T', ' '), (i % 9 === 0 ? 300 + i : -(3 + (i % 13) * 4.25)).toFixed(2), (1000 + i * 1.5).toFixed(2), statuses[i % statuses.length], i % 5 ? 'debit' : 'credit'].join(','));
  const p = createPipeline({ llm: null, duck });
  const { profile: pr } = await p.load({ bytes: new TextEncoder().encode(lines.join('\n')), format: 'csv', fileName: 'drill_bank.csv' });
  const plans = heuristicCharts(pr).filter((x) => x.drill);
  assert.ok(plans.length >= 4, plans.map((x) => x.title).join(' | '));
  let checked = 0;
  for (const plan of plans) {
    const res = await duck.query(guardSQL(plan.sql));
    for (const row of res.rows) {
      const w = drillWhere(plan.drill, row, res.rows);
      assert.ok(w, `${plan.title}: no WHERE for ${JSON.stringify(row)}`);
      const s = drillSql(plan.drill, w.where, { columns: pr.columns.map((c) => c.name).slice(0, 5), limit: 20 });
      const agg = (await duck.query(s.aggSql)).rows[0];
      const rec = reconcile(plan.drill, row, agg);
      assert.equal(rec.ok, true, `${plan.title} [${w.label}]: chart says ${rec.expected}, rows add up to ${rec.actual}`);
      const rows = (await duck.query(s.rowsSql)).rows;
      assert.ok(rows.length > 0 && rows.length <= 20);
      checked++;
    }
  }
  assert.ok(checked >= 20, `checked ${checked} marks`);
});

// ------------------------------------------------------------ plan + assumptions under each answer

test('ask(): the card carries the AI\'s plain sentence and assumptions, plus coverage written by us', async () => {
  const { llm } = mockLLM((kind) => {
    if (kind === 'sql') return { sql: 'SELECT "Region" AS region, SUM("amount") AS total_amount FROM "sales_2024" GROUP BY 1 ORDER BY 2 DESC LIMIT 500', rationale: 'Adds up the amount for each region.', assumptions: ['"Revenue" is taken to be the amount column.'] };
    if (kind === 'viz') return { title: 'Revenue by region', spec: { mark: 'bar', encoding: { x: { field: 'region', type: 'nominal' }, y: { field: 'total_amount', type: 'quantitative' } } } };
    throw new Error(kind);
  });
  const p = createPipeline({ llm, duck });
  await p.load(fileInput());
  const c = await p.ask('revenue by region');
  assert.equal(c.explain.source, 'ai');
  assert.equal(c.explain.how, 'Adds up the amount for each region.');
  assert.deepEqual(c.explain.assumptions, ['"Revenue" is taken to be the amount column.']);
  assert.equal(c.explain.coverage, 'Uses all 8 rows.');
});

test('suggest(): built-in charts explain themselves from the chart, never from a model', async () => {
  const p = createPipeline({ llm: null, duck });
  await p.load(fileInput());
  const cards = await p.suggest(() => {});
  const withExplain = cards.filter((c) => c.explain);
  assert.ok(withExplain.length >= 2);
  for (const c of withExplain) {
    assert.equal(c.explain.source, 'rules', c.title);
    assert.ok(c.explain.how && c.explain.how.endsWith('.'), c.title);
    assert.equal(c.explain.coverage, 'Uses all 8 rows.');
  }
});

// ------------------------------------------------------------ check this number (real DuckDB)

test('check this number: every built-in chart on bank data checks out, and a tampered number is caught', async () => {
  const { planChecks, summarize } = await import('../src/data/check.js');
  const lines = ['txn_id,account_number,posted_at,amount,balance,status,type'];
  for (let i = 0; i < 300; i++) {
    // a few rows with no timestamp and no status, so "rows left out" has something to find
    lines.push([`T${i}`, 4000 + (i % 7), i % 25 === 0 ? '' : new Date(Date.UTC(2025, 0, 1) + i * 86400000 * 0.9).toISOString().slice(0, 19).replace('T', ' '), (i % 9 === 0 ? 300 + i : -(3 + (i % 13) * 4.25)).toFixed(2), (1000 + i * 1.5).toFixed(2), i % 40 === 0 ? '' : ['completed', 'pending', 'declined'][i % 3], i % 5 ? 'debit' : 'credit'].join(','));
  }
  const p = createPipeline({ llm: null, duck });
  const { profile: pr } = await p.load({ bytes: new TextEncoder().encode(lines.join('\n')), format: 'csv', fileName: 'check_bank.csv' });
  const run = async (card) => {
    const plan = planChecks(card, pr);
    const marks = [];
    for (const k of plan.marks) marks.push({ ...k, agg: (await duck.query(k.aggSql)).rows[0] });
    const totals = plan.totals ? { all: (await duck.query(plan.totals.all)).rows[0], base: (await duck.query(plan.totals.base)).rows[0] } : null;
    return summarize(card, pr, { marks, totals, skipped: plan.skipped });
  };
  const cards = [];
  for (const plan of heuristicCharts(pr).filter((x) => x.drill)) {
    const res = await duck.query(guardSQL(plan.sql));
    cards.push({ ...plan, rows: res.rows });
  }
  assert.ok(cards.length >= 4);
  for (const c of cards) {
    const r = await run(c);
    assert.notEqual(r.verdict, 'partial', c.title);
    const bad = r.items.filter((i) => i.level === 'warn' && !/left out because the column/.test(i.text));
    assert.deepEqual(bad, [], `${c.title}: ${bad.map((b) => b.text).join(' | ')}`);
  }
  // the monthly chart drops rows with no timestamp: the check finds and counts them
  const monthly = await run(cards[0]);
  assert.ok(monthly.items.some((i) => /12 of 300 rows \(4%\) are left out because the column this chart groups by is empty/.test(i.text)), monthly.items.map((i) => i.text).join(' | '));
  // tamper with one bar: the check names it
  const byStatus = cards.find((c) => c.title === 'amount by status');
  const tampered = { ...byStatus, rows: byStatus.rows.map((r, i) => (i === 0 ? { ...r, total_amount: r.total_amount + 10 } : r)) };
  const bad = await run(tampered);
  assert.equal(bad.verdict, 'warn');
  assert.ok(bad.items.some((i) => /the chart shows .* but its rows give/.test(i.text)), bad.items.map((i) => i.text).join(' | '));
});

// ------------------------------------------------------------ SQL box starter queries run (real DuckDB)

test('sqlExamples: every starter query for a bank table is valid SQL, passes the guard and returns rows', async () => {
  const { sqlExamples } = await import('../src/data/sqlexamples.js');
  const lines = ['txn_id,account_number,posted_at,amount,balance,status,type'];
  for (let i = 0; i < 120; i++) lines.push([`T${i}`, 4000 + (i % 7), new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 19).replace('T', ' '), (i % 9 === 0 ? 300 + i : -(3 + (i % 13) * 4.25)).toFixed(2), (1000 + i).toFixed(2), ['completed', 'pending'][i % 2], i % 5 ? 'debit' : 'credit'].join(','));
  const p = createPipeline({ llm: null, duck });
  const { profile: pr } = await p.load({ bytes: new TextEncoder().encode(lines.join('\n')), format: 'csv', fileName: 'sql_bank.csv' });
  const ex = sqlExamples(pr);
  assert.ok(ex.length >= 6, ex.map((x) => x.label).join(' | '));
  for (const x of ex) {
    const r = await duck.query(guardSQL(x.sql));
    if (/Repeated/.test(x.label)) assert.equal(r.rows.length, 0, 'the ids are unique, so nothing is repeated');
    else assert.ok(r.rows.length > 0, x.label);
  }
  const empties = await duck.query(ex.find((x) => /Empty values/.test(x.label)).sql);
  assert.equal(empties.rows.length, pr.columns.length);
  assert.ok(empties.rows.every((r) => r.empty_rows === 0));
});

// ------------------------------------------------------------ metric definitions (real DuckDB)

test('metrics: suggested definitions run on a bank table and equal the same number computed by hand', async () => {
  const { metricSuggestions, metricSql } = await import('../src/data/metrics.js');
  const lines = ['txn_id,amount,balance,status'];
  for (let i = 0; i < 90; i++) lines.push([`T${i}`, (i % 4 === 0 ? 100 + i : -(2 + i % 7)).toFixed(2), (500 + i).toFixed(2), ['completed', 'pending', 'declined'][i % 3]].join(','));
  const p = createPipeline({ llm: null, duck });
  const { profile: pr } = await p.load({ bytes: new TextEncoder().encode(lines.join('\n')), format: 'csv', fileName: 'metric_bank.csv' });
  const ideas = metricSuggestions(pr);
  assert.ok(ideas.length >= 3, ideas.map((x) => x.name).join(' | '));
  const value = async (m) => (await duck.query(guardSQL(metricSql(m, pr.table)))).rows[0].value;
  assert.equal(await value(ideas.find((x) => x.name === 'Rows')), 90);
  const total = ideas.find((x) => x.name === 'Total amount');
  const direct = (await duck.query(`SELECT SUM("amount") AS v FROM "${pr.table}"`)).rows[0].v;
  assert.equal(await value(total), direct);
  const filtered = ideas.find((x) => / where status is /.test(x.name));
  assert.ok(filtered, ideas.map((x) => x.name).join(' | '));
  const statusValue = filtered.name.split(' is ')[1];
  const byHand = (await duck.query(`SELECT SUM("amount") AS v FROM "${pr.table}" WHERE "status" = '${statusValue}'`)).rows[0].v;
  assert.equal(await value(filtered), byHand, 'FILTER (WHERE …) equals the hand-written WHERE');
});

test('metrics: the AI is told the user\'s definitions, for the dashboard and for a question', async () => {
  const seen = [];
  const { llm } = mockLLM((kind, { system }) => {
    seen.push({ kind, system });
    if (kind === 'sql') return { sql: 'SELECT SUM("amount") AS total_amount FROM "sales_2024"', rationale: 'Adds up the amount.', assumptions: ['Used your metric "Net revenue".'] };
    if (kind === 'viz') return { title: 'Net revenue', spec: { mark: 'bar', encoding: { x: { field: 'total_amount', type: 'quantitative' } } } };
    if (kind === 'planner') throw new Error('stop');
    throw new Error(kind);
  });
  const p = createPipeline({ llm, duck });
  await p.load(fileInput());
  p.setMetrics([{ name: 'Net revenue', expr: 'SUM("amount")' }]);
  const card = await p.ask('net revenue');
  assert.match(seen.find((s) => s.kind === 'sql').system, /- "Net revenue": SUM\("amount"\)/);
  assert.deepEqual(card.explain.assumptions, ['Used your metric "Net revenue".']);
  await p.suggest(() => {}); // planner prompt also carries it (the planner mock throws, heuristics take over)
  assert.match(seen.find((s) => s.kind === 'planner').system, /- "Net revenue": SUM\("amount"\)/);
  p.setMetrics([]);
  seen.length = 0;
  await p.ask('anything');
  assert.doesNotMatch(seen.find((s) => s.kind === 'sql').system, /Defined metrics/);
});

// ------------------------------------------------------------ taxi-trip-like data (NYC TLC): codes stored as numbers

test('heuristicCharts on a taxi-trip profile: VendorID / payment_type are categories, fare_amount is the measure', () => {
  const col = (name, type, kind, extra = {}) => ({ name, type, kind, nullPct: 0, distinct: null, min: null, max: null, bytesPerRow: 1.5, ...extra });
  const plans = heuristicCharts({
    table: 'trips', rowCount: 3.7e6, sample: [], remote: true,
    columns: [
      col('VendorID', 'BIGINT', 'quantitative', { bytesPerRow: 0.3 }),
      col('tpep_pickup_datetime', 'TIMESTAMP', 'temporal', { min: '2026-01-01', max: '2026-01-31' }),
      col('passenger_count', 'BIGINT', 'quantitative', { bytesPerRow: 0.4 }),
      col('trip_distance', 'DOUBLE', 'quantitative', { min: 0, max: 400, bytesPerRow: 2.1 }),
      col('RatecodeID', 'BIGINT', 'quantitative', { bytesPerRow: 0.2 }),
      col('store_and_fwd_flag', 'VARCHAR', 'nominal', { bytesPerRow: 0.14 }),
      col('PULocationID', 'BIGINT', 'quantitative', { bytesPerRow: 1.2 }),
      col('payment_type', 'BIGINT', 'quantitative', { bytesPerRow: 0.39 }),
      col('fare_amount', 'DOUBLE', 'quantitative', { min: -10, max: 900, bytesPerRow: 2.4 }),
      col('total_amount', 'DOUBLE', 'quantitative', { min: -10, max: 950, bytesPerRow: 2.6 }),
    ],
  });
  const sqls = plans.map((p) => p.sql).join('\n');
  assert.match(plans[0].title, /^fare_amount by (day|week)$/, plans.map((p) => p.title).join(' | '));
  assert.ok(!/SUM\("(VendorID|RatecodeID|PULocationID|payment_type)"\)/.test(sqls), 'an id or a code is never summed');
  assert.ok(!/"(VendorID|RatecodeID|PULocationID)" AS DOUBLE/.test(sqls), 'nor binned');
  assert.ok(!plans.some((p) => /^Distribution of (payment_type|VendorID)/.test(p.title)));
  assert.ok(plans.some((p) => /^Top .* by count/.test(p.title)), plans.map((p) => p.title).join(' | '));
});
