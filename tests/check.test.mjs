import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEvenly, maxMarksFor, planChecks, basicChecks, summarize } from '../src/data/check.js';

const sumDrill = { table: 'bank', base: '"status" IS NOT NULL', dims: [{ kind: 'value', expr: 'CAST("status" AS VARCHAR)', field: 'status', label: 'status', column: 'status' }], measure: { fn: 'SUM', column: 'amount', field: 'total_amount' } };
const avgDrill = { ...sumDrill, measure: { fn: 'AVG', column: 'balance', field: 'avg_balance' } };
const cntDrill = { ...sumDrill, measure: { fn: 'COUNT', field: 'row_count' } };
const card = (drill, rows, extra = {}) => ({ drill, rows, sql: 'SELECT 1', ...extra });
const prof = { rowCount: 100, columns: [] };

test('pickEvenly: all when few, an even spread with both ends when many', () => {
  assert.deepEqual(pickEvenly(3, 8), [0, 1, 2]);
  const p = pickEvenly(100, 5);
  assert.equal(p.length, 5);
  assert.equal(p[0], 0);
  assert.equal(p.at(-1), 99);
  assert.deepEqual(p, [...p].sort((a, b) => a - b));
  assert.equal(new Set(pickEvenly(20, 20)).size, 20);
});

test('maxMarksFor: fewer re-checks when each one reads a remote file', () => {
  assert.equal(maxMarksFor({ remote: true }), 8);
  assert.equal(maxMarksFor({}), 40);
});

test('planChecks: one aggregate query per mark; whole-table totals only for counts and sums', () => {
  const rows = [{ status: 'a', total_amount: 5 }, { status: 'b', total_amount: 3 }];
  const sum = planChecks(card(sumDrill, rows), prof);
  assert.equal(sum.marks.length, 2);
  assert.match(sum.marks[0].aggSql, /^SELECT COUNT\(\*\) AS n, SUM\("amount"\) AS v FROM "bank" WHERE/);
  assert.equal(sum.totals.all, 'SELECT COUNT(*) AS n, SUM("amount") AS v FROM "bank"');
  assert.equal(sum.totals.base, 'SELECT COUNT(*) AS n, SUM("amount") AS v FROM "bank" WHERE "status" IS NOT NULL');
  assert.equal(sum.skipped, 0);
  assert.equal(planChecks(card(cntDrill, rows), prof).totals.base, 'SELECT COUNT(*) AS n, COUNT(*) AS v FROM "bank" WHERE "status" IS NOT NULL');
  assert.equal(planChecks(card(avgDrill, rows), prof).totals, null, 'an average cannot be added across groups');
  assert.deepEqual(planChecks(card(null, rows), prof), { marks: [], totals: null, skipped: 0 }, 'no drill descriptor: no plan');
  assert.deepEqual(planChecks(card(sumDrill, []), prof), { marks: [], totals: null, skipped: 0 });
});

test('planChecks: a big chart is sampled evenly and says how many it skipped', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ status: `s${i}`, total_amount: i }));
  const p = planChecks(card(sumDrill, rows), { remote: true });
  assert.equal(p.marks.length, 8);
  assert.equal(p.skipped, 92);
  assert.equal(p.marks[0].index, 0);
  assert.equal(p.marks.at(-1).index, 99);
});

test('basicChecks: sample, cut-off LIMIT, empty result', () => {
  assert.match(basicChecks(card(null, [{ a: 1 }]), { rowCount: 5, totalRows: 50 })[0].text, /reads a sample \(5 of 50 rows\)/);
  const lim = basicChecks({ sql: 'SELECT a FROM t LIMIT 3', rows: [1, 2, 3] }, prof);
  assert.equal(lim[0].level, 'info');
  assert.match(lim[0].text, /stops at 3 rows/);
  assert.deepEqual(basicChecks({ sql: 'SELECT a FROM t LIMIT 3', rows: [1, 2] }, prof), [], 'under the limit: nothing to say');
  assert.equal(basicChecks({ sql: 'SELECT 1', rows: [] }, prof)[0].text, 'The query returned no rows.');
});

const results = (marks, totals, skipped = 0) => ({ marks, totals, skipped });

test('summarize: everything holds -> ok, in plain words', () => {
  const rows = [{ status: 'a', total_amount: 5 }, { status: 'b', total_amount: 3 }];
  const r = summarize(card(sumDrill, rows), prof, results(
    [{ index: 0, label: 'status = a', agg: { n: 2, v: 5 } }, { index: 1, label: 'status = b', agg: { n: 1, v: 3 } }],
    { all: { n: 3, v: 8 }, base: { n: 3, v: 8 } }));
  assert.equal(r.verdict, 'ok');
  assert.equal(r.checked, 2);
  assert.match(r.items[0].text, /All 2 marks checked: the rows behind each one add up/);
  assert.match(r.items[1].text, /Together the marks add up to 8, the same as a direct total amount over the table/);
});

test('summarize: a mark that does not add up is named, with both numbers', () => {
  const rows = [{ status: 'a', total_amount: 5 }, { status: 'b', total_amount: 3 }];
  const r = summarize(card(sumDrill, rows), prof, results(
    [{ index: 0, label: 'status = a', agg: { n: 2, v: 5 } }, { index: 1, label: 'status = b', agg: { n: 1, v: 4 } }], null));
  assert.equal(r.verdict, 'warn');
  assert.match(r.items.find((i) => i.level === 'warn').text, /status = b: the chart shows 3 but its rows give 4/);
});

test('summarize: rows left out of every bar are counted; truncated groups explain a gap', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ status: `s${i}`, total_amount: 1 }));
  const r = summarize(card(sumDrill, rows), prof, results([], { all: { n: 40, v: 25 }, base: { n: 30, v: 20 } }));
  assert.equal(r.verdict, 'warn');
  const texts = r.items.map((i) => i.text);
  assert.ok(texts.some((t) => /add up to 15 but a direct total amount over the table is 20: 5 \(25%\) is not in any mark, most likely because only the biggest groups are shown/.test(t)), texts.join(' | '));
  assert.ok(texts.some((t) => /10 of 40 rows \(25%\) are left out because the column this chart groups by is empty/.test(t)), texts.join(' | '));
});

test('summarize: counts compare exactly; skipped marks and samples are reported, never hidden', () => {
  const rows = [{ status: 'a', row_count: 2 }, { status: 'b', row_count: 1 }];
  const r = summarize(card(cntDrill, rows), { rowCount: 3, totalRows: 3000 }, results([{ index: 0, label: 'status = a', agg: { n: 2, v: 2 } }], { all: { n: 3, v: 3 }, base: { n: 3, v: 3 } }, 1));
  assert.equal(r.verdict, 'warn', 'a sample is a warning');
  const texts = r.items.map((i) => i.text);
  assert.ok(texts.some((t) => /1 of 2 marks checked/.test(t)));
  assert.ok(texts.some((t) => /1 other marks were not re-checked/.test(t)));
  assert.ok(texts.some((t) => /reads a sample \(3 of 3,000 rows\)/.test(t)));
});

test('summarize: an AI answer gets only the basics, and says so (verdict "partial")', () => {
  const r = summarize({ rows: [{ a: 1 }], sql: 'SELECT a FROM t' }, prof, { marks: [], totals: null, skipped: 0 });
  assert.equal(r.verdict, 'partial');
  assert.match(r.items[0].text, /written by the AI, so its marks can't be traced to rows automatically/);
  const sampled = summarize({ rows: [{ a: 1 }], sql: 'SELECT a FROM t' }, { rowCount: 1, totalRows: 5 }, { marks: [], totals: null, skipped: 0 });
  assert.equal(sampled.verdict, 'warn');
});
