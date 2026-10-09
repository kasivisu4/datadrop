import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferLayout, normalizeLayout, orderCards, LAYOUT_PROMPT, SECTIONS } from '../src/agents/layout.js';

const enc = (encoding, mark = 'bar') => ({ mark, encoding });

test('inferLayout: section and size from the spec', () => {
  assert.deepEqual(inferLayout(enc({ x: { field: 'd', type: 'temporal' }, y: { field: 'v', type: 'quantitative' } }, 'line')), { section: 'trends', size: 'l', priority: 1 });
  assert.equal(inferLayout(enc({ y: { field: 'k', type: 'nominal' }, x: { field: 'n', type: 'quantitative' } })).section, 'breakdowns');
  assert.equal(inferLayout(enc({ x: { field: 'a', type: 'quantitative', bin: { binned: true } }, x2: { field: 'b' }, y: { field: 'n', type: 'quantitative' } })).section, 'distributions');
  assert.equal(inferLayout(enc({ x: { field: 'a', type: 'quantitative', bin: { binned: true } }, x2: { field: 'b' }, y: { field: 'c', type: 'quantitative', bin: { binned: true } }, y2: { field: 'd' } }, 'rect')).section, 'relationships');
  assert.equal(inferLayout(enc({ x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } }, 'point')).section, 'relationships');
  assert.deepEqual(inferLayout(enc({ text: { field: 'n', type: 'quantitative' } }, 'text')), { section: 'overview', size: 's', priority: 1 });
  assert.equal(inferLayout(null).section, 'details');
});

test('normalizeLayout: keeps valid LLM hints, repairs bad ones from the spec', () => {
  const line = enc({ x: { field: 'd', type: 'temporal' } }, 'line');
  assert.deepEqual(normalizeLayout({ section: 'overview', size: 's', priority: 1 }, line), { section: 'overview', size: 's', priority: 1 });
  assert.deepEqual(normalizeLayout({ section: 'nonsense', size: 'xl', priority: 99 }, line), { section: 'trends', size: 'l', priority: 9 });
  assert.deepEqual(normalizeLayout(undefined, line), inferLayout(line));
});

test('orderCards: answers and pinned first, then section order, then priority; stable', () => {
  const c = (id, section, priority, extra = {}) => ({ id, layout: { section, size: 'm', priority }, ...extra });
  const order = orderCards([
    c('dist', 'distributions', 1), c('trend2', 'trends', 2), c('trend1', 'trends', 1),
    c('ans', 'details', 5, { asked: true }), c('pin', 'relationships', 3, { pinned: true }), c('brk', 'breakdowns', 1),
  ]).map((x) => x.id);
  assert.deepEqual(order, ['ans', 'pin', 'trend1', 'trend2', 'brk', 'dist']);
});

test('LAYOUT_PROMPT names every section', () => {
  for (const s of SECTIONS) assert.ok(LAYOUT_PROMPT.includes(`"${s}"`), s);
});
