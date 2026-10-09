// Metric cards: your named definitions ("Net revenue" = SUM(amount) FILTER (WHERE status = 'completed')) with their current
// value, a small form to define or edit one, and one-click starting points. Definitions are saved in this browser per
// dataset (data/metrics.js) and fed to the AI's prompts and the SQL box, so a name always means the same expression.
import { h } from './dom.js';
import { validateMetric, metricSql, loadMetrics, saveMetrics, metricSuggestions, formatMetricValue } from '../data/metrics.js';

/**
 * run(sql, { signal }) -> Promise<{ rows }>; guard(sql) -> cleaned read-only SQL or throws;
 * onChange(metrics) is called with the saved list when a dataset loads and after every change.
 * Returns { el, setDataset({ profile, tableName } | null), setVisible(bool), list() }.
 */
export function createMetricsPanel({ run, guard, onChange, storage = globalThis.localStorage }) {
  let ds = null;
  let metrics = [];
  let values = new Map(); // name -> { state: 'idle' | 'loading' | 'ok' | 'error', value?, error? }
  let editing = null; // index being edited, or -1 for a new one
  let ctl = new AbortController();
  let visible = true;

  const row = h('div', { class: 'metrics-row' });
  const suggest = h('div', { class: 'metric-suggest' });
  const nameIn = h('input', { type: 'text', class: 'metric-name', maxlength: '60', placeholder: 'Net revenue', 'aria-label': 'Metric name', autocomplete: 'off' });
  const exprIn = h('input', { type: 'text', class: 'metric-expr', placeholder: 'SUM("amount") FILTER (WHERE "status" = \'completed\')', 'aria-label': 'Metric definition (a SQL aggregate)', autocomplete: 'off', spellcheck: 'false' });
  const preview = h('p', { class: 'metric-preview small', role: 'status', 'aria-live': 'polite' });
  const form = h('form', { class: 'metric-form', hidden: true, onsubmit: (e) => { e.preventDefault(); save(); } },
    suggest,
    h('label', null, h('span', null, 'Name'), nameIn),
    h('label', { class: 'metric-expr-label' }, h('span', null, 'Definition (one SQL aggregate over the table)'), exprIn),
    preview,
    h('div', { class: 'metric-form-actions' },
      h('button', { type: 'submit', class: 'btn primary tiny metric-save' }, 'Save'),
      h('button', { type: 'button', class: 'btn tiny metric-try', onclick: () => tryIt() }, 'Try it'),
      h('button', { type: 'button', class: 'btn tiny ghost', onclick: () => closeForm() }, 'Cancel')));
  const addBtn = h('button', { type: 'button', class: 'btn tiny ghost metric-add', title: 'Define a metric: a name for a number you care about', onclick: () => openForm(-1) }, '+ Metric');
  const el = h('section', { class: 'metrics', 'aria-label': 'Metrics', hidden: true },
    h('div', { class: 'metrics-head' },
      h('h2', null, 'Metrics'),
      h('span', { class: 'muted small' }, 'Your definitions. The AI and the SQL tab use them, so a name always means the same number.')),
    row, form);

  const remote = () => !!ds?.profile?.remote;
  // nothing takes room above the charts until there is a metric or the form is open
  const sync = () => { el.hidden = !ds || !visible || (!metrics.length && form.hidden); addBtn.hidden = !ds || !visible || metrics.length >= 12; };

  function render() {
    row.textContent = '';
    for (const [i, m] of metrics.entries()) {
      const v = values.get(m.name) || { state: 'idle' };
      const val = v.state === 'ok' ? h('span', { class: 'metric-value' }, formatMetricValue(v.value))
        : v.state === 'error' ? h('span', { class: 'metric-value err', title: v.error }, "Can't compute")
        : v.state === 'loading' ? h('span', { class: 'metric-value muted' }, '…')
        : h('button', { type: 'button', class: 'btn tiny metric-compute', onclick: () => compute(m) }, 'Compute');
      row.append(h('article', { class: 'metric', dataset: { name: m.name } },
        h('div', { class: 'metric-top' }, h('b', { class: 'metric-title' }, m.name),
          h('span', { class: 'metric-tools' },
            h('button', { type: 'button', class: 'metric-edit', 'aria-label': `Edit ${m.name}`, title: 'Edit', onclick: () => openForm(i) }, '✎'),
            h('button', { type: 'button', class: 'metric-del', 'aria-label': `Remove ${m.name}`, title: 'Remove', onclick: () => remove(i) }, '✕'))),
        val,
        h('code', { class: 'metric-def', title: m.expr }, m.expr)));
    }
    suggest.textContent = '';
    const have = new Set(metrics.map((m) => m.expr));
    const ideas = ds ? metricSuggestions(ds.profile).filter((s) => !have.has(s.expr)) : [];
    suggest.hidden = !ideas.length;
    if (!suggest.hidden) {
      suggest.append(h('span', { class: 'muted small' }, 'Start from:'),
        ...ideas.map((s) => h('button', { type: 'button', class: 'chip metric-idea', title: s.expr, onclick: () => { if (add(s)) closeForm(); } }, h('span', { class: 'chip-label' }, s.name))));
    }
    sync();
  }

  async function compute(m) {
    if (!ds) return;
    const signal = ctl.signal;
    values.set(m.name, { state: 'loading' });
    render();
    try {
      const res = await run(guard(metricSql(m, ds.tableName)), { signal });
      if (signal.aborted) return;
      values.set(m.name, { state: 'ok', value: res.rows[0]?.value ?? null });
    } catch (e) {
      if (signal.aborted || e?.name === 'AbortError') return;
      values.set(m.name, { state: 'error', error: String(e?.message || e) });
    }
    render();
  }
  const computeAll = () => { if (!remote()) metrics.forEach((m) => { compute(m); }); }; // a remote file is read only when asked

  function persist() {
    saveMetrics(storage, ds.profile, metrics);
    onChange?.(metrics.slice());
  }
  function add(m) {
    const v = validateMetric(m);
    if (v.error || metrics.some((x) => x.name.toLowerCase() === v.name.toLowerCase())) return false;
    metrics.push(v);
    persist();
    render();
    compute(v);
    return true;
  }
  function remove(i) {
    const [m] = metrics.splice(i, 1);
    values.delete(m.name);
    persist();
    render();
  }
  function openForm(i) {
    editing = i;
    nameIn.value = i >= 0 ? metrics[i].name : '';
    exprIn.value = i >= 0 ? metrics[i].expr : '';
    preview.textContent = '';
    preview.className = 'metric-preview small';
    form.hidden = false;
    render();
    nameIn.focus();
  }
  function closeForm() { form.hidden = true; editing = null; render(); }
  const setPreview = (text, level) => { preview.textContent = text; preview.className = `metric-preview small ${level}`; };

  async function tryIt() {
    const v = validateMetric({ name: nameIn.value || 'x', expr: exprIn.value });
    if (v.error) { setPreview(v.error, 'err'); return null; }
    setPreview('Trying it…', 'muted');
    try {
      const res = await run(guard(metricSql(v, ds.tableName)), { signal: ctl.signal });
      const value = res.rows[0]?.value ?? null;
      setPreview(`= ${formatMetricValue(value)}`, 'ok');
      return { value };
    } catch (e) {
      setPreview(String(e?.message || e).replace(/^Unsafe SQL: /, 'Only read-only expressions are allowed. ').split('\n')[0], 'err');
      return null;
    }
  }
  async function save() {
    const v = validateMetric({ name: nameIn.value, expr: exprIn.value });
    if (v.error) { setPreview(v.error, 'err'); return; }
    const dup = metrics.findIndex((x) => x.name.toLowerCase() === v.name.toLowerCase());
    if (dup >= 0 && dup !== editing) { setPreview(`A metric called "${metrics[dup].name}" already exists.`, 'err'); return; }
    const tried = await tryIt();
    if (!tried) return; // a definition that doesn't run is not saved
    if (editing >= 0) { values.delete(metrics[editing].name); metrics[editing] = v; } else metrics.push(v);
    persist();
    values.set(v.name, { state: 'ok', value: tried.value });
    closeForm();
    render();
  }

  return {
    el,
    addBtn, // placed in the tab row by the app
    list: () => metrics.slice(),
    setVisible(on) { visible = !!on; sync(); },
    setDataset(next) {
      ctl.abort();
      ctl = new AbortController();
      ds = next;
      values = new Map();
      closeForm();
      metrics = ds ? loadMetrics(storage, ds.profile) : [];
      render();
      if (ds) { onChange?.(metrics.slice()); computeAll(); }
    },
  };
}
