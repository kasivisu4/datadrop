// Agents + orchestrator. Every agent is `async (ctx, input) -> output` and reports via ctx.trace(event).
// ctx = { llm, duck, profile, trace }
// TraceEvent = { agent, status: 'start'|'done'|'error'|'retry', message, detail?, ms? }

import { plannerPrompt, sqlPrompt, repairPrompt, vizPrompt } from './prompts.js';
import { inferLayout, normalizeLayout } from './layout.js';
import { explainCard } from './explain.js';
import { guardSQL } from '../data/sqlguard.js';
export { guardSQL }; // tests and callers import it from here
import { isIdLike, isIdName, isRowKeyName, aggregateFor, measureRank, STATUS_NAME } from '../data/roles.js';

const MAX_REPAIRS = 2;
const MAX_CHARTS = 4;
const HISTORY_SIZE = 4;

// ---------------------------------------------------------------- helpers

const now = () => (globalThis.performance && performance.now ? performance.now() : Date.now());

function emit(ctx, ev) {
  try { ctx && typeof ctx.trace === 'function' && ctx.trace(ev); } catch { /* listener errors never break the pipeline */ }
}

/** Run fn wrapped in start/done/error trace events with timing. */
async function traced(ctx, agent, startMsg, fn, doneMsg) {
  const t0 = now();
  emit(ctx, { agent, status: 'start', message: startMsg });
  try {
    const out = await fn();
    const ms = Math.round(now() - t0);
    const m = typeof doneMsg === 'function' ? doneMsg(out) : (doneMsg || 'done');
    const ev = { agent, status: 'done', message: typeof m === 'string' ? m : m.message, ms };
    if (m && typeof m === 'object' && 'detail' in m) ev.detail = m.detail;
    emit(ctx, ev);
    return out;
  } catch (e) {
    emit(ctx, { agent, status: 'error', message: e?.message || String(e), ms: Math.round(now() - t0), detail: e?.detail });
    throw e;
  }
}

let cardSeq = 0;
function newCardId() {
  cardSeq += 1;
  return `card_${Date.now().toString(36)}_${cardSeq}_${Math.random().toString(36).slice(2, 6)}`;
}

const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';

export function safeAlias(name) {
  let s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = 'col';
  if (/^[0-9]/.test(s)) s = 'c_' + s;
  return s;
}

function clone(o) {
  return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
}

// ---------------------------------------------------------------- SQL guard


// ---------------------------------------------------------------- column classification

const YEARISH = /^(year|yr|fiscal_year|season)$|_year$|^year_/i;

/** Map a DuckDB/Arrow type string (+ optional sample values) to a Vega-Lite-ish kind. */
export function kindOfType(type, values = []) {
  const t = String(type || '').toUpperCase();
  if (/INTERVAL/.test(t)) return 'nominal';
  if (/BOOL/.test(t)) return 'nominal';
  if (/DATE|TIMESTAMP|TIME/.test(t)) return 'temporal';
  if (/INT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|HUGEINT|UBIGINT/.test(t)) return 'quantitative';
  if (/VARCHAR|UTF8|STRING|TEXT|CHAR|ENUM|UUID|BLOB/.test(t)) return 'nominal';
  // unknown type: inspect values
  const vals = values.filter((v) => v !== null && v !== undefined).slice(0, 20);
  if (vals.length && vals.every((v) => typeof v === 'number' || typeof v === 'bigint')) return 'quantitative';
  if (vals.length && vals.every((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ][\d:.]+)?/.test(v))) return 'temporal';
  return 'nominal';
}

/** Classify result columns into kinds. Returns [{name, type, kind, yearish}] */
export function classifyColumns(result) {
  const rows = result?.rows || [];
  return (result?.columns || []).map((c) => {
    const vals = rows.slice(0, 50).map((r) => r?.[c.name]);
    const kind = kindOfType(c.type, vals);
    const yearish = kind === 'quantitative' && YEARISH.test(c.name) &&
      vals.filter((v) => v != null).every((v) => Number(v) >= 1000 && Number(v) <= 2200 && Number.isInteger(Number(v)));
    return { name: c.name, type: c.type, kind, yearish };
  });
}

/** Escape a column name for use as a Vega-Lite field (dots/brackets are path syntax). */
function vlField(name) {
  return String(name).replace(/([.[\]\\])/g, '\\$1');
}
function unescapeField(f) {
  return String(f).replace(/\\(.)/g, '$1');
}

// ---------------------------------------------------------------- heuristic spec (from result)

/** Build a sensible Vega-Lite spec from result columns, or null if only a table makes sense. */
export function heuristicSpec(result) {
  const cols = classifyColumns(result);
  if (!cols.length || !(result?.rows || []).length) return null;
  const T = cols.filter((c) => c.kind === 'temporal' || c.yearish);
  const Q = cols.filter((c) => c.kind === 'quantitative' && !c.yearish);
  const N = cols.filter((c) => c.kind === 'nominal');
  const rows = result.rows;
  const tip = (list) => list.map((c) => ({ field: vlField(c.name), type: c.yearish ? 'ordinal' : c.kind }));

  if (T.length && Q.length) {
    const t = T[0];
    const enc = {
      x: { field: vlField(t.name), type: t.yearish ? 'ordinal' : 'temporal' },
      y: { field: vlField(Q[0].name), type: 'quantitative' },
    };
    const used = [t, Q[0]];
    if (N.length) {
      const distinct = new Set(rows.map((r) => r[N[0].name])).size;
      if (distinct <= 12) { enc.color = { field: vlField(N[0].name), type: 'nominal' }; used.push(N[0]); }
    }
    enc.tooltip = tip(used);
    return { mark: { type: 'line', point: rows.length <= 60 }, encoding: enc };
  }
  if (N.length && Q.length) {
    const n = N[0];
    const q = Q[0];
    const distinct = new Set(rows.map((r) => r[n.name])).size;
    if (distinct > 12) {
      return {
        mark: 'bar',
        encoding: {
          y: { field: vlField(n.name), type: 'nominal', sort: '-x' },
          x: { field: vlField(q.name), type: 'quantitative' },
          tooltip: tip([n, q]),
        },
      };
    }
    return {
      mark: 'bar',
      encoding: {
        x: { field: vlField(n.name), type: 'nominal', sort: '-y' },
        y: { field: vlField(q.name), type: 'quantitative' },
        tooltip: tip([n, q]),
      },
    };
  }
  if (Q.length >= 2) {
    const enc = {
      x: { field: vlField(Q[0].name), type: 'quantitative' },
      y: { field: vlField(Q[1].name), type: 'quantitative' },
      tooltip: tip([Q[0], Q[1]]),
    };
    return { mark: { type: 'point', filled: true, opacity: 0.6 }, encoding: enc };
  }
  if (Q.length === 1 && cols.length === 1) {
    if (rows.length <= 1) return null; // single KPI value -> table
    return {
      mark: 'bar',
      encoding: {
        x: { field: vlField(Q[0].name), type: 'quantitative', bin: { maxbins: 30 } },
        y: { aggregate: 'count', type: 'quantitative', title: 'count' },
      },
    };
  }
  if (N.length === 1 && cols.length === 1) {
    return {
      mark: 'bar',
      encoding: {
        y: { field: vlField(N[0].name), type: 'nominal', sort: '-x' },
        x: { aggregate: 'count', type: 'quantitative', title: 'count' },
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------- heuristic charts (no LLM)

function pickGrain(col) {
  const a = Date.parse(col.min);
  const b = Date.parse(col.max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'month';
  const days = Math.abs(b - a) / 86400000;
  if (days > 365 * 6) return 'year';
  if (days > 120) return 'month';
  if (days > 21) return 'week';
  if (days > 3) return 'day';
  return days > 3 / 24 ? 'hour' : 'minute'; // e.g. the first rows of a huge time-ordered log
}

// Scatter plots of more rows than this become density grids.
const DENSITY_ROWS = 5000;

/**
 * SQL pieces for binning one numeric axis into n bins, on ln(1 + x) when the column is heavy-tailed: non-negative,
 * with 90% of values in the bottom 10% of its range (typical of latencies, token counts, sizes).
 * p prefixes the columns so two axes can share a query. Use as:
 *   WITH s AS (SELECT stats FROM t), e AS (SELECT edges FROM s), b AS (SELECT bin AS <p>k, e.* FROM t, e)
 *   SELECT start, end, scale ... FROM b GROUP BY ALL
 */
function axis(expr, p, n) {
  const lg = `${p}lg`;
  const heavy = `(${p}lo >= 0 AND ${p}hi > ${p}lo AND (${p}p90 - ${p}lo) < 0.1 * (${p}hi - ${p}lo))`;
  const fwd = (v) => `CASE WHEN ${lg} THEN ln(${v} + 1) ELSE ${v} END`;
  const back = (v) => `CASE WHEN ${lg} THEN exp(${v}) - 1 ELSE ${v} END`;
  const step = `(${p}z - ${p}a) / ${n}`;
  return {
    stats: `MIN(${expr}) AS ${p}lo, MAX(${expr}) AS ${p}hi, approx_quantile(${expr}, 0.9) AS ${p}p90`,
    edges: `${heavy} AS ${lg}, CASE WHEN ${heavy} THEN ln(${p}lo + 1) ELSE ${p}lo END AS ${p}a, ` +
      `CASE WHEN ${heavy} THEN ln(${p}hi + 1) ELSE ${p}hi END AS ${p}z`,
    bin: `LEAST(FLOOR((${fwd(expr)} - ${p}a) / NULLIF(${step}, 0)), ${n - 1})`,
    start: back(`${p}a + COALESCE(${p}k, 0) * ${step}`),
    end: back(`${p}a + (COALESCE(${p}k, 0) + 1) * ${step}`),
    scale: `CASE WHEN ${lg} THEN 'log' ELSE 'linear' END`,
  };
}

/** plan.adapt for binned charts: put an axis on a symlog scale (= ln(1 + x), matching the bins) when SQL chose log bins. */
function logAxes(result, spec) {
  const r = result.rows[0] || {};
  const out = structuredClone(spec);
  for (const ch of ['x', 'y']) {
    if (r[`${ch}_scale`] === 'log' && out.encoding?.[ch]) {
      out.encoding[ch].scale = { type: 'symlog' };
      out.encoding[ch].axis = { format: '~s', labelOverlap: 'greedy' }; // log ticks crowd at the high end
      out.encoding[ch].title = `${out.encoding[ch].title} (log scale)`;
    }
  }
  return out;
}

/** ChartPlan[] built only from the profile (no LLM), so the app is useful with zero setup. */
export function heuristicCharts(profile) {
  if (!profile || !profile.columns) return [];
  const t = qi(profile.table);
  const rc = profile.rowCount || 0;
  const cols = profile.columns;
  const temporal = cols.filter((c) => c.kind === 'temporal');
  // Remote Parquet profiles have no distinct counts. A column stored in under 1 byte/row is dictionary-encoded
  // with few values, so rank it as low-cardinality (smallest first); anything bigger as high.
  // A number stored in under 0.05 bytes/row takes only a handful of values (a round, a code, a flag): it's a
  // category, not a measure. Ranked after real text columns.
  const lowCardNum = (c) => c.kind === 'quantitative' && c.distinct == null && c.bytesPerRow != null && c.bytesPerRow < 0.05;
  const distinctOf = (c) => c.distinct ?? (c.bytesPerRow == null ? undefined : c.bytesPerRow < 1 ? 2 + c.bytesPerRow + (lowCardNum(c) ? 0.5 : 0) : Infinity);
  // An identifier is never a number to sum or bin (an account number, a txn id). A few-valued one (7 accounts) still
  // makes a useful breakdown, so it counts as a category.
  const fewIds = (c) => isIdLike(c, rc) && !isRowKeyName(c) && c.distinct != null && c.distinct >= 2 && c.distinct <= 50;
  const quant = cols.filter((c) => c.kind === 'quantitative' && !lowCardNum(c) && !isIdName(c) && !isIdLike(c, rc) && (distinctOf(c) ?? 2) > 1)
    .map((c, i) => ({ c, i })).sort((a, b) => measureRank(a.c) - measureRank(b.c) || a.i - b.i).map((x) => x.c);
  const nominal = cols.filter((c) => (c.kind === 'nominal' || c.kind === 'boolean' || lowCardNum(c) || (c.kind === 'quantitative' && fewIds(c))) && (!isIdLike(c, rc) || fewIds(c)));
  const goodNominal = nominal.filter((c) => (distinctOf(c) ?? 2) >= 2 && (distinctOf(c) ?? 0) <= Math.max(50, rc * 0.5))
    .sort((a, b) => (distinctOf(a) ?? 0) - (distinctOf(b) ?? 0));
  // status-like columns (status, type, category…) split data into groups people ask about: prefer them
  // (only when the distinct count is known: without it the bytes-per-row ranking is the better guide)
  const statusLike = goodNominal.filter((c) => STATUS_NAME.test(c.name) && c.distinct != null);
  const agg = (c) => (aggregateFor(c) === 'AVG' ? { fn: 'AVG', prefix: 'avg_', word: 'average' } : { fn: 'SUM', prefix: 'total_', word: 'total' });
  const plans = [];

  // 1. trend over time
  if (temporal.length) {
    const d = temporal[0];
    const grain = pickGrain(d);
    const bucket = `date_trunc('${grain}', TRY_CAST(${qi(d.name)} AS TIMESTAMP))`;
    const m = quant[0];
    const ag = m ? agg(m) : null;
    const measure = m ? `${ag.fn}(${qi(m.name)})` : 'COUNT(*)';
    const alias = m ? ag.prefix + safeAlias(m.name) : 'row_count';
    plans.push({
      title: m ? (ag.fn === 'AVG' ? `Average ${m.name} by ${grain}` : `${m.name} by ${grain}`) : `Rows per ${grain}`,
      question: m ? `How does ${ag.word} ${m.name} change over time (by ${grain})?` : `How many rows per ${grain}?`,
      sql: `SELECT ${bucket} AS period, ${measure} AS ${alias} FROM ${t} WHERE TRY_CAST(${qi(d.name)} AS TIMESTAMP) IS NOT NULL GROUP BY 1 ORDER BY 1 LIMIT 500`,
      spec: {
        mark: { type: 'line', point: true },
        encoding: {
          x: { field: 'period', type: 'temporal', title: grain },
          y: { field: alias, type: 'quantitative', title: m ? `${ag.word} ${m.name}` : 'rows' },
          tooltip: [{ field: 'period', type: 'temporal' }, { field: alias, type: 'quantitative' }],
        },
      },
      // one or two periods is not a trend: say so instead of drawing a dot
      minRows: 3,
      note: (rows) => `No clear time trend: every row falls in ${rows.length || 'no'} ${grain}${rows.length === 1 ? '' : 's'}.`,
      drill: {
        table: profile.table, base: `TRY_CAST(${qi(d.name)} AS TIMESTAMP) IS NOT NULL`,
        dims: [{ kind: 'bucket', expr: bucket, field: 'period', label: `${d.name} (${grain})`, column: d.name }],
        measure: m ? { fn: ag.fn, column: m.name, field: alias } : { fn: 'COUNT', field: 'row_count' },
      },
    });
  }

  // 2. top-10 of a nominal by count
  const n = statusLike[0] || goodNominal[0] || nominal[0];
  if (n) {
    const alias = safeAlias(n.name) === 'row_count' ? 'category' : safeAlias(n.name);
    plans.push({
      title: `Top ${n.name} by count`,
      question: `What are the most common values of ${n.name}?`,
      // top 9 + "Other" when there are more than 10 values, so the bars add up to every row
      sql: `WITH c AS (SELECT CAST(${qi(n.name)} AS VARCHAR) AS v, COUNT(*) AS row_count FROM ${t} WHERE ${qi(n.name)} IS NOT NULL GROUP BY 1), ` +
        'r AS (SELECT v, row_count, row_number() OVER (ORDER BY row_count DESC, v) AS rk, count(*) OVER () AS nv FROM c) ' +
        `SELECT CASE WHEN rk <= 9 OR nv <= 10 THEN v ELSE 'Other' END AS ${alias}, SUM(row_count)::BIGINT AS row_count, MIN(rk) AS rank ` +
        'FROM r GROUP BY 1 ORDER BY rank LIMIT 10',
      spec: {
        mark: 'bar',
        encoding: {
          y: { field: alias, type: 'nominal', sort: { field: 'rank', order: 'ascending' }, title: n.name },
          x: { field: 'row_count', type: 'quantitative', title: 'rows' },
          tooltip: [{ field: alias, type: 'nominal', title: n.name }, { field: 'row_count', type: 'quantitative' }],
        },
      },
      drill: {
        table: profile.table, base: `${qi(n.name)} IS NOT NULL`,
        dims: [{ kind: 'value', expr: `CAST(${qi(n.name)} AS VARCHAR)`, field: alias, label: n.name, column: n.name }],
        measure: { fn: 'COUNT', field: 'row_count' },
        topN: true,
      },
    });
  }

  // 3. the headline measure by a category ("amount by status"): a bar per group. Skipped for two ordinary measures, where the
  // relationship (scatter) says more; always wanted for money, or when there is only one measure.
  const cat = statusLike.find((c) => c !== n) || goodNominal.find((c) => c !== n) || n;
  if (quant.length && cat && (quant.length === 1 || measureRank(quant[0]) === 0)) {
    const q = quant[0];
    const ag = agg(q);
    const na = safeAlias(cat.name);
    const qa = ag.prefix + safeAlias(q.name);
    plans.push({
      title: ag.fn === 'AVG' ? `Average ${q.name} by ${cat.name}` : `${q.name} by ${cat.name}`,
      question: `Which ${cat.name} has the highest ${ag.word} ${q.name}?`,
      sql: `SELECT CAST(${qi(cat.name)} AS VARCHAR) AS ${na}, ${ag.fn}(${qi(q.name)}) AS ${qa} FROM ${t} WHERE ${qi(cat.name)} IS NOT NULL GROUP BY 1 ORDER BY ${qa} DESC LIMIT 15`,
      spec: {
        mark: 'bar',
        encoding: {
          y: { field: na, type: 'nominal', sort: '-x', title: cat.name },
          x: { field: qa, type: 'quantitative', title: `${ag.word} ${q.name}` },
          tooltip: [{ field: na, type: 'nominal' }, { field: qa, type: 'quantitative' }],
        },
      },
      drill: {
        table: profile.table, base: `${qi(cat.name)} IS NOT NULL`,
        dims: [{ kind: 'value', expr: `CAST(${qi(cat.name)} AS VARCHAR)`, field: na, label: cat.name, column: cat.name }],
        measure: { fn: ag.fn, column: q.name, field: qa },
      },
    });
  }

  // 4. histogram of first quantitative (binned in SQL so it reflects the whole table)
  if (quant.length) {
    const q = quant[0];
    const x = axis(`CAST(${qi(q.name)} AS DOUBLE)`, 'x', 20);
    plans.push({
      title: `Distribution of ${q.name}`,
      question: `How is ${q.name} distributed?`,
      sql: `WITH s AS (SELECT ${x.stats} FROM ${t} WHERE ${qi(q.name)} IS NOT NULL), e AS (SELECT ${x.edges} FROM s), ` +
        `b AS (SELECT ${x.bin} AS xk, e.* FROM ${t}, e WHERE ${qi(q.name)} IS NOT NULL) ` +
        `SELECT ${x.start} AS bin_start, ${x.end} AS bin_end, COUNT(*) AS row_count, ${x.scale} AS x_scale ` +
        'FROM b GROUP BY ALL ORDER BY bin_start LIMIT 500',
      adapt: logAxes,
      spec: {
        mark: 'bar',
        encoding: {
          x: { field: 'bin_start', type: 'quantitative', bin: { binned: true }, title: q.name },
          x2: { field: 'bin_end' },
          y: { field: 'row_count', type: 'quantitative', title: 'rows' },
          tooltip: [{ field: 'bin_start', type: 'quantitative' }, { field: 'bin_end', type: 'quantitative' }, { field: 'row_count', type: 'quantitative' }],
        },
      },
      drill: {
        table: profile.table, base: `${qi(q.name)} IS NOT NULL`,
        dims: [{ kind: 'range', expr: `CAST(${qi(q.name)} AS DOUBLE)`, startField: 'bin_start', endField: 'bin_end', label: q.name, column: q.name }],
        measure: { fn: 'COUNT', field: 'row_count' },
      },
    });
  }

  // 5. relationship between two measures
  if (quant.length >= 2) {
    const [a, b] = quant;
    const aa = safeAlias(a.name);
    let bb = safeAlias(b.name);
    if (bb === aa) bb += '_2';
    const both = `${qi(a.name)} IS NOT NULL AND ${qi(b.name)} IS NOT NULL`;
    if (rc > DENSITY_ROWS) {
      // too many points for a readable scatter: a 30×30 density grid over every row
      const x = axis(`CAST(${qi(a.name)} AS DOUBLE)`, 'x', 30);
      const y = axis(`CAST(${qi(b.name)} AS DOUBLE)`, 'y', 30);
      plans.push({
        title: `${a.name} vs ${b.name}`,
        question: `Is there a relationship between ${a.name} and ${b.name}?`,
        sql: `WITH s AS (SELECT ${x.stats}, ${y.stats} FROM ${t} WHERE ${both}), e AS (SELECT ${x.edges}, ${y.edges} FROM s), ` +
          `b AS (SELECT ${x.bin} AS xk, ${y.bin} AS yk, e.* FROM ${t}, e WHERE ${both}) ` +
          `SELECT ${x.start} AS x_start, ${x.end} AS x_end, ${y.start} AS y_start, ${y.end} AS y_end, COUNT(*) AS row_count, ` +
          `${x.scale} AS x_scale, ${y.scale} AS y_scale FROM b GROUP BY ALL LIMIT 1000`,
        adapt: logAxes,
        spec: {
          mark: 'rect',
          encoding: {
            x: { field: 'x_start', type: 'quantitative', bin: { binned: true }, title: a.name },
            x2: { field: 'x_end' },
            y: { field: 'y_start', type: 'quantitative', bin: { binned: true }, title: b.name },
            y2: { field: 'y_end' },
            color: { field: 'row_count', type: 'quantitative', scale: { type: 'log', scheme: 'blues' }, title: 'rows' },
            tooltip: [
              { field: 'x_start', type: 'quantitative', title: a.name },
              { field: 'y_start', type: 'quantitative', title: b.name },
              { field: 'row_count', type: 'quantitative', title: 'rows' },
            ],
          },
        },
        drill: {
          table: profile.table, base: both,
          dims: [
            { kind: 'range', expr: `CAST(${qi(a.name)} AS DOUBLE)`, startField: 'x_start', endField: 'x_end', label: a.name, column: a.name },
            { kind: 'range', expr: `CAST(${qi(b.name)} AS DOUBLE)`, startField: 'y_start', endField: 'y_end', label: b.name, column: b.name },
          ],
          measure: { fn: 'COUNT', field: 'row_count' },
        },
      });
    } else plans.push({
      title: `${a.name} vs ${b.name}`,
      question: `Is there a relationship between ${a.name} and ${b.name}?`,
      sql: `SELECT ${qi(a.name)} AS ${aa}, ${qi(b.name)} AS ${bb} FROM ${t} WHERE ${both} LIMIT 500`,
      spec: {
        mark: { type: 'point', filled: true, opacity: 0.6 },
        encoding: {
          x: { field: aa, type: 'quantitative', title: a.name },
          y: { field: bb, type: 'quantitative', title: b.name },
          tooltip: [{ field: aa, type: 'quantitative', title: a.name }, { field: bb, type: 'quantitative', title: b.name }],
        },
      },
    });
  }

  // nothing chartable: show a preview table
  if (!plans.length) {
    plans.push({
      title: `Preview of ${profile.table}`,
      question: 'Show the first rows',
      sql: `SELECT * FROM ${t} LIMIT 100`,
      spec: null,
    });
  }
  return plans.slice(0, MAX_CHARTS).map((p) => ({ ...p, layout: p.layout || inferLayout(p.spec) }));
}

// ---------------------------------------------------------------- agents

/** 1. Deterministic profile of the loaded table. */
export async function profilerAgent(ctx) {
  const table = ctx.tableName || ctx.profile?.table;
  return traced(ctx, 'profiler', `Profiling table ${table}`, async () => {
    const p = await ctx.duck.profile(table);
    ctx.profile = p;
    return p;
  }, (p) => ({ message: `${p.rowCount} rows × ${p.columns.length} columns`, detail: { columns: p.columns.map((c) => `${c.name}:${c.kind}`) } }));
}

function normalizePlan(p) {
  if (!p || typeof p !== 'object') return null;
  const sql = p.sql || p.query;
  if (typeof sql !== 'string' || !sql.trim()) return null;
  return {
    title: String(p.title || p.question || 'Chart'),
    question: String(p.question || p.title || ''),
    sql: sql.trim(),
    spec: p.spec && typeof p.spec === 'object' ? p.spec : (p.vegaLite || p.vega_lite || null),
    layout: normalizeLayout(p.layout, p.spec && typeof p.spec === 'object' ? p.spec : null),
    rationale: typeof p.rationale === 'string' ? p.rationale : undefined,
    assumptions: Array.isArray(p.assumptions) ? p.assumptions : undefined,
  };
}

/** 2. LLM proposes up to 4 charts. */
export async function chartPlannerAgent(ctx) {
  return traced(ctx, 'planner', 'Planning charts', async () => {
    if (!ctx.llm) throw new Error('No LLM configured');
    const { system, messages } = plannerPrompt(ctx.profile, ctx.metrics);
    const out = await ctx.llm.completeJSON({ system, messages, maxTokens: 3000 });
    const list = Array.isArray(out) ? out : (out?.charts || out?.plans || []);
    const plans = list.map(normalizePlan).filter(Boolean).slice(0, MAX_CHARTS);
    if (!plans.length) throw new Error('Planner returned no usable charts');
    return plans;
  }, (plans) => ({ message: `${plans.length} charts planned`, detail: plans.map((p) => p.title) }));
}

/** 3. NL2SQL. */
export async function sqlAgent(ctx, { question, history = [] }) {
  return traced(ctx, 'sql', `Writing SQL for: ${question}`, async () => {
    if (!ctx.llm) throw new Error('Add an API key in Settings to ask questions.');
    const { system, messages } = sqlPrompt(ctx.profile, question, history, ctx.metrics);
    const out = await ctx.llm.completeJSON({ system, messages, maxTokens: 1200 });
    const sql = typeof out === 'string' ? out : (out?.sql || out?.query);
    if (typeof sql !== 'string' || !sql.trim()) throw new Error('SQL agent returned no SQL');
    return { sql: sql.trim(), rationale: String(out?.rationale || ''), assumptions: Array.isArray(out?.assumptions) ? out.assumptions.map(String) : [] };
  }, (r) => ({ message: r.rationale || 'SQL ready', detail: { sql: r.sql } }));
}

/** Repair: LLM fixes failed SQL given the DuckDB error. */
export async function repairAgent(ctx, { sql, error, question }) {
  return traced(ctx, 'repair', `Repairing SQL: ${String(error).slice(0, 120)}`, async () => {
    if (!ctx.llm) throw new Error('No LLM configured for SQL repair');
    const { system, messages } = repairPrompt(ctx.profile, sql, error, question);
    const out = await ctx.llm.completeJSON({ system, messages, maxTokens: 1200 });
    const fixed = typeof out === 'string' ? out : (out?.sql || out?.query);
    if (typeof fixed !== 'string' || !fixed.trim()) throw new Error('Repair agent returned no SQL');
    return { sql: fixed.trim() };
  }, (r) => ({ message: 'Repaired SQL', detail: { sql: r.sql } }));
}

/**
 * 4. Execute SQL (after the safety guard); on error ask repairAgent up to 2 times.
 * Returns Result = { columns, rows, sql } (sql = the query that finally ran).
 * Throws Error (with .sql = last attempted query) if it still fails.
 */
export async function executorAgent(ctx, { sql, question }) {
  const t0 = now();
  emit(ctx, { agent: 'executor', status: 'start', message: 'Running query', detail: { sql } });
  let current = sql;
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    try {
      const clean = guardSQL(current);
      const res = await ctx.duck.query(clean, { signal: ctx.signal, onStart: ctx.onStart });
      const result = { columns: res.columns || [], rows: res.rows || [], sql: clean };
      emit(ctx, {
        agent: 'executor', status: 'done', ms: Math.round(now() - t0),
        message: `${result.rows.length} rows${attempt ? ` after ${attempt} repair${attempt > 1 ? 's' : ''}` : ''}`,
        detail: { sql: clean, attempts: attempt + 1 },
      });
      return result;
    } catch (e) {
      if (e?.name === 'AbortError') {
        emit(ctx, { agent: 'executor', status: 'error', message: 'Cancelled', ms: Math.round(now() - t0), detail: { sql: current } });
        throw e;
      }
      lastErr = e;
      if (attempt === MAX_REPAIRS || !ctx.llm) break;
      emit(ctx, {
        agent: 'executor', status: 'retry', ms: Math.round(now() - t0),
        message: `Query failed (attempt ${attempt + 1}): ${e?.message || e}`, detail: { sql: current },
      });
      try {
        const r = await repairAgent(ctx, { sql: current, error: e?.message || String(e), question });
        current = r.sql;
      } catch (re) {
        lastErr = new Error(`${e?.message || e} (repair failed: ${re?.message || re})`);
        break;
      }
    }
  }
  const err = new Error(`Query failed: ${lastErr?.message || lastErr}`);
  err.sql = current;
  emit(ctx, { agent: 'executor', status: 'error', message: err.message, ms: Math.round(now() - t0), detail: { sql: current } });
  throw err;
}

/** 5. LLM picks mark + encodings for the result. */
export async function vizAgent(ctx, { question, sql, result }) {
  return traced(ctx, 'viz', 'Choosing a chart', async () => {
    if (!ctx.llm) throw new Error('No LLM configured');
    const { system, messages } = vizPrompt(question, sql, result);
    const out = await ctx.llm.completeJSON({ system, messages, maxTokens: 1500 });
    const spec = out?.spec && typeof out.spec === 'object' ? out.spec : (out?.mark || out?.layer ? out : null);
    return { title: String(out?.title || question || 'Chart'), spec };
  }, (v) => ({ message: v.spec ? `mark: ${markName(v.spec) || 'composite'}` : 'no spec', detail: v.spec }));
}

function markName(spec) {
  if (!spec) return null;
  if (typeof spec.mark === 'string') return spec.mark;
  if (spec.mark && typeof spec.mark === 'object') return spec.mark.type;
  return null;
}

// ---------------------------------------------------------------- validator

const STRIP_KEYS = ['data', 'datasets', '$schema'];

function stripData(spec) {
  if (!spec || typeof spec !== 'object') return;
  for (const k of STRIP_KEYS) delete spec[k];
  for (const k of ['layer', 'concat', 'hconcat', 'vconcat']) {
    if (Array.isArray(spec[k])) spec[k].forEach(stripData);
  }
  if (spec.spec) stripData(spec.spec);
}

/** Field names created by transforms (calculate/aggregate/bin/window/fold/...). */
function transformFields(spec, acc = new Set()) {
  if (!spec || typeof spec !== 'object') return acc;
  for (const tr of spec.transform || []) {
    if (!tr || typeof tr !== 'object') continue;
    const addAs = (as) => { if (Array.isArray(as)) as.forEach((a) => acc.add(a)); else if (typeof as === 'string') acc.add(as); };
    addAs(tr.as);
    for (const k of ['aggregate', 'window', 'joinaggregate']) {
      if (Array.isArray(tr[k])) tr[k].forEach((a) => addAs(a?.as));
    }
    if (tr.fold && !tr.as) { acc.add('key'); acc.add('value'); }
    if (tr.pivot) acc.add('*'); // pivot output fields are data-dependent
  }
  for (const k of ['layer', 'concat', 'hconcat', 'vconcat']) {
    if (Array.isArray(spec[k])) spec[k].forEach((s) => transformFields(s, acc));
  }
  if (spec.spec) transformFields(spec.spec, acc);
  return acc;
}

/** Collect every {field: string} object referenced by encodings (incl. arrays, sort.field), facet, layers. */
function collectFieldRefs(spec, refs = []) {
  if (!spec || typeof spec !== 'object') return refs;
  const visitDef = (def) => {
    if (!def) return;
    if (Array.isArray(def)) { def.forEach(visitDef); return; }
    if (typeof def !== 'object') return;
    if (typeof def.field === 'string') refs.push(def);
    if (def.sort && typeof def.sort === 'object' && !Array.isArray(def.sort) && typeof def.sort.field === 'string') refs.push(def.sort);
    if (def.condition) visitDef(def.condition);
  };
  if (spec.encoding && typeof spec.encoding === 'object') {
    for (const ch of Object.values(spec.encoding)) visitDef(ch);
  }
  if (spec.facet) {
    if (typeof spec.facet.field === 'string') visitDef(spec.facet);
    else { visitDef(spec.facet.row); visitDef(spec.facet.column); }
  }
  for (const k of ['layer', 'concat', 'hconcat', 'vconcat']) {
    if (Array.isArray(spec[k])) spec[k].forEach((s) => collectFieldRefs(s, refs));
  }
  if (spec.spec) collectFieldRefs(spec.spec, refs);
  return refs;
}

function hasMarks(spec) {
  if (!spec || typeof spec !== 'object') return false;
  if (spec.mark) return true;
  for (const k of ['layer', 'concat', 'hconcat', 'vconcat']) {
    if (Array.isArray(spec[k]) && spec[k].length && spec[k].every(hasMarks)) return true;
  }
  if (spec.spec) return hasMarks(spec.spec);
  return false;
}

/** Fill missing encoding types and fix quantitative-on-text. */
function fixTypes(spec, kinds) {
  const fix = (def) => {
    if (!def || typeof def !== 'object') return;
    if (Array.isArray(def)) { def.forEach(fix); return; }
    if (typeof def.field === 'string') {
      const col = kinds.get(unescapeField(def.field));
      if (col) {
        const k = col.yearish ? 'ordinal' : col.kind;
        if (!def.type) def.type = def.bin || def.aggregate ? 'quantitative' : (def.timeUnit ? 'temporal' : k);
        if (def.type === 'quantitative' && col.kind === 'nominal' && !def.aggregate) def.type = 'nominal';
        if (def.type === 'temporal' && col.kind === 'nominal' && !def.timeUnit) {
          // text column claimed temporal: OK only if it parses as dates; leave as ordinal otherwise
          if (!col.dateLike) def.type = 'ordinal';
        }
      }
    }
  };
  const visit = (s) => {
    if (!s || typeof s !== 'object') return;
    if (s.encoding) Object.values(s.encoding).forEach(fix);
    for (const k of ['layer', 'concat', 'hconcat', 'vconcat']) if (Array.isArray(s[k])) s[k].forEach(visit);
    if (s.spec) visit(s.spec);
  };
  visit(spec);
}

function finalizeSize(spec) {
  const unit = !!(spec.mark || spec.layer);
  if (unit) {
    if (spec.width === undefined) spec.width = 'container';
    if (spec.height === undefined) spec.height = 260;
  }
  if (spec.autosize === undefined) spec.autosize = { type: 'fit', contains: 'padding' };
  return spec;
}

/**
 * 6. Deterministic validation. Returns VizSpec { title, spec, fallback? }.
 * spec never contains data; UI injects data: {values: rows}. fallback:true + spec:null -> render a table.
 */
export async function validatorAgent(ctx, { spec, result, title }) {
  return traced(ctx, 'validator', 'Validating chart spec', async () => validateSpec(spec, result, title),
    (v) => ({ message: v.fallback ? 'fallback to table' : (v.repaired ? `fixed: ${v.repaired}` : 'spec ok') }))
    .then((v) => { delete v.repaired; return v; });
}

/** Pure version of validatorAgent (no tracing). */
export function validateSpec(inputSpec, result, title) {
  const cols = result?.columns || [];
  const rows = result?.rows || [];
  const out = { title: title || 'Chart', spec: null };
  if (!cols.length) return { ...out, fallback: true };

  const classified = classifyColumns(result);
  const kinds = new Map(classified.map((c) => {
    const vals = rows.slice(0, 20).map((r) => r?.[c.name]).filter((v) => v != null);
    return [c.name, { ...c, dateLike: vals.length > 0 && vals.every((v) => typeof v === 'string' && !Number.isNaN(Date.parse(v))) }];
  }));
  const names = cols.map((c) => c.name);
  const lower = new Map();
  for (const n of names) if (!lower.has(n.toLowerCase())) lower.set(n.toLowerCase(), n);

  let spec = inputSpec && typeof inputSpec === 'object' && !Array.isArray(inputSpec) ? clone(inputSpec) : null;
  let reason = spec ? null : 'no spec';
  const fixes = [];

  if (spec) {
    stripData(spec);
    if (!hasMarks(spec)) reason = 'missing mark';
  }
  if (spec && !reason) {
    const derived = transformFields(spec);
    for (const ref of collectFieldRefs(spec)) {
      const raw = ref.field;
      const plain = unescapeField(raw);
      if (derived.has(raw) || derived.has(plain) || derived.has('*')) continue;
      if (names.includes(raw)) {
        // exact column name; escape if it contains path characters
        if (/[.[\]]/.test(raw) && vlField(raw) !== raw) { ref.field = vlField(raw); fixes.push(`escaped ${raw}`); }
        continue;
      }
      if (names.includes(plain)) continue; // already escaped
      const ci = lower.get(plain.toLowerCase());
      if (ci) { ref.field = vlField(ci); fixes.push(`${raw}→${ci}`); continue; }
      reason = `unknown field "${raw}"`;
      break;
    }
  }
  if (spec && !reason) {
    fixTypes(spec, kinds);
    return { ...out, spec: finalizeSize(spec), repaired: fixes.join(', ') || undefined };
  }

  const h = heuristicSpec(result);
  if (h) return { ...out, spec: finalizeSize(h), repaired: `heuristic (${reason})` };
  return { ...out, spec: null, fallback: true };
}

// ---------------------------------------------------------------- orchestrator

function localTableName(name) {
  const base = String(name || 'data').split(/[\\/]/).pop().replace(/\.[^.]*$/, '').replace(/\.[^.]*$/, '');
  return safeAlias(base) || 'data';
}

/**
 * createPipeline({ llm, duck, fetchFile? }) -> { load, suggest, ask, getProfile, getHistory, reset }
 * llm may be null: suggest() uses heuristicCharts, ask() throws a friendly error.
 */
export function createPipeline({ llm = null, duck, fetchFile } = {}) {
  const state = { profile: null, tableName: null, history: [] };

  const makeCtx = (onTrace) => ({
    llm,
    duck,
    metrics: state.metrics,
    profile: state.profile,
    tableName: state.tableName,
    trace: (ev) => { if (typeof onTrace === 'function') { try { onTrace(ev); } catch { /* ignore */ } } },
  });

  async function load(input, onTrace) {
    if (!duck) throw new Error('DuckDB is not ready');
    const ctx = makeCtx(onTrace);
    const loaded = await traced(ctx, 'loader', typeof input === 'string' ? `Fetching ${input}` : `Loading ${input?.fileName || 'file'}`, async () => {
      let file;
      let tableName;
      if (typeof input === 'string') {
        let gh = null;
        try { gh = await import('../data/github.js'); } catch { gh = null; }
        const fetcher = fetchFile || gh?.fetchGitHubFile;
        if (!fetcher) throw new Error('GitHub loader unavailable');
        file = await fetcher(input);
        const p = file?.source?.path || file?.fileName;
        tableName = gh?.tableNameFor ? gh.tableNameFor(p) : localTableName(p);
      } else if (input && input.remoteUrl) {
        // remote Parquet: query in place over HTTP range requests, nothing downloaded up front
        tableName = input.tableName || localTableName(input.fileName);
        const r = await duck.attachUrl({ url: input.remoteUrl, tableName, fileName: input.fileName, sample: input.sample });
        return { tableName: r?.tableName || tableName, rowCount: r?.rowCount, totalRows: r?.totalRows, fileName: input.fileName, remote: true };
      } else if (input && (input.bytes || input.parts)) {
        file = input;
        tableName = input.tableName || localTableName(input.fileName);
      } else {
        throw new Error('Nothing to load: pass a GitHub URL, {bytes, format, fileName} or {remoteUrl, fileName}');
      }
      if (!file.format) throw new Error(`Unsupported file format for ${file.fileName || 'file'} (use CSV, TSV, JSON, NDJSON or Parquet)`);
      const r = await duck.loadFile({ bytes: file.bytes, parts: file.parts, format: file.format, tableName, fileName: file.fileName });
      return { tableName: r?.tableName || tableName, rowCount: r?.rowCount, fileName: file.fileName };
    }, (r) => (r.totalRows > r.rowCount
      ? `File has ${r.totalRows.toLocaleString('en-US')} rows; "${r.tableName}" is a ${r.rowCount.toLocaleString('en-US')}-row sample`
      : `Loaded ${r.rowCount ?? '?'} rows into "${r.tableName}"`));

    state.tableName = loaded.tableName;
    state.history = [];
    ctx.tableName = loaded.tableName;
    const profile = await profilerAgent(ctx);
    state.profile = profile;
    return { profile, tableName: loaded.tableName };
  }

  /** Large remote Parquet: switch to another sample ({ mode: 'spread'|'window', rows, offset }), then re-profile. */
  async function resample(sample, onTrace) {
    if (!state.tableName) throw new Error('Load a file first');
    const ctx = makeCtx(onTrace);
    await traced(ctx, 'sampler', 'Picking row groups', () => duck.resample(state.tableName, sample),
      (r) => `${r.rowCount.toLocaleString('en-US')} rows in ${r.sample.slices} slice${r.sample.slices > 1 ? 's' : ''}`);
    state.history = [];
    const profile = await profilerAgent(ctx);
    state.profile = profile;
    return { profile, tableName: state.tableName };
  }

  async function runPlan(ctx, plan) {
    const card = { id: plan.id || newCardId(), title: plan.title, question: plan.question, sql: plan.sql, spec: null, rows: [], columns: [], layout: plan.layout };
    if (plan.drill) card.drill = plan.drill; // lets the UI turn a click on a mark into the rows behind it (data/drill.js)
    if (plan.rationale) card.rationale = plan.rationale;
    if (plan.assumptions) card.assumptions = plan.assumptions;
    try {
      const result = await executorAgent(ctx, { sql: plan.sql, question: plan.question });
      card.sql = result.sql;
      card.rows = result.rows;
      card.columns = result.columns;
      card.explain = explainCard(card, state.profile);
      // heuristic plans may decline to draw (plan.minRows + plan.note) or fit the spec to the result (plan.adapt)
      if (plan.minRows && result.rows.length < plan.minRows) {
        card.note = plan.note ? plan.note(result.rows) : 'Not enough data for this chart.';
        return card;
      }
      const spec = plan.adapt && plan.spec ? plan.adapt(result, plan.spec) : plan.spec;
      const v = await validatorAgent(ctx, { spec, result, title: plan.title });
      card.spec = v.spec;
      if (v.fallback) card.fallback = true;
    } catch (e) {
      if (e?.name === 'AbortError') card.cancelled = true;
      else card.error = e?.message || String(e);
      if (e?.sql) card.sql = e.sql;
    }
    return card;
  }

  /**
   * Plan charts, then run them. Streaming hooks (all optional):
   *   onPlans(plans)   plans with ids, titles, SQL and layout, before any query runs
   *   onStart(id)      a chart's query left the queue and is running
   *   onCard(card)     a chart finished (or failed, or was cancelled)
   *   signalFor(id)    AbortSignal to cancel one chart
   * Resolves to every card, in plan order.
   */
  async function suggest(onTrace, { onPlans, beforeRun, onStart, onCard, signalFor } = {}) {
    if (!state.profile) throw new Error('Load a file first');
    const ctx = makeCtx(onTrace);
    let plans;
    if (llm) {
      try {
        plans = await chartPlannerAgent(ctx);
      } catch (e) {
        emit(ctx, { agent: 'planner', status: 'retry', message: `Using built-in heuristic charts instead (${e?.message || e})` });
        plans = heuristicCharts(state.profile);
      }
    } else {
      plans = await traced(ctx, 'planner', 'No API key: using built-in heuristic charts', async () => heuristicCharts(state.profile),
        (p) => `${p.length} heuristic charts`);
    }
    plans = plans.map((p) => ({ ...p, id: newCardId(), layout: p.layout || inferLayout(p.spec) }));
    onPlans?.(plans);
    // e.g. build a working set of the columns these charts use, so their queries run locally
    if (beforeRun) { try { await beforeRun(plans); } catch { /* charts still run, reading the file */ } }
    const settled = await Promise.allSettled(plans.map(async (p) => {
      const cardCtx = { ...ctx, signal: signalFor?.(p.id), onStart: () => onStart?.(p.id) };
      const card = await runPlan(cardCtx, p);
      onCard?.(card);
      return card;
    }));
    return settled.map((s, i) => (s.status === 'fulfilled' ? s.value : {
      id: plans[i].id, title: plans[i].title, question: plans[i].question, sql: plans[i].sql, layout: plans[i].layout,
      spec: null, rows: [], columns: [], error: s.reason?.message || String(s.reason),
    }));
  }

  /**
   * ask(question) -> Card. Throws only for setup problems (no API key, no file, LLM failure while
   * writing SQL). A query that still fails after repairs returns a Card with .error.
   */
  async function ask(question, onTrace) {
    if (!llm) throw new Error('Add an API key in Settings to ask questions.');
    if (!state.profile) throw new Error('Load a file first');
    const q = String(question || '').trim();
    if (!q) throw new Error('Type a question first');
    const ctx = makeCtx(onTrace);
    const { sql, rationale, assumptions } = await sqlAgent(ctx, { question: q, history: state.history });
    const card = { id: newCardId(), title: q, question: q, sql, rationale, assumptions, spec: null, rows: [], columns: [] };
    let result;
    try {
      result = await executorAgent(ctx, { sql, question: q });
    } catch (e) {
      card.error = e?.message || String(e);
      if (e?.sql) card.sql = e.sql;
      return card;
    }
    card.sql = result.sql;
    card.rows = result.rows;
    card.columns = result.columns;
    card.explain = explainCard(card, state.profile);
    state.history.push({ question: q, sql: result.sql, rationale, assumptions });
    if (state.history.length > HISTORY_SIZE) state.history = state.history.slice(-HISTORY_SIZE);

    let viz = { title: q, spec: null };
    try {
      viz = await vizAgent(ctx, { question: q, sql: result.sql, result });
    } catch { /* validator falls back to heuristic spec */ }
    const v = await validatorAgent(ctx, { spec: viz.spec, result, title: viz.title || q });
    card.title = v.title;
    card.spec = v.spec;
    if (v.fallback) card.fallback = true;
    return card;
  }

  /** Working set: cache these columns of the current remote sample (see Duck.buildWorkingSet). */
  async function buildWorkingSet(columns, onTrace, { signal, onProgress, memoryBudgetMB } = {}) {
    if (!state.tableName) throw new Error('Load a file first');
    const ctx = makeCtx(onTrace);
    return traced(ctx, 'workset', `Building working set (${columns.length} columns)`,
      () => duck.buildWorkingSet(state.tableName, columns, { signal, onProgress, memoryBudgetMB }),
      (r) => ({ message: `${r.columns.length} columns × ${r.rowCount.toLocaleString('en-US')} rows in memory (${r.parts} workers)`, detail: r }));
  }
  /** Drop the working set: queries read the file again. */
  async function clearWorkingSet() { if (state.tableName) await duck.clearWorkingSet(state.tableName); }

  /** Fast mode: cache the current remote sample in memory (see Duck.materialize). */
  async function materialize(onTrace, { signal, onProgress } = {}) {
    if (!state.tableName) throw new Error('Load a file first');
    const ctx = makeCtx(onTrace);
    return traced(ctx, 'cache', 'Caching the sample in memory', () => duck.materialize(state.tableName, { signal, onProgress }),
      (r) => `${r.rowCount.toLocaleString('en-US')} rows cached: charts and questions now run locally`);
  }

  /** Run one plan on its own (e.g. "Run again" after a cancel). */
  async function run(plan, onTrace, { signal, onStart } = {}) {
    return runPlan({ ...makeCtx(onTrace), signal, onStart }, plan);
  }

  return {
    load,
    resample,
    buildWorkingSet,
    clearWorkingSet,
    materialize,
    suggest,
    run,
    ask,
    getProfile: () => state.profile,
    getHistory: () => state.history.slice(),
    resetHistory: () => { state.history = []; },
    /** The user's defined metrics (data/metrics.js): the AI's prompts quote them, so a named metric means one expression. */
    setMetrics: (list) => { state.metrics = Array.isArray(list) ? list.slice() : []; },
  };
}
