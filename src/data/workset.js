// Working set: the columns a dashboard's queries need, cached once instead of re-read from the file by every query.
// Pure functions (no DuckDB): which columns a SQL text uses, and how to split row groups across workers.

const SIMPLE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// SQL without string literals and comments, so a word inside 'text' or -- a comment isn't taken for a column.
function stripLiterals(sql) {
  return String(sql)
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

// SELECT * / DESCRIBE / SUMMARIZE read every column; count(*) doesn't. (table.* is checked separately: x.* on a CTE doesn't.)
const ALL_COLUMNS = /\bselect\s+(?:distinct\s+)?\*|,\s*\*\s*(?:,|from\b|exclude\b|replace\b)|\bdescribe\b|\bsummarize\b|\bpivot\b|\bunpivot\b/i;
const NOT_ALIAS = new Set(['where', 'group', 'order', 'limit', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on',
  'using', 'union', 'having', 'qualify', 'window', 'natural', 'positional', 'asof', 'semi', 'anti', 'sample', 'tablesample']);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Columns of the table (from `columns`, its full list) that `sql` refers to. Over-inclusion is harmless (an alias that
 * matches a column name caches that column). A query that needs every column returns all of them: SELECT *, or
 * table.* / alias.* where `table` is the table's name (aliases are found from "FROM table [AS] a").
 */
export function columnsInSql(sql, columns, table) {
  const text = stripLiterals(sql);
  if (ALL_COLUMNS.test(text)) return [...columns];
  if (table) {
    const name = `(?:"${escapeRe(table.replace(/"/g, '""'))}"|${escapeRe(table)})`;
    const names = [name];
    const aliasRe = new RegExp(`\\b(?:from|join)\\s+${name}\\s+(?:as\\s+)?([A-Za-z_][A-Za-z0-9_]*)`, 'gi');
    for (const m of text.matchAll(aliasRe)) if (!NOT_ALIAS.has(m[1].toLowerCase())) names.push(m[1]);
    if (new RegExp(`(?:^|[^A-Za-z0-9_])(?:${names.join('|')})\\s*\\.\\s*\\*`, 'i').test(text)) return [...columns];
  }
  return columns.filter((c) => {
    if (text.includes(`"${String(c).replace(/"/g, '""')}"`)) return true;
    return SIMPLE_IDENT.test(c) && new RegExp(`(^|[^A-Za-z0-9_"])${c}($|[^A-Za-z0-9_"])`, 'i').test(text);
  });
}

/** Union of the columns a set of queries uses, in table order. */
export function unionColumns(sqls, columns, table) {
  const used = new Set(sqls.flatMap((s) => columnsInSql(s, columns, table)));
  return columns.filter((c) => used.has(c));
}

/**
 * Split row groups (with `start`, `rows`) into up to n parts of about equal rows, keeping each part's groups in file
 * order. Each part becomes one worker's share of a working-set build. Returns arrays of groups (no empty parts).
 */
export function splitGroups(groups, n) {
  const total = groups.reduce((s, g) => s + g.rows, 0);
  const parts = [];
  let cur = [];
  let acc = 0;
  for (const g of groups) {
    cur.push(g);
    acc += g.rows;
    if (parts.length < n - 1 && acc >= (total * (parts.length + 1)) / n) { parts.push(cur); cur = []; }
  }
  if (cur.length) parts.push(cur);
  return parts;
}
