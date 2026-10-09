// Drill-through: from a clicked bar / point / cell of a chart to the table rows behind that number, and a check that
// those rows add up to the number on screen. Pure (no DOM, no DuckDB): a heuristic chart plan carries a `drill`
// descriptor, the UI turns a click into a WHERE clause here, runs the two queries, and compares.
//
// drill = {
//   table,                                   // SQL table
//   base,                                    // WHERE the chart's own query applied ("col IS NOT NULL")
//   dims: [ { kind: 'value',  expr, field, label }                       // one group: expr = the clicked value
//         | { kind: 'bucket', expr, field, label }                       // a time bucket: expr = date_trunc(...)
//         | { kind: 'range',  expr, startField, endField, label } ],     // a bin: start <= expr < end
//   measure: { fn: 'COUNT' | 'SUM' | 'AVG', column?, field },            // the number the chart shows in `field`
// }

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const num = (v) => (typeof v === 'number' ? v : Number(v));

// a timestamp as a DuckDB-friendly literal: no T, no trailing Z
const tsLit = (v) => lit(String(v).replace('T', ' ').replace(/Z$/, ''));

/** The result row a click came from. `datum` is Vega's copy of it (dates arrive as numbers or Dates), `fields` the dim fields. */
export function rowForDatum(rows, datum, fields) {
  const same = (a, b) => {
    if (a == null || b == null) return a == b;
    if (a === b) return true;
    const na = a instanceof Date ? a.getTime() : a;
    const nb = b instanceof Date ? b.getTime() : b;
    if (typeof na === 'number' && typeof nb === 'string') return na === Date.parse(nb.includes('T') || nb.length > 10 ? nb : `${nb}T00:00:00Z`) || String(na) === nb;
    if (typeof nb === 'number' && typeof na === 'string') return same(nb, na);
    return String(na) === String(nb);
  };
  return rows.find((r) => fields.every((f) => same(datum[f], r[f]))) || null;
}

const dimFields = (d) => (d.kind === 'range' ? [d.startField, d.endField] : [d.field]);
export const drillFields = (drill) => drill.dims.flatMap(dimFields);

/**
 * WHERE for one clicked result row -> { where, label } or null when it can't be expressed.
 * `rows` is the whole result: the "Other" bar of a top-N chart is every row NOT among the other bars, and the last
 * histogram bin includes its upper edge.
 */
export function drillWhere(drill, row, rows = []) {
  if (!drill?.dims?.length || !row) return null;
  const parts = [];
  const labels = [];
  for (const d of drill.dims) {
    if (d.kind === 'value') {
      const v = row[d.field];
      if (v == null) return null;
      if (v === 'Other' && rows.length > 1) {
        const rest = rows.map((r) => r[d.field]).filter((x) => x !== 'Other' && x != null);
        if (!rest.length) return null;
        parts.push(`${d.expr} NOT IN (${rest.map(lit).join(', ')})`);
        labels.push(`${d.label}: everything not shown above`);
      } else {
        parts.push(`${d.expr} = ${lit(v)}`);
        labels.push(`${d.label} = ${v}`);
      }
    } else if (d.kind === 'bucket') {
      const v = row[d.field];
      if (v == null) return null;
      parts.push(`${d.expr} = CAST(${tsLit(v)} AS TIMESTAMP)`);
      labels.push(`${d.label}: ${String(v).slice(0, 10)}`);
    } else if (d.kind === 'range') {
      const a = num(row[d.startField]);
      const b = num(row[d.endField]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      const top = Math.max(...rows.map((r) => num(r[d.endField])).filter(Number.isFinite));
      parts.push(`${d.expr} >= ${a} AND ${d.expr} ${b >= top ? '<=' : '<'} ${b}`);
      labels.push(`${d.label} from ${fmt(a)} to ${fmt(b)}`);
    } else return null;
  }
  if (drill.base) parts.unshift(`(${drill.base})`);
  return { where: parts.join(' AND '), label: labels.join(' · ') };
}

function fmt(n) {
  const a = Math.abs(n);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: a >= 1000 ? 0 : a >= 1 ? 2 : 4 }).format(n);
}

/**
 * The two queries for a drilled WHERE: the rows (first `columns`, at most `limit`) and the aggregate that must equal the
 * bar. COUNT charts compare COUNT(*); SUM / AVG charts compare that function over the measure column.
 */
export function drillSql(drill, where, { columns, limit = 100 }) {
  const m = drill.measure || { fn: 'COUNT' };
  const agg = m.fn === 'COUNT' ? 'COUNT(*)' : `${m.fn}(${q(m.column)})`;
  const sel = columns?.length ? columns.map(q).join(', ') : '*';
  return {
    rowsSql: `SELECT ${sel} FROM ${q(drill.table)} WHERE ${where} LIMIT ${limit}`,
    aggSql: `SELECT COUNT(*) AS n, ${agg} AS v FROM ${q(drill.table)} WHERE ${where}`,
  };
}

/** Do the drilled rows add up to the number on the chart? { ok, expected, actual, count } */
export function reconcile(drill, row, agg) {
  const m = drill.measure || { fn: 'COUNT', field: 'row_count' };
  const expected = num(row[m.field]);
  const actual = num(agg?.v);
  const count = num(agg?.n);
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return { ok: null, expected, actual, count };
  const tol = m.fn === 'COUNT' ? 0 : Math.max(1e-9, Math.abs(expected) * 1e-9) + 0.005; // a cent of float noise
  return { ok: Math.abs(expected - actual) <= tol, expected, actual, count };
}

/** Columns worth showing for a drill: the dimension and measure columns first, then the table's others, up to `max`. */
export function drillColumns(drill, all, max = 12) {
  const first = [];
  const add = (n) => { if (n && all.includes(n) && !first.includes(n)) first.push(n); };
  if (drill.measure?.column) add(drill.measure.column);
  for (const d of drill.dims) for (const n of all) if (d.expr.includes(q(n))) add(n);
  for (const n of all) add(n);
  return first.slice(0, max);
}
