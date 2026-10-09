// The SQL tab: write a read-only query over the loaded table, see the result in the same grid as the Data tab
// (sort, pin, resize, record view). Runs through the same engine and guard as the AI's queries.
import { h } from './dom.js';
import { createExplorer } from './explorer.js';
import { profileFromResult, pageFromRows } from './gridmodel.js';
import { sqlExamples } from '../data/sqlexamples.js';

export const MAX_RESULT_ROWS = 100000;
const HISTORY_KEY = 'datadrop.sqlhistory.v1';
const HISTORY_MAX = 15;

function readHistory() {
  try { const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function writeHistory(list) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ } }

/**
 * run(sql, { signal }) -> Promise<{ columns, rows }> (at most MAX_RESULT_ROWS + 1 rows, so "cut off" can be told);
 * guard(sql) -> the cleaned read-only SQL, or throws; copyText(text) -> Promise<boolean>; toCSV(rows, columns) -> string.
 * Returns { el, setDataset({ profile, tableName } | null), activate(bool), setSql(text), run() }.
 */
export function createSqlBox({ run, guard, copyText, toCSV }) {
  let ds = null;
  let active = false;
  let result = null; // { columns, rows, truncated, ms, sql }
  let ctl = null;
  let history = readHistory();

  const input = h('textarea', {
    class: 'sql-input', rows: '6', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
    'aria-label': 'SQL query', placeholder: 'SELECT … FROM "table" LIMIT 100',
    onkeydown: (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doRun(); } },
  });
  const runBtn = h('button', { type: 'button', class: 'btn primary sql-run', onclick: () => doRun(), title: 'Run (Ctrl or ⌘ + Enter)' }, 'Run');
  const cancelBtn = h('button', { type: 'button', class: 'btn sql-cancel', hidden: true, onclick: () => ctl?.abort() }, 'Cancel');
  const examples = h('select', { class: 'sql-examples', 'aria-label': 'Example queries', onchange: () => { const i = Number(examples.value); if (examples.value !== '') setSql(allExamples()[i].sql); examples.value = ''; } });
  const historySel = h('select', { class: 'sql-history', 'aria-label': 'Earlier queries', onchange: () => {
    if (historySel.value === 'clear') { history = []; writeHistory(history); drawHistory(); return; }
    if (historySel.value !== '') setSql(history[Number(historySel.value)]);
    historySel.value = '';
  } });
  const tableChip = h('button', { type: 'button', class: 'sql-table-chip', title: 'Insert the table name at the cursor', onclick: () => insertAtCursor(`"${ds?.tableName || ''}"`) });
  const status = h('p', { class: 'sql-status muted small', role: 'status', 'aria-live': 'polite' });
  const err = h('pre', { class: 'sql-error', role: 'alert', hidden: true });
  const csvBtn = h('button', { type: 'button', class: 'btn tiny', hidden: true, onclick: () => download() }, 'Download CSV');
  const copyBtn = h('button', { type: 'button', class: 'btn tiny', onclick: async () => { copyBtn.textContent = (await copyText(input.value)) ? 'Copied' : 'Copy failed'; setTimeout(() => { copyBtn.textContent = 'Copy SQL'; }, 1400); } }, 'Copy SQL');
  // the results grid is built on the first result, so a page that never runs SQL carries no second grid
  let grid = null;
  const ensureGrid = () => {
    if (!grid) {
      grid = createExplorer({ fetchPage: async (_table, o) => ({ rows: pageFromRows(result?.rows || [], o) }), copyText });
      el.append(grid.el);
    }
    return grid;
  };
  const empty = h('p', { class: 'sql-empty muted small pad' }, 'Write a query and press Run. Results open in the same grid as the Data tab.');
  const el = h('section', { class: 'sqlbox', 'aria-label': 'SQL', hidden: true },
    h('div', { class: 'sql-bar' }, h('span', { class: 'muted small' }, 'Table'), tableChip, examples, historySel),
    input,
    h('div', { class: 'sql-actions' }, runBtn, cancelBtn, copyBtn, csvBtn, status),
    err, empty);

  let examplesList = [];
  let metricList = [];
  const allExamples = () => [...examplesList, ...metricList.map((m) => ({ label: `Metric: ${m.name}`, sql: `SELECT ${m.expr} AS "${m.name.replace(/"/g, '""')}" FROM "${(ds?.tableName || '').replace(/"/g, '""')}"` }))];
  function drawExamples() {
    examples.textContent = '';
    examples.append(h('option', { value: '' }, 'Examples…'), ...allExamples().map((x, i) => h('option', { value: String(i) }, x.label)));
  }
  function drawHistory() {
    historySel.textContent = '';
    historySel.hidden = !history.length;
    if (!history.length) return;
    historySel.append(h('option', { value: '' }, 'Earlier…'), ...history.map((s, i) => h('option', { value: String(i) }, s.replace(/\s+/g, ' ').slice(0, 70))), h('option', { value: 'clear' }, 'Clear history'));
  }
  function insertAtCursor(text) {
    const a = input.selectionStart ?? input.value.length;
    const b = input.selectionEnd ?? a;
    input.setRangeText(text, a, b, 'end');
    input.focus();
  }
  function setSql(text) { input.value = text; input.focus(); }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([toCSV(result.rows, result.columns)], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: 'sql_result.csv' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function showError(msg) {
    err.textContent = msg;
    err.hidden = false;
  }

  async function doRun() {
    if (!ds || ctl) return;
    err.hidden = true;
    let sql;
    try { sql = guard(input.value); } catch (e) {
      showError(String(e.message || e).replace(/^Unsafe SQL: /, 'Only read-only queries (SELECT or WITH) are allowed here. '));
      return;
    }
    ctl = new AbortController();
    runBtn.disabled = true;
    cancelBtn.hidden = false;
    const t0 = performance.now();
    const timer = setInterval(() => { status.textContent = `Running… ${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 200);
    status.textContent = 'Running…';
    try {
      const res = await run(sql, { signal: ctl.signal });
      const truncated = res.rows.length > MAX_RESULT_ROWS;
      const rows = truncated ? res.rows.slice(0, MAX_RESULT_ROWS) : res.rows;
      result = { columns: res.columns, rows, truncated, ms: performance.now() - t0, sql };
      ensureGrid().setDataset({ profile: profileFromResult(res.columns, rows, 'result'), tableName: 'result' });
      grid.activate(active);
      empty.hidden = true;
      csvBtn.hidden = !rows.length;
      const n = new Intl.NumberFormat('en-US').format(rows.length);
      status.textContent = `${n} row${rows.length === 1 ? '' : 's'}${truncated ? ` (cut off at ${new Intl.NumberFormat('en-US').format(MAX_RESULT_ROWS)}: add a LIMIT or a WHERE)` : ''} · ${(result.ms / 1000).toFixed(2)} s`;
      if (!rows.length) { empty.hidden = false; empty.textContent = 'The query ran and returned no rows.'; grid.setDataset(null); }
      history = [input.value.trim(), ...history.filter((s) => s !== input.value.trim())].slice(0, HISTORY_MAX);
      writeHistory(history);
      drawHistory();
    } catch (e) {
      if (e?.name === 'AbortError') status.textContent = 'Cancelled.';
      else { status.textContent = ''; showError(String(e?.message || e)); }
    } finally {
      clearInterval(timer);
      ctl = null;
      runBtn.disabled = false;
      cancelBtn.hidden = true;
    }
  }

  drawHistory();
  return {
    el,
    run: doRun,
    setSql,
    /** the user's metrics join the examples ("Metric: Net revenue") */
    setMetrics(list) { metricList = list || []; drawExamples(); },
    setDataset(next) {
      ctl?.abort();
      ds = next;
      result = null;
      grid?.setDataset(null);
      el.hidden = !ds || !active;
      err.hidden = true;
      csvBtn.hidden = true;
      status.textContent = '';
      empty.hidden = false;
      empty.textContent = 'Write a query and press Run. Results open in the same grid as the Data tab.';
      examplesList = ds ? sqlExamples(ds.profile) : [];
      tableChip.textContent = ds?.tableName || '';
      drawExamples();
      input.value = examplesList[0]?.sql || '';
    },
    activate(on) {
      active = !!on;
      el.hidden = !ds || !active;
      grid?.activate(active && !!result);
    },
  };
}
