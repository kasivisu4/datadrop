import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIdName, isRowKeyName, isIdLike, aggregateFor, measureRank, STATUS_NAME } from '../src/data/roles.js';

const col = (name, extra = {}) => ({ name, type: 'DOUBLE', kind: 'quantitative', ...extra });

test('isIdName: identifiers by name, including account/card/reference numbers stored as numbers', () => {
  for (const n of ['id', 'user_id', 'txn_id', 'uuid', 'account_number', 'account_no', 'acct', 'card_number', 'iban', 'reference', 'ref_no', 'zip_code', 'phone', 'index', 'Unnamed: 0']) {
    assert.equal(isIdName({ name: n }), true, n);
  }
  for (const n of ['amount', 'balance', 'merchant', 'account_balance', 'accounting', 'status', 'created_at', 'paid']) {
    assert.equal(isIdName({ name: n }), false, n);
  }
});

test('isRowKeyName: only keys that differ on every row by design', () => {
  assert.equal(isRowKeyName({ name: 'id' }), true);
  assert.equal(isRowKeyName({ name: 'uuid' }), true);
  assert.equal(isRowKeyName({ name: 'account_number' }), false, 'a few accounts is a useful breakdown');
});

test('isIdLike: by name, or an integer column that is unique per row', () => {
  assert.equal(isIdLike(col('account_number', { type: 'BIGINT' }), 50000), true);
  assert.equal(isIdLike(col('n', { type: 'BIGINT', distinct: 1000, min: 1, max: 1000 }), 1000), true);
  assert.equal(isIdLike(col('n', { type: 'BIGINT', distinct: 30, min: 1, max: 1000 }), 1000), false);
  assert.equal(isIdLike(col('amount', { distinct: 1000, min: 1.5, max: 9 }), 1000), false, 'fractional values are never ids');
});

test('aggregateFor: sum amounts and counts, average levels (balances, prices, rates)', () => {
  for (const n of ['amount', 'revenue', 'quantity', 'fee', 'debit']) assert.equal(aggregateFor({ name: n }), 'SUM', n);
  for (const n of ['balance', 'price', 'Close', 'interest_rate', 'age', 'temperature']) assert.equal(aggregateFor({ name: n }), 'AVG', n);
});

test('measureRank: additive money first, other additive next, levels last', () => {
  const names = ['balance', 'quantity', 'amount'];
  assert.deepEqual([...names].sort((a, b) => measureRank({ name: a }) - measureRank({ name: b })), ['amount', 'quantity', 'balance']);
});

test('STATUS_NAME', () => {
  for (const n of ['status', 'payment_type', 'category', 'channel', 'tx_state']) assert.equal(STATUS_NAME.test(n), true, n);
  for (const n of ['amount', 'merchant', 'currency']) assert.equal(STATUS_NAME.test(n), false, n);
});
