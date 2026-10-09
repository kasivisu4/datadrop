import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, DEFAULT_MODE, isMode, suggestMode, loadPrefs, savePrefs, parseShare, buildShareLink } from '../src/data/modes.js';

const col = (name, type, kind, extra = {}) => ({ name, type, kind, ...extra });
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };

test('three views, each with a clear job; Review opens on the data', () => {
  assert.deepEqual(Object.keys(MODES), ['overview', 'explore', 'review']);
  assert.equal(DEFAULT_MODE, 'overview');
  assert.equal(MODES.review.tab, 'data');
  assert.equal(MODES.overview.tab, 'charts');
  assert.equal(MODES.overview.rail, false);
  assert.equal(MODES.explore.density, 'compact');
  assert.equal(MODES.explore.explain, true, 'analysts get "how this was calculated" open');
  for (const m of Object.values(MODES)) assert.ok(m.label && m.hint);
  assert.equal(isMode('review'), true);
  assert.equal(isMode('toString'), false, 'not a prototype key');
  assert.equal(isMode('nope'), false);
});

test('suggestMode: transactions (additive money + a status or an account) -> review; prices, balances and plain measures -> nothing', () => {
  const bank = { columns: [col('txn_id', 'VARCHAR', 'nominal'), col('account_number', 'BIGINT', 'quantitative'), col('amount', 'DOUBLE', 'quantitative'), col('status', 'VARCHAR', 'nominal')] };
  assert.equal(suggestMode(bank), 'review');
  assert.equal(suggestMode({ columns: [col('amount', 'DOUBLE', 'quantitative'), col('status', 'VARCHAR', 'nominal')] }), 'review');
  assert.equal(suggestMode({ columns: [col('amount', 'DOUBLE', 'quantitative'), col('iban', 'VARCHAR', 'nominal')] }), 'review');
  assert.equal(suggestMode({ columns: [col('amount', 'DOUBLE', 'quantitative'), col('day', 'DATE', 'temporal')] }), null, 'money and a date alone is any time series');
  assert.equal(suggestMode({ columns: [col('Close', 'DOUBLE', 'quantitative'), col('Date', 'DATE', 'temporal'), col('Sector', 'VARCHAR', 'nominal')] }), null, 'a stock file is not a ledger');
  assert.equal(suggestMode({ columns: [col('balance', 'DOUBLE', 'quantitative'), col('status', 'VARCHAR', 'nominal')] }), null, 'a balance is a level');
  assert.equal(suggestMode({ columns: [col('amount', 'BIGINT', 'quantitative'), col('status', 'VARCHAR', 'nominal')] }), null, 'whole-number "amounts" are usually counts');
  assert.equal(suggestMode({ columns: [col('amount', 'DOUBLE', 'quantitative'), col('id', 'BIGINT', 'quantitative')] }), null, 'a bare row id is not an account');
  assert.equal(suggestMode(null), null);
  assert.equal(suggestMode({ columns: [] }), null);
});

test('prefs: the saved view and dismissed suggestions, safe against bad storage', () => {
  const s = mem();
  assert.deepEqual(loadPrefs(s), { mode: 'overview', dismissed: {} });
  assert.equal(savePrefs(s, { mode: 'review', dismissed: { abc: true } }), true);
  assert.deepEqual(loadPrefs(s), { mode: 'review', dismissed: { abc: true } });
  s.setItem('datadrop.view.v1', JSON.stringify({ mode: 'bogus', dismissed: 'x' }));
  assert.deepEqual(loadPrefs(s), { mode: 'overview', dismissed: {} });
  assert.deepEqual(loadPrefs({ getItem: () => '{not json' }), { mode: 'overview', dismissed: {} });
  assert.deepEqual(loadPrefs(null), { mode: 'overview', dismissed: {} });
  assert.equal(savePrefs(null, { mode: 'review' }), false);
});

test('parseShare: only valid view and tab values survive', () => {
  assert.deepEqual(parseShare('?url=https%3A%2F%2Fx.org%2Fa.csv&view=review&tab=data'), { url: 'https://x.org/a.csv', view: 'review', tab: 'data' });
  assert.deepEqual(parseShare('?url=a&view=evil&tab=<script>'), { url: 'a', view: undefined, tab: undefined });
  assert.deepEqual(parseShare(''), { url: undefined, view: undefined, tab: undefined });
  assert.equal(parseShare('view=explore').view, 'explore');
});

test('buildShareLink: dataset + view (+ tab only when it differs from the view\'s own); never for local files', () => {
  const base = { origin: 'https://datadrop.example', pathname: '/app/', url: 'https://x.org/a b.csv' };
  assert.equal(buildShareLink({ ...base, view: 'review', tab: 'data' }), 'https://datadrop.example/app/?url=https%3A%2F%2Fx.org%2Fa+b.csv&view=review');
  assert.equal(buildShareLink({ ...base, view: 'review', tab: 'sql' }), 'https://datadrop.example/app/?url=https%3A%2F%2Fx.org%2Fa+b.csv&view=review&tab=sql');
  assert.equal(buildShareLink({ ...base, view: 'overview', tab: 'charts' }), 'https://datadrop.example/app/?url=https%3A%2F%2Fx.org%2Fa+b.csv&view=overview');
  assert.equal(buildShareLink({ ...base, url: 's3://b/k.parquet', view: 'explore' }).includes('s3%3A%2F%2Fb%2Fk.parquet'), true);
  assert.equal(buildShareLink({ ...base, url: null, view: 'review' }), null, 'a local file has no link');
  assert.equal(buildShareLink({ ...base, url: 'javascript:alert(1)', view: 'review' }), null);
  assert.equal(buildShareLink({ ...base, url: 'file:///c/x.csv' }), null);
  const round = parseShare(new URL(buildShareLink({ ...base, view: 'explore', tab: 'sql' })).search);
  assert.deepEqual(round, { url: base.url, view: 'explore', tab: 'sql' }, 'what we build, we can read');
});
