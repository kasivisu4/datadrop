// Row-group sampling for remote Parquet files too large to scan. Pure functions, no DuckDB.
//
// A sample is a set of whole row groups: each one is a contiguous file_row_number range, which DuckDB can
// jump to without reading the rows before it (filters on file_row_number prune row groups). Whole groups mean
// no partly-used column chunks are downloaded.

/** groups: [{ id, rows }] in file order -> adds `start` (first file_row_number of each group). */
export function withStarts(groups) {
  let start = 0;
  return groups.map((g) => { const out = { ...g, start }; start += g.rows; return out; });
}

/**
 * Pick row groups for a sample of about `rows` rows.
 *   mode 'spread': groups evenly spaced from start to end of the file (a representative cross-section).
 *   mode 'window': consecutive groups starting at the group that holds file row `offset` (first / next N rows).
 * groups must carry `start` (see withStarts). Returns groups in file order.
 */
export function pickRowGroups(groups, { mode = 'spread', rows, offset = 0 } = {}) {
  if (!groups.length) return [];
  const total = groups[groups.length - 1].start + groups[groups.length - 1].rows;
  const k = Math.min(groups.length, Math.max(1, Math.round((rows || total) / (total / groups.length))));
  if (mode === 'window') {
    let i = groups.findIndex((g) => g.start + g.rows > offset);
    if (i < 0) i = groups.length - k; // past the end: show the last rows
    i = Math.min(i, groups.length - k);
    return groups.slice(i, i + k);
  }
  return Array.from({ length: k }, (_, j) => groups[Math.floor(((j + 0.5) * groups.length) / k)]);
}

/**
 * The file-row ranges holding sample rows [offset, offset + count), where the sample is `ranges` laid end to end
 * (see rowRanges). Lets a page of the sample be read by file_row_number, which prunes row groups.
 */
export function sliceRanges(ranges, offset, count) {
  const out = [];
  let skip = offset;
  let left = count;
  for (const [a, b] of ranges) {
    const n = b - a;
    if (skip >= n) { skip -= n; continue; }
    const take = Math.min(n - skip, left);
    out.push([a + skip, a + skip + take]);
    left -= take;
    skip = 0;
    if (left <= 0) break;
  }
  return out;
}

/** Merge picked groups into [startRow, endRow) ranges, joining neighbours. */
export function rowRanges(picked) {
  const ranges = [];
  for (const g of picked) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === g.start) last[1] = g.start + g.rows;
    else ranges.push([g.start, g.start + g.rows]);
  }
  return ranges;
}
