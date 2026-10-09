import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlExamples } from '../src/data/sqlexamples.js';
import { guardSQL } from '../src/data/sqlguard.js';

const col = (name, type, kind, extra = {}) => ({ name, type, kind, ...extra });
const bank = {
  table: 'bank', rowCount: 50000,
  columns: [
    col('txn_id', 'VARCHAR', 'nominal', { distinct: 49990 }),
    col('account_number', 'BIGINT', 'quantitative', { distinct: 7, min: 4010, max: 4090 }),
    col('posted_at', 'TIMESTAMP', 'temporal', { distinct: 48000 }),
    col('amount', 'DOUBLE', 'quantitative', { distinct: 36000, min: -898, max: 4999 }),
    col('balance', 'DOUBLE', 'quantitative', { distinct: 50000, min: 8708, max: 13900000 }),
    col('status', 'VARCHAR', 'nominal', { distinct: 4 }),
    col('type', 'VARCHAR', 'nominal', { distinct: 2 }),
  ],
};

test('sqlExamples: always the basics, then ones that fit this table', () => {
  const ex = sqlExamples(bank);
  const labels = ex.map((x) => x.label);
  assert.deepEqual(labels, [
    'First 100 rows', 'How many rows', 'Rows per status', 'Total amount per status', 'Total amount per month',
    'Repeated txn_id values', 'Empty values per column',
  ]);
  assert.equal(ex[0].sql, 'SELECT * FROM "bank" LIMIT 100');
  assert.match(ex[3].sql, /SUM\("amount"\)/, 'a money measure is summed');
  assert.match(ex[4].sql, /date_trunc\('month', TRY_CAST\("posted_at" AS TIMESTAMP\)\)/);
  assert.match(ex[5].sql, /HAVING COUNT\(\*\) > 1/);
});

test('sqlExamples: a level (balance) is averaged; a table with no groups or time gets only the basics', () => {
  const lv = sqlExamples({ table: 'a', rowCount: 100, columns: [col('day', 'DATE', 'temporal', { distinct: 100 }), col('balance', 'DOUBLE', 'quantitative', { distinct: 100, min: 1, max: 5 })] });
  const month = lv.find((x) => /per month/.test(x.label));
  assert.equal(month.label, 'Average balance per month');
  assert.match(month.sql, /AVG\("balance"\)/);
  const plain = sqlExamples({ table: 't', rowCount: 3, columns: [col('x', 'DOUBLE', 'quantitative', { distinct: 3 })] });
  assert.deepEqual(plain.map((x) => x.label), ['First 100 rows', 'How many rows']);
  assert.deepEqual(sqlExamples(null), []);
});

test('sqlExamples: names are quoted safely and every example passes the read-only guard', () => {
  const ex = sqlExamples({ table: 'we"ird', rowCount: 10, columns: [col("it's", 'VARCHAR', 'nominal', { distinct: 3 }), col('n', 'BIGINT', 'quantitative', { distinct: 9 })] });
  for (const x of ex) assert.doesNotThrow(() => guardSQL(x.sql), x.label);
  assert.match(ex[0].sql, /"we""ird"/);
  assert.match(ex.at(-1).sql, /'it''s' AS column_name/);
});

test('guardSQL (shared by the agents and the SQL box)', () => {
  assert.equal(guardSQL('SELECT 1;'), 'SELECT 1');
  assert.equal(guardSQL('-- note\nSELECT 1 /* x */'), 'SELECT 1');
  for (const bad of ['DROP TABLE t', 'SELECT 1; SELECT 2', 'COPY t TO \'x\'', 'ATTACH \'x\'', '', 'INSERT INTO t VALUES (1)']) assert.throws(() => guardSQL(bad), /Unsafe SQL/, bad);
});
