// Chart styling, kept apart from the DOM so it can be unit tested (tests/chartstyle.test.mjs).
//   vegaConfig(getVar)            Vega-Lite `config` from the design tokens (CSS custom properties)
//   prepareSpec(spec, rows, opts) the spec the card actually renders: data, size, config, single hue, thinned time axes
// Rules applied by prepareSpec (without touching the spec the agents produced):
//   * Colour only says something when it encodes a field that is not already on an axis. A bar / point chart whose
//     colour is the same field as x or y (rainbow bars, one per category) gets one colour from the theme instead.
//   * Time axes get a tick count that fits the chart width (about one label per 90px, 3 to 8), so weekly ticks don't crowd.

const POSITIONAL = ['x', 'y'];
const TICK_PX = 90;

/** Read a CSS custom property from the page (the default `getVar` of vegaConfig / prepareSpec). */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function vegaConfig(getVar = cssVar) {
  const v = (n) => getVar(n) || '';
  const font = v('--font-sans') || 'system-ui, sans-serif';
  const series = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`)).filter(Boolean);
  const label = v('--text-2'), title = v('--text'), grid = v('--grid'), domain = v('--border-strong');
  return {
    background: 'transparent',
    font,
    padding: 4,
    view: { stroke: null },
    axis: {
      labelColor: label, titleColor: label, gridColor: grid, domainColor: domain, tickColor: domain,
      labelFont: font, titleFont: font, labelFontSize: 11, titleFontSize: 11, titleFontWeight: 500,
      labelPadding: 4, titlePadding: 8, labelOverlap: true, labelLimit: 140,
    },
    axisX: { grid: false },
    legend: { labelColor: label, titleColor: label, labelFont: font, titleFont: font, labelFontSize: 11, titleFontSize: 11, titleFontWeight: 500, symbolStrokeWidth: 2 },
    header: { labelColor: label, titleColor: label, labelFont: font, titleFont: font },
    title: { color: title, font, fontSize: 13, fontWeight: 600, anchor: 'start' },
    text: { color: label, font },
    range: { category: series },
    scale: { bandPaddingInner: 0.2, bandPaddingOuter: 0.1 },
    mark: { color: series[0] },
    bar: { color: series[0] }, // no cornerRadiusEnd: it collapses x/x2 (binned) bars in vega-lite 5.21
    line: { color: series[0], strokeWidth: 2 },
    area: { color: series[0], opacity: 0.85 },
    point: { color: series[0], size: 40, filled: true },
    circle: { color: series[0] },
    rect: { color: series[0] },
    arc: { stroke: v('--surface') },
  };
}

export function mergeDeep(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? mergeDeep(a[k], v) : v;
  }
  return out;
}

const markType = (m) => (typeof m === 'string' ? m : m?.type);
const SINGLE_HUE_MARKS = new Set(['bar', 'point', 'circle', 'square', 'tick', 'rule', 'text']);

/** Visit every unit (a node with a mark) of a Vega-Lite spec with its effective encoding (own over inherited). */
function eachUnit(node, fn, inherited = {}) {
  if (!node || typeof node !== 'object') return;
  const enc = { ...inherited, ...(node.encoding || {}) };
  if (node.mark) fn(node, enc);
  for (const key of ['layer', 'hconcat', 'vconcat', 'concat']) {
    if (Array.isArray(node[key])) for (const child of node[key]) eachUnit(child, fn, node.mark ? {} : enc);
  }
  if (node.spec) eachUnit(node.spec, fn, enc);
}

const fieldOf = (e) => (e && typeof e === 'object' && !Array.isArray(e) ? e.field : undefined);

/**
 * Drop a colour encoding that only repeats a field already on an axis (or a facet). The theme colour applies instead.
 * Colour that encodes something else (a series, a stacked/grouped category, a measure) is kept. Mutates the spec it is given.
 */
export function singleHue(spec) {
  eachUnit(spec, (node, enc) => {
    const color = enc.color;
    const f = fieldOf(color);
    if (!f || !SINGLE_HUE_MARKS.has(markType(node.mark))) return;
    if (color.type && !['nominal', 'ordinal'].includes(color.type)) return;
    const onAxis = POSITIONAL.some((ch) => fieldOf(enc[ch]) === f) || [spec.facet?.field, spec.facet?.row?.field, spec.facet?.column?.field].includes(f);
    if (!onAxis || !node.encoding?.color) return; // an inherited colour is removed where it is defined
    delete node.encoding.color;
  });
  // a colour defined on a parent of layers
  if (spec.encoding?.color && spec.layer) {
    const f = fieldOf(spec.encoding.color);
    if (f && POSITIONAL.some((ch) => fieldOf(spec.encoding[ch]) === f) && ['bar', 'point', 'circle', 'square', 'tick'].some((m) => spec.layer.some((l) => markType(l.mark) === m))) delete spec.encoding.color;
  }
  return spec;
}

/** Number of time ticks for a chart `width` px wide: about one label per 90px, between 3 and 8 (6 when the width is unknown). */
export function tickCountFor(width) {
  if (!Number.isFinite(width) || width <= 0) return 6;
  return Math.max(3, Math.min(8, Math.floor(width / TICK_PX)));
}

/** Thin temporal axes: set a tick count (unless the spec has one) and drop labels that would still collide. Mutates the spec. */
export function thinTimeAxes(spec, width) {
  const count = tickCountFor(width);
  eachUnit(spec, (node) => {
    for (const ch of POSITIONAL) {
      const e = node.encoding?.[ch];
      if (!e || typeof e !== 'object' || e.type !== 'temporal' || e.axis === null) continue;
      const axis = { ...(e.axis || {}) };
      if (axis.tickCount == null && axis.values == null) axis.tickCount = count;
      if (axis.labelOverlap == null) axis.labelOverlap = 'greedy';
      e.axis = axis;
    }
  });
  return spec;
}

/**
 * The spec a card renders: data, responsive size, theme config, single hue, thinned time ticks.
 * opts: { getVar, width } (width = the chart's pixel width, for tick thinning).
 */
export function prepareSpec(spec, rows, opts = {}) {
  const s = JSON.parse(JSON.stringify({ ...spec, data: undefined, datasets: undefined })); // a copy: the card's own spec stays as the agent made it
  delete s.data; delete s.datasets;
  s.data = { values: rows };
  const unit = s.mark || s.layer;
  if (unit) {
    if (s.width == null) s.width = 'container';
    if (s.height == null) s.height = 240;
    if (!s.autosize) s.autosize = { type: 'fit', contains: 'padding' };
  }
  singleHue(s);
  thinTimeAxes(s, opts.width);
  s.config = mergeDeep(vegaConfig(opts.getVar || cssVar), spec.config || {});
  delete s.title; // the card renders its own title
  if (!s.$schema) s.$schema = 'https://vega.github.io/schema/vega-lite/v5.json';
  return s;
}
