// Chart styling rules (src/ui/chartstyle.js) and the CSV export (src/ui/csv.js): pure, no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSpec, singleHue, thinTimeAxes, tickCountFor, vegaConfig } from '../src/ui/chartstyle.js';
import { toCSV, csvFileName } from '../src/ui/csv.js';

const VARS = { '--series-1': '#2a78d6', '--series-2': '#eb6834', '--text': '#111', '--text-2': '#555', '--grid': '#eee', '--border-strong': '#ccc', '--surface': '#fff', '--font-sans': 'sans-serif' };
const getVar = (n) => VARS[n] || '';
const prep = (spec, opts = {}) => prepareSpec(spec, [{ a: 1 }], { getVar, ...opts });

const rainbowBars = () => ({
  mark: 'bar',
  encoding: { y: { field: 'Sector', type: 'nominal' }, x: { field: 'total', type: 'quantitative' }, color: { field: 'Sector', type: 'nominal', legend: null } },
});

test('single hue: colour that only repeats an axis is dropped', () => {
  const s = prep(rainbowBars());
  assert.equal(s.encoding.color, undefined);
  assert.equal(s.config.bar.color, '#2a78d6', 'the theme colour applies');
  assert.equal(prep({ mark: 'point', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } } }).encoding.color, undefined);
});

test('single hue: colour that encodes another field is kept (stacked / grouped series, a measure, pie slices)', () => {
  const stacked = { mark: 'bar', encoding: { x: { field: 'month', type: 'ordinal' }, y: { field: 'n', type: 'quantitative' }, color: { field: 'region', type: 'nominal' } } };
  assert.deepEqual(prep(stacked).encoding.color, { field: 'region', type: 'nominal' });
  const heat = { mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' }, color: { field: 'b', type: 'quantitative' } } };
  assert.ok(prep(heat).encoding.color, 'a quantitative colour on y is a measure, not a repeated category');
  const pie = { mark: 'arc', encoding: { theta: { field: 'n', type: 'quantitative' }, color: { field: 'region', type: 'nominal' } } };
  assert.ok(prep(pie).encoding.color, 'slices need colour: the category is on no axis');
  const lines = { mark: 'line', encoding: { x: { field: 'd', type: 'temporal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'series', type: 'nominal' } } };
  assert.ok(prep(lines).encoding.color, 'one line per series');
});

test('single hue: layered specs and the spec the agent made is not mutated', () => {
  const layered = { layer: [{ mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'k', type: 'nominal' } } }, { mark: 'rule', encoding: { y: { datum: 3 } } }] };
  const copy = JSON.stringify(layered);
  const s = prep(layered);
  assert.equal(s.layer[0].encoding.color, undefined);
  assert.equal(JSON.stringify(layered), copy, 'input untouched');
  const parent = { encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'k', type: 'nominal' } }, layer: [{ mark: 'bar' }] };
  assert.equal(singleHue(structuredClone(parent)).encoding.color, undefined, 'colour defined on the parent of layers');
});

test('time axes: tick count fits the width (about one label per 90px, 3 to 8)', () => {
  assert.equal(tickCountFor(360), 4);
  assert.equal(tickCountFor(720), 8);
  assert.equal(tickCountFor(1600), 8, 'never more than 8');
  assert.equal(tickCountFor(100), 3, 'never fewer than 3');
  assert.equal(tickCountFor(0), 6, 'unknown width');
  assert.equal(tickCountFor(NaN), 6);
  const s = prep({ mark: 'line', encoding: { x: { field: 'd', type: 'temporal' }, y: { field: 'v', type: 'quantitative' } } }, { width: 540 });
  assert.equal(s.encoding.x.axis.tickCount, 6);
  assert.equal(s.encoding.x.axis.labelOverlap, 'greedy');
  assert.equal(s.encoding.y.axis, undefined, 'only time axes');
});

test('time axes: an explicit tickCount / values / hidden axis is respected', () => {
  const t = (axis) => thinTimeAxes({ mark: 'bar', encoding: { x: { field: 'd', type: 'temporal', axis } } }, 700).encoding.x.axis;
  assert.equal(t({ tickCount: 12 }).tickCount, 12);
  assert.equal(t({ values: [1, 2] }).tickCount, undefined);
  assert.equal(t(null), null);
});

test('prepareSpec: data, responsive size, theme config, no title', () => {
  const s = prep({ mark: 'bar', title: 'x', data: { url: 'nope' }, encoding: {} });
  assert.deepEqual(s.data, { values: [{ a: 1 }] });
  assert.equal(s.width, 'container');
  assert.equal(s.height, 240);
  assert.equal(s.title, undefined);
  assert.equal(s.config.axis.labelColor, '#555');
  assert.deepEqual(vegaConfig(getVar).range.category, ['#2a78d6', '#eb6834']);
  const own = prep({ mark: 'bar', config: { bar: { color: 'red' } } });
  assert.equal(own.config.bar.color, 'red', 'the spec\'s own config wins');
});

test('toCSV: header, quoting, nulls, nested values', () => {
  const rows = [{ a: 1, b: 'x,y', c: null }, { a: 2, b: 'say "hi"', c: { k: 1 } }, { a: 3, b: 'line\nbreak', c: 'z' }];
  assert.equal(toCSV(rows, [{ name: 'a' }, { name: 'b' }, { name: 'c' }]), 'a,b,c\r\n1,"x,y",\r\n2,"say ""hi""","{""k"":1}"\r\n3,"line\nbreak",z\r\n');
  assert.equal(toCSV([{ q: 1 }]), 'q\r\n1\r\n', 'columns default to the first row\'s keys');
  assert.equal(toCSV([], [{ name: 'a' }]), 'a\r\n');
});

test('csvFileName: from the card title', () => {
  assert.equal(csvFileName('Revenue by sector'), 'revenue-by-sector.csv');
  assert.equal(csvFileName('  Top 10: users / day!  '), 'top-10-users-day.csv');
  assert.equal(csvFileName(''), 'data.csv');
  assert.equal(csvFileName('日本語のタイトル'), '日本語のタイトル.csv');
});
