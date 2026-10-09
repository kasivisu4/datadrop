import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricKey, validateMetric, metricSql, loadMetrics, saveMetrics, metricPrompt, metricSuggestions, formatMetricValue } from '../src/data/metrics.js';
import { plannerPrompt, sqlPrompt } from '../src/agents/prompts.js';
import { guardSQL } from '../src/data/sqlguard.js';

const col = (name, type, kind, extra = {}) => ({ name, type, kind, ...extra });
const bank = {
  table: 'bank', rowCount: 50000,
  columns: [
    col('txn_id', 'VARCHAR', 'nominal', { distinct: 49990 }),
    col('amount', 'DOUBLE', 'quantitative', { distinct: 36000 }),
    col('balance', 'DOUBLE', 'quantitative', { distinct: 50000 }),
    col('status', 'VARCHAR', 'nominal', { distinct: 4, topValues: [{ value: 'completed', count: 25000 }, { value: "it's pending", count: 9000 }] }),
  ],
};
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };

test('metricKey: same file finds its metrics again; a different table or different columns does not', () => {
  assert.equal(metricKey(bank), metricKey({ ...bank }));
  assert.notEqual(metricKey(bank), metricKey({ ...bank, table: 'other' }));
  assert.notEqual(metricKey(bank), metricKey({ ...bank, columns: bank.columns.slice(1) }));
});

test('validateMetric: a name and one aggregate expression', () => {
  assert.deepEqual(validateMetric({ name: '  Net   revenue ', expr: 'SUM("amount");' }), { name: 'Net revenue', expr: 'SUM("amount")' });
  assert.match(validateMetric({ name: '', expr: 'COUNT(*)' }).error, /name/);
  assert.match(validateMetric({ name: 'x', expr: '' }).error, /definition/);
  assert.match(validateMetric({ name: 'x', expr: 'SUM(a); DROP TABLE t' }).error, /One expression only/);
  assert.match(validateMetric({ name: 'x', expr: 'SUM(a) -- note' }).error, /One expression only/);
  assert.equal(validateMetric({ name: 'x', expr: "SUM(a) FILTER (WHERE s = 'a;b -- c')" }).error, undefined, 'punctuation inside a string literal is fine');
  assert.match(validateMetric({ name: 'x'.repeat(61), expr: 'COUNT(*)' }).error, /60/);
});

test('metricSql evaluates against the table and passes the read-only guard', () => {
  const sql = metricSql({ expr: "SUM(\"amount\") FILTER (WHERE \"status\" = 'completed')" }, 'bank');
  assert.equal(sql, "SELECT SUM(\"amount\") FILTER (WHERE \"status\" = 'completed') AS value FROM \"bank\"");
  assert.doesNotThrow(() => guardSQL(sql));
  assert.throws(() => guardSQL(metricSql({ expr: '(SELECT 1); DROP TABLE x' }, 't')), /Unsafe SQL/);
});

test('save and load: per dataset, survives bad storage', () => {
  const s = mem();
  assert.deepEqual(loadMetrics(s, bank), []);
  assert.equal(saveMetrics(s, bank, [{ name: 'Rows', expr: 'COUNT(*)' }, { name: 'Total', expr: 'SUM("amount")', junk: 1 }]), true);
  assert.deepEqual(loadMetrics(s, bank), [{ name: 'Rows', expr: 'COUNT(*)' }, { name: 'Total', expr: 'SUM("amount")' }]);
  assert.deepEqual(loadMetrics(s, { ...bank, table: 'other' }), [], 'another dataset has its own');
  assert.equal(saveMetrics(null, bank, []), false);
  assert.deepEqual(loadMetrics({ getItem: () => 'not json' }, bank), []);
  s.setItem('datadrop.metrics.v1', JSON.stringify({ [metricKey(bank)]: [{ name: '', expr: 'x' }, { name: 'ok', expr: 'COUNT(*)' }] }));
  assert.deepEqual(loadMetrics(s, bank), [{ name: 'ok', expr: 'COUNT(*)' }], 'invalid entries are dropped on load');
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `m${i}`, expr: 'COUNT(*)' }));
  saveMetrics(s, bank, many);
  assert.equal(loadMetrics(s, bank).length, 12, 'at most 12');
});

test('metricPrompt: the block the AI sees', () => {
  assert.equal(metricPrompt([]), '');
  const p = metricPrompt([{ name: 'Net revenue', expr: 'SUM("amount")' }]);
  assert.match(p, /use exactly this expression/);
  assert.match(p, /^- "Net revenue": SUM\("amount"\)$/m);
});

test('prompts include the defined metrics, for the planner and for questions', () => {
  const metrics = [{ name: 'Net revenue', expr: 'SUM("amount") FILTER (WHERE "status" = \'completed\')' }];
  assert.match(sqlPrompt(bank, 'net revenue by month', [], metrics).system, /- "Net revenue": SUM\("amount"\) FILTER/);
  assert.match(plannerPrompt(bank, metrics).system, /- "Net revenue": SUM\("amount"\) FILTER/);
  assert.doesNotMatch(sqlPrompt(bank, 'q').system, /Defined metrics/);
  assert.doesNotMatch(plannerPrompt(bank).system, /Defined metrics/);
});

test('metricSuggestions: a count, the main measure, a filtered total, distinct keys', () => {
  const s = metricSuggestions(bank);
  assert.deepEqual(s.map((x) => x.name), ['Rows', 'Total amount', 'amount where status is completed', 'Distinct txn_id']);
  assert.equal(s[2].expr, `SUM("amount") FILTER (WHERE "status" = 'completed')`);
  const lvl = metricSuggestions({ table: 't', rowCount: 10, columns: [col('balance', 'DOUBLE', 'quantitative', { distinct: 9 })] });
  assert.equal(lvl[1].expr, 'AVG("balance")', 'a balance is averaged, not summed');
  assert.ok(metricSuggestions(bank).every((x) => !validateMetric(x).error));
  assert.deepEqual(metricSuggestions(null), []);
});

test('formatMetricValue: every digit, grouped', () => {
  assert.equal(formatMetricValue(13878092.93), '13,878,092.93');
  assert.equal(formatMetricValue(50000), '50,000');
  assert.equal(formatMetricValue(12345678901n), '12,345,678,901');
  assert.equal(formatMetricValue(null), '—');
  assert.equal(formatMetricValue('x'), 'x');
  assert.equal(formatMetricValue(0.5), '0.50');
});
