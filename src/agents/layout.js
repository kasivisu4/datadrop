// Dashboard layout model, shared by the heuristics, the AI planner (prompt + parsing) and the grid.
//
// Every chart carries layout = { section, size, priority }:
//   section   where it belongs in a dashboard read top to bottom: an overview first, then how things change
//             over time, then what they break down into, how values are spread, how measures relate, and details.
//   size      's' (narrow, e.g. a single number), 'm' (one grid column), 'l' (full width, e.g. a long time series)
//   priority  1 = most important; orders charts within a section.
// The grid renders sections in SECTIONS order, then by priority. Answers to questions and pinned charts stay on top.

export const SECTIONS = ['overview', 'trends', 'breakdowns', 'distributions', 'relationships', 'details'];
export const SIZES = ['s', 'm', 'l'];

/** One-line description of the model for LLM prompts. */
export const LAYOUT_PROMPT =
  'Give each chart a "layout": {"section": one of ' + SECTIONS.map((s) => `"${s}"`).join('|') +
  ', "size": "s"|"m"|"l", "priority": 1-9}. Sections read top to bottom: overview (headline numbers), trends (change over time), ' +
  'breakdowns (rankings / composition), distributions (spread of one measure), relationships (two measures), details (tables). ' +
  'Use size "l" for time series and wide charts, "s" for single numbers, "m" otherwise. Priority 1 is the chart a reader should see first.';

/** Guess a layout from a Vega-Lite spec, for charts that don't come with one. */
export function inferLayout(spec) {
  const enc = spec?.encoding || {};
  const mark = typeof spec?.mark === 'string' ? spec.mark : spec?.mark?.type;
  const t = (ch) => enc[ch]?.type;
  if (!spec) return { section: 'details', size: 'm', priority: 5 };
  if (mark === 'text' && !enc.x && !enc.y) return { section: 'overview', size: 's', priority: 1 };
  if (t('x') === 'temporal' || t('y') === 'temporal') return { section: 'trends', size: 'l', priority: 1 };
  if (enc.x?.bin || enc.y?.bin) {
    return t('x') === 'quantitative' && t('y') === 'quantitative' && enc.x2 && enc.y2
      ? { section: 'relationships', size: 'm', priority: 2 }
      : { section: 'distributions', size: 'm', priority: 2 };
  }
  if (t('x') === 'quantitative' && t('y') === 'quantitative') return { section: 'relationships', size: 'm', priority: 3 };
  if (t('x') === 'nominal' || t('y') === 'nominal' || t('x') === 'ordinal' || t('y') === 'ordinal') return { section: 'breakdowns', size: 'm', priority: 2 };
  return { section: 'details', size: 'm', priority: 5 };
}

/** Validate a layout from an LLM (or anywhere), filling gaps from the spec. */
export function normalizeLayout(layout, spec) {
  const guess = inferLayout(spec);
  if (!layout || typeof layout !== 'object') return guess;
  const p = Number(layout.priority);
  return {
    section: SECTIONS.includes(layout.section) ? layout.section : guess.section,
    size: SIZES.includes(layout.size) ? layout.size : guess.size,
    priority: Number.isFinite(p) ? Math.min(9, Math.max(1, Math.round(p))) : guess.priority,
  };
}

/** Grid order: answers and pinned charts first (in their current order), then by section, then priority. Stable. */
export function orderCards(cards) {
  const rank = (c) => (c.asked || c.pinned ? -1 : SECTIONS.indexOf(c.layout?.section ?? 'details'));
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || (a.c.asked || a.c.pinned ? 0 : (a.c.layout?.priority ?? 5) - (b.c.layout?.priority ?? 5)) || a.i - b.i)
    .map(({ c }) => c);
}
