// Starter queries for the SQL box, written from the loaded table's profile, so there is always something sensible to
// run and to learn from. Pure (no DOM, no DuckDB).
import { isRowKeyName, isIdLike, STATUS_NAME, aggregateFor, measureRank } from './roles.js';

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
const MAX_EMPTY_COLS = 30;
// the group people ask about first: a status / stage / outcome, then other status-like names, then anything few-valued
const rank = (c) => (/status|state|stage|outcome|result/i.test(c.name) ? 0 : STATUS_NAME.test(c.name) ? 1 : 2);

/** -> [{ label, sql }], first the always-useful ones, then ones that fit this table's columns. */
export function sqlExamples(profile) {
  if (!profile?.table) return [];
  const t = q(profile.table);
  const cols = profile.columns || [];
  const rc = profile.rowCount || 0;
  const out = [
    { label: 'First 100 rows', sql: `SELECT * FROM ${t} LIMIT 100` },
    { label: 'How many rows', sql: `SELECT COUNT(*) AS row_count FROM ${t}` },
  ];

  const cat = cols.filter((c) => c.distinct != null && c.distinct >= 2 && c.distinct <= 50 && c.kind !== 'quantitative' && c.kind !== 'temporal')
    .sort((a, b) => rank(a) - rank(b) || a.distinct - b.distinct)[0];
  if (cat) out.push({ label: `Rows per ${cat.name}`, sql: `SELECT ${q(cat.name)}, COUNT(*) AS row_count FROM ${t} GROUP BY 1 ORDER BY 2 DESC LIMIT 20` });

  const measure = cols.filter((c) => c.kind === 'quantitative' && !isIdLike(c, rc) && c.distinct !== 1)
    .map((c, i) => ({ c, i })).sort((a, b) => measureRank(a.c) - measureRank(b.c) || a.i - b.i)[0]?.c;
  const time = cols.find((c) => c.kind === 'temporal');
  if (measure && cat) {
    const fn = aggregateFor(measure);
    out.push({ label: `${fn === 'AVG' ? 'Average' : 'Total'} ${measure.name} per ${cat.name}`, sql: `SELECT ${q(cat.name)}, ${fn}(${q(measure.name)}) AS ${fn === 'AVG' ? 'average' : 'total'}_${measure.name.replace(/\W+/g, '_')} FROM ${t} GROUP BY 1 ORDER BY 2 DESC LIMIT 20` });
  }
  if (measure && time) {
    const fn = aggregateFor(measure);
    out.push({ label: `${fn === 'AVG' ? 'Average' : 'Total'} ${measure.name} per month`, sql: `SELECT date_trunc('month', TRY_CAST(${q(time.name)} AS TIMESTAMP)) AS month, ${fn}(${q(measure.name)}) AS ${fn === 'AVG' ? 'average' : 'total'}_${measure.name.replace(/\W+/g, '_')} FROM ${t} GROUP BY 1 ORDER BY 1` });
  }

  // a key column: are any values repeated? (the first thing a reviewer checks)
  const key = cols.find((c) => isRowKeyName(c) || (isIdLike(c, rc) && c.distinct != null && c.distinct >= rc * 0.9));
  if (key) out.push({ label: `Repeated ${key.name} values`, sql: `SELECT ${q(key.name)}, COUNT(*) AS times FROM ${t} GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY 2 DESC LIMIT 20` });

  if (cols.length > 1) {
    const some = cols.slice(0, MAX_EMPTY_COLS);
    out.push({
      label: 'Empty values per column',
      sql: some.map((c) => `SELECT ${`'${c.name.replace(/'/g, "''")}'`} AS column_name, COUNT(*) - COUNT(${q(c.name)}) AS empty_rows FROM ${t}`).join('\nUNION ALL ') + '\nORDER BY empty_rows DESC',
    });
  }
  return out;
}
