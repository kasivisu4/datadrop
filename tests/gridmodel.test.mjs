import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  columnRole, statusTone, formatCell, formatDateTime, copyValue, defaultWidth, defaultVisible, displayOrder,
  windowFor, scrollTopFor, pagesFor, columnGroups, PAGE_SIZE, MAX_SPACER_PX,
} from '../src/ui/gridmodel.js';

const col = (name, type, kind, extra = {}) => ({ name, type, kind, ...extra });

test('columnRole: banking columns', () => {
  assert.equal(columnRole(col('amount', 'DOUBLE', 'quantitative')), 'money');
  assert.equal(columnRole(col('balance', 'DECIMAL(18,2)', 'quantitative')), 'money');
  assert.equal(columnRole(col('Close', 'DOUBLE', 'quantitative')), 'money');
  assert.equal(columnRole(col('total_rows', 'BIGINT', 'quantitative')), 'int', 'integer counts are not money (no ".00")');
  assert.equal(columnRole(col('temperature', 'DOUBLE', 'quantitative')), 'decimal');
  assert.equal(columnRole(col('account_number', 'BIGINT', 'quantitative')), 'id', 'account numbers are never grouped');
  assert.equal(columnRole(col('iban', 'VARCHAR', 'nominal')), 'id');
  assert.equal(columnRole(col('txn_id', 'VARCHAR', 'nominal', { distinct: 47000 })), 'id');
  assert.equal(columnRole(col('posted_at', 'TIMESTAMP', 'temporal')), 'datetime');
  assert.equal(columnRole(col('value_date', 'DATE', 'temporal')), 'date');
  assert.equal(columnRole(col('cleared', 'BOOLEAN', 'boolean')), 'bool');
  assert.equal(columnRole(col('status', 'VARCHAR', 'nominal', { distinct: 4 })), 'category');
  assert.equal(columnRole(col('merchant', 'VARCHAR', 'nominal', { distinct: 5000 })), 'text');
  assert.equal(columnRole(col('merchant', 'VARCHAR', 'nominal', { distinct: null })), 'text', 'unknown cardinality is text');
  assert.equal(columnRole(col('meta', 'STRUCT(a INTEGER)', 'nominal')), 'json');
  assert.equal(columnRole(col('tags', 'VARCHAR[]', 'nominal')), 'json');
});

test('statusTone: transaction statuses and credit/debit', () => {
  for (const s of ['completed', 'Paid', 'SETTLED', 'credit', 'deposit']) assert.equal(statusTone(s), 'good', s);
  for (const s of ['pending', 'On Hold', 'in_progress', 'scheduled']) assert.equal(statusTone(s), 'warn', s);
  for (const s of ['failed', 'declined', 'reversed', 'chargeback', 'debit', 'cancelled']) assert.equal(statusTone(s), 'bad', s);
  assert.equal(statusTone('Groceries'), null);
  assert.equal(statusTone(null), null);
});

test('formatCell: money has 2 decimals, grouping, and negatives are flagged', () => {
  assert.deepEqual(formatCell(-1234.5, 'money', 'en-US'), { text: '-1,234.50', cls: 'neg' });
  assert.deepEqual(formatCell(1234567.891, 'money', 'en-US'), { text: '1,234,567.89', cls: '' });
  assert.deepEqual(formatCell(0, 'money', 'en-US'), { text: '0.00', cls: '' });
  assert.equal(formatCell(5000000000, 'int', 'en-US').text, '5,000,000,000');
  assert.equal(formatCell(0.0000123, 'decimal', 'en-US').text, '0.000012');
  assert.equal(formatCell(12.34567891, 'decimal', 'en-US').text, '12.3457');
  assert.equal(formatCell(98765.4321, 'decimal', 'en-US').text, '98,765.43');
  assert.equal(formatCell(-3, 'int', 'en-US').cls, 'neg');
});

test('formatCell: ids are never grouped, nulls, booleans, large integers, dates', () => {
  assert.deepEqual(formatCell(401002469134, 'id'), { text: '401002469134', cls: 'id' });
  assert.deepEqual(formatCell('TX1000002', 'id'), { text: 'TX1000002', cls: 'id' });
  assert.deepEqual(formatCell(null, 'money'), { text: 'null', cls: 'null' });
  assert.deepEqual(formatCell(undefined, 'text'), { text: 'null', cls: 'null' });
  assert.equal(formatCell(true, 'bool').cls, 'bool-true');
  assert.equal(formatCell(false, 'bool').cls, 'bool-false');
  assert.equal(formatCell('9007199254740993', 'int').text, '9007199254740993', 'a bigint that arrived as a string is shown as is');
  assert.equal(formatCell('2025-01-01T00:00:00.000Z', 'date').text, '2025-01-01');
  assert.equal(formatCell('2025-01-01', 'datetime').text, '2025-01-01 00:00:00', 'midnight timestamps arrive as bare dates');
  assert.equal(formatCell('2025-03-04T05:06:07.000Z', 'datetime').text, '2025-03-04 05:06:07');
  assert.equal(formatCell('2025-03-04T05:06:07.250Z', 'datetime').text, '2025-03-04 05:06:07.250');
  assert.equal(formatDateTime('not a date'), 'not a date');
});

test('formatCell: status pills, long text, nested values', () => {
  assert.deepEqual(formatCell('completed', 'category'), { text: 'completed', cls: 'pill', tone: 'good' });
  assert.deepEqual(formatCell('Groceries', 'category'), { text: 'Groceries', cls: 'pill' });
  const long = 'x'.repeat(500);
  const f = formatCell(long, 'text');
  assert.equal(f.text.length, 301);
  assert.ok(f.text.endsWith('…'));
  assert.ok(f.title && f.title.length > 40, 'full text on hover');
  assert.equal(formatCell('short', 'text').title, undefined);
  assert.equal(formatCell({ a: 1, b: [2, 3] }, 'json').text, '{"a":1,"b":[2,3]}');
});

test('copyValue', () => {
  assert.equal(copyValue(null), '');
  assert.equal(copyValue(12.5), '12.5');
  assert.equal(copyValue({ a: 1 }), '{"a":1}');
  assert.equal(copyValue('TX1'), 'TX1');
});

test('defaultWidth: header always fits, within bounds', () => {
  assert.ok(defaultWidth(col('a', 'INT', 'quantitative'), 'int') >= 88);
  assert.ok(defaultWidth(col('a_really_long_column_name_that_keeps_going_and_going_and_going', 'VARCHAR', 'nominal'), 'text') <= 340);
  assert.ok(defaultWidth(col('posted_at', 'TIMESTAMP', 'temporal'), 'datetime') >= 176);
});

test('defaultVisible / displayOrder', () => {
  const cols = Array.from({ length: 40 }, (_, i) => col(`c${i}`, 'INT', 'quantitative', { nullPct: i === 1 ? 100 : 0 }));
  const v = defaultVisible(cols);
  assert.equal(v.length, 30, 'capped at 30');
  assert.ok(!v.includes('c1'), 'a fully empty column is left out of a wide table');
  const small = [col('a', 'INT', 'quantitative', { nullPct: 100 }), col('b', 'INT', 'quantitative')];
  assert.deepEqual(defaultVisible(small), ['a', 'b'], 'narrow tables show everything');
  assert.deepEqual(displayOrder(small, new Set(['a', 'b']), new Set(['b'])).map((c) => c.name), ['b', 'a'], 'pinned first');
  assert.deepEqual(displayOrder(small, new Set(['a']), new Set()).map((c) => c.name), ['a']);
});

test('windowFor: 1:1 scrolling for ordinary tables', () => {
  const w = windowFor({ scrollTop: 0, viewH: 360, total: 1000, rowH: 36 });
  assert.deepEqual(w, { first: 0, count: 11, offset: -0, spacerH: 36000, scaled: false });
  const m = windowFor({ scrollTop: 100, viewH: 360, total: 1000, rowH: 36 });
  assert.equal(m.first, 2);
  assert.equal(m.offset, -28, 'sub-row scroll is a pixel offset');
  const end = windowFor({ scrollTop: 36000 - 360, viewH: 360, total: 1000, rowH: 36 });
  assert.equal(end.first, 990);
  assert.equal(windowFor({ scrollTop: 0, viewH: 360, total: 0, rowH: 36 }).first, 0);
});

test('windowFor: millions of rows scale the scrollbar and still reach both ends', () => {
  const total = 5_000_000;
  const o = { viewH: 360, total, rowH: 36 };
  const top = windowFor({ scrollTop: 0, ...o });
  assert.equal(top.scaled, true);
  assert.equal(top.spacerH, MAX_SPACER_PX);
  assert.equal(top.first, 0);
  const bottom = windowFor({ scrollTop: MAX_SPACER_PX - 360, ...o });
  assert.equal(bottom.first, total - 10, 'last row is reachable');
  const mid = windowFor({ scrollTop: (MAX_SPACER_PX - 360) / 2, ...o });
  assert.ok(Math.abs(mid.first - total / 2) < 20);
});

test('scrollTopFor is the inverse of windowFor', () => {
  for (const total of [1000, 5_000_000]) {
    const o = { viewH: 360, total, rowH: 36 };
    for (const row of [0, 1, 57, Math.floor(total / 3), total - 20]) {
      const w = windowFor({ scrollTop: scrollTopFor(row, o), ...o });
      assert.ok(Math.abs(w.first - row) <= 1, `${total} rows, row ${row} -> ${w.first}`);
    }
  }
});

test('pagesFor: the visible pages plus the next one', () => {
  assert.deepEqual(pagesFor(0, 20, 1000), [0, 1], 'page 0 plus read-ahead');
  assert.deepEqual(pagesFor(190, 20, 1000), [0, 1, 2], 'a window across a page boundary, then read-ahead');
  assert.deepEqual(pagesFor(900, 50, 1000), [4], 'no read-ahead past the end');
  assert.deepEqual(pagesFor(0, 20, 150), [0]);
  assert.equal(PAGE_SIZE, 200);
});

test('columnGroups: a remote page loads in groups, working-set columns first; downloaded tables and sorted pages are one query', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.deepEqual(columnGroups(names, { remote: false }), [names], 'downloaded table');
  assert.deepEqual(columnGroups(names, { remote: true }), [['a', 'b', 'c', 'd'], ['e', 'f']], 'groups of 4');
  assert.deepEqual(columnGroups(['a', 'b'], { remote: true }), [['a', 'b']], 'few columns: one query');
  assert.deepEqual(columnGroups(names, { remote: true, fast: ['c', 'x', 'a'] }), [['a', 'c'], ['b', 'd', 'e', 'f']], 'the working set group first, in display order');
  assert.deepEqual(columnGroups(names, { remote: true, fast: names }), [names], 'everything already in memory: one query');
  assert.deepEqual(columnGroups(['a', 'b'], { remote: true, fast: ['a'] }), [['a'], ['b']], 'even two columns split when one is instant');
  assert.deepEqual(columnGroups(names, { remote: true }).flat(), names, 'every column exactly once');
});

import { kindFromType, profileFromResult, pageFromRows } from '../src/ui/gridmodel.js';

test('kindFromType', () => {
  assert.equal(kindFromType('BIGINT'), 'quantitative');
  assert.equal(kindFromType('DECIMAL(18,2)'), 'quantitative');
  assert.equal(kindFromType('TIMESTAMP'), 'temporal');
  assert.equal(kindFromType('DATE'), 'temporal');
  assert.equal(kindFromType('BOOLEAN'), 'boolean');
  assert.equal(kindFromType('VARCHAR'), 'nominal');
  assert.equal(kindFromType('STRUCT(a INT)'), 'nominal');
});

const R = [{ s: 'b', n: 2, d: '2025-01-02' }, { s: 'a', n: 10, d: '2025-01-01' }, { s: null, n: null, d: '2025-01-03' }, { s: 'a', n: 5, d: null }];
const C = [{ name: 's', type: 'VARCHAR' }, { name: 'n', type: 'BIGINT' }, { name: 'd', type: 'DATE' }];

test('profileFromResult: the shape the grid reads, from rows held in memory', () => {
  const p = profileFromResult(C, R);
  assert.equal(p.rowCount, 4);
  const [s, n, d] = p.columns;
  assert.deepEqual([s.kind, s.distinct, s.nullPct, s.min, s.max], ['nominal', 2, 25, 'a', 'b']);
  assert.deepEqual(s.topValues, [{ value: 'a', count: 2 }, { value: 'b', count: 1 }]);
  assert.deepEqual([n.kind, n.distinct, n.min, n.max, n.mean], ['quantitative', 3, 2, 10, 17 / 3]);
  assert.deepEqual([d.kind, d.nullPct, d.min, d.max], ['temporal', 25, '2025-01-01', '2025-01-03']);
  assert.deepEqual(profileFromResult(C, []).columns[1].nullPct, 0);
});

test('pageFromRows: pages, only the asked columns, sorted with nulls last in both directions and stable ties', () => {
  assert.deepEqual(pageFromRows(R, { offset: 1, limit: 2 }).map((r) => r.s), ['a', null]);
  assert.deepEqual(pageFromRows(R, { columns: ['n'], limit: 2 }), [{ n: 2 }, { n: 10 }]);
  assert.deepEqual(pageFromRows(R, { sort: { column: 'n', dir: 'asc' } }).map((r) => r.n), [2, 5, 10, null]);
  assert.deepEqual(pageFromRows(R, { sort: { column: 'n', dir: 'desc' } }).map((r) => r.n), [10, 5, 2, null]);
  assert.deepEqual(pageFromRows(R, { sort: { column: 's', dir: 'asc' } }).map((r) => r.n), [10, 5, 2, null], 'ties (a, a) keep result order');
  assert.deepEqual(pageFromRows(R, { offset: 10 }), []);
  const same = pageFromRows(R, { sort: { column: 'n', dir: 'asc' } });
  assert.deepEqual(pageFromRows(R, { sort: { column: 'n', dir: 'asc' } }), same, 'repeatable (cached order)');
});
