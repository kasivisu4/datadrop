import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowForDatum, drillWhere, drillSql, reconcile, drillColumns, drillFields } from '../src/data/drill.js';

const value = { table: 'bank', base: '"status" IS NOT NULL', dims: [{ kind: 'value', expr: 'CAST("status" AS VARCHAR)', field: 'status', label: 'status' }], measure: { fn: 'SUM', column: 'amount', field: 'total_amount' } };
const bucket = { table: 'bank', base: 'TRY_CAST("posted_at" AS TIMESTAMP) IS NOT NULL', dims: [{ kind: 'bucket', expr: "date_trunc('month', TRY_CAST(\"posted_at\" AS TIMESTAMP))", field: 'period', label: 'posted_at (month)' }], measure: { fn: 'COUNT', field: 'row_count' } };
const range = { table: 't', base: '"x" IS NOT NULL', dims: [{ kind: 'range', expr: 'CAST("x" AS DOUBLE)', startField: 'bin_start', endField: 'bin_end', label: 'x' }], measure: { fn: 'COUNT', field: 'row_count' } };

test('drillWhere: a category value, quoted safely', () => {
  const w = drillWhere(value, { status: "it's done", total_amount: 5 }, []);
  assert.equal(w.where, `("status" IS NOT NULL) AND CAST("status" AS VARCHAR) = 'it''s done'`);
  assert.equal(w.label, "status = it's done");
  assert.equal(drillWhere(value, { status: null }, []), null, 'a null group has no filter');
});

test('drillWhere: "Other" is every row not among the other bars', () => {
  const rows = [{ status: 'a', c: 5 }, { status: 'b', c: 4 }, { status: 'Other', c: 3 }];
  const w = drillWhere(value, rows[2], rows);
  assert.match(w.where, /NOT IN \('a', 'b'\)/);
  assert.match(w.label, /everything not shown/);
  assert.equal(drillWhere(value, { status: 'Other' }, [{ status: 'Other' }]).where.includes('= \'Other\''), true, 'a real value called Other when it is the only bar');
});

test('drillWhere: a time bucket, with the T and Z stripped', () => {
  assert.match(drillWhere(bucket, { period: '2025-03-01' }, []).where, /= CAST\('2025-03-01' AS TIMESTAMP\)$/);
  assert.match(drillWhere(bucket, { period: '2025-03-01T05:00:00.000Z' }, []).where, /CAST\('2025-03-01 05:00:00.000' AS TIMESTAMP\)/);
});

test('drillWhere: a bin is start <= x < end; the last bin includes its upper edge', () => {
  const rows = [{ bin_start: 0, bin_end: 10 }, { bin_start: 10, bin_end: 20 }];
  assert.match(drillWhere(range, rows[0], rows).where, /"x" AS DOUBLE\) >= 0 AND CAST\("x" AS DOUBLE\) < 10$/);
  assert.match(drillWhere(range, rows[1], rows).where, /<= 20$/);
  assert.equal(drillWhere(range, { bin_start: 'x', bin_end: 1 }, rows), null);
});

test('drillWhere: unknown dims and missing rows give null', () => {
  assert.equal(drillWhere({ dims: [{ kind: 'nope' }] }, { a: 1 }), null);
  assert.equal(drillWhere(value, null), null);
  assert.equal(drillWhere(null, {}), null);
});

test('rowForDatum: finds the result row from Vega\'s datum, dates as numbers or Dates', () => {
  const rows = [{ period: '2025-01-01', n: 3 }, { period: '2025-02-01', n: 4 }];
  assert.equal(rowForDatum(rows, { period: Date.UTC(2025, 1, 1), n: 4 }, ['period']), rows[1]);
  assert.equal(rowForDatum(rows, { period: new Date(Date.UTC(2025, 0, 1)) }, ['period']), rows[0]);
  assert.equal(rowForDatum(rows, { period: '2025-02-01' }, ['period']), rows[1]);
  assert.equal(rowForDatum(rows, { period: '2030-01-01' }, ['period']), null);
  assert.equal(rowForDatum([{ s: 'a' }, { s: 'b' }], { s: 'b' }, ['s']).s, 'b');
});

test('drillSql: rows and the aggregate that must equal the bar', () => {
  const s = drillSql(value, 'W', { columns: ['amount', 'status'], limit: 50 });
  assert.equal(s.rowsSql, 'SELECT "amount", "status" FROM "bank" WHERE W LIMIT 50');
  assert.equal(s.aggSql, 'SELECT COUNT(*) AS n, SUM("amount") AS v FROM "bank" WHERE W');
  assert.equal(drillSql(range, 'W', {}).aggSql, 'SELECT COUNT(*) AS n, COUNT(*) AS v FROM "t" WHERE W');
  assert.match(drillSql(range, 'W', {}).rowsSql, /^SELECT \* FROM/);
});

test('reconcile: exact for counts, a cent of float noise for sums, null when unknown', () => {
  assert.deepEqual(reconcile(range, { row_count: 12 }, { n: 12, v: 12 }), { ok: true, expected: 12, actual: 12, count: 12 });
  assert.equal(reconcile(range, { row_count: 12 }, { n: 11, v: 11 }).ok, false);
  assert.equal(reconcile(value, { total_amount: 100.004 }, { n: 3, v: 100.0 }).ok, true);
  assert.equal(reconcile(value, { total_amount: 100.2 }, { n: 3, v: 100.0 }).ok, false);
  assert.equal(reconcile(value, {}, { n: 3, v: 1 }).ok, null);
});

test('drillColumns / drillFields', () => {
  const all = ['id', 'status', 'amount', 'memo', 'x'];
  assert.deepEqual(drillColumns(value, all, 3), ['amount', 'status', 'id']);
  assert.deepEqual(drillFields(range), ['bin_start', 'bin_end']);
});
