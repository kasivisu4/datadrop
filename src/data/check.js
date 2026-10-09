// "Check this number": re-derive a chart's numbers another way and say plainly whether they hold. Pure (no DOM, no DuckDB):
// planChecks() says which queries to run, the caller runs them, summarize() turns the answers into a verdict.
//
// What is checked, for a built-in chart (one with a `drill` descriptor, see drill.js):
//   - every mark (or an even spread of them on big charts): the rows behind it add up to the number shown
//   - the whole chart: the bars together equal a direct total over the table, and rows left out are counted
// For any chart: it covers a sample, the result was cut off at a LIMIT, or it is empty.
import { drillWhere, drillSql, reconcile } from './drill.js';

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
const full = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '');

/** Evenly spaced picks, always including the first and last: [0..n) -> at most `max` indexes. */
export function pickEvenly(n, max) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out = new Set([0, n - 1]);
  for (let i = 1; out.size < max; i++) out.add(Math.round((i * (n - 1)) / (max - 1)));
  return [...out].sort((a, b) => a - b);
}

/** Number of marks to check: all of them on a small chart, fewer when every check reads a remote file. */
export const maxMarksFor = (profile) => (profile?.remote ? 8 : 40);

/**
 * Queries for a card. -> { marks: [{ index, label, rowsSql?, aggSql }], totals: { all, base } | null, skipped }
 * `skipped` = marks not checked (big charts): reported, never hidden.
 */
export function planChecks(card, profile) {
  const drill = card?.drill;
  if (!drill || !card.rows?.length) return { marks: [], totals: null, skipped: 0 };
  const rows = card.rows;
  const picks = pickEvenly(rows.length, maxMarksFor(profile));
  const marks = [];
  for (const i of picks) {
    const w = drillWhere(drill, rows[i], rows);
    if (!w) continue;
    marks.push({ index: i, label: w.label, aggSql: drillSql(drill, w.where, { limit: 1 }).aggSql });
  }
  const m = drill.measure || { fn: 'COUNT' };
  // an average can't be added across groups: only counts and sums get a whole-chart total
  const additive = m.fn === 'COUNT' || m.fn === 'SUM';
  const agg = m.fn === 'COUNT' ? 'COUNT(*)' : `SUM(${q(m.column)})`;
  const totals = additive ? {
    all: `SELECT COUNT(*) AS n, ${agg} AS v FROM ${q(drill.table)}`,
    base: `SELECT COUNT(*) AS n, ${agg} AS v FROM ${q(drill.table)}${drill.base ? ` WHERE ${drill.base}` : ''}`,
  } : null;
  return { marks, totals, skipped: rows.length - marks.length };
}

/** Checks that need no query. -> [{ level: 'ok'|'warn'|'info', text }] */
export function basicChecks(card, profile) {
  const out = [];
  if (profile?.totalRows && profile.totalRows > (profile.rowCount || 0)) {
    out.push({ level: 'warn', text: `This chart reads a sample (${full(profile.rowCount)} of ${full(profile.totalRows)} rows). Counts and totals describe the sample, not the whole file.` });
  }
  const limit = /\bLIMIT\s+(\d+)\s*;?\s*$/i.exec(String(card?.sql || '').trim())?.[1];
  if (limit && card.rows?.length >= Number(limit)) {
    out.push({ level: 'info', text: `The query stops at ${limit} rows, so anything past that is not shown.` });
  }
  if (card && !card.error && !card.rows?.length) out.push({ level: 'warn', text: 'The query returned no rows.' });
  return out;
}

/**
 * Turn the answers into a verdict.
 *  results = { marks: [{ label, index, agg: { n, v } }], totals: { all: {n, v}, base: {n, v} } | null, skipped }
 * -> { verdict: 'ok' | 'warn' | 'partial', items: [{ level, text }], checked: number }
 */
export function summarize(card, profile, results) {
  const drill = card.drill;
  const items = [];
  const m = drill?.measure || { fn: 'COUNT', field: 'row_count' };
  const what = m.fn === 'COUNT' ? 'rows' : `${m.fn === 'AVG' ? 'average' : 'total'} ${m.column}`;
  const marks = results?.marks || [];
  const direct = m.fn === 'COUNT' ? 'a direct row count' : `a direct ${what}`;

  if (marks.length) {
    const bad = [];
    for (const k of marks) {
      const rec = reconcile(drill, card.rows[k.index], k.agg);
      if (rec.ok === false) bad.push({ label: k.label, rec });
    }
    if (!bad.length) {
      items.push({ level: 'ok', text: `${marks.length === card.rows.length ? `All ${marks.length}` : `${marks.length} of ${card.rows.length}`} marks checked: the rows behind each one add up to the number shown.` });
    } else {
      for (const b of bad.slice(0, 5)) items.push({ level: 'warn', text: `${b.label}: the chart shows ${full(b.rec.expected)} but its rows give ${full(b.rec.actual)} (${what}).` });
      if (bad.length > 5) items.push({ level: 'warn', text: `…and ${bad.length - 5} more marks that do not add up.` });
    }
    if (results.skipped > 0) items.push({ level: 'info', text: `${results.skipped} other marks were not re-checked (each check reads the data again). Click any mark to check it yourself.` });
  }

  const t = results?.totals;
  if (t?.base && t?.all) {
    const shown = card.rows.reduce((s, r) => s + (Number(r[m.field]) || 0), 0);
    const base = Number(t.base.v);
    const diff = Math.abs(shown - base);
    const tol = m.fn === 'COUNT' ? 0 : Math.max(0.005, Math.abs(base) * 1e-9);
    const left = Number(t.all.n) - Number(t.base.n);
    if (Number.isFinite(base)) {
      if (diff <= tol) items.push({ level: 'ok', text: `Together the marks add up to ${full(shown)}, the same as ${direct} over the table.` });
      else items.push({ level: 'warn', text: `The marks add up to ${full(shown)} but ${direct} over the table is ${full(base)}: ${full(base - shown)} (${pct(Math.abs(base - shown), Math.abs(base))}) is not in any mark${card.rows.length >= 15 ? ', most likely because only the biggest groups are shown' : ''}.` });
    }
    if (left > 0) items.push({ level: 'warn', text: `${full(left)} of ${full(t.all.n)} rows (${pct(left, t.all.n)}) are left out because the column this chart groups by is empty for them.` });
  }

  if (!drill) items.push({ level: 'info', text: "This answer's SQL was written by the AI, so its marks can't be traced to rows automatically. Open View SQL under \u22EF to read what it does." });
  items.push(...basicChecks(card, profile));
  // 'partial': nothing wrong found, but only the basics could be checked
  const verdict = items.some((i) => i.level === 'warn') ? 'warn' : drill ? 'ok' : 'partial';
  return { verdict, items, checked: marks.length };
}
