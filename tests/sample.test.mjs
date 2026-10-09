import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withStarts, pickRowGroups, rowRanges, sliceRanges } from '../src/data/sample.js';

const groups = withStarts(Array.from({ length: 100 }, (_, id) => ({ id, rows: 1000 }))); // 100k rows

test('withStarts adds cumulative row offsets', () => {
  assert.deepEqual(withStarts([{ id: 0, rows: 5 }, { id: 1, rows: 3 }, { id: 2, rows: 4 }]).map((g) => g.start), [0, 5, 8]);
});

test('spread: evenly spaced whole groups covering about `rows`', () => {
  const p = pickRowGroups(groups, { mode: 'spread', rows: 5000 });
  assert.deepEqual(p.map((g) => g.id), [10, 30, 50, 70, 90]);
  assert.equal(rowRanges(p).length, 5, 'separate windows');
});

test('window: consecutive groups from the one holding `offset`; clamps at the end', () => {
  assert.deepEqual(pickRowGroups(groups, { mode: 'window', rows: 3000, offset: 0 }).map((g) => g.id), [0, 1, 2]);
  assert.deepEqual(pickRowGroups(groups, { mode: 'window', rows: 3000, offset: 3500 }).map((g) => g.id), [3, 4, 5]);
  assert.deepEqual(pickRowGroups(groups, { mode: 'window', rows: 3000, offset: 99_500 }).map((g) => g.id), [97, 98, 99]);
  assert.deepEqual(pickRowGroups(groups, { mode: 'window', rows: 3000, offset: 1e9 }).map((g) => g.id), [97, 98, 99]);
  assert.deepEqual(rowRanges(pickRowGroups(groups, { mode: 'window', rows: 3000, offset: 3500 })), [[3000, 6000]], 'neighbours merge');
});

test('at least one group; never more than the file has', () => {
  assert.equal(pickRowGroups(groups, { rows: 1 }).length, 1);
  assert.equal(pickRowGroups(groups, { rows: 1e9 }).length, 100);
  assert.deepEqual(pickRowGroups([], { rows: 10 }), []);
});

test('sliceRanges: the file rows behind a page of the sample', () => {
  const ranges = [[0, 100], [500, 600], [900, 1000]]; // a 300-row sample from three places in the file
  assert.deepEqual(sliceRanges(ranges, 0, 50), [[0, 50]]);
  assert.deepEqual(sliceRanges(ranges, 90, 30), [[90, 100], [500, 520]], 'a page across two ranges');
  assert.deepEqual(sliceRanges(ranges, 100, 100), [[500, 600]]);
  assert.deepEqual(sliceRanges(ranges, 190, 200), [[590, 600], [900, 1000]], 'the last page is cut short at the end of the sample');
  assert.deepEqual(sliceRanges(ranges, 300, 10), [], 'past the end');
  assert.deepEqual(sliceRanges([], 0, 10), []);
  assert.deepEqual(sliceRanges([[10, 20]], 3, 4), [[13, 17]]);
  const n = sliceRanges(ranges, 0, 300).reduce((s, [a, b]) => s + b - a, 0);
  assert.equal(n, 300, 'the whole sample is covered exactly once');
});
