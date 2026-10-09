import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateSample, readMemorySignals, memoryTier, cacheDecision, memoryBudgetMB, MEMORY_EXPANSION, DOWNLOAD_OVERHEAD } from '../src/data/memory.js';

test('estimateSample: compressed bytes/row × rows × read overhead, × expansion for memory', () => {
  // the chutes sample: 72 MB of compressed column chunks over 5,007,360 rows -> ~105 MB read, ~735 MB memory
  const cols = [{ bytesPerRow: 7 }, { bytesPerRow: 7.37 }, { bytesPerRow: null }];
  const e = estimateSample({ rowCount: 5_007_360, columns: cols });
  assert.equal(Math.round(e.downloadMB / DOWNLOAD_OVERHEAD), 72);
  assert.ok(Math.abs(e.downloadMB - 105) < 2, String(e.downloadMB));
  assert.equal(Math.round(e.memoryMB), Math.round(e.downloadMB * MEMORY_EXPANSION));
  assert.deepEqual(estimateSample(null), { downloadMB: 0, memoryMB: 0 });
});

test('estimateSample(profile, columns): only the working set columns; memoryBudgetMB per device', () => {
  const p = { rowCount: 1e6, columns: [{ name: 'a', bytesPerRow: 1 }, { name: 'b', bytesPerRow: 3 }] };
  assert.equal(Math.round(estimateSample(p, ['a']).downloadMB * 100) / 100, 1.45);
  assert.equal(Math.round(estimateSample(p).downloadMB * 100) / 100, 5.8);
  assert.equal(memoryBudgetMB({ deviceMemoryGB: 8 }), 2000, 'WASM ceiling');
  assert.equal(Math.round(memoryBudgetMB({ deviceMemoryGB: 4 })), 1229);
  assert.equal(Math.round(memoryBudgetMB({ deviceMemoryGB: 4, mobile: true })), 614);
  assert.equal(memoryBudgetMB({}), 1500);
  assert.equal(memoryBudgetMB({ mobile: true }), 300);
});

test('memoryTier: shares of device RAM, halved on mobile; WASM ceiling; no-signal fallbacks', () => {
  assert.equal(memoryTier(740, { deviceMemoryGB: 8 }), 'green');           // 9% of 8 GB
  assert.equal(memoryTier(740, { deviceMemoryGB: 4 }), 'yellow');          // 18% of 4 GB
  assert.equal(memoryTier(740, { deviceMemoryGB: 2 }), 'red');             // 36% of 2 GB
  assert.equal(memoryTier(740, { deviceMemoryGB: 8, mobile: true }), 'yellow');
  assert.equal(memoryTier(740, { deviceMemoryGB: 4, mobile: true }), 'red');
  assert.equal(memoryTier(2500, { deviceMemoryGB: 8 }), 'red', '32-bit WASM ceiling');
  assert.equal(memoryTier(740, {}), 'yellow', 'desktop without a signal: ask');
  assert.equal(memoryTier(740, { mobile: true }), 'red', 'mobile without a signal: light');
  assert.equal(memoryTier(200, { mobile: true }), 'yellow');
  assert.equal(memoryTier(0, {}), 'green');
});

test('cacheDecision: preference vs tier; "fast" never overrides red', () => {
  assert.deepEqual(cacheDecision('green', 'ask'), { action: 'auto' });
  assert.deepEqual(cacheDecision('yellow', 'ask'), { action: 'ask' });
  assert.deepEqual(cacheDecision('yellow', 'fast'), { action: 'auto' });
  assert.deepEqual(cacheDecision('red', 'fast'), { action: 'light', reason: 'memory' });
  assert.deepEqual(cacheDecision('green', 'light'), { action: 'light', reason: 'preference' });
});

test('readMemorySignals: Chromium signals, fallbacks, test override', () => {
  const chrome = { navigator: { deviceMemory: 8, userAgentData: { mobile: false } }, performance: { memory: { jsHeapSizeLimit: 4294705152 } } };
  assert.deepEqual(readMemorySignals(chrome), { deviceMemoryGB: 8, heapLimitMB: 4095.75, mobile: false });
  const safariPhone = { navigator: {}, performance: {}, matchMedia: (q) => ({ matches: q.includes('coarse') }) };
  assert.deepEqual(readMemorySignals(safariPhone), { deviceMemoryGB: null, heapLimitMB: null, mobile: true });
  assert.deepEqual(readMemorySignals({ __memorySignals: { deviceMemoryGB: 2, mobile: false } }), { deviceMemoryGB: 2, mobile: false });
});
