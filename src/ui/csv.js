// CSV export of a card's rows (pure; the download itself is in app.js).

const cell = (v) => {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** rows: array of objects; columns: [{ name }] or names (default: the keys of the first row). */
export function toCSV(rows, columns) {
  const names = columns?.length ? columns.map((c) => c.name ?? c) : Object.keys(rows?.[0] || {});
  return [names.map(cell).join(','), ...(rows || []).map((r) => names.map((n) => cell(r[n])).join(','))].join('\r\n') + '\r\n';
}

/** A file name from a card title: "Revenue by sector" -> "revenue-by-sector.csv". */
export function csvFileName(title) {
  const base = String(title || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${base || 'data'}.csv`;
}
