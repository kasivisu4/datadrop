// Pure prompt builders. Each builder returns { system, messages } ready for LLM.complete().
import { metricPrompt } from '../data/metrics.js';
import { LAYOUT_PROMPT } from './layout.js';

const MAX_STR = 60;

function short(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) + '…' : v;
  if (typeof v === 'number') return Number.isInteger(v) ? v : Number(v.toPrecision(6));
  return v;
}

function shortRow(row) {
  const o = {};
  for (const [k, v] of Object.entries(row || {})) o[k] = short(v);
  return o;
}

/** Compact schema context for the LLM: table, rows, columns with stats, 5 sample rows. */
export function schemaContext(profile) {
  if (!profile) return '(no table loaded)';
  const lines = [];
  lines.push(`Table "${profile.table}" — ${profile.rowCount} rows, ${profile.columns.length} columns.`);
  if (profile.totalRows > profile.rowCount) {
    const how = profile.sampleInfo?.mode === 'window' ? 'consecutive rows' : 'whole row groups spread evenly across the file';
    lines.push(`Note: this table is a ${profile.rowCount}-row sample (${how}) of a ${profile.totalRows}-row file that is too large to scan in the browser. Say so when an answer depends on the whole file.`);
  }
  lines.push('Columns (name | DuckDB type | kind | null% | distinct | min..max | top values):');
  for (const c of profile.columns) {
    const parts = [`"${c.name}"`, c.type, c.kind];
    parts.push(`null ${c.nullPct != null ? Math.round(c.nullPct * 10) / 10 : '?'}%`);
    parts.push(`distinct ${c.distinct ?? '?'}`);
    if (c.min !== undefined && c.min !== null) parts.push(`${short(c.min)}..${short(c.max)}`);
    if (c.topValues && c.topValues.length) {
      parts.push('top: ' + c.topValues.slice(0, 5).map((t) => `${JSON.stringify(short(t.value))}(${t.count})`).join(', '));
    }
    lines.push('- ' + parts.join(' | '));
  }
  const sample = (profile.sample || []).slice(0, 5).map(shortRow);
  lines.push('Sample rows (JSON):');
  for (const r of sample) lines.push(JSON.stringify(r));
  return lines.join('\n');
}

export function sqlRules(table) {
  return [
    'SQL rules:',
    `- Use the DuckDB SQL dialect. Only query the table "${table}" (no other tables, no files).`,
    '- Quote every identifier (table and column names) with double quotes, exactly as named in the schema.',
    '- A single SELECT statement only (WITH ... SELECT allowed). Never INSERT/UPDATE/DELETE/CREATE/DROP/ATTACH/COPY/PRAGMA. No trailing semicolon-separated statements.',
    '- Alias every computed/aggregated column with a simple snake_case name (e.g. COUNT(*) AS row_count, SUM("Sales") AS total_sales).',
    '- LIMIT results to at most 500 rows.',
    '- For time bucketing use date_trunc(\'month\', CAST("col" AS DATE)) (or \'year\', \'week\', \'day\'); CAST text dates to DATE/TIMESTAMP before date functions, and alias the bucket (e.g. AS month).',
    '- Order results meaningfully (time ascending for trends, value descending for rankings).',
  ].join('\n');
}

const SPEC_RULES = [
  'Vega-Lite rules:',
  '- Vega-Lite v5 spec WITHOUT "data", "datasets" or "$schema" (data is injected later).',
  '- Every encoding "field" must exactly equal a column alias returned by the SQL.',
  '- Use proper types: "temporal" for dates/time buckets, "quantitative" for numbers, "nominal" for categories, "ordinal" for ordered categories.',
  '- Keep it simple: one mark (bar, line, point, area, arc, rect) with x/y (and optional color/tooltip).',
].join('\n');

function jsonOnly(shape) {
  return `Respond with ONLY a JSON object of the form ${shape} — no prose, no markdown.`;
}

/** Planner: proposes up to 4 diverse charts. */
export function plannerPrompt(profile, metrics = []) {
  const t = profile.table;
  const system = [
    'You are a senior data analyst who designs insightful dashboards over a single DuckDB table.',
    sqlRules(t),
    SPEC_RULES,
    'Propose up to 4 DIVERSE charts covering, when the data allows: a trend over time, a ranking (top-N), a distribution, and a relationship between two measures.',
    'Skip a category if the data has no suitable columns; prefer low-cardinality categories for grouping.',
    LAYOUT_PROMPT,
    metricPrompt(metrics),
    jsonOnly('{"charts":[{"title":string,"question":string,"sql":string,"spec":object,"layout":{"section":string,"size":string,"priority":number}}]}'),
    '',
    'Example (for a table "sales" with columns "order_date" DATE, "region" VARCHAR, "amount" DOUBLE):',
    JSON.stringify({
      charts: [
        {
          title: 'Monthly revenue',
          question: 'How does revenue change by month?',
          sql: 'SELECT date_trunc(\'month\', CAST("order_date" AS DATE)) AS month, SUM("amount") AS total_amount FROM "sales" GROUP BY 1 ORDER BY 1 LIMIT 500',
          spec: { mark: 'line', encoding: { x: { field: 'month', type: 'temporal' }, y: { field: 'total_amount', type: 'quantitative' } } },
          layout: { section: 'trends', size: 'l', priority: 1 },
        },
      ],
    }),
  ].join('\n');
  const user = `Schema:\n${schemaContext(profile)}\n\nDesign up to 4 charts for this table.`;
  return { system, messages: [{ role: 'user', content: user }] };
}

/** NL2SQL: question (+ history of previous Q/SQL pairs) -> {"sql","rationale"} */
export function sqlPrompt(profile, question, history = [], metrics = []) {
  const t = profile.table;
  const system = [
    'You translate natural-language questions into a single DuckDB SQL query over one table.',
    sqlRules(t),
    'If the question is a follow-up (e.g. "now only for 2014"), modify the previous query accordingly.',
    metricPrompt(metrics),
    jsonOnly('{"sql":string,"rationale":string,"assumptions":string[]}'),
    'rationale: ONE plain sentence for a non-technical reader saying what the query computes (no SQL words).',
    'assumptions: 0-3 short plain statements of any interpretation you chose that the user did not spell out: what a term like "revenue" or "active" maps to, how empty values, duplicates or the time range were treated. Use [] when the question was unambiguous. Never invent facts about the data.',
    '',
    'Example: question "top 5 regions by revenue" ->',
    JSON.stringify({
      sql: 'SELECT "region", SUM("amount") AS total_amount FROM "sales" GROUP BY 1 ORDER BY total_amount DESC LIMIT 5',
      rationale: 'Adds up the amount for each region and shows the five biggest.',
      assumptions: ['"Revenue" is taken to be the amount column.'],
    }),
  ].join('\n');
  const messages = [{ role: 'user', content: `Schema:\n${schemaContext(profile)}` }, { role: 'assistant', content: 'Understood. Ask your question.' }];
  for (const h of (history || []).slice(-4)) {
    messages.push({ role: 'user', content: `Question: ${h.question}` });
    messages.push({ role: 'assistant', content: JSON.stringify({ sql: h.sql, rationale: h.rationale || '', assumptions: h.assumptions || [] }) });
  }
  messages.push({ role: 'user', content: `Question: ${question}` });
  return { system, messages };
}

/** Repair: failed sql + DuckDB error -> {"sql"} */
export function repairPrompt(profile, sql, error, question) {
  const t = profile.table;
  const system = [
    'You fix broken DuckDB SQL queries. Keep the original intent; change as little as needed.',
    sqlRules(t),
    jsonOnly('{"sql":string}'),
    '',
    'Example: error \'Referenced column "Region" not found\' for SELECT "Region" ... -> ' +
      JSON.stringify({ sql: 'SELECT "region", COUNT(*) AS row_count FROM "sales" GROUP BY 1 ORDER BY row_count DESC LIMIT 10' }),
  ].join('\n');
  const user = [
    `Schema:\n${schemaContext(profile)}`,
    question ? `\nIntended question: ${question}` : '',
    `\nFailed SQL:\n${sql}`,
    `\nDuckDB error:\n${String(error).slice(0, 1500)}`,
    '\nReturn the corrected query.',
  ].join('\n');
  return { system, messages: [{ role: 'user', content: user }] };
}

/** Viz: question, sql, result columns+types and 5 rows -> {"title","spec"} */
export function vizPrompt(question, sql, result) {
  const system = [
    'You choose the best Vega-Lite v5 chart for a SQL result.',
    SPEC_RULES,
    'Pick: line for time trends, bar for categories vs a measure (sort descending by the measure), point for two measures, arc only for <= 6 parts of a whole.',
    'Add a short descriptive title.',
    jsonOnly('{"title":string,"spec":object}'),
    '',
    'Example: columns [region VARCHAR, total_amount DOUBLE] ->',
    JSON.stringify({
      title: 'Revenue by region',
      spec: {
        mark: 'bar',
        encoding: {
          x: { field: 'region', type: 'nominal', sort: '-y' },
          y: { field: 'total_amount', type: 'quantitative' },
          tooltip: [{ field: 'region', type: 'nominal' }, { field: 'total_amount', type: 'quantitative' }],
        },
      },
    }),
  ].join('\n');
  const cols = (result?.columns || []).map((c) => `${c.name} ${c.type}`).join(', ');
  const rows = (result?.rows || []).slice(0, 5).map(shortRow).map((r) => JSON.stringify(r)).join('\n');
  const user = [
    `Question: ${question}`,
    `SQL:\n${sql}`,
    `Result columns: [${cols}] (${(result?.rows || []).length} rows)`,
    `First rows:\n${rows || '(no rows)'}`,
  ].join('\n');
  return { system, messages: [{ role: 'user', content: user }] };
}
