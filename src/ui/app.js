// DataDrop UI. Vanilla DOM, no framework. vega / vegaLite / vegaEmbed are globals from index.html.
import { orderCards } from '../agents/layout.js';
import { estimateSample, readMemorySignals, memoryTier, cacheDecision, memoryBudgetMB } from '../data/memory.js';
import { unionColumns } from '../data/workset.js';
import { LINK_SOURCES, linkSourceFor, parseProxy, applyProxy } from '../data/links.js';
import { planChecks, summarize as summarizeChecks } from '../data/check.js';
import { rowForDatum, drillWhere, drillSql, reconcile, drillColumns, drillFields } from '../data/drill.js';
import { h } from './dom.js';
import { columnRole, formatCell } from './gridmodel.js';
import { createExplorer } from './explorer.js';
import { createSqlBox } from './sqlbox.js';
import { createMetricsPanel } from './metrics.js';
import { MODES, isMode, suggestMode, loadPrefs, savePrefs, parseShare, buildShareLink } from '../data/modes.js';
import { metricKey } from '../data/metrics.js';
import { guardSQL } from '../data/sqlguard.js';
import { prepareSpec } from './chartstyle.js';
import { toCSV, csvFileName } from './csv.js';
import { attachPopover } from './popover.js';

const EXAMPLES = [
  { label: 'Apple stock, 2014', meta: 'daily prices · CSV', url: 'https://github.com/plotly/datasets/blob/master/2014_apple_stock.csv' },
  { label: 'Gapminder', meta: 'countries × years · CSV', url: 'https://github.com/plotly/datasets/blob/master/gapminder_unfiltered.csv' },
  { label: 'COVID-19 by country', meta: 'daily cases · CSV', url: 'https://github.com/datasets/covid-19/blob/main/data/countries-aggregated.csv' },
  { label: 'LLM trace, 6.1B rows', meta: 'S3 · 85 GB Parquet · sampled', url: 's3://harvardsys-datasets/2026_chutes_anonymized/chutes_trace.parquet' },
];
const ID_LIKE = /(^id$|_id$|^id_|uuid|^index$)/i;
const GROUP_COLUMNS_OVER = 20; // longer schemas are grouped into collapsible sections

const PROVIDERS = {
  anthropic: { label: 'Anthropic', model: 'claude-sonnet-4-5' },
  openai: { label: 'OpenAI-compatible', model: 'gpt-4o-mini' },
  none: { label: 'None — heuristic charts only', model: '' },
};

const SETTINGS_KEY = 'datadrop.settings.v1';
const OLD_SETTINGS_KEY = 'gitviz.settings.v1'; // pre-rename; read once so saved keys carry over
const KIND_BADGE = { quantitative: 'num', temporal: 'time', nominal: 'text', boolean: 'bool' };
const FORMAT_BY_EXT = { csv: 'csv', tsv: 'tsv', json: 'json', jsonl: 'ndjson', ndjson: 'ndjson', parquet: 'parquet' };
const TABLE_ROWS = 50;
const MAX_SQL_ROWS = 100000; // rows kept from a SQL-box result

const $ = (root, sel) => root.querySelector(sel);

const ICONS = {
  gear: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5Zm0 1.3a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4ZM6.9 1h2.2l.4 1.8c.4.1.8.3 1.1.5l1.6-1 1.6 1.6-1 1.6c.2.3.4.7.5 1.1L15 6.9v2.2l-1.8.4c-.1.4-.3.8-.5 1.1l1 1.6-1.6 1.6-1.6-1c-.3.2-.7.4-1.1.5L9.1 15H6.9l-.4-1.8c-.4-.1-.8-.3-1.1-.5l-1.6 1-1.6-1.6 1-1.6c-.2-.3-.4-.7-.5-1.1L1 9.1V6.9l1.8-.4c.1-.4.3-.8.5-1.1l-1-1.6 1.6-1.6 1.6 1c.3-.2.7-.4 1.1-.5L6.9 1Z"/></svg>',
  file: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M4 1.7h5l3 3v9.6H4z M9 1.7v3h3"/></svg>',
  ext: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" d="M9 2.5h4.5V7M13.5 2.5 7 9M12 10v3.5H2.5V4H6"/></svg>',
  chev: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="m4 6 4 4 4-4"/></svg>',
};
const icon = (name) => { const s = h('span', { class: 'icon' }); s.innerHTML = ICONS[name]; return s; };

// ---------- formatting ----------
const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const nfCompact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
function fmtNum(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  return Math.abs(n) >= 1e6 ? nfCompact.format(n) : nf.format(n);
}
function fmtVal(v) {
  if (v == null) return '∅';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  // ISO timestamps at midnight -> date only
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ]00:00:00(?:\.0+)?Z?$/);
  return m ? m[1] : s;
}
function fmtBytes(b) {
  if (!Number.isFinite(b)) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}
function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
function fmtPct(p) {
  if (!Number.isFinite(p)) return '';
  const v = p <= 1 && p > 0 ? p * 100 : p; // accept 0–1 or 0–100
  return v === 0 ? '0%' : v < 0.1 ? '<0.1%' : `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}

// ---------- settings ----------
function loadSettings() {
  const d = { provider: 'none', apiKey: '', model: '', baseUrl: '', cacheMode: 'ask', showSteps: false, corsProxy: '' };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY) ?? localStorage.getItem(OLD_SETTINGS_KEY);
    if (raw) return { ...d, ...JSON.parse(raw) };
  } catch { /* storage blocked */ }
  return d;
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); return true; } catch { return false; }
}

// ---------- URL routing ----------
function initialUrl() {
  try {
    const q = new URLSearchParams(location.search).get('url');
    if (q) return q.trim();
  } catch { /* ignore */ }
  return hashUrl();
}
function hashUrl() {
  const hsh = decodeURIComponent(location.hash || '');
  if (/^#\/[^/]+\/[^/]+\/(blob|raw|tree)\/.+/.test(hsh)) return hsh.slice(2);
  return '';
}
function hashFor(src) {
  if (!src?.owner) return '';
  const enc = (p) => String(p).split('/').map(encodeURIComponent).join('/');
  return `#/${enc(src.owner)}/${enc(src.repo)}/blob/${enc(src.ref)}/${enc(src.path)}`;
}
function githubUrlFor(src) {
  if (!src?.owner) return '';
  return `https://github.com${hashFor(src).slice(1)}`;
}
function sourceUrlFor(src) {
  return githubUrlFor(src) || src?.page || src?.url || '';
}
function formatForName(name) {
  const ext = (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
  return FORMAT_BY_EXT[ext] || null;
}

const isDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;

// cellText(columnName, value) -> string: lets a table format by what each column means (money, ids) like the Data tab
function renderTable(rows, columns, limit = TABLE_ROWS, cellText) {
  const cols = columns?.length ? columns.map((c) => c.name ?? c) : Object.keys(rows?.[0] || {});
  if (!rows?.length) return h('p', { class: 'muted small pad' }, 'No rows returned.');
  const numeric = new Set(cols.filter((c) => rows.slice(0, 20).every((r) => r[c] == null || typeof r[c] === 'number') && !(cellText && /^\d{9,}$/.test(String(rows[0]?.[c])))));
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, cols.map((c) => h('th', { class: numeric.has(c) ? 'num' : null, scope: 'col' }, c)))),
      h('tbody', null, rows.slice(0, limit).map((r) =>
        h('tr', null, cols.map((c) => h('td', { class: [numeric.has(c) && 'num', r[c] == null && 'null'].filter(Boolean).join(' ') || null }, cellText ? cellText(c, r[c]) : fmtVal(r[c]))))))),
    rows.length > limit ? h('p', { class: 'muted small table-more' }, `Showing ${limit} of ${fmtNum(rows.length)} rows`) : null);
}

// ======================================================================
export function mountApp(root, deps) {
  const { createPipeline, createLLM, fetchGitHubFile, resolveRemoteFile, Duck } = deps;

  const state = {
    settings: loadSettings(),
    duck: null,
    duckPromise: null,
    llm: null,
    pipeline: null,
    dataset: null, // { profile, tableName, source, fileName, sizeBytes, input }
    controllers: new Map(), // card id -> AbortController for queued/running chart queries
    cache: null, // fast mode for a sampled remote file: { status, tier, est, readMB, reason, error }
    pipelineHasData: false,
    cards: [], // newest asked first, then suggested
    loadSeq: 0,
    view: 'charts', // 'charts' | 'data' | 'sql'
    metrics: [], // the user's metric definitions for the loaded dataset (data/metrics.js)
    prefs: loadPrefs((() => { try { return localStorage; } catch { return null; } })()), // { mode, dismissed } (data/modes.js)
    mode: 'overview',
    pendingTab: null, // the tab a share link asked for, applied once the dataset is loaded
    busy: false,
    runs: [],
  };

  // ---------- skeleton ----------
  root.textContent = '';
  root.classList.add('app');

  const urlInput = h('input', {
    type: 'url', class: 'url-input', id: 'gv-url', name: 'url', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Paste a link to a CSV, Parquet or JSON file (GitHub, Google Drive, Dropbox, S3…)', 'aria-label': 'Data file URL',
    'aria-describedby': 'gv-link-hint',
  });
  // Help for the kind of link being pasted (Google Drive, Dropbox…), and a list of every kind DataDrop understands.
  const linkHint = h('p', { class: 'link-hint notice info', id: 'gv-link-hint', 'aria-live': 'polite', hidden: true });
  const linkHelpList = h('dl', { class: 'link-help-list' },
    LINK_SOURCES.flatMap((s) => [
      h('dt', null, s.name),
      h('dd', null, s.howTo, h('code', { class: 'link-example' }, s.example)),
    ]));
  const linkHelp = h('section', { class: 'link-help', id: 'gv-link-help', 'aria-label': 'Which links work', hidden: true },
    h('div', { class: 'link-help-head' },
      h('h2', null, 'Which links work?'),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => toggleLinkHelp(false) }, 'Close')),
    h('p', { class: 'muted small' }, 'Everything is downloaded by your browser, straight from where the file lives: the file must be public, and the host must allow downloads from other websites (CORS). If a link is blocked, download the file and drop it on the page instead.'),
    linkHelpList);
  const linkHelpBtn = (label = 'Which links work?') => h('button', { type: 'button', class: 'link-help-btn', 'aria-controls': 'gv-link-help', onclick: () => toggleLinkHelp() }, label);
  function toggleLinkHelp(open = linkHelp.hidden) {
    linkHelp.hidden = !open;
    if (open) linkHelp.scrollIntoView?.({ block: 'nearest' });
  }
  function renderLinkHint() {
    const v = urlInput.value.trim();
    const src = v && v !== state.dataset?.source?.url ? linkSourceFor(v) : null;
    linkHint.textContent = '';
    linkHint.hidden = !src;
    if (!src) return;
    linkHint.dataset.source = src.id;
    linkHint.append(h('b', null, src.name), ` · ${src.howTo} `, linkHelpBtn('All link types'));
  }
  urlInput.addEventListener('input', renderLinkHint);
  const openBtn = h('button', { type: 'submit', class: 'btn primary' }, 'Open');
  const fileInput = h('input', { type: 'file', class: 'sr-only', accept: '.csv,.tsv,.json,.jsonl,.ndjson,.parquet', 'aria-label': 'File: open a local data file' });
  const settingsBtn = h('button', { type: 'button', class: 'btn ghost icon-btn', 'aria-label': 'Settings', title: 'Settings', 'aria-haspopup': 'dialog' }, icon('gear'), h('span', { class: 'btn-label' }, 'Settings'));
  const providerPill = h('button', { type: 'button', class: 'provider-pill', onclick: () => openSettings() });

  const loadForm = h('form', { class: 'loadbar', onsubmit: (e) => { e.preventDefault(); const u = urlInput.value.trim(); if (u) loadUrl(u); } },
    urlInput, openBtn);

  const header = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: './', 'aria-label': 'DataDrop home' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), 'DataDrop'),
    loadForm,
    h('label', { class: 'btn ghost file-btn', title: 'Open a local CSV, TSV, JSON or Parquet file (or drop one on the page)' }, icon('file'), h('span', null, 'File'), fileInput),
    h('div', { class: 'topbar-end' }, providerPill, settingsBtn));

  const exampleChips = (cls, after) => h('div', { class: `chips ${cls || ''}` },
    EXAMPLES.map((ex) => h('button', { type: 'button', class: 'chip', title: ex.url, dataset: { url: ex.url }, onclick: () => { after?.(); urlInput.value = ex.url; loadUrl(ex.url); } },
      h('span', { class: 'chip-label' }, ex.label), h('span', { class: 'chip-meta' }, ex.meta))));

  // ---- dataset bar (after a load) + the one notice slot, in a sticky stack under the top bar ----
  const dsName = h('span', { class: 'ds-name' });
  const dsSource = h('a', { class: 'ds-source', target: '_blank', rel: 'noopener' });
  const dsCols = h('span', { class: 'ds-cols' });
  const dsSize = h('span', { class: 'ds-size' });
  const dsRows = h('span', { class: 'ds-rows' });
  const dsMeta = h('span', { class: 'ds-meta' }, dsRows, dsCols, dsSize);
  const fieldsBtn = h('button', { type: 'button', class: 'btn small fields-toggle', 'aria-controls': 'gv-rail', 'aria-expanded': 'false', title: 'Show or hide the list of columns', onclick: () => setRail(!railIsOpen()) }, 'Columns');
  const examplesMenu = h('div', { class: 'menu examples-menu', 'aria-label': 'Examples', hidden: true });
  const examplesBtn = h('button', { type: 'button', class: 'btn small examples-btn', 'aria-haspopup': 'true' }, 'Examples ', icon('chev'));
  const examplesPop = attachPopover(examplesBtn, examplesMenu);
  examplesMenu.append(exampleChips('compact', () => examplesPop.close(false)), linkHelpBtn());
  // views (data/modes.js): same data, different arrangement. A suggestion chip offers Review for transaction-like tables.
  const viewSelect = h('select', { class: 'view-select', 'aria-label': 'View', onchange: () => applyMode(viewSelect.value, { user: true, rail: true }) },
    Object.entries(MODES).map(([id, m]) => h('option', { value: id, title: m.hint }, m.label)));
  const shareBtn = h('button', { type: 'button', class: 'btn small share-btn', title: 'Copy a link that reopens this dataset in this view', onclick: () => shareLink() }, 'Share');
  const datasetBar = h('div', { class: 'databar', 'aria-label': 'Dataset', hidden: true },
    dsName, dsSource, dsMeta,
    h('div', { class: 'databar-end' }, viewSelect, shareBtn, fieldsBtn, h('div', { class: 'menu-wrap' }, examplesBtn, examplesMenu)));
  const statusEl = h('div', { class: 'status notice', role: 'status', 'aria-live': 'polite', hidden: true });
  const sampleNotice = h('div', { class: 'sample-notice notice warn', role: 'note', hidden: true });
  const cacheBanner = h('div', { class: 'cache-banner notice', role: 'status', 'aria-live': 'polite', hidden: true });
  const modeChip = h('div', { class: 'mode-chip notice info', role: 'status', hidden: true });
  const notices = h('div', { class: 'notices', 'aria-label': 'Notices' }, statusEl, sampleNotice, cacheBanner, modeChip, linkHint);
  const chrome = h('div', { class: 'chrome' }, datasetBar, notices);

  // columns rail (a bottom sheet on narrow screens)
  const railClose = h('button', { type: 'button', class: 'btn ghost small rail-close', 'aria-label': 'Close the columns list', onclick: () => setRail(false) }, '✕');
  const datasetBody = h('div', { class: 'panel-body dataset-body' });
  const datasetPanel = h('aside', { class: 'panel dataset', id: 'gv-rail', 'aria-label': 'Columns' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Columns'), h('span', { class: 'panel-sub' }), railClose), datasetBody);
  const sheetScrim = h('div', { class: 'sheet-scrim', onclick: () => setRail(false) });

  // ask + grid
  const askInput = h('input', { type: 'text', class: 'ask-input', id: 'gv-ask', autocomplete: 'off', placeholder: 'Ask a question about this data', 'aria-label': 'Ask a question about this data', disabled: true });
  const askBtn = h('button', { type: 'submit', class: 'btn primary', disabled: true }, 'Ask');
  const askForm = h('form', { class: 'ask', onsubmit: (e) => { e.preventDefault(); const q = askInput.value.trim(); if (q) ask(q); } },
    h('div', { class: 'ask-row' }, h('span', { class: 'ask-prompt', 'aria-hidden': 'true' }, '?'), askInput, askBtn));
  const aiChip = h('button', { type: 'button', class: 'ai-chip', hidden: true, onclick: () => openSettings() },
    h('b', null, 'Ask in plain English'), h('span', { class: 'muted' }, ' · add an API key'));
  const grid = h('div', { class: 'grid', 'aria-live': 'polite' });
  // the start page: one centred column
  const emptyState = h('div', { class: 'empty' },
    h('h1', null, 'Paste a data link. Get a dashboard.'),
    h('p', { class: 'empty-sub muted' }, 'CSV, Parquet or JSON from GitHub, Google Drive and Sheets, Dropbox, S3, Hugging Face and more. ', linkHelpBtn('Which links work?')),
    exampleChips('large'),
    h('ul', { class: 'trust' },
      h('li', null, 'Stays in your browser'),
      h('li', null, 'No account'),
      h('li', null, 'Huge Parquet files are sampled')));
  // Charts / Data tabs: the grid + record view (explorer.js) shows the rows themselves
  const explorer = createExplorer({
    fetchPage: (table, o) => state.duck.pageRows(table, o),
    fastColumns: (table) => state.duck?.workingSet?.(table)?.columns || null,
    copyText: (t) => copyText(t),
  });
  const tabButton = (id, label) => h('button', { type: 'button', class: 'view-tab', role: 'tab', id: `gv-tab-${id}`, 'aria-selected': 'false', 'aria-controls': `gv-view-${id}`, dataset: { view: id }, onclick: () => setView(id) }, label);
  const chartsTab = tabButton('charts', 'Charts');
  const dataTab = tabButton('data', 'Data');
  const sqlTab = tabButton('sql', 'SQL');
  const viewTabs = h('div', { class: 'view-tabs', role: 'tablist', 'aria-label': 'View', hidden: true }, chartsTab, dataTab, sqlTab);
  // your own query over the table; results open in the same grid. Reads the file for columns outside a working set, never extends it.
  const sqlbox = createSqlBox({
    run: (sql, o) => state.duck.query(sql, { limit: MAX_SQL_ROWS + 1, autoExtend: false, cache: false, signal: o.signal }),
    guard: guardSQL,
    copyText: (t) => copyText(t),
    toCSV,
  });
  // your named metrics: cards on the Charts tab; the list goes to the AI's prompts and the SQL tab's examples
  const metricsPanel = createMetricsPanel({
    run: (sql, o) => state.duck.query(sql, { limit: null, autoExtend: false, cache: false, signal: o.signal }),
    guard: guardSQL,
    onChange: (list) => { state.metrics = list; state.pipeline?.setMetrics?.(list); sqlbox.setMetrics(list); },
  });
  // activity: a low-key pill beside the tabs opens a slide-over with the agents' steps
  const traceList = h('div', { class: 'trace-list' }, h('p', { class: 'muted small' }, 'Agent activity shows up here.'));
  const traceToggle = h('button', { type: 'button', class: 'panel-toggle activity-pill', 'aria-expanded': 'false', 'aria-haspopup': 'dialog', title: 'What the agents are doing' },
    h('span', { class: 'pill-dot', 'aria-hidden': 'true' }), h('span', { class: 'pill-label' }, 'Activity'), h('span', { class: 'panel-sub trace-live' }));
  const slideover = h('div', { class: 'slideover', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gv-activity-title', hidden: true },
    h('div', { class: 'slideover-scrim', onclick: () => closeActivity() }),
    h('aside', { class: 'slideover-panel' },
      h('div', { class: 'slideover-head' }, h('h2', { id: 'gv-activity-title' }, 'Activity'),
        h('button', { type: 'button', class: 'btn ghost', 'aria-label': 'Close activity', onclick: () => closeActivity() }, '✕')),
      h('div', { class: 'slideover-body' }, traceList)));
  const tracePanel = h('div', { class: 'trace collapsed' }, traceToggle, slideover);
  const viewRow = h('div', { class: 'view-row' }, viewTabs, metricsPanel.addBtn, tracePanel);
  const workspace = h('section', { class: 'workspace', 'aria-label': 'Workspace' }, askForm, aiChip, viewRow, metricsPanel.el, emptyState, grid, explorer.el, sqlbox.el);
  grid.id = 'gv-view-charts';
  explorer.el.id = 'gv-view-data';
  let explorerProfile = null;
  function setView(v) {
    state.view = state.dataset ? v : 'charts';
    const data = state.view === 'data';
    grid.hidden = state.view !== 'charts';
    root.classList.toggle('view-data', data);
    for (const b of [chartsTab, dataTab, sqlTab]) { const on = b.dataset.view === state.view; b.setAttribute('aria-selected', String(on)); b.classList.toggle('active', on); b.tabIndex = on ? 0 : -1; }
    explorer.activate(data);
    sqlbox.activate(state.view === 'sql');
    metricsPanel.setVisible(state.view === 'charts');
    if (state.view === 'charts') for (const c of state.cards) if (c._stale && !c.error) drawViz(c);
    if (typeof updateShare === 'function') updateShare();
  }
  // keep the tabs and the explorer in step with state.dataset (called from renderDataset)
  function syncExplorer() {
    const d = state.dataset;
    viewTabs.hidden = !d;
    if (!d) { explorerProfile = null; explorer.setDataset(null); sqlbox.setDataset(null); metricsPanel.setDataset(null); setView('charts'); return; }
    dataTab.textContent = '';
    dataTab.append('Data ', h('span', { class: 'view-count' }, fmtNum(d.profile.rowCount)));
    if (explorerProfile !== d.profile) {
      explorerProfile = d.profile;
      explorer.setDataset({ profile: d.profile, tableName: d.tableName || d.profile.table });
      sqlbox.setDataset({ profile: d.profile, tableName: d.tableName || d.profile.table });
      metricsPanel.setDataset({ profile: d.profile, tableName: d.tableName || d.profile.table });
    }
    setView(state.view);
    syncExplorerHint();
  }
  function syncExplorerHint() {
    const p = state.dataset?.profile;
    const ready = ['ready', 'extending'].includes(state.cache?.status);
    explorer.setHint(p?.remote && !ready ? 'Reading rows straight from the file: scrolling may pause. A working set makes it instant.' : '');
  }

  const layout = h('main', { class: 'layout' }, datasetPanel, workspace);

  // settings drawer
  const sProvider = h('select', { id: 'gv-provider', name: 'provider' }, Object.entries(PROVIDERS).map(([k, p]) => h('option', { value: k }, p.label)));
  const sKey = h('input', { id: 'gv-key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-…' });
  const sModel = h('input', { id: 'gv-model', type: 'text', autocomplete: 'off', spellcheck: 'false' });
  const sBase = h('input', { id: 'gv-base', type: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://api.openai.com/v1' });
  const sCache = h('select', { id: 'gv-cache', name: 'cacheMode' },
    h('option', { value: 'ask' }, 'Working set: cache the columns charts use (recommended)'),
    h('option', { value: 'fast' }, 'Fast mode: cache every column'),
    h('option', { value: 'light' }, 'Prefer low memory (no working set)'));
  const sSteps = h('input', { id: 'gv-steps', type: 'checkbox', name: 'showSteps' });
  const sProxy = h('input', { id: 'gv-proxy', type: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://your-proxy.workers.dev/?url={url}' });
  const sClear = h('button', { type: 'button', class: 'btn small', disabled: true, onclick: () => { clearWorkingSet(); } }, 'Clear working set');
  const sMsg = h('p', { class: 'small muted', role: 'status' });
  const field = (label, input, extra) => h('div', { class: 'field', dataset: { field: input.id } }, h('label', { for: input.id }, label), input, extra);
  const keyField = field('API key', sKey);
  const modelField = field('Model', sModel);
  const baseField = field('Base URL', sBase, h('p', { class: 'small muted' }, 'Any endpoint that speaks the OpenAI chat/completions API and allows browser CORS.'));
  const drawer = h('div', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gv-settings-title', hidden: true },
    h('div', { class: 'drawer-scrim', onclick: () => closeSettings() }),
    h('form', { class: 'drawer-panel', onsubmit: (e) => { e.preventDefault(); applySettings(); } },
      h('div', { class: 'drawer-head' }, h('h2', { id: 'gv-settings-title' }, 'Settings'),
        h('button', { type: 'button', class: 'btn ghost', 'aria-label': 'Close settings', onclick: () => closeSettings() }, '✕')),
      field('Provider', sProvider), keyField, modelField, baseField,
      h('p', { class: 'note small' }, 'Key stays in this browser and is sent only to the provider.'),
      h('div', { class: 'field' }, h('label', { class: 'check', for: 'gv-steps' }, sSteps, 'Show agent steps'),
        h('p', { class: 'small muted' }, 'Keeps a count of the agents\' runs next to the Activity button. Off: it only says "working…" while something runs.')),
      field('Large files', sCache, [h('p', { class: 'small muted' }, 'For big remote files, DataDrop copies the columns your charts use into memory once, so charts and questions run instantly. Fast mode copies every column; low memory reads the file for every chart instead (slower, lighter).'), sClear]),
      field('Links that block browsers (optional)', sProxy, h('p', { class: 'small muted' }, 'Some servers (like the NYC taxi files) don\'t let websites read them. If you run a small relay of your own, DataDrop uses it for those links only; your data then passes through your relay. ', h('a', { href: 'https://github.com/kasivisu4/datadrop/blob/main/docs/CORS-PROXY.md', target: '_blank', rel: 'noopener' }, 'How to set one up (free, 5 minutes)'))),
      h('div', { class: 'drawer-actions' },
        h('button', { type: 'submit', class: 'btn primary' }, 'Save'),
        h('button', { type: 'button', class: 'btn', onclick: () => closeSettings() }, 'Cancel')),
      sMsg));

  viewTabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const order = ['charts', 'data', 'sql'];
    const i = order.indexOf(state.view) + (e.key === 'ArrowRight' ? 1 : -1);
    setView(order[(i + order.length) % order.length]);
    ({ charts: chartsTab, data: dataTab, sql: sqlTab })[state.view].focus();
  });
  const dropOverlay = h('div', { class: 'drop-overlay', hidden: true }, h('div', null, icon('file'), h('p', null, 'Drop a CSV, TSV, JSON or Parquet file')));

  root.append(header, chrome, linkHelp, layout, sheetScrim, drawer, dropOverlay);
  examplesMenu.addEventListener('click', (e) => { if (e.target.closest?.('.link-help-btn')) examplesPop.close(false); });

  // ---------- shell state: start page / dataset bar / rail ----------
  // Start page = nothing loaded and nothing loading: one centred column, no rail, no dataset bar.
  function syncShell() {
    const d = state.dataset;
    const start = !d && state.cards.length === 0 && !state.busy;
    emptyState.hidden = !start;
    datasetBar.hidden = !d;
    root.classList.toggle('is-start', start);
    root.classList.toggle('has-dataset', !!d);
    viewRow.hidden = start;
    syncRail();
    syncStack();
  }
  // the rail sticks below the sticky stack: tell the CSS how tall that is
  const stackObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => syncStack()) : null;
  stackObserver?.observe(chrome);
  function syncStack() { root.style.setProperty('--stack-h', `${Math.round(chrome.getBoundingClientRect().height)}px`); }

  // ---------- status ----------
  // action: an optional { label, href } link shown after the message (e.g. "Download the file")
  function setStatus(msg, kind = 'info', action = null) {
    if (!msg) { statusEl.hidden = true; statusEl.textContent = ''; return; }
    statusEl.hidden = false;
    statusEl.className = `status notice ${kind}`;
    statusEl.textContent = msg;
    if (action) statusEl.append(' ', h('a', { class: 'status-action', href: action.href, target: '_blank', rel: 'noopener' }, action.label));
  }

  // ---------- providers / pipeline ----------
  function hasLLM() { return !!state.llm; }
  function buildLLM() {
    const s = state.settings;
    if (s.provider === 'none' || !s.apiKey) return null;
    try {
      return createLLM({ provider: s.provider, apiKey: s.apiKey, model: s.model || PROVIDERS[s.provider].model, baseUrl: s.baseUrl || undefined });
    } catch (e) {
      setStatus(`Couldn't set up the ${PROVIDERS[s.provider]?.label || s.provider} client: ${e.message}`, 'error');
      return null;
    }
  }
  function rebuildPipeline() {
    state.llm = buildLLM();
    state.pipeline = state.duck ? createPipeline({ llm: state.llm, duck: state.duck }) : null;
    state.pipeline?.setMetrics?.(state.metrics || []); // a rebuilt pipeline keeps the user's definitions
    state.pipelineHasData = false;
    syncProviderUI();
  }
  function syncProviderUI() {
    const s = state.settings;
    const ai = hasLLM();
    askForm.hidden = !ai;
    aiChip.hidden = ai;
    providerPill.textContent = ai ? 'AI on' : 'AI off';
    providerPill.title = ai ? `AI picks charts and answers questions (${PROVIDERS[s.provider].label}, ${s.model || PROVIDERS[s.provider].model}). Click to open Settings.`
      : 'AI is off: charts come from built-in rules. Click to open Settings and add an API key for AI charts and plain-English questions.';
    providerPill.classList.toggle('ai', ai);
    syncAsk();
  }
  function syncAsk() {
    const ready = !!state.dataset && hasLLM();
    askInput.disabled = !ready || state.busy;
    askBtn.disabled = !ready || state.busy;
    askInput.placeholder = !state.dataset ? 'Load a dataset, then ask a question about this data'
      : hasLLM() ? 'Ask a question about this data' : 'Add an API key in Settings to ask questions';
    askForm.title = state.dataset && hasLLM() ? 'Press Enter: an agent writes the SQL, DuckDB runs it, and the answer becomes a chart.' : '';
  }
  async function ensureDuck(onTrace) {
    if (state.duck) return state.duck;
    if (!state.duckPromise) {
      const t0 = performance.now();
      onTrace({ agent: 'duckdb', status: 'start', message: 'Starting DuckDB-WASM' });
      const baseUrl = new URL('./duckdb/', location.href).href;
      state.duckPromise = Duck.create({ baseUrl }).then((d) => {
        state.duck = d;
        d.onWorkingSet = onWorkingSetEvent;
        onTrace({ agent: 'duckdb', status: 'done', message: 'DuckDB ready', ms: performance.now() - t0 });
        return d;
      }, (e) => { state.duckPromise = null; throw e; });
    }
    await state.duckPromise;
    if (!state.pipeline) rebuildPipeline();
    return state.duck;
  }

  // ---------- trace ----------
  function startRun(label) {
    const run = { id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, label, t0: performance.now(), rows: [], status: 'running' };
    state.runs.unshift(run);
    if (state.runs.length === 1) traceList.textContent = '';
    // collapse older runs
    for (const r of state.runs.slice(1)) if (r.el) r.el.open = false;
    const time = h('span', { class: 'run-time' });
    const list = h('ol', { class: 'events' });
    run.el = h('details', { class: 'run running', open: true },
      h('summary', null, h('span', { class: 'run-dot', 'aria-hidden': 'true' }), h('span', { class: 'run-label' }, label), time), list);
    run.timeEl = time; run.listEl = list;
    traceList.prepend(run.el);
    if (state.runs.length > 12) { const old = state.runs.pop(); old.el?.remove(); }
    run.trace = (ev) => addEvent(run, ev);
    updateLive();
    if (!ticker) ticker = setInterval(tick, 100);
    return run;
  }
  // Live elapsed time for running runs and their open steps, shown once past 1 s.
  let ticker = null;
  function tick() {
    const now = performance.now();
    const running = state.runs.filter((r) => r.status === 'running');
    if (!running.length) { clearInterval(ticker); ticker = null; return; }
    for (const el of grid.querySelectorAll('.pending-time[data-since]')) el.textContent = fmtMs(now - Number(el.dataset.since));
    for (const run of running) {
      if (now - run.t0 >= 1000) run.timeEl.textContent = fmtMs(now - run.t0);
      for (const r of run.rows) {
        if (r.status === 'start' && now - r.t0 >= 1000) r.msEl.textContent = fmtMs(now - r.t0);
      }
    }
  }
  function addEvent(run, ev) {
    if (!ev || typeof ev !== 'object') return;
    const agent = String(ev.agent || 'agent');
    const status = ['start', 'done', 'error', 'retry'].includes(ev.status) ? ev.status : 'start';
    const at = performance.now() - run.t0;
    // a done/error closes the latest open start row of the same agent
    let row = null;
    if (status === 'done' || status === 'error') row = [...run.rows].reverse().find((r) => r.agent === agent && r.status === 'start');
    if (!row) {
      row = { agent, t0: performance.now() };
      row.el = h('li', { class: 'event' });
      run.rows.push(row);
      run.listEl.append(row.el);
    }
    Object.assign(row, { status, message: ev.message || '', ms: ev.ms, at });
    row.el.className = `event ${status}`;
    row.el.dataset.status = status;
    row.el.textContent = '';
    row.msEl = h('span', { class: 'ev-ms' }, Number.isFinite(ev.ms) ? fmtMs(ev.ms) : status === 'start' ? '…' : '');
    row.el.append(
      h('span', { class: 'ev-status', title: status, 'aria-label': status }),
      h('span', { class: 'agent-chip', dataset: { agent } }, agent),
      h('span', { class: 'ev-msg' }, row.message),
      row.msEl);
    if (ev.detail != null) {
      const d = typeof ev.detail === 'string' ? ev.detail : safeJSON(ev.detail);
      if (d) row.el.append(h('details', { class: 'ev-detail' }, h('summary', null, 'detail'), h('pre', null, d.length > 4000 ? d.slice(0, 4000) + '…' : d)));
    }
    run.timeEl.textContent = fmtMs(at);
    if (run.listEl.parentElement) run.listEl.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
  }
  function endRun(run, ok = true) {
    run.status = ok ? 'done' : 'error';
    run.el.classList.remove('running');
    run.el.classList.add(ok ? 'ok' : 'failed');
    // any start rows left open are finished now
    for (const r of run.rows) if (r.status === 'start') { r.el.classList.add('stale'); const ms = r.el.querySelector('.ev-ms'); if (ms) ms.textContent = ''; }
    run.timeEl.textContent = fmtMs(performance.now() - run.t0);
    updateLive();
  }
  function updateLive() {
    const running = state.runs.filter((r) => r.status === 'running').length;
    const runs = state.runs.length ? `${state.runs.length} run${state.runs.length > 1 ? 's' : ''}` : '';
    // low-key by default: the pill only says "working…" while a run is going; "Show agent steps" (Settings) keeps the count
    const closed = tracePanel.classList.contains('collapsed');
    $(tracePanel, '.trace-live').textContent = running ? 'working…'
      : state.settings.showSteps && runs ? (closed ? `${runs} · show steps` : runs) : '';
    tracePanel.classList.toggle('is-live', running > 0);
  }
  // the activity slide-over: scrim, Escape, focus in and back out (same pattern as the settings drawer)
  function openActivity() {
    tracePanel.classList.remove('collapsed');
    traceToggle.setAttribute('aria-expanded', 'true');
    slideover.hidden = false;
    requestAnimationFrame(() => slideover.classList.add('open'));
    updateLive();
    $(slideover, '.slideover-head .btn').focus();
  }
  function closeActivity(refocus = true) {
    if (slideover.hidden) return;
    slideover.classList.remove('open');
    slideover.hidden = true;
    tracePanel.classList.add('collapsed');
    traceToggle.setAttribute('aria-expanded', 'false');
    updateLive();
    if (refocus) traceToggle.focus();
  }
  traceToggle.addEventListener('click', () => (slideover.hidden ? openActivity() : closeActivity()));
  function safeJSON(x) { try { return JSON.stringify(x, null, 2); } catch { return String(x); } }

  // ---------- dataset panel ----------
  function renderDataset() {
    const d = state.dataset;
    datasetBody.textContent = '';
    if (!d) {
      $(datasetPanel, '.panel-sub').textContent = '';
      renderSampleNotice();
      syncExplorer();
      syncShell();
      return;
    }
    const p = d.profile;
    // dataset bar: name, source, "N rows × M columns", size
    const srcUrl = sourceUrlFor(d.source);
    dsName.textContent = d.fileName || p.table;
    dsName.title = d.fileName || p.table;
    if (d.fileCount) dsName.append(h('span', { class: 'muted' }, ` × ${d.fileCount} files`));
    dsSource.textContent = '';
    if (srcUrl) {
      dsSource.href = srcUrl;
      dsSource.classList.remove('muted');
      dsSource.append(...(d.source?.owner ? [`${d.source.owner}/${d.source.repo}`, h('span', { class: 'muted' }, ` @ ${d.source.ref}`)] : [d.source?.host || 'source']), icon('ext'));
    } else {
      dsSource.removeAttribute('href');
      dsSource.classList.add('muted');
      dsSource.append('Local file');
    }
    dsRows.textContent = `${p.totalRows ? `${fmtNum(p.rowCount)} of ${fmtNum(p.totalRows)}` : fmtNum(p.rowCount)} rows`;
    dsCols.textContent = ` × ${p.columns.length} column${p.columns.length === 1 ? '' : 's'}`;
    dsSize.textContent = d.sizeBytes ? ` · ${fmtBytes(d.sizeBytes)}` : '';
    // columns rail: the sample controls (when sampled), the table name, every column
    $(datasetPanel, '.panel-sub').textContent = `${p.columns.length}`;
    datasetBody.textContent = '';
    datasetBody.append(
      ...(p.totalRows ? [samplePanel(p)] : []), // native append() would print null as text
      h('div', { class: 'ds-table' }, h('span', { class: 'muted small' }, 'Table '), h('code', null, d.tableName || p.table)),
      columnList(p.columns));
    renderSampleNotice();
    syncExplorer();
    syncShell();
  }

  // The short sample summary in the notice slot (visible in Charts and Data); the full controls are in the columns rail.
  function renderSampleNotice() {
    const p = state.dataset?.profile;
    sampleNotice.textContent = '';
    sampleNotice.hidden = !p?.totalRows;
    if (!p?.totalRows) return;
    const s = p.sampleInfo || {};
    const what = s.mode === 'window' ? `rows ${fmtNum(s.firstRow)}–${fmtNum(s.endRow)} in file order, not random` : 'spread across the file';
    sampleNotice.append(
      h('span', { class: 'notice-msg' }, h('b', null, `Sample: ${fmtNum(p.rowCount)} of ${fmtNum(p.totalRows)} rows`), `, ${what}. Charts and questions use only these rows.`),
      h('div', { class: 'notice-end' }, h('button', { type: 'button', class: 'btn small sample-change', onclick: () => openSampleControls() }, 'Change')));
  }
  function openSampleControls() {
    setRail(true);
    const panel = $(datasetBody, '.sample-panel');
    panel?.scrollIntoView?.({ block: 'nearest' });
    panel?.focus();
  }

  // ---------- columns rail: collapsible on desktop (remembered), a bottom sheet on narrow screens ----------
  const RAIL_KEY = 'datadrop.rail.v1';
  const mqNarrow = window.matchMedia?.('(max-width: 900px)');
  let railOpen = true; // desktop preference
  try { railOpen = localStorage.getItem(RAIL_KEY) !== 'closed'; } catch { /* storage blocked: default open */ }
  let sheetOpen = false; // narrow screens: always starts closed
  const isNarrow = () => !!mqNarrow?.matches;
  function railIsOpen() { return isNarrow() ? sheetOpen : railOpen; }
  function setRail(open) {
    if (isNarrow()) sheetOpen = open;
    else {
      railOpen = open;
      try { localStorage.setItem(RAIL_KEY, open ? 'open' : 'closed'); } catch { /* ignore */ }
    }
    syncRail();
    if (isNarrow()) (open ? railClose : fieldsBtn).focus();
  }
  function syncRail() {
    const open = railIsOpen();
    root.classList.toggle('rail-closed', !isNarrow() && !railOpen);
    root.classList.toggle('sheet-open', isNarrow() && sheetOpen && !!state.dataset);
    fieldsBtn.setAttribute('aria-expanded', String(open));
  }
  mqNarrow?.addEventListener?.('change', () => { sheetOpen = false; syncRail(); });

  // Schema list. Over GROUP_COLUMNS_OVER columns, it's split into collapsible sections by role.
  function columnList(columns) {
    if (columns.length <= GROUP_COLUMNS_OVER) return h('ul', { class: 'columns' }, columns.map(columnItem));
    const groups = [
      ['Timestamps', (c) => c.kind === 'temporal'],
      ['Identifiers', (c) => ID_LIKE.test(c.name)],
      ['Metrics', (c) => c.kind === 'quantitative'],
      ['Text', (c) => c.kind === 'nominal'],
      ['Other', () => true],
    ];
    const seen = new Set();
    return h('div', { class: 'column-groups' }, groups.map(([label, test]) => {
      const cols = columns.filter((c) => !seen.has(c) && test(c));
      cols.forEach((c) => seen.add(c));
      return cols.length ? h('details', { class: 'col-group', open: true },
        h('summary', null, label, h('span', { class: 'muted' }, ` ${cols.length}`)),
        h('ul', { class: 'columns' }, cols.map(columnItem))) : null;
    }));
  }

  function columnItem(c) {
        const kind = KIND_BADGE[c.kind] || 'text';
        const range = c.min != null && c.max != null && c.kind !== 'nominal'
          ? (columnRole(c) === 'id' ? `${c.min} – ${c.max}` : `${fmtVal(c.min)} – ${fmtVal(c.max)}`) // an account number is never "401B"
          : c.topValues?.length ? `top: ${c.topValues.slice(0, 3).map((t) => fmtVal(t.value)).join(', ')}` : '';
        const nullPct = Number(c.nullPct) || 0;
        // mostly-null columns are dimmed and tagged, so the useful ones stand out
        const nullTag = nullPct >= 100 ? 'empty' : nullPct >= 50 ? 'mostly null' : null;
        const show = () => { setView('data'); explorer.revealColumn(c.name); if (isNarrow()) setRail(false); };
        return h('li', { class: `col${nullTag ? ' mostly-null' : ''}`, title: `${c.name} · ${c.type}. Click to show it in the Data tab`, role: 'button', tabindex: '0', onclick: show, onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); show(); } } },
          h('div', { class: 'col-head' },
            h('span', { class: `kind kind-${kind}` }, kind),
            h('span', { class: 'col-name' }, c.name),
            nullTag ? h('span', { class: 'null-tag' }, nullTag) : null,
            h('span', { class: 'col-type' }, String(c.type || '').toLowerCase())),
          h('div', { class: 'col-meta' },
            // remote Parquet profiles skip distinct counts for large columns (and nulls when the footer has no stats)
            c.distinct != null ? h('span', null, `${fmtNum(c.distinct)} distinct`) : null,
            c.nullPct != null ? h('span', { class: nullPct > 0 ? 'has-null' : null }, `${fmtPct(nullPct)} null`) : null),
          range ? h('div', { class: 'col-range', title: range }, range) : null);
  }

  // ---------- cards ----------
  function skeletonCard() {
    return h('article', { class: 'card skeleton', 'aria-busy': 'true', 'aria-label': 'Loading chart' },
      h('div', { class: 'sk sk-title' }), h('div', { class: 'sk sk-sub' }), h('div', { class: 'sk sk-chart' }));
  }
  function renderCard(card) {
    if (card.pending) return renderPendingCard(card);
    const el = h('article', { class: `card${card.error ? ' error' : ''}${card.asked ? ' asked' : ''}${card.pinned ? ' pinned' : ''} size-${card.layout?.size || 'm'}`, dataset: { id: card.id || '', section: card.layout?.section || '' } });
    el._card = card;
    // a tag only when it means something: the card failed (running / queued are on pending cards)
    el.append(h('header', { class: 'card-head' },
      h('div', { class: 'card-titles' },
        h('h3', null, card.title || card.question || 'Untitled'),
        card.question && card.question !== card.title ? h('p', { class: 'card-q' }, card.question) : null),
      card.error ? h('span', { class: 'tag tag-error' }, 'error') : null));

    const viz = h('div', { class: 'viz' });
    el.append(viz);
    card._viz = viz;
    if (card.explain && !card.error) el.append(explainBlock(card));

    const sqlPanel = h('div', { class: 'card-panel sql-panel', hidden: true });
    const dataPanel = h('div', { class: 'card-panel data-panel', hidden: true });
    const drillPanel = h('div', { class: 'card-panel drill-panel', hidden: true, 'aria-live': 'polite' });
    card._drillPanel = drillPanel;
    const checkPanel = h('div', { class: 'card-panel check-panel', hidden: true, 'aria-live': 'polite' });
    card._checkPanel = checkPanel;
    if (card.sql) {
      const copyBtn = h('button', { type: 'button', class: 'btn tiny copy', onclick: async () => {
        const ok = await copyText(card.sql);
        copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
      } }, 'Copy');
      sqlPanel.append(h('pre', { class: 'sql' }, h('code', null, card.sql)), copyBtn);
    }

    // A failed chart says so in plain words; the raw message and the SQL are one click away.
    if (card.error) {
      viz.classList.add('viz-error');
      viz.append(
        h('p', { class: 'err-title' }, card.asked ? "That question couldn't be answered from this data." : "This chart couldn't be built from this data."),
        h('details', { class: 'err-details' },
          h('summary', null, 'Show technical details'),
          h('pre', { class: 'err-msg' }, String(card.error)),
          card.sql ? h('pre', { class: 'sql err-sql' }, h('code', null, card.sql)) : null));
    }

    const rows = card.rows || [];
    const x = card.spec?.encoding?.x;
    const pinBtn = card.error ? null : h('button', {
      type: 'button', class: 'btn tiny toggle pin', 'aria-pressed': String(!!card.pinned), title: 'Keep this chart when charts are re-suggested or the sample changes',
      onclick: () => { card.pinned = !card.pinned; pinBtn.setAttribute('aria-pressed', String(card.pinned)); el.classList.toggle('pinned', card.pinned); },
    }, 'Pin');
    const panelItem = (cls, show, hide, panel, build) => ({
      cls, label: () => (panel.hidden ? show : hide),
      onclick: () => { if (build && !panel.childElementCount) build(); panel.hidden = !panel.hidden; },
    });
    const menu = cardMenu(card, [
      card.sql ? panelItem('act-sql', 'View SQL', 'Hide SQL', sqlPanel) : null,
      !card.error ? panelItem('act-data', 'Show data', 'Hide data', dataPanel, () => dataPanel.append(renderTable(rows, card.columns))) : null,
      x?.type === 'quantitative' && !card.fallback && !card.error ? {
        label: () => 'Log x', role: 'menuitemcheckbox', checked: () => x.scale?.type === 'symlog', cls: 'act-logx', title: 'Log scale on the x axis',
        onclick: () => {
          const on = x.scale?.type !== 'symlog';
          if (on) { x.scale = { type: 'symlog' }; x.axis = { ...x.axis, format: '~s', labelOverlap: 'greedy' }; } else delete x.scale;
          drawViz(card);
        },
      } : null,
      !card.error && rows.length ? { label: () => 'Download data', cls: 'act-download', onclick: () => downloadCSV(card) } : null,
      card.sql ? { label: () => 'Edit in SQL tab', cls: 'act-edit-sql', onclick: () => { setView('sql'); sqlbox.setSql(card.sql); } } : null,
    ]);
    const checkBtn = !card.error && rows.length ? h('button', { type: 'button', class: 'btn tiny ghost check-btn', title: 'Re-derive this chart\'s numbers another way and see whether they hold', onclick: () => runCheck(card) }, 'Check this number') : null;
    const footer = h('footer', { class: 'card-foot' },
      pinBtn,
      checkBtn,
      h('span', { class: 'card-count muted small' }, card.error ? '' : `${fmtNum(rows.length)} row${rows.length === 1 ? '' : 's'}`),
      menu);
    el.append(footer, sqlPanel, dataPanel, drillPanel, checkPanel);
    card._el = el;
    if (!card.error) drawViz(card);
    return el;
  }
  async function drawViz(card) {
    const viz = card._viz;
    if (!viz) return;
    try { card._view?.finalize?.(); } catch { /* ignore */ }
    card._view = null;
    viz.textContent = '';
    viz.classList.remove('viz-table', 'viz-chart');
    const rows = card.rows || [];
    if (card.note || card.cancelled) {
      viz.append(h('p', { class: 'card-note' }, card.cancelled ? 'Cancelled.' : card.note));
      if (card.cancelled && card.plan) viz.append(h('button', { type: 'button', class: 'btn small rerun', onclick: () => rerun(card) }, 'Run again'));
      return;
    }
    if (card.fallback || !card.spec || typeof window.vegaEmbed !== 'function') {
      viz.classList.add('viz-table');
      viz.append(renderTable(rows, card.columns));
      return;
    }
    // a hidden Charts tab (the Review view opens on Data) has no width to size to: draw it when the tab is shown
    if (state.view !== 'charts') { card._stale = true; return; }
    card._stale = false;
    viz.classList.add('viz-chart');
    const target = h('div', { class: 'vega-target' });
    viz.append(target);
    try {
      const res = await window.vegaEmbed(target, prepareSpec(card.spec, rows, { width: viz.clientWidth - 28 }), {
        actions: false, renderer: 'svg', tooltip: { theme: isDark() ? 'dark' : 'light' },
      });
      card._view = res.view;
      if (card.drill) bindDrill(card, res.view, viz);
    } catch (e) {
      viz.textContent = '';
      viz.classList.replace('viz-chart', 'viz-table');
      viz.append(h('p', { class: 'muted small viz-note' }, `Chart couldn't render (${e.message}). Showing the data instead.`), renderTable(rows, card.columns));
    }
  }
  // "How this was calculated": a plain-language plan, what the numbers cover, and what was assumed. Open by default on
  // answers to your own questions, where the AI made the choices; closed on suggested charts.
  function explainBlock(card) {
    const e = card.explain;
    return h('details', { class: 'explain', open: card.asked || MODES[state.mode].explain ? true : null },
      h('summary', null, 'How this was calculated'),
      e.how ? h('p', { class: 'explain-how' }, e.how, e.source === 'ai' ? h('span', { class: 'explain-by muted' }, ' (the AI\'s own description of its query)') : null) : null,
      e.coverage ? h('p', { class: 'explain-cov' }, e.coverage) : null,
      e.assumptions?.length ? h('div', { class: 'explain-assume' }, h('b', null, 'Assumptions and caveats'), h('ul', null, e.assumptions.map((a) => h('li', null, a)))) : null);
  }

  // ---- check this number: re-derive the chart another way (every mark's rows, the whole-table total) and say what holds ----
  async function runCheck(card) {
    const panel = card._checkPanel;
    if (!panel || !state.duck || !state.dataset) return;
    card._checkCtl?.abort();
    const ctl = new AbortController();
    card._checkCtl = ctl;
    const profile = state.dataset.profile;
    const plan = planChecks(card, profile);
    const close = h('button', { type: 'button', class: 'btn tiny ghost', 'aria-label': 'Close the check', onclick: () => { ctl.abort(); panel.hidden = true; } }, '\u2715');
    const head = h('div', { class: 'drill-head' }, h('b', null, 'Check this number'), close);
    const progress = h('p', { class: 'check-progress muted small pad' });
    panel.hidden = false;
    panel.replaceChildren(head, progress);
    const total = plan.marks.length + (plan.totals ? 2 : 0);
    let done = 0;
    const tick = () => { progress.textContent = total ? `Re-checking with ${total} queries… ${done} done` : 'Checking…'; };
    tick();
    const t0 = performance.now();
    const run = async (sql) => { const r = await state.duck.query(sql, { limit: null, signal: ctl.signal }); done++; tick(); return r.rows[0]; };
    try {
      const marks = [];
      const queue = plan.marks.slice();
      const worker = async () => { for (let k = queue.shift(); k; k = queue.shift()) marks.push({ ...k, agg: await run(k.aggSql) }); };
      const totals = plan.totals ? Promise.all([run(plan.totals.all), run(plan.totals.base)]).then(([all, base]) => ({ all, base })) : Promise.resolve(null);
      const [, , , , t] = await Promise.all([worker(), worker(), worker(), worker(), totals]);
      if (ctl.signal.aborted) return;
      const res = summarizeChecks(card, profile, { marks, totals: t, skipped: plan.skipped });
      const title = { ok: '\u2713 Checks out', warn: '\u26A0 Needs a look', partial: 'Only basic checks were possible' }[res.verdict];
      const icon = { ok: '\u2713', warn: '\u26A0', info: 'i' };
      panel.replaceChildren(head,
        h('p', { class: `check-verdict ${res.verdict}` }, title),
        h('ul', { class: 'check-list' }, res.items.map((i) => h('li', { class: i.level }, h('span', { class: 'check-ico', 'aria-hidden': 'true' }, icon[i.level]), i.text))),
        h('p', { class: 'check-foot muted small' }, `${total ? `Re-ran ${total} queries in ${((performance.now() - t0) / 1000).toFixed(1)} s. ` : ''}This confirms the chart matches the data it was built from. It can't tell you whether the data itself is right.`));
    } catch (e) {
      if (e?.name === 'AbortError') return;
      panel.replaceChildren(head, h('p', { class: 'check-verdict warn' }, `Couldn't finish the check: ${e?.message || e}`));
    }
  }

  // ---- drill-through: click a mark, see the rows behind it and whether they add up to the number on the chart ----
  function bindDrill(card, view, viz) {
    viz.classList.add('drillable');
    viz.append(h('p', { class: 'drill-hint muted small' }, 'Click a mark to see the rows behind it.'));
    view.addEventListener('click', (_ev, item) => {
      const datum = item?.datum;
      if (!datum) return;
      const row = rowForDatum(card.rows || [], datum, drillFields(card.drill));
      if (row) openDrill(card, row);
    });
  }
  async function openDrill(card, row) {
    const panel = card._drillPanel;
    if (!panel || !state.duck || !state.dataset) return;
    const w = drillWhere(card.drill, row, card.rows || []);
    const close = h('button', { type: 'button', class: 'btn tiny ghost', 'aria-label': 'Close the rows behind this mark', onclick: () => { card._drillCtl?.abort(); panel.hidden = true; } }, '✕');
    panel.hidden = false;
    if (!w) { panel.replaceChildren(h('div', { class: 'drill-head' }, h('b', null, 'Rows behind this mark'), close), h('p', { class: 'muted small pad' }, "This mark can't be traced to rows.")); return; }
    card._drillCtl?.abort();
    const ctl = new AbortController();
    card._drillCtl = ctl;
    const head = h('div', { class: 'drill-head' }, h('div', null, h('b', null, 'Rows behind this mark'), h('span', { class: 'drill-label muted' }, w.label)), close);
    panel.replaceChildren(head, h('p', { class: 'drill-loading muted small pad' }, 'Finding the rows…'));
    try {
      const names = state.dataset.profile.columns.map((c) => c.name);
      const sql = drillSql(card.drill, w.where, { columns: drillColumns(card.drill, names), limit: 100 });
      const [agg, rows] = await Promise.all([
        state.duck.query(sql.aggSql, { limit: null, signal: ctl.signal }),
        state.duck.query(sql.rowsSql, { limit: null, autoExtend: false, signal: ctl.signal }), // reads the file for columns outside the working set
      ]);
      if (ctl.signal.aborted) return;
      const rec = reconcile(card.drill, row, agg.rows[0]);
      const m = card.drill.measure || {};
      const isCount = m.fn === 'COUNT' || !m.column;
      const what = `${m.fn === 'AVG' ? 'average' : 'total'} ${m.column}`;
      const full = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n); // a reconciliation shows every digit
      const check = rec.ok === true ? h('p', { class: 'drill-check ok' }, isCount
          ? `✓ ${full(rec.count)} rows: exactly the count on the chart.`
          : `✓ ${full(rec.count)} rows, and their ${what} is ${full(rec.actual)}: the same as the chart.`)
        : rec.ok === false ? h('p', { class: 'drill-check warn' }, isCount
          ? `⚠ ${full(rec.count)} rows match this mark, but the chart shows ${full(rec.expected)}. Treat this chart with care.`
          : `⚠ These ${full(rec.count)} rows give ${full(rec.actual)} for ${what}, but the chart shows ${full(rec.expected)}. Treat this chart with care.`)
        : h('p', { class: 'drill-check muted' }, `${full(rec.count)} rows.`);
      const more = rec.count > rows.rows.length ? h('p', { class: 'muted small table-more' }, `Showing the first ${fmtNum(rows.rows.length)} of ${fmtNum(rec.count)} rows. The Data tab has them all.`) : null;
      const roles = new Map(state.dataset.profile.columns.map((c) => [c.name, columnRole(c)]));
      panel.replaceChildren(head, check, renderTable(rows.rows, rows.columns, 100, (name, v) => (v == null ? '∅' : formatCell(v, roles.get(name) || 'text').text)), more);
    } catch (e) {
      if (e?.name === 'AbortError') return;
      panel.replaceChildren(head, h('p', { class: 'drill-check warn' }, `Couldn't load the rows: ${e?.message || e}`));
    }
  }
  // A chart that is queued or running: its title, question and SQL show at once, with a live timer and Cancel.
  function renderPendingCard(card) {
    const running = card.pending === 'running';
    const el = h('article', { class: `card pending size-${card.layout?.size || 'm'}`, 'aria-busy': 'true', dataset: { id: card.id, section: card.layout?.section || '' } });
    el._card = card;
    const cancel = h('button', { type: 'button', class: 'btn tiny cancel', onclick: () => controllerFor(card.id).abort() }, 'Cancel');
    el.append(
      h('header', { class: 'card-head' },
        h('div', { class: 'card-titles' }, h('h3', null, card.title || 'Untitled'), card.question && card.question !== card.title ? h('p', { class: 'card-q' }, card.question) : null),
        h('span', { class: `tag tag-${running ? 'running' : 'queued'}` }, running ? 'running' : 'queued')),
      h('div', { class: 'viz viz-pending' },
        h('p', { class: 'pending-status small' }, running
          ? ['Running query · ', h('span', { class: 'pending-time', dataset: { since: String(card.startedAt) } }, '0 ms')]
          : 'Queued: starts when a DuckDB worker is free.'),
        card.sql ? h('pre', { class: 'sql pending-sql' }, h('code', null, card.sql)) : null),
      h('footer', { class: 'card-foot' }, cancel, cardMenu(card, [])));
    card._el = el;
    return el;
  }
  function removeCard(card) {
    state.controllers.get(card.id)?.abort();
    state.cards = state.cards.filter((c) => c !== card);
    renderGrid();
  }
  // The card's "⋯" menu: the given actions, then Remove. Items are { label(), onclick, role?, checked?, cls?, title? }.
  function cardMenu(card, items) {
    const btn = h('button', { type: 'button', class: 'btn tiny card-menu-btn', 'aria-haspopup': 'menu', 'aria-label': 'More actions', title: 'More actions' }, '⋯');
    const list = h('div', { class: 'menu card-menu', role: 'menu', 'aria-label': 'Chart actions', hidden: true });
    const pop = attachPopover(btn, list);
    const all = [...items.filter(Boolean), { label: () => 'Remove', cls: 'remove danger', onclick: () => removeCard(card) }];
    const els = all.map((it) => {
      const b = h('button', { type: 'button', role: it.role || 'menuitem', class: `menu-item ${it.cls || ''}`, title: it.title || null });
      const sync = () => { b.textContent = it.label(); if (it.checked) b.setAttribute('aria-checked', String(!!it.checked())); };
      b.addEventListener('click', () => { pop.close(); it.onclick(); sync(); });
      sync();
      return b;
    });
    list.append(...els);
    return h('div', { class: 'menu-wrap' }, btn, list);
  }
  function downloadCSV(card) {
    const url = URL.createObjectURL(new Blob([toCSV(card.rows || [], card.columns)], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: csvFileName(card.title || card.question) });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  // Swap one card in place (by id) without touching the others' rendered charts.
  function updateCard(id, patch) {
    const i = state.cards.findIndex((c) => c.id === id);
    if (i < 0) return;
    const old = state.cards[i];
    const next = typeof patch === 'function' ? patch(old) : { ...old, ...patch };
    next._el = null;
    state.cards[i] = next;
    const el = renderCard(next);
    if (old._el?.isConnected) { try { old._view?.finalize?.(); } catch { /* ignore */ } old._el.replaceWith(el); } else renderGrid();
  }
  // One AbortController per chart, created on first use, so Cancel works even before the pipeline asks for the signal.
  function controllerFor(id) {
    if (!state.controllers.has(id)) state.controllers.set(id, new AbortController());
    return state.controllers.get(id);
  }
  function abortPendingCharts() {
    for (const c of state.controllers.values()) c.abort();
    state.controllers.clear();
  }
  // A new file or sample: drop any cache in progress (charts are cancelled separately)
  function abortCache() {
    state.cacheCtl?.abort();
    state.cache = null;
    renderCacheBanner();
    if (state.duck) state.duck.onWorkingSet = onWorkingSetEvent;
  }
  async function rerun(card) {
    const ctl = new AbortController();
    state.controllers.set(card.id, ctl);
    updateCard(card.id, { pending: 'queued', cancelled: false });
    const run = startRun(`Chart: ${card.title}`);
    const done = await state.pipeline.run(card.plan, run.trace, {
      signal: ctl.signal,
      onStart: () => updateCard(card.id, { pending: 'running', startedAt: performance.now() }),
    });
    state.controllers.delete(card.id);
    endRun(run, !done.error && !done.cancelled);
    updateCard(card.id, (c) => ({ ...done, id: c.id, heuristic: c.heuristic, pinned: c.pinned, plan: c.plan }));
  }

  // Cards in layout order (answers and pinned first, then by section and priority). Rendered charts are moved, not redrawn.
  function renderGrid() {
    const order = orderCards(state.cards);
    for (const c of order) if (!c._el || c._stale) renderCard(c);
    const keep = new Set(order.map((c) => c._el));
    for (const el of [...grid.querySelectorAll(':scope > .card:not(.skeleton)')]) {
      if (!keep.has(el)) { try { el._card?._view?.finalize?.(); } catch { /* ignore */ } el.remove(); }
    }
    for (const c of order) grid.append(c._el);
    syncShell();
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch { /* fall through */ }
    try {
      const ta = h('textarea', { class: 'sr-only' }); ta.value = t; document.body.append(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch { return false; }
  }

  // ---------- flows ----------
  function setBusy(b) {
    state.busy = b;
    openBtn.disabled = b;
    root.classList.toggle('is-busy', b);
    syncAsk();
    syncShell();
  }

  // npm run serve has a relay for this machine's own pages (serve.mjs); the deployed site doesn't, so the probe fails there
  let localRelayP = null;
  function localRelay() {
    if (!localRelayP) {
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
      localRelayP = local ? fetch('/__relay?probe=1', { method: 'HEAD' }).then((r) => r.headers.get('x-datadrop-relay') === 'local').catch(() => false) : Promise.resolve(false);
    }
    return localRelayP;
  }

  async function loadUrl(url) {
    setView('charts'); // loading progress and the first charts show there
    abortPendingCharts();
    abortCache();
    const seq = ++state.loadSeq;
    setStatus(`Loading ${shortUrl(url)}…`);
    setBusy(true);
    showLoading(4, true);
    const run = startRun('Load');
    try {
      const t0 = performance.now();
      run.trace({ agent: 'fetch', status: 'start', message: `Fetching ${shortUrl(url)}` });
      const duckP = ensureDuck(run.trace); // boot DuckDB in parallel with the download
      duckP.catch(() => {});
      const go = async (proxied) => {
      // Parquet on a server with range requests: query it in place instead of downloading it all.
      const remote = resolveRemoteFile ? await resolveRemoteFile(url, { proxied }).catch(() => null) : null;
      if (remote) {
        run.trace({ agent: 'fetch', status: 'done', message: `${remote.fileName} · ${fmtBytes(remote.sizeBytes)} · parquet, read in place`, ms: performance.now() - t0 });
        if (seq !== state.loadSeq) return endRun(run, true);
        await duckP;
        await loadInput({ remoteUrl: remote.url, format: remote.format, fileName: remote.fileName }, { source: remote.source, sizeBytes: remote.sizeBytes }, run, seq);
        return;
      }
      let f;
      try {
        f = await fetchGitHubFile(url, { proxied });
      } catch (e) {
        run.trace({ agent: 'fetch', status: 'error', message: e.message, ms: performance.now() - t0 });
        throw e;
      }
      run.trace({ agent: 'fetch', status: 'done', message: `${f.fileName}${f.fileCount ? ` × ${f.fileCount} files` : ''} · ${fmtBytes(f.sizeBytes ?? f.bytes?.byteLength)} · ${f.format}`, ms: performance.now() - t0 });
      if (seq !== state.loadSeq) return endRun(run, true);
      await duckP;
      await loadInput({ bytes: f.bytes, parts: f.parts, format: f.format, fileName: f.fileName }, { source: f.source, sizeBytes: f.sizeBytes ?? f.bytes?.byteLength, fileCount: f.fileCount }, run, seq);
      };
      try { await go(null); } catch (e) {
        // the server blocks browsers: if the user set up a relay of their own, read this one link through it
        let proxy = parseProxy(state.settings.corsProxy).template;
        let local = false;
        if (e?.blocked && !proxy && await localRelay()) { proxy = `${location.origin}/__relay?url={url}`; local = true; }
        if (!(e?.blocked && proxy) || seq !== state.loadSeq) throw e;
        setStatus(`${new URL(e.downloadUrl).host} blocks browsers, so this link is read through ${local ? 'the relay built into your local server' : 'your proxy'}…`);
        run.trace({ agent: 'fetch', status: 'retry', message: `Blocked by the server: trying ${local ? 'the local relay' : 'your CORS proxy'}` });
        await go(applyProxy(proxy, e.downloadUrl));
      }
    } catch (e) {
      if (seq !== state.loadSeq) return;
      endRun(run, false);
      clearLoading();
      setStatus(`Couldn't load that file: ${e.message || e}`, 'error', e.blocked ? { label: 'Download the file', href: e.downloadUrl } : null);
      setBusy(false);
      renderLinkHint(); // the how-to for this kind of link, next to the error
    }
  }

  async function loadLocalFile(file) {
    setView('charts');
    abortPendingCharts();
    abortCache();
    const seq = ++state.loadSeq;
    setStatus(`Loading ${file.name}…`);
    const format = formatForName(file.name);
    if (!format) { setStatus(`Couldn't load that file: ${file.name} isn't CSV, TSV, JSON, NDJSON or Parquet.`, 'error'); return; }
    setBusy(true);
    showLoading(4, true);
    const run = startRun('Load');
    try {
      const t0 = performance.now();
      run.trace({ agent: 'file', status: 'start', message: `Reading ${file.name}` });
      const duckP = ensureDuck(run.trace);
      duckP.catch(() => {});
      const bytes = new Uint8Array(await file.arrayBuffer());
      run.trace({ agent: 'file', status: 'done', message: `${file.name} · ${fmtBytes(bytes.byteLength)}`, ms: performance.now() - t0 });
      await duckP;
      await loadInput({ bytes, format, fileName: file.name }, { source: null, sizeBytes: bytes.byteLength }, run, seq);
    } catch (e) {
      if (seq !== state.loadSeq) return;
      endRun(run, false);
      clearLoading();
      setStatus(`Couldn't load that file: ${e.message || e}`, 'error');
      setBusy(false);
    }
  }

  async function loadInput(input, meta, run, seq) {
    const { profile, tableName } = await state.pipeline.load(input, run.trace);
    if (seq !== state.loadSeq) return endRun(run, true);
    state.pipelineHasData = true;
    state.dataset = { profile, tableName: tableName || profile?.table, source: meta.source, fileName: input.fileName, fileCount: meta.fileCount, sizeBytes: meta.sizeBytes, input };
    state.cards = [];
    setStatus('');
    endRun(run, true);
    renderDataset();
    linkHint.hidden = true;
    const tab = state.pendingTab || MODES[state.mode].tab; // a link's tab, else the view's own (Review opens on the rows)
    state.pendingTab = null;
    if (tab !== 'charts') setView(tab);
    renderModeChip();
    updateShare();
    if (meta.source?.owner) {
      urlInput.value = githubUrlFor(meta.source);
      try { history.replaceState(null, '', location.pathname + hashFor(meta.source)); } catch { /* ignore */ }
    } else if (meta.source?.url) {
      urlInput.value = meta.source.url;
      try { history.replaceState(null, '', `${location.pathname}?url=${encodeURIComponent(meta.source.url)}`); } catch { /* ignore */ }
    } else {
      try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
    }
    document.title = `${input.fileName} · DataDrop`;
    await suggest(seq);
  }

  async function ensurePipelineData(run) {
    if (state.pipelineHasData || !state.dataset) return;
    // pipeline was recreated (settings changed): re-register the cached bytes
    const r = await state.pipeline.load(state.dataset.input, run.trace);
    state.dataset.profile = r.profile || state.dataset.profile;
    state.dataset.tableName = r.tableName || state.dataset.tableName;
    state.pipelineHasData = true;
  }

  // ---------- views and share links ----------
  const prefStorage = () => { try { return localStorage; } catch { return null; } };
  function applyMode(mode, { user = false, rail = false } = {}) {
    if (!isMode(mode)) return;
    const m = MODES[mode];
    state.mode = mode;
    root.dataset.mode = mode;
    root.dataset.density = m.density;
    viewSelect.value = mode;
    viewSelect.title = m.hint;
    explorer.setDensity(m.density);
    if (user) { state.prefs.mode = mode; savePrefs(prefStorage(), state.prefs); }
    if (rail) setRail(m.rail);
    if (user && state.dataset) setView(m.tab);
    for (const d of document.querySelectorAll('.card:not(.asked) details.explain')) d.open = m.explain;
    renderModeChip();
    updateShare();
  }
  function renderModeChip() {
    const p = state.dataset?.profile;
    const s = p ? suggestMode(p) : null;
    const key = p ? metricKey(p) : '';
    const show = !!s && state.mode !== s && !state.prefs.dismissed[key];
    modeChip.hidden = !show;
    modeChip.textContent = '';
    if (!show) return;
    modeChip.append(h('span', { class: 'notice-text' }, h('b', null, 'Looks like transactions.'), ' Review opens on the rows, with a compact layout.'),
      h('button', { type: 'button', class: 'btn tiny primary mode-switch', onclick: () => applyMode(s, { user: true, rail: true }) }, 'Switch to Review'),
      h('button', { type: 'button', class: 'btn tiny ghost mode-dismiss', onclick: () => { state.prefs.dismissed[key] = true; savePrefs(prefStorage(), state.prefs); renderModeChip(); } }, 'Not now'));
  }
  function shareUrl() {
    const src = state.dataset?.source;
    return src?.owner ? githubUrlFor(src) : src?.url || null;
  }
  const currentShare = () => buildShareLink({ origin: location.origin, pathname: location.pathname, url: shareUrl(), view: state.mode, tab: state.view });
  function updateShare() {
    const ok = !!state.dataset && !!currentShare();
    shareBtn.disabled = !ok;
    shareBtn.title = !state.dataset ? 'Load a dataset first' : ok ? 'Copy a link that reopens this dataset in this view' : "A file from your computer can't be shared by link";
  }
  async function shareLink() {
    const link = currentShare();
    if (!link) return;
    const ok = await copyText(link);
    shareBtn.textContent = ok ? 'Link copied' : 'Copy failed';
    setTimeout(() => { shareBtn.textContent = 'Share'; }, 1600);
  }

  // ---------- working set: cache the columns the charts use, then run them locally ----------
  // Decided once charts are planned (suggest's beforeRun), from the estimated memory of exactly those columns and the
  // browser's memory signals: green -> build now (charts wait for it, then run in milliseconds), yellow -> one-click
  // offer (charts read the file meanwhile), red -> light mode. "Large files" in Settings: working set (default) /
  // fast mode (every column) / prefer low memory. Questions that need more columns extend it (Duck.onWorkingSet).
  async function planWorkingSet(plans, seq) {
    const p = state.dataset?.profile;
    const duck = state.duck;
    if (!p?.remote || !state.pipeline?.buildWorkingSet || !duck?.remoteColumns) { state.cache = null; renderCacheBanner(); return; }
    const all = duck.remoteColumns(p.table) || p.columns.map((c) => c.name);
    const mode = state.settings.cacheMode || 'ask';
    const cols = mode === 'fast' ? all : unionColumns(plans.map((x) => x.sql), all, p.table);
    if (!cols.length) { state.cache = null; renderCacheBanner(); return; }
    const est = estimateSample(p, cols);
    // progress is measured in bytes read, which also counts the file's footer once per worker
    if (duck.workingSetDownloadMB) est.downloadMB = duck.workingSetDownloadMB(p.table, cols);
    const signals = readMemorySignals();
    duck.memoryBudgetMB = memoryBudgetMB(signals);
    duck.workingSetKeep = new Set(cols);
    const tier = memoryTier(est.memoryMB, signals);
    const d = cacheDecision(tier, mode === 'fast' ? 'fast' : mode === 'light' ? 'light' : 'ask');
    state.cache = { status: d.action === 'auto' ? 'building' : d.action === 'ask' ? 'asking' : 'light', reason: d.reason, tier, est, cols, readMB: 0 };
    renderCacheBanner();
    if (d.action === 'auto') await buildWorkingSet(seq);
  }
  async function buildWorkingSet(seq = state.loadSeq) {
    const c = state.cache;
    if (!c) return;
    const ctl = new AbortController();
    state.cacheCtl = ctl;
    state.cache = { ...c, status: 'building', readMB: 0, error: null };
    renderCacheBanner();
    const run = startRun('Working set');
    try {
      await state.pipeline.buildWorkingSet(c.cols, run.trace, {
        signal: ctl.signal,
        memoryBudgetMB: state.duck.memoryBudgetMB,
        onProgress: ({ fraction, readMB }) => {
          if (state.cache?.status !== 'building' || seq !== state.loadSeq) return;
          state.cache.readMB = readMB ?? fraction * state.cache.est.downloadMB; // finished share of the expected download
          renderCacheBanner();
        },
      });
      endRun(run, true);
      if (seq !== state.loadSeq || ctl.signal.aborted) return;
      state.cache = { ...state.cache, status: 'ready' };
    } catch (e) {
      endRun(run, false);
      if (seq !== state.loadSeq) return;
      state.cache = { ...state.cache, status: 'light', reason: e?.name === 'AbortError' ? 'cancelled' : e?.name === 'MemoryError' ? 'memory' : 'error', error: e?.message || String(e) };
    } finally {
      if (state.cacheCtl === ctl) state.cacheCtl = null;
    }
    renderCacheBanner();
  }
  async function clearWorkingSet() {
    state.cacheCtl?.abort();
    await state.pipeline?.clearWorkingSet?.();
    if (state.cache) state.cache = { ...state.cache, status: 'light', reason: 'cleared' };
    renderCacheBanner();
    syncWorkingSetControls();
  }
  // Questions that need columns outside the working set: Duck extends it (or reads the file) and tells us here.
  function onWorkingSetEvent(ev) {
    if (!state.cache || ev.type !== 'extend') return;
    const n = ev.columns.length;
    if (ev.phase === 'start') state.cache = { ...state.cache, status: 'extending', adding: ev.columns };
    else if (ev.phase === 'done') state.cache = { ...state.cache, status: 'ready', cols: [...state.cache.cols, ...ev.columns], adding: null };
    else if (ev.phase === 'refused') state.cache = { ...state.cache, status: 'ready', note: `Not enough memory to add ${n} column${n > 1 ? 's' : ''}; that question reads the file instead.` };
    else state.cache = { ...state.cache, status: 'ready', adding: null };
    renderCacheBanner();
  }
  function renderCacheBanner() {
    const c = state.cache;
    cacheBanner.textContent = '';
    cacheBanner.hidden = !c;
    syncWorkingSetControls();
    syncExplorerHint();
    if (!c) return;
    cacheBanner.dataset.status = c.status;
    const n = c.cols?.length || 0;
    const ncols = `${n} column${n === 1 ? '' : 's'}`;
    const btn = (label, onclick, cls = 'btn small') => h('button', { type: 'button', class: cls, onclick }, label);
    const light = () => { state.cacheCtl?.abort(); state.cache = { ...state.cache, status: 'light', reason: 'choice' }; renderCacheBanner(); };
    if (c.status === 'building') {
      const pct = c.est.downloadMB > 0 ? Math.min(99, Math.round((c.readMB / c.est.downloadMB) * 100)) : null;
      cacheBanner.append(
        h('span', { class: 'cache-msg' }, h('b', null, `Building working set (${ncols})…`),
          ` ${fmtMB(c.readMB)}${c.readMB < c.est.downloadMB ? ` of ~${fmtMB(c.est.downloadMB)}` : ''} downloaded.`),
        h('progress', { class: 'cache-progress', max: 100, value: pct ?? undefined, 'aria-label': 'Working set progress' }),
        btn('Cancel', light, 'btn small ghost'));
    } else if (c.status === 'extending') {
      const k = c.adding?.length || 0;
      cacheBanner.append(h('span', { class: 'cache-msg' }, h('b', null, `Adding ${k} column${k === 1 ? '' : 's'} to working set…`)));
    } else if (c.status === 'asking') {
      cacheBanner.append(
        h('span', { class: 'cache-msg' }, h('b', null, 'Make charts instant?'), ` A working set of the ${ncols} these charts use takes about ${fmtMB(c.est.memoryMB)} of memory (one ~${fmtMB(c.est.downloadMB)} download).`),
        btn('Build it', () => buildWorkingSet(), 'btn small primary'), btn('Keep light mode', light, 'btn small ghost'));
    } else if (c.status === 'ready') {
      cacheBanner.append(h('span', { class: 'cache-msg' }, h('b', null, 'Working set ready'), ` · charts instant (${ncols} in memory).`, c.note ? ` ${c.note}` : ''),
        btn('×', () => { cacheBanner.hidden = true; }, 'btn small ghost dismiss'));
    } else {
      const why = c.reason === 'memory' ? `This browser has limited memory for a working set (${fmtMB(c.est.memoryMB)}), so DataDrop uses light mode: each chart reads the file (slower).`
        : c.reason === 'preference' ? 'Light mode (your Large files setting): each chart reads the file.'
        : c.reason === 'cleared' ? 'Working set cleared: each chart reads the file.'
        : c.reason === 'error' ? `Couldn't build the working set (${c.error}). Using light mode: each chart reads the file.`
        : 'Light mode: each chart reads the file (slower, lighter on memory).';
      cacheBanner.append(h('span', { class: 'cache-msg' }, why),
        c.reason !== 'memory' ? btn('Build working set', () => buildWorkingSet(), 'btn small') : null);
    }
  }
  function syncWorkingSetControls() { sClear.disabled = !(state.cache && ['ready', 'extending'].includes(state.cache.status)); }
  function fmtMB(mb) { return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(0, Math.round(mb))} MB`; }

  // ---------- sampling (remote Parquet too large to scan) ----------
  const SAMPLE_SIZES = [1_000_000, 5_000_000, 10_000_000];
  function samplePanel(p) {
    const s = p.sampleInfo || {};
    const spread = s.mode !== 'window';
    const what = spread
      ? `spread across the file in ${s.slices} slice${s.slices > 1 ? 's' : ''}`
      : `rows ${fmtNum(s.firstRow)}–${fmtNum(s.endRow)} in file order (not random)`;
    // charts touch ~2 columns: estimate from the median column's compressed bytes/row
    const per = p.columns.map((c) => c.bytesPerRow).filter((b) => b > 0).sort((a, b) => a - b);
    const chartBytes = per.length ? per[Math.floor(per.length / 2)] * 2 * p.rowCount : null;
    const size = h('select', { class: 'sample-size', 'aria-label': 'Sample size', onchange: () => resample({ mode: s.mode || 'spread', rows: Number(size.value), offset: s.firstRow }) },
      SAMPLE_SIZES.map((n) => h('option', { value: n, selected: Math.abs(n - (s.rows || p.rowCount)) < 1 ? true : null }, `${fmtNum(n)} rows`)));
    const btn = (label, sample, active) => h('button', { type: 'button', class: `btn small${active ? ' active' : ''}`, 'aria-pressed': String(!!active), onclick: () => resample(sample) }, label);
    const rows = s.rows || p.rowCount;
    return h('div', { class: 'sample-panel', role: 'note', tabindex: '-1' },
      h('p', { class: 'sample-head' }, h('b', null, `Sample: ${fmtNum(p.rowCount)} of ${fmtNum(p.totalRows)} rows`), `, ${what}.`),
      h('p', { class: 'small' }, 'This file is too large to scan in the browser, so charts and questions use only these rows.',
        chartBytes ? ` Without a working set, each chart downloads about ${fmtBytes(chartBytes)}.` : ''),
      h('div', { class: 'sample-actions' },
        btn('Spread', { mode: 'spread', rows }, spread),
        btn('First rows', { mode: 'window', rows, offset: 0 }, !spread && s.firstRow === 0),
        btn('Next rows →', { mode: 'window', rows, offset: spread ? 0 : s.endRow }, false),
        size));
  }

  async function resample(sample) {
    abortPendingCharts();
    abortCache();
    const seq = ++state.loadSeq;
    setStatus('');
    setBusy(true);
    showLoading(3, true);
    const run = startRun('Resample');
    try {
      const { profile } = await state.pipeline.resample(sample, run.trace);
      if (seq !== state.loadSeq) return endRun(run, true);
      state.dataset = { ...state.dataset, profile, input: { ...state.dataset.input, sample } };
      state.cards = state.cards.filter((c) => c.pinned);
      endRun(run, true);
      renderDataset();
      await suggest(seq);
    } catch (e) {
      if (seq !== state.loadSeq) return;
      endRun(run, false);
      clearLoading();
      setStatus(`Couldn't change the sample: ${e.message || e}`, 'error');
      setBusy(false);
    }
  }

  // Plans show up as placeholder cards right away; each chart replaces its placeholder as soon as its query is done.
  async function suggest(seq = state.loadSeq) {
    abortPendingCharts();
    setBusy(true);
    showLoading(hasLLM() ? 4 : 3, true);
    const run = startRun('Suggest');
    const heuristic = !hasLLM();
    const kept = state.cards.filter((c) => c.asked || c.pinned);
    const live = () => seq === state.loadSeq;
    let streamed = false;
    try {
      await ensurePipelineData(run);
      const cards = await state.pipeline.suggest(run.trace, {
        onPlans: (plans) => {
          streamed = true;
          if (!live()) return;
          clearLoading();
          state.cards = [...kept, ...plans.map((p) => ({ id: p.id, title: p.title, question: p.question, sql: p.sql, layout: p.layout, plan: p, heuristic, pending: 'queued', rows: [] }))];
          renderGrid();
          setBusy(false); // charts keep streaming in; loading another file or asking is fine meanwhile
        },
        beforeRun: (plans) => (live() ? planWorkingSet(plans, seq) : null),
        signalFor: (id) => controllerFor(id).signal,
        // only a card still waiting can start: never flip a finished card back to "running"
        onStart: (id) => { if (live() && state.cards.find((c) => c.id === id)?.pending) updateCard(id, { pending: 'running', startedAt: performance.now() }); },
        onCard: (card) => {
          state.controllers.delete(card.id);
          if (live()) updateCard(card.id, (c) => ({ ...card, heuristic, pinned: c.pinned, plan: c.plan }));
        },
      });
      if (!live()) return endRun(run, true);
      // a pipeline that doesn't stream just returns the finished cards
      if (!streamed) state.cards = [...kept, ...(cards || []).map((c) => ({ ...c, heuristic }))];
      endRun(run, true);
      if (!cards?.length) setStatus('No charts were suggested for this dataset. Try asking a question, or check the Data panel.', 'info');
    } catch (e) {
      endRun(run, false);
      if (live()) setStatus(`Couldn't suggest charts: ${e.message || e}`, 'error');
    } finally {
      if (live()) { clearLoading(); renderGrid(); setBusy(false); }
    }
  }

  async function ask(question) {
    if (!state.dataset) return;
    if (!hasLLM()) { setStatus('Questions need an AI provider. Add an API key in Settings.', 'info'); return; }
    setView('charts'); // the answer is a chart card
    setStatus('');
    setBusy(true);
    const sk = skeletonCard();
    sk.classList.add('asked');
    grid.prepend(sk);
    syncShell();
    const label = question.length > 48 ? `${question.slice(0, 46)}…` : question;
    const run = startRun(`Ask: ${label}`);
    run.el.title = question;
    try {
      await ensurePipelineData(run);
      const card = await state.pipeline.ask(question, run.trace);
      state.cards.unshift({ ...card, question: card.question || question, id: card.id || `a-${Date.now()}`, asked: true });
      endRun(run, !card.error);
      askInput.value = '';
    } catch (e) {
      endRun(run, false);
      state.cards.unshift({ id: `a-${Date.now()}`, title: question, question, error: e.message || String(e), asked: true, rows: [] });
    } finally {
      sk.remove();
      renderGrid();
      setBusy(false);
      askInput.focus();
    }
  }

  function showLoading(n, replace) {
    if (replace) { for (const c of state.cards) { try { c._view?.finalize?.(); } catch { /* */ } } grid.textContent = ''; }
    syncShell();
    for (let i = 0; i < n; i++) grid.append(skeletonCard());
  }
  function clearLoading() {
    grid.querySelectorAll('.card.skeleton').forEach((n) => n.remove());
    syncShell();
  }
  function shortUrl(u) {
    return String(u).replace(/^https?:\/\/(www\.)?/, '').replace(/^github\.com\//, '').slice(0, 80);
  }

  // ---------- settings drawer ----------
  let lastFocus = null;
  function fillSettingsForm() {
    const s = state.settings;
    sProvider.value = s.provider in PROVIDERS ? s.provider : 'none';
    sKey.value = s.apiKey || '';
    sModel.value = s.model || '';
    sBase.value = s.baseUrl || '';
    sCache.value = s.cacheMode || 'ask';
    sProxy.value = s.corsProxy || '';
    sSteps.checked = !!s.showSteps;
    syncSettingsFields();
  }
  function syncSettingsFields() {
    const p = sProvider.value;
    keyField.hidden = p === 'none';
    modelField.hidden = p === 'none';
    baseField.hidden = p !== 'openai';
    sModel.placeholder = PROVIDERS[p].model;
    sKey.placeholder = p === 'anthropic' ? 'sk-ant-…' : 'sk-…';
    sMsg.textContent = '';
  }
  sProvider.addEventListener('change', () => {
    // swap model default if the user hadn't customised it
    if (Object.values(PROVIDERS).some((x) => x.model === sModel.value)) sModel.value = '';
    syncSettingsFields();
  });
  function openSettings() {
    lastFocus = document.activeElement;
    fillSettingsForm();
    drawer.hidden = false;
    requestAnimationFrame(() => drawer.classList.add('open'));
    (sProvider.value === 'none' ? sProvider : sKey).focus();
  }
  function closeSettings() {
    drawer.classList.remove('open');
    drawer.hidden = true;
    lastFocus?.focus?.();
  }
  function applySettings() {
    const next = { provider: sProvider.value, apiKey: sKey.value.trim(), model: sModel.value.trim(), baseUrl: sBase.value.trim(), cacheMode: sCache.value, showSteps: sSteps.checked, corsProxy: sProxy.value.trim() };
    const px = parseProxy(next.corsProxy);
    if (px.error) { sMsg.textContent = px.error; sProxy.focus(); return; }
    if (next.provider !== 'none' && !next.apiKey) { sMsg.textContent = 'Enter an API key, or choose None.'; sKey.focus(); return; }
    const ai = (s) => JSON.stringify({ ...s, cacheMode: undefined, showSteps: undefined, corsProxy: undefined });
    const changed = ai(next) !== ai(state.settings);
    const cacheChanged = next.cacheMode !== (state.settings.cacheMode || 'ask');
    state.settings = next;
    const persisted = saveSettings(next);
    closeSettings();
    updateLive();
    if (!persisted) setStatus('Settings apply to this tab only: this browser blocked local storage.', 'info');
    if (changed) { // a new LLM means a new pipeline (which reloads the file); the large-file setting alone doesn't
      rebuildPipeline();
      if (state.dataset && state.pipeline && !state.busy) suggest();
    } else if (cacheChanged && state.dataset && state.pipeline && !state.busy) {
      suggest(); // re-plan the working set under the new setting
    }
  }
  settingsBtn.addEventListener('click', openSettings);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) closeSettings(); });

  // ---------- Escape closes the activity slide-over and the columns sheet ----------
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !drawer.hidden) return;
    if (!slideover.hidden) closeActivity();
    else if (isNarrow() && sheetOpen) setRail(false);
  });

  // ---------- file input + drag/drop ----------
  fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) loadLocalFile(f); fileInput.value = ''; });
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropOverlay.hidden = false; });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropOverlay.hidden = true; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; dropOverlay.hidden = true;
    const f = e.dataTransfer.files?.[0];
    if (f) loadLocalFile(f);
  });

  // ---------- theme changes -> redraw charts ----------
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    for (const c of state.cards) if (!c.error && c._el) drawViz(c);
  });

  // ---------- routing ----------
  window.addEventListener('hashchange', () => {
    const u = hashUrl();
    if (u && githubUrlFor(state.dataset?.source) !== `https://github.com/${u}`) { urlInput.value = `https://github.com/${u}`; loadUrl(u); }
  });

  // ---------- boot ----------
  const share = parseShare(location.search); // a shared link's view and tab apply to this visit only; they are not saved
  state.mode = share.view || state.prefs.mode;
  state.pendingTab = share.tab || null;
  rebuildPipeline();
  renderDataset();
  syncAsk();
  applyMode(state.mode, { rail: !!share.view });
  const start = initialUrl();
  if (start) {
    urlInput.value = /^[a-z][a-z0-9]*:\/\//i.test(start) ? start : `https://github.com/${start}`;
    loadUrl(start);
  }

  return { state, loadUrl, ask, openSettings };
}
