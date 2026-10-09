// Pure logic for the Data tab (grid + record view): what kind of column this is, how a cell is shown, which rows
// are on screen, and the SQL for a page of rows. No DOM, so tier 1 tests cover it.

import { ID_NAME, MONEY_NAME } from '../data/roles.js';

export const PAGE_SIZE = 200;
export const MAX_SPACER_PX = 8_000_000; // browsers clamp element heights (~33M px); stay well under

const FRACTIONAL = /^(DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC)/i;
const NESTED = /^(STRUCT|MAP|JSON)|\[\]$|^LIST/i;

/** One of: money, decimal, int, id, date, datetime, bool, category, json, text. */
export function columnRole(col) {
  const type = String(col.type || '');
  if (col.kind === 'boolean') return 'bool';
  if (col.kind === 'temporal') return /^TIMESTAMP/i.test(type) ? 'datetime' : 'date';
  if (col.kind === 'quantitative') {
    if (ID_NAME.test(col.name)) return 'id';
    if (FRACTIONAL.test(type)) return MONEY_NAME.test(col.name) ? 'money' : 'decimal';
    return 'int';
  }
  if (NESTED.test(type)) return 'json';
  if (ID_NAME.test(col.name)) return 'id';
  if (col.distinct != null && col.distinct <= 12) return 'category';
  return 'text';
}

const GOOD = /^(paid|complete[d]?|success(ful)?|settled|posted|approved|active|cleared|credit|deposit|inflow|income|cr|yes|open|ok|true)$/i;
const WARN = /^(pending|processing|in[ _-]?progress|hold|on[ _-]?hold|review|scheduled|authorized|authorised|partial|draft|new)$/i;
const BAD = /^(fail(ed)?|declined|rejected|error|cancel(l)?ed|overdue|reversed|chargeback|refunded|debit|withdrawal|outflow|expense|dr|blocked|closed|no|false)$/i;

/** Colour for a status-like value ("completed", "pending", "declined"; "credit" / "debit"), or null. */
export function statusTone(value) {
  const s = String(value ?? '').trim();
  if (GOOD.test(s)) return 'good';
  if (WARN.test(s)) return 'warn';
  if (BAD.test(s)) return 'bad';
  return null;
}

const fmtCache = new Map();
function numberFormat(locale, min, max) {
  const key = `${locale}|${min}|${max}`;
  let f = fmtCache.get(key);
  if (!f) fmtCache.set(key, f = new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max }));
  return f;
}

export function formatDateTime(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?Z?$/.exec(s);
  if (!m) return s;
  const ms = m[3] && /[1-9]/.test(m[3]) ? m[3].slice(0, 4) : '';
  return `${m[1]} ${m[2]}${ms}`;
}

const MAX_TEXT = 300; // the grid cell only ever shows the start; the record view has the rest

/**
 * How a value is shown: { text, cls, title?, tone? }.
 *  - cls: 'null' | 'neg' | 'id' | 'pill' | 'bool-true' | 'bool-false' (cell colouring); title: the full text on hover
 *  - money: 2 decimals and thousands separators; negatives are marked red. ids: never grouped. Large integers
 *    that arrived as strings are shown as they are.
 */
export function formatCell(value, role, locale) {
  if (value == null) return { text: 'null', cls: 'null' };
  if (role === 'bool' || typeof value === 'boolean') return { text: String(value), cls: value ? 'bool-true' : 'bool-false' };
  if (typeof value === 'object') {
    let s;
    try { s = JSON.stringify(value); } catch { s = String(value); }
    return { text: s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s, cls: 'json', title: s.length > 80 ? s.slice(0, 600) : undefined };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { text: String(value), cls: '' };
    if (role === 'id') return { text: String(value), cls: 'id' };
    const abs = Math.abs(value);
    let f;
    if (role === 'money') f = numberFormat(locale, 2, 2);
    else if (Number.isInteger(value)) f = numberFormat(locale, 0, 0);
    else f = numberFormat(locale, 0, abs < 1 ? 6 : abs < 1000 ? 4 : 2);
    return { text: f.format(value), cls: value < 0 ? 'neg' : '' };
  }
  let s = String(value);
  if (role === 'datetime') s = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s} 00:00:00` : formatDateTime(s); // DuckDB hands over midnight timestamps as bare dates
  else if (role === 'date') s = s.replace(/T00:00:00(\.0+)?Z?$/, '');
  const out = { text: s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s, cls: role === 'id' ? 'id' : '' };
  if (s.length > 40) out.title = s.length > 600 ? `${s.slice(0, 600)}…` : s;
  if (role === 'category') {
    const tone = statusTone(s);
    out.cls = 'pill';
    if (tone) out.tone = tone;
  }
  return out;
}

/** Plain-text version of a value, for copying. */
export function copyValue(value) {
  if (value == null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Starting width in px: wide enough for the header and a typical value. */
export function defaultWidth(col, role) {
  const base = { money: 124, decimal: 116, int: 104, id: 150, date: 118, datetime: 176, bool: 88, category: 132, json: 220, text: 200 }[role] || 160;
  const header = String(col.name).length * 7.4 + 52; // name + sort arrow + menu button
  return Math.round(Math.max(88, Math.min(340, Math.max(base, header))));
}

/** Columns shown first: all of them up to `max`, leaving out fully empty ones once the table is wide. */
export function defaultVisible(columns, max = 30) {
  const keep = columns.length > 8 ? columns.filter((c) => !(Number(c.nullPct) >= 100)) : columns;
  return (keep.length ? keep : columns).slice(0, max).map((c) => c.name);
}

/**
 * How to fetch a page of a remote file: columns in groups, each its own query, so the cells fill in as groups arrive.
 * A remote page costs a row group's worth of every column it touches, and queries run on parallel lanes. Columns
 * already in the working set come first (instant); the rest go in groups of `size`. Downloaded tables and sorted
 * pages (each group would repeat the sort) are one query.
 */
export function columnGroups(names, { remote = false, fast = null, size = 4 } = {}) {
  if (!remote) return [names];
  const quick = fast ? names.filter((n) => fast.includes(n)) : [];
  const rest = names.filter((n) => !quick.includes(n));
  if (!rest.length || (!quick.length && names.length <= size)) return [names];
  const groups = quick.length ? [quick] : [];
  for (let i = 0; i < rest.length; i += size) groups.push(rest.slice(i, i + size));
  return groups;
}

/** Display order: pinned columns first (in table order), then the other visible ones. */
export function displayOrder(columns, visible, pinned) {
  const vis = columns.filter((c) => visible.has(c.name));
  return [...vis.filter((c) => pinned.has(c.name)), ...vis.filter((c) => !pinned.has(c.name))];
}

/**
 * Which rows are on screen for a scroll position. Up to MAX_SPACER_PX the scroll position maps 1:1 to rows; past
 * that (millions of rows) the scrollbar is scaled, so dragging it covers the whole table.
 * -> { first, count, offset, spacerH, scaled }: render rows first..first+count, shifted by `offset` px.
 */
export function windowFor({ scrollTop, viewH, total, rowH, maxH = MAX_SPACER_PX }) {
  const count = Math.max(1, Math.ceil(viewH / rowH) + 1);
  const full = total * rowH;
  if (full <= maxH) {
    const first = Math.min(Math.floor(scrollTop / rowH), Math.max(0, total - 1));
    return { first, count, offset: -(scrollTop - first * rowH), spacerH: full, scaled: false };
  }
  const maxScroll = Math.max(1, maxH - viewH);
  const lastFirst = Math.max(0, total - Math.floor(viewH / rowH));
  const first = Math.min(lastFirst, Math.round((scrollTop / maxScroll) * lastFirst));
  return { first, count, offset: 0, spacerH: maxH, scaled: true };
}

/** scrollTop that puts `row` at the top of the view (inverse of windowFor). */
export function scrollTopFor(row, { viewH, total, rowH, maxH = MAX_SPACER_PX }) {
  if (total * rowH <= maxH) return Math.max(0, row * rowH);
  const lastFirst = Math.max(1, total - Math.floor(viewH / rowH));
  return Math.round((Math.min(row, lastFirst) / lastFirst) * (maxH - viewH));
}

/** Page indexes covering rows [first, first+count), plus the next page so scrolling down stays ahead. */
export function pagesFor(first, count, total, pageSize = PAGE_SIZE) {
  const last = Math.min(total - 1, first + count - 1);
  const out = [];
  for (let p = Math.floor(first / pageSize); p <= Math.floor(last / pageSize); p++) out.push(p);
  const next = out[out.length - 1] + 1;
  if (next * pageSize < total) out.push(next);
  return out;
}

// ---- results held in memory (the SQL box): same grid, no table behind it ----

/** DuckDB / Arrow type name -> the kind the grid uses. */
export function kindFromType(type) {
  const t = String(type || '').toUpperCase();
  if (/BOOL/.test(t)) return 'boolean';
  if (/^(DATE|TIMESTAMP|TIME)/.test(t)) return 'temporal';
  if (/^(U?(TINY|SMALL|BIG|HUGE)?INT|DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC)/.test(t)) return 'quantitative';
  return 'nominal';
}

const keyOf = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

/** A profile (the shape the grid reads) for a result held as rows: counts, nulls, distinct, range, top values. */
export function profileFromResult(columns, rows, table = 'result') {
  const n = rows.length;
  const cols = columns.map((c) => {
    const kind = kindFromType(c.type);
    const seen = new Map();
    let nulls = 0, min = null, max = null, sum = 0, count = 0;
    for (const r of rows) {
      const v = r[c.name];
      if (v == null) { nulls++; continue; }
      const k = keyOf(v);
      if (seen.size <= 5000) seen.set(k, (seen.get(k) || 0) + 1);
      if (kind !== 'nominal' || typeof v === 'string') {
        if (min === null || v < min) min = v;
        if (max === null || v > max) max = v;
      }
      if (typeof v === 'number') { sum += v; count++; }
    }
    const distinct = seen.size > 5000 ? null : seen.size;
    const out = { name: c.name, type: c.type, kind, nullPct: n ? (nulls / n) * 100 : 0, distinct, min, max };
    if (kind === 'quantitative' && count) out.mean = sum / count;
    if (kind === 'nominal' && distinct != null && distinct <= 50) out.topValues = [...seen].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, c2]) => ({ value, count: c2 }));
    return out;
  });
  return { table, rowCount: n, columns: cols, sample: [] };
}

const sortedCache = new WeakMap();
function cmp(a, b) {
  if (a == null || b == null) return (a == null) - (b == null); // nulls last
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = keyOf(a), y = keyOf(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Rows [offset, offset+limit) of an in-memory result, optionally sorted (nulls last, ties keep result order), only `columns`. */
export function pageFromRows(rows, { columns = null, sort = null, offset = 0, limit = PAGE_SIZE } = {}) {
  let order = null;
  if (sort) {
    const key = `${sort.column}|${sort.dir}`;
    let cache = sortedCache.get(rows);
    if (!cache) sortedCache.set(rows, cache = new Map());
    order = cache.get(key);
    if (!order) {
      const sign = sort.dir === 'desc' ? -1 : 1;
      order = rows.map((_, i) => i).sort((i, j) => {
        const a = rows[i][sort.column], b = rows[j][sort.column];
        if (a == null || b == null) return cmp(a, b); // nulls last in both directions
        return sign * cmp(a, b) || i - j;
      });
      cache.set(key, order);
    }
  }
  const out = [];
  for (let k = offset; k < Math.min(rows.length, offset + limit); k++) {
    const r = rows[order ? order[k] : k];
    out.push(columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r);
  }
  return out;
}
