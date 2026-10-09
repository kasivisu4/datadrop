// The Data tab: a virtualized grid over the loaded table plus a record view for one row.
// Rows come from DuckDB a page at a time (only the visible columns are selected, so a remote Parquet file downloads
// just those); the grid keeps ~30 pages and renders only the rows on screen. Pure helpers are in gridmodel.js.
import { h } from './dom.js';
import {
  PAGE_SIZE, columnRole, formatCell, copyValue, defaultWidth, defaultVisible, displayOrder,
  windowFor, scrollTopFor, pagesFor, columnGroups,
} from './gridmodel.js';

const GUTTER = 58;
const HEAD_H = 58;
const ROW_H = { comfortable: 36, compact: 28 };
const MAX_PAGES = 30;
const MAX_COLS = 30; // columns shown at first (12 for a remote file: each one is a download)
const MAX_COLS_REMOTE = 12;
const LOADING = 'loading';
const NOROW = Object.freeze({}); // a row the table doesn't have (profile count was off): shown empty
const nf = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const ROLE_LABEL = { money: 'amount', decimal: 'decimal', int: 'integer', id: 'identifier', date: 'date', datetime: 'timestamp', bool: 'boolean', category: 'category', json: 'nested', text: 'text' };
const NUMERIC = new Set(['money', 'decimal', 'int']);

const ICON = {
  sortUp: '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M5 1.5 9 7H1z" fill="currentColor"/></svg>',
  sortDown: '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M5 8.5 1 3h8z" fill="currentColor"/></svg>',
  dots: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="3.2" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="12.8" r="1.4" fill="currentColor"/></svg>',
  up: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  down: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  pin: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M9.5 1.5 14.5 6.5 12.6 7.4 10.7 11.4 9.7 10.4 6.6 13.5 5.2 14.9l-.1-2.6 3.1-3.1-1-1 4-1.9z" fill="currentColor"/></svg>',
};
const svg = (name) => { const s = h('span', { class: 'ex-ico', 'aria-hidden': 'true' }); s.innerHTML = ICON[name]; return s; };

/**
 * fetchPage(table, { columns | null, sort, offset, limit, signal }) -> Promise<{ rows }> (Duck.pageRows); fastColumns(table) -> the
 * names already in memory (a working set) or null; copyText(text) -> Promise<boolean>.
 * Returns { el, setDataset({ profile, tableName } | null), activate(bool), setHint(text), revealColumn(name) }.
 */
export function createExplorer({ fetchPage, fastColumns, copyText }) {
  // ---- state ----
  let ds = null;
  let cols = []; // profile columns, table order
  let roles = new Map();
  let widths = new Map();
  let visible = new Set();
  let pinned = new Set();
  let sort = null; // { column, dir }
  let density = 'comfortable';
  let total = 0;
  let pages = new Map();
  let partial = new Set(); // pages whose column groups haven't all arrived
  let fetchedCols = new Set();
  let gen = 0;
  let ctl = new AbortController();
  let active = false;
  let dirty = false;
  let selected = null;
  let rowEls = new Map();
  let cur = { first: 0, count: 1, offset: 0, spacerH: 0 };
  let viewH = 300;
  let disp = []; // displayed columns: { c, idx, role, left? }
  let hint = '';
  let loadError = '';
  let fetchTimer = null;
  let raf = 0;
  let pop = null;
  let popAnchor = null;
  const rec = { open: false, row: null, data: null, loading: false, error: '', filter: '', hideEmpty: false, cache: new Map(), gen: 0 };
  const rowH = () => ROW_H[density];

  // ---- elements ----
  const columnsBtn = h('button', { type: 'button', class: 'btn tiny ex-columns', 'aria-haspopup': 'dialog', onclick: () => openColumnPicker() });
  const densityBtn = h('button', { type: 'button', class: 'btn tiny ex-density', title: 'Row height', onclick: () => setDensity(density === 'comfortable' ? 'compact' : 'comfortable') });
  const jumpInput = h('input', { type: 'number', class: 'ex-jump', min: '1', placeholder: 'Go to row', 'aria-label': 'Go to row number', inputmode: 'numeric',
    onkeydown: (e) => { if (e.key === 'Enter') { const n = Math.floor(Number(jumpInput.value)); if (n >= 1 && total) { jumpTo(Math.min(n, total) - 1); jumpInput.blur(); } } } });
  const sortChip = h('button', { type: 'button', class: 'ex-chip ex-sortchip', hidden: true, title: 'Clear sort', onclick: () => setSort(null) });
  const resetBtn = h('button', { type: 'button', class: 'btn tiny ghost ex-reset', hidden: true, onclick: () => resetView() }, 'Reset view');
  const toolbar = h('div', { class: 'ex-toolbar' }, columnsBtn, densityBtn, h('label', { class: 'ex-jumpwrap' }, jumpInput), sortChip, resetBtn);

  const head = h('div', { class: 'ex-head', role: 'row' });
  const rows = h('div', { class: 'ex-rows' });
  const vp = h('div', { class: 'ex-vp' }, rows);
  const spacer = h('div', { class: 'ex-spacer' }, vp);
  const inner = h('div', { class: 'ex-inner' }, head, spacer);
  const scroller = h('div', { class: 'ex-scroll', tabindex: '0', role: 'grid', 'aria-label': 'Table rows. Arrow keys move between rows, Enter opens the record.' }, inner);
  const statusLeft = h('span', { class: 'ex-status-left' });
  const loader = h('span', { class: 'ex-loader', hidden: true });
  const statusErr = h('span', { class: 'ex-status-err', role: 'alert' });
  const statusHint = h('span', { class: 'ex-status-hint muted' });
  const status = h('div', { class: 'ex-status', role: 'status' }, statusLeft, loader, statusErr, statusHint);
  const toast = h('div', { class: 'ex-toast', role: 'status', 'aria-live': 'polite', hidden: true });
  const empty = h('div', { class: 'ex-empty muted', hidden: true });

  const recTitle = h('div', { class: 'ex-rec-title' });
  const recPrev = h('button', { type: 'button', class: 'btn tiny', 'aria-label': 'Previous row', title: 'Previous row (↑)', onclick: () => step(-1) }, svg('up'));
  const recNext = h('button', { type: 'button', class: 'btn tiny', 'aria-label': 'Next row', title: 'Next row (↓)', onclick: () => step(1) }, svg('down'));
  const recCopy = h('button', { type: 'button', class: 'btn tiny', onclick: async () => { if (rec.data) say(await copyText(JSON.stringify(rec.data, null, 2)) ? 'Row copied as JSON' : 'Copy failed'); } }, 'Copy JSON');
  const recClose = h('button', { type: 'button', class: 'btn tiny ghost', 'aria-label': 'Close record', onclick: () => closeRecord() }, '✕');
  const recFilter = h('input', { type: 'search', class: 'ex-rec-filter', placeholder: 'Find a field', 'aria-label': 'Find a field', oninput: () => { rec.filter = recFilter.value.trim().toLowerCase(); renderRecord(); } });
  const recHide = h('input', { type: 'checkbox', onchange: () => { rec.hideEmpty = recHide.checked; renderRecord(); } });
  const recBody = h('div', { class: 'ex-rec-body' });
  const recordPanel = h('aside', { class: 'ex-record', 'aria-label': 'Record', hidden: true },
    h('div', { class: 'ex-rec-head' }, recTitle, h('div', { class: 'ex-rec-actions' }, recPrev, recNext, recCopy, recClose)),
    h('div', { class: 'ex-rec-tools' }, recFilter, h('label', { class: 'ex-rec-empty' }, recHide, ' Hide empty')),
    recBody);

  const body = h('div', { class: 'ex-body' }, h('div', { class: 'ex-gridwrap' }, scroller, empty, status), recordPanel);
  const root = h('section', { class: 'explorer', 'aria-label': 'Data', hidden: true }, toolbar, body, toast);

  // ---- small helpers ----
  const fmt = (n) => nf.format(n);
  let toastTimer = null;
  function say(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 1600);
  }
  const roleOf = (c) => roles.get(c.name) || 'text';
  const widthOf = (c) => widths.get(c.name) || 140;
  const defaults = () => defaultVisible(cols, ds?.profile?.remote ? MAX_COLS_REMOTE : MAX_COLS);
  const colIndex = (name) => cols.findIndex((c) => c.name === name);
  const sortKey = () => (sort ? `${sort.column}|${sort.dir}` : '');

  // ---- dataset ----
  function setDataset(next) {
    abortAll();
    ds = next;
    cols = ds?.profile?.columns || [];
    total = ds?.profile?.rowCount || 0;
    roles = new Map(cols.map((c) => [c.name, columnRole(c)]));
    widths = new Map(cols.map((c) => [c.name, defaultWidth(c, roles.get(c.name))]));
    visible = new Set(defaults());
    pinned = new Set();
    sort = null;
    selected = null;
    pages.clear();
    rec.cache.clear();
    closeRecord(true);
    closePopover();
    loadError = '';
    root.hidden = !ds;
    dirty = true;
    if (active) init();
  }
  function activate(on) {
    active = !!on;
    root.hidden = !ds || !active;
    if (active && dirty) init();
    else if (active) { measure(); render(); fetchVisible(); }
  }
  function init() {
    dirty = false;
    fetchedCols = new Set(visible);
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
    rebuild();
    fetchVisible();
  }
  function abortAll() {
    gen++;
    ctl.abort();
    ctl = new AbortController();
    pages = new Map();
    partial = new Set();
    clearTimeout(fetchTimer);
  }
  // data for the current columns/sort is stale: drop it and start again from the top of what's on screen
  function refetch() {
    abortAll();
    fetchedCols = new Set(visible);
    loadError = '';
    rec.cache.clear();
    render();
    fetchVisible();
  }

  // ---- layout ----
  function measure() {
    viewH = Math.max(rowH() * 3, scroller.clientHeight - HEAD_H);
    vp.style.height = `${viewH}px`;
  }
  function rebuild() {
    disp = displayOrder(cols, visible, pinned).map((c) => ({ c, idx: colIndex(c.name), role: roleOf(c) }));
    let left = 'var(--gutter)';
    for (const d of disp) {
      if (pinned.has(d.c.name)) { d.left = `calc(${left})`; left += ` + var(--w-${d.idx})`; }
    }
    const lastPinned = [...disp].reverse().find((d) => pinned.has(d.c.name));
    for (const d of disp) d.lastPin = d === lastPinned;
    inner.style.setProperty('--gutter', `${GUTTER}px`);
    for (const c of cols) inner.style.setProperty(`--w-${colIndex(c.name)}`, `${widthOf(c)}px`);
    syncInnerWidth();
    renderHead();
    rowEls = new Map();
    rows.textContent = '';
    scroller.setAttribute('aria-rowcount', String(total + 1));
    scroller.setAttribute('aria-colcount', String(disp.length));
    columnsBtn.textContent = `Columns · ${visible.size} of ${cols.length}`;
    densityBtn.textContent = density === 'compact' ? 'Compact rows' : 'Comfortable rows';
    sortChip.hidden = !sort;
    if (sort) sortChip.textContent = `Sorted by ${sort.column} ${sort.dir === 'asc' ? '↑' : '↓'}  ✕`;
    const dv = defaults();
    resetBtn.hidden = !(sort || pinned.size || visible.size !== dv.length || dv.some((n) => !visible.has(n)));
    empty.hidden = total > 0 || !ds;
    empty.textContent = ds && !total ? 'This table has no rows.' : '';
    measure();
    render();
  }
  function syncInnerWidth() {
    inner.style.width = `${GUTTER + disp.reduce((n, d) => n + widthOf(d.c), 0)}px`;
  }
  function headMeta(c, role) {
    const parts = [ROLE_LABEL[role]];
    if (NUMERIC.has(role) && c.min != null && c.max != null && typeof c.min === 'number') parts.push(`${compact.format(c.min)} – ${compact.format(c.max)}`);
    else if ((role === 'date' || role === 'datetime') && c.min != null) parts.push(`${String(c.min).slice(0, 10)} → ${String(c.max).slice(0, 10)}`);
    else if (c.distinct != null) parts.push(`${compact.format(c.distinct)} distinct`);
    if (Number(c.nullPct) > 0) parts.push(`${Number(c.nullPct) >= 10 ? Math.round(c.nullPct) : Number(c.nullPct).toFixed(1)}% null`);
    return parts.join(' · ');
  }
  function renderHead() {
    head.textContent = '';
    head.append(h('div', { class: 'ex-hcell ex-gutter', role: 'columnheader', 'aria-label': 'Row number' }, '#'));
    for (const d of disp) {
      const { c, idx, role } = d;
      const sorted = sort?.column === c.name ? sort.dir : null;
      const cell = h('div', {
        class: `ex-hcell${NUMERIC.has(role) ? ' num' : ''}${pinned.has(c.name) ? ' pin' : ''}${d.lastPin ? ' pin-last' : ''}${sorted ? ' sorted' : ''}`,
        role: 'columnheader', 'aria-sort': sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : 'none',
        dataset: { col: c.name }, style: { width: `var(--w-${idx})`, ...(d.left ? { left: d.left } : {}) },
      },
        h('div', { class: 'ex-htop' },
          h('button', { type: 'button', class: 'ex-hname', title: `${c.name} · ${String(c.type || '').toLowerCase()}. Click to sort`, onclick: () => cycleSort(c.name) },
            pinned.has(c.name) ? svg('pin') : null, h('span', { class: 'ex-nm' }, c.name), sorted ? svg(sorted === 'asc' ? 'sortUp' : 'sortDown') : null),
          h('button', { type: 'button', class: 'ex-hmenu', 'aria-label': `Column options for ${c.name}`, 'aria-haspopup': 'dialog', onclick: (e) => openColumnMenu(c, e.currentTarget) }, svg('dots'))),
        h('div', { class: 'ex-hmeta', title: headMeta(c, role) }, headMeta(c, role)),
        h('div', { class: 'ex-resize', 'aria-hidden': 'true', onpointerdown: (e) => startResize(e, c) }));
      head.append(cell);
    }
  }
  function startResize(e, c) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const w0 = widthOf(c);
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const w = Math.max(64, Math.min(700, Math.round(w0 + ev.clientX - startX)));
      widths.set(c.name, w);
      inner.style.setProperty(`--w-${colIndex(c.name)}`, `${w}px`);
      syncInnerWidth();
    };
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  // ---- rows ----
  function refFor(i) {
    const p = pages.get(Math.floor(i / PAGE_SIZE));
    if (Array.isArray(p)) return p[i % PAGE_SIZE] || NOROW;
    return p && p !== LOADING ? p : LOADING;
  }
  function buildRow(i, ref) {
    const el = h('div', { class: `ex-row${i % 2 ? ' odd' : ''}${i === selected ? ' sel' : ''}`, role: 'row', 'aria-rowindex': String(i + 2), dataset: { i: String(i) }, style: { height: `${rowH()}px` } },
      h('div', { class: 'ex-cell ex-gutter', role: 'rowheader' }, fmt(i + 1)));
    const failed = ref && ref !== LOADING && ref !== NOROW && ref.error;
    if (failed) el.classList.add('failed');
    disp.forEach((d, k) => {
      const style = { width: `var(--w-${d.idx})`, ...(d.left ? { left: d.left } : {}) };
      const pin = pinned.has(d.c.name) ? ` pin${d.lastPin ? ' pin-last' : ''}` : '';
      if (ref === LOADING) { el.append(h('div', { class: `ex-cell sk${pin}`, style, role: 'gridcell' }, h('i', { style: { width: `${40 + ((i * 7 + k * 13) % 45)}%` } }))); return; }
      if (failed) { el.append(h('div', { class: `ex-cell err${pin}`, style, role: 'gridcell' }, k === 0 ? 'Couldn\'t load these rows. Click to retry.' : '')); return; }
      if (ref === NOROW) { el.append(h('div', { class: `ex-cell${pin}`, style, role: 'gridcell' })); return; }
      if (!(d.c.name in ref)) { el.append(h('div', { class: `ex-cell sk${pin}`, style, role: 'gridcell' }, h('i', { style: { width: `${40 + ((i * 7 + k * 13) % 45)}%` } }))); return; } // this column's group is still on its way
      const f = formatCell(ref[d.c.name], d.role);
      el.append(h('div', { class: `ex-cell r-${d.role}${f.cls ? ` ${f.cls}` : ''}${pin}`, role: 'gridcell', title: f.title, style },
        f.cls === 'pill' ? h('span', { class: `pill-v${f.tone ? ` tone-${f.tone}` : ''}` }, f.text) : f.text));
    });
    return el;
  }
  function render() {
    if (!ds || !active) return;
    cur = windowFor({ scrollTop: scroller.scrollTop, viewH, total, rowH: rowH() });
    spacer.style.height = `${cur.spacerH}px`;
    rows.style.transform = `translateY(${cur.offset}px)`;
    const last = Math.min(total, cur.first + cur.count + 1);
    const keep = new Map();
    const order = [];
    for (let i = cur.first; i < last; i++) {
      const ref = refFor(i);
      let ent = rowEls.get(i);
      if (!ent || ent.ref !== ref) ent = { el: buildRow(i, ref), ref };
      keep.set(i, ent);
      order.push(ent.el);
    }
    rowEls = keep;
    rows.replaceChildren(...order);
    updateStatus();
  }
  function updateStatus() {
    const lastRow = Math.min(total, cur.first + Math.floor((viewH - cur.offset - 1) / rowH()) + 1);
    const sample = ds?.profile?.totalRows > total ? ` (a sample of ${fmt(ds.profile.totalRows)})` : '';
    statusLeft.textContent = total ? `Rows ${fmt(cur.first + 1)}–${fmt(lastRow)} of ${fmt(total)}${sample}` : '';
    const busy = partial.size > 0 || [...pages.values()].some((p) => p === LOADING);
    loader.hidden = !busy;
    loader.textContent = busy ? (sort ? 'Sorting…' : 'Loading…') : '';
    statusErr.textContent = loadError;
    statusHint.textContent = hint;
  }
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; render(); scheduleFetch(); });
  }

  // ---- fetching ----
  function scheduleFetch() { clearTimeout(fetchTimer); fetchTimer = setTimeout(fetchVisible, 90); }
  function fetchVisible() {
    if (!ds || !active || !total) return;
    const w = windowFor({ scrollTop: scroller.scrollTop, viewH, total, rowH: rowH() });
    for (const p of pagesFor(w.first, w.count, total)) if (!pages.has(p)) loadPage(p);
  }
  function loadPage(p) {
    const myGen = gen;
    const names = disp.map((d) => d.c.name);
    const groups = columnGroups(names, { remote: !!ds.profile?.remote && !sort, fast: fastColumns?.(ds.tableName) });
    const offset = p * PAGE_SIZE;
    let left = groups.length;
    let failed = false;
    let acc = null;
    pages.set(p, LOADING);
    if (groups.length > 1) partial.add(p);
    for (const n of names) fetchedCols.add(n);
    updateStatus();
    for (const columns of groups) {
      fetchPage(ds.tableName, { columns, sort, offset, limit: PAGE_SIZE, signal: ctl.signal }).then((res) => {
        if (myGen !== gen || failed) return;
        acc = acc ? acc.map((r, i) => ({ ...r, ...res.rows[i] })) : res.rows.map((r) => ({ ...r })); // new row objects, so the grid redraws them
        pages.set(p, acc);
        if (--left === 0) partial.delete(p);
        loadError = '';
        evict();
        render();
        if (rec.open && selected != null && Math.floor(selected / PAGE_SIZE) === p) loadRecord();
      }, (e) => {
        if (myGen !== gen || failed || e?.name === 'AbortError') return;
        failed = true;
        partial.delete(p);
        pages.set(p, { error: e?.message || String(e) });
        loadError = `Couldn't load rows: ${e?.message || e}`;
        render();
      });
    }
  }
  function evict() {
    if (pages.size <= MAX_PAGES) return;
    const keep = new Set(pagesFor(cur.first, cur.count, total));
    for (const k of [...pages.keys()]) {
      if (pages.size <= MAX_PAGES) break;
      if (!keep.has(k)) pages.delete(k);
    }
  }

  // ---- view changes ----
  function cycleSort(name) {
    if (sort?.column !== name) setSort({ column: name, dir: 'asc' });
    else if (sort.dir === 'asc') setSort({ column: name, dir: 'desc' });
    else setSort(null);
  }
  function setSort(next) {
    sort = next;
    selected = null;
    closeRecord(true);
    scroller.scrollTop = 0;
    rebuild();
    refetch();
  }
  function setDensity(d) {
    density = d;
    rowEls = new Map();
    densityBtn.textContent = density === 'compact' ? 'Compact rows' : 'Comfortable rows';
    measure();
    render();
    scheduleFetch();
  }
  function setVisible(name, on) {
    if (!on && visible.size <= 1) return;
    on ? visible.add(name) : visible.delete(name);
    if (!on) pinned.delete(name);
    const grew = [...visible].some((n) => !fetchedCols.has(n));
    rebuild();
    if (grew) refetch();
  }
  function togglePin(name) {
    pinned.has(name) ? pinned.delete(name) : pinned.add(name);
    rebuild();
  }
  function resetView() {
    sort = null;
    pinned = new Set();
    visible = new Set(defaults());
    widths = new Map(cols.map((c) => [c.name, defaultWidth(c, roles.get(c.name))]));
    selected = null;
    closeRecord(true);
    scroller.scrollTop = 0;
    rebuild();
    refetch();
  }
  function revealColumn(name) {
    if (!ds || colIndex(name) < 0) return;
    if (!visible.has(name)) setVisible(name, true);
    const idx = disp.findIndex((d) => d.c.name === name);
    const left = GUTTER + disp.slice(0, idx).reduce((n, d) => n + widthOf(d.c), 0);
    scroller.scrollLeft = Math.max(0, left - 140);
    const cell = [...head.querySelectorAll('.ex-hcell[data-col]')].find((el) => el.dataset.col === name);
    cell?.classList.add('flash');
    setTimeout(() => cell?.classList.remove('flash'), 1400);
  }

  // ---- selection, navigation ----
  function visibleRowCount() { return Math.max(1, Math.floor(viewH / rowH())); }
  function reveal(i) {
    const rh = rowH();
    if (!cur.scaled) {
      const top = i * rh;
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (top + rh > scroller.scrollTop + viewH) scroller.scrollTop = top + rh - viewH;
    } else if (i < cur.first || i >= cur.first + visibleRowCount() - 1) {
      scroller.scrollTop = scrollTopFor(Math.max(0, i - 2), { viewH, total, rowH: rh });
    }
  }
  function jumpTo(i) {
    scroller.scrollTop = scrollTopFor(i, { viewH, total, rowH: rowH() });
    select(i, { open: rec.open });
    render();
    fetchVisible();
  }
  function select(i, { open = false, scroll = false } = {}) {
    if (i == null || i < 0 || i >= total) return;
    selected = i;
    if (scroll) { reveal(i); render(); scheduleFetch(); }
    for (const [k, ent] of rowEls) ent.el.classList.toggle('sel', k === i);
    if (open) openRecord(i);
  }
  function step(d) {
    const base = selected ?? cur.first - (d > 0 ? 1 : -1);
    select(Math.max(0, Math.min(total - 1, base + d)), { open: rec.open, scroll: true });
  }
  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('keydown', (e) => {
    if (!total) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); step(k === 'ArrowDown' ? 1 : -1); }
    else if (k === 'PageDown' || k === 'PageUp') { e.preventDefault(); step((k === 'PageDown' ? 1 : -1) * Math.max(1, visibleRowCount() - 1)); }
    else if (k === 'Home' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); select(0, { open: rec.open, scroll: true }); }
    else if (k === 'End' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); select(total - 1, { open: rec.open, scroll: true }); }
    else if (k === 'Enter' || k === ' ') { if (selected != null) { e.preventDefault(); openRecord(selected); } }
    else if (k === 'Escape') { if (rec.open) { e.preventDefault(); closeRecord(); } }
  });
  rows.addEventListener('click', (e) => {
    const rowEl = e.target.closest('.ex-row');
    if (!rowEl) return;
    if (window.getSelection?.().toString()) return; // dragging to select text isn't a click
    const i = Number(rowEl.dataset.i);
    if (rowEl.classList.contains('failed')) { pages.delete(Math.floor(i / PAGE_SIZE)); loadError = ''; render(); fetchVisible(); return; }
    scroller.focus({ preventScroll: true });
    select(i, { open: true });
  });
  rows.addEventListener('dblclick', async (e) => {
    const cell = e.target.closest('.ex-cell:not(.ex-gutter)');
    const rowEl = e.target.closest('.ex-row');
    if (!cell || !rowEl) return;
    const k = [...rowEl.children].indexOf(cell) - 1;
    const ref = refFor(Number(rowEl.dataset.i));
    if (k < 0 || !ref || ref === LOADING || ref.error) return;
    say(await copyText(copyValue(ref[disp[k].c.name])) ? 'Copied' : 'Copy failed');
  });

  // ---- record view ----
  function openRecord(i) {
    rec.open = true;
    rec.row = i;
    selected = i;
    for (const [k, ent] of rowEls) ent.el.classList.toggle('sel', k === i);
    recordPanel.hidden = false;
    root.classList.add('has-record');
    loadRecord();
  }
  function closeRecord(silent) {
    rec.open = false;
    rec.row = null;
    rec.data = null;
    recordPanel.hidden = true;
    root.classList.remove('has-record');
    if (!silent && active) scroller.focus({ preventScroll: true });
  }
  function loadRecord() {
    const i = rec.row;
    if (i == null) return;
    const myGen = ++rec.gen;
    const cached = rec.cache.get(`${sortKey()}|${i}`);
    const page = pages.get(Math.floor(i / PAGE_SIZE));
    const pageRow = Array.isArray(page) ? page[i % PAGE_SIZE] : null;
    rec.error = '';
    if (cached) rec.data = cached;
    else if (pageRow && cols.every((c) => c.name in pageRow)) rec.data = pageRow; // every column is already in the grid
    else { rec.data = null; rec.loading = true; }
    rec.loading = !rec.data;
    renderRecord();
    if (rec.data) return;
    fetchPage(ds.tableName, { columns: null, sort, offset: i, limit: 1, signal: ctl.signal }).then((res) => {
      if (myGen !== rec.gen) return;
      rec.data = res.rows[0] || null;
      if (rec.data) { rec.cache.set(`${sortKey()}|${i}`, rec.data); if (rec.cache.size > 50) rec.cache.delete(rec.cache.keys().next().value); }
      rec.loading = false;
      renderRecord();
    }, (e) => {
      if (myGen !== rec.gen || e?.name === 'AbortError') return;
      rec.loading = false;
      rec.error = e?.message || String(e);
      renderRecord();
    });
  }
  const URL_RE = /^https?:\/\/[^\s<>"]+$/i;
  function fieldValue(value, role) {
    if (value != null && typeof value === 'object') return h('pre', { class: 'ex-json' }, JSON.stringify(value, null, 2));
    if (typeof value === 'string' && URL_RE.test(value)) return h('a', { href: value, target: '_blank', rel: 'noopener noreferrer', class: 'ex-link', onclick: (e) => e.stopPropagation() }, value);
    const f = typeof value === 'string' && role !== 'date' && role !== 'datetime' && role !== 'category'
      ? { text: value, cls: role === 'id' ? 'id' : '' } // the record shows long text in full
      : formatCell(value, role);
    return f.cls === 'pill' ? h('span', { class: `pill-v${f.tone ? ` tone-${f.tone}` : ''}` }, f.text) : f.text;
  }
  function renderRecord() {
    recBody.textContent = '';
    recTitle.textContent = rec.row == null ? '' : `Row ${fmt(rec.row + 1)} of ${fmt(total)}`;
    recPrev.disabled = rec.row == null || rec.row <= 0;
    recNext.disabled = rec.row == null || rec.row >= total - 1;
    recCopy.disabled = !rec.data;
    if (rec.loading) { recBody.append(h('div', { class: 'ex-rec-loading' }, ...Array.from({ length: 7 }, () => h('div', { class: 'sk-line' })))); return; }
    if (rec.error) { recBody.append(h('p', { class: 'ex-rec-err' }, `Couldn't load this row: ${rec.error}`)); return; }
    if (!rec.data) { recBody.append(h('p', { class: 'muted small pad' }, 'Row not found.')); return; }
    const shown = cols.filter((c) => {
      const v = rec.data[c.name];
      if (rec.hideEmpty && (v == null || v === '')) return false;
      return !rec.filter || c.name.toLowerCase().includes(rec.filter);
    });
    if (!shown.length) { recBody.append(h('p', { class: 'muted small pad' }, 'No fields match.')); return; }
    const dl = h('dl', { class: 'ex-fields' });
    for (const c of shown) {
      const role = roleOf(c);
      const v = rec.data[c.name];
      const f = formatCell(v, role);
      const copy = async () => say(await copyText(copyValue(v)) ? `Copied ${c.name}` : 'Copy failed');
      const val = h('div', {
        role: 'button', tabindex: '0', class: `ex-fval r-${role}${f.cls && f.cls !== 'pill' ? ` ${f.cls}` : ''}`, title: 'Click to copy',
        onclick: () => { if (!window.getSelection?.().toString()) copy(); },
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); copy(); } },
      }, fieldValue(v, role));
      dl.append(h('div', { class: 'ex-field', dataset: { col: c.name } },
        h('dt', null, h('span', { class: 'ex-fname' }, c.name), h('span', { class: 'ex-ftype' }, String(c.type || '').toLowerCase())),
        h('dd', null, val)));
    }
    recBody.append(dl);
  }

  // ---- popovers: column menu and column picker ----
  function closePopover() {
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener('pointerdown', outside, true);
    popAnchor = null;
  }
  function outside(e) { if (pop && !pop.contains(e.target) && !popAnchor?.contains(e.target)) closePopover(); }
  function openPopover(anchor, content, cls = '') {
    const same = popAnchor === anchor;
    closePopover();
    if (same) return;
    popAnchor = anchor;
    pop = h('div', { class: `ex-pop ${cls}`, role: 'dialog' }, content);
    root.append(pop);
    const r = anchor.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(4, Math.min(r.left - rr.left, rr.width - w - 4))}px`;
    pop.style.top = `${r.bottom - rr.top + 4}px`;
    document.addEventListener('pointerdown', outside, true);
  }
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop) { e.stopPropagation(); const a = popAnchor; closePopover(); a?.focus?.(); } });

  function openColumnMenu(c, anchor) {
    const role = roleOf(c);
    const item = (label, fn, extra = '') => h('button', { type: 'button', class: `ex-mi ${extra}`, onclick: () => { closePopover(); fn(); } }, label);
    const stat = (k, v) => (v == null || v === '' ? null : h('div', null, h('dt', null, k), h('dd', null, String(v))));
    const range = c.min != null && c.max != null && c.kind !== 'nominal' ? `${formatCell(c.min, role).text} → ${formatCell(c.max, role).text}` : null;
    const top = c.topValues?.length ? c.topValues.slice(0, 5).map((t) => `${formatCell(t.value, 'text').text} (${compact.format(t.count)})`).join(', ') : null;
    openPopover(anchor, [
      h('div', { class: 'ex-pop-title' }, h('b', null, c.name), h('span', { class: 'muted' }, ` ${String(c.type || '').toLowerCase()} · ${ROLE_LABEL[role]}`)),
      h('dl', { class: 'ex-stats' },
        stat('Distinct', c.distinct != null ? fmt(c.distinct) : null),
        stat('Empty', c.nullPct != null ? `${Number(c.nullPct) >= 10 ? Math.round(c.nullPct) : Number(c.nullPct).toFixed(1)}%` : null),
        stat('Range', range), stat('Mean', typeof c.mean === 'number' ? formatCell(c.mean, role === 'int' ? 'decimal' : role).text : null), stat('Top values', top)),
      h('div', { class: 'ex-menu' },
        item('Sort ascending ↑', () => setSort({ column: c.name, dir: 'asc' }), sort?.column === c.name && sort.dir === 'asc' ? 'on' : ''),
        item('Sort descending ↓', () => setSort({ column: c.name, dir: 'desc' }), sort?.column === c.name && sort.dir === 'desc' ? 'on' : ''),
        sort?.column === c.name ? item('Clear sort', () => setSort(null)) : null,
        item(pinned.has(c.name) ? 'Unpin column' : 'Pin column to the left', () => togglePin(c.name)),
        visible.size > 1 ? item('Hide column', () => setVisible(c.name, false)) : null,
        item('Copy column name', async () => say(await copyText(c.name) ? 'Copied' : 'Copy failed'))),
    ], 'ex-pop-menu');
  }

  function openColumnPicker() {
    const list = h('div', { class: 'ex-pick-list' });
    const search = h('input', { type: 'search', class: 'ex-pick-search', placeholder: 'Find a column', 'aria-label': 'Find a column' });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      list.textContent = '';
      for (const c of cols.filter((x) => !q || x.name.toLowerCase().includes(q))) {
        const cb = h('input', { type: 'checkbox', checked: visible.has(c.name) || null, onchange: () => { setVisible(c.name, cb.checked); cb.checked = visible.has(c.name); count.textContent = `${visible.size} of ${cols.length} shown`; } });
        list.append(h('label', { class: 'ex-pick-row' }, cb, h('span', { class: 'ex-pick-name' }, c.name), h('span', { class: 'ex-pick-role' }, ROLE_LABEL[roleOf(c)])));
      }
      if (!list.childElementCount) list.append(h('p', { class: 'muted small pad' }, 'No columns match.'));
    };
    const count = h('span', { class: 'muted small' }, `${visible.size} of ${cols.length} shown`);
    const all = h('button', { type: 'button', class: 'btn tiny', onclick: () => { for (const c of cols) visible.add(c.name); rebuild(); refetch(); draw(); count.textContent = `${visible.size} of ${cols.length} shown`; } }, 'Show all');
    const defaults = h('button', { type: 'button', class: 'btn tiny', onclick: () => { visible = new Set(defaults()); rebuild(); refetch(); draw(); count.textContent = `${visible.size} of ${cols.length} shown`; } }, 'Defaults');
    search.addEventListener('input', draw);
    draw();
    openPopover(columnsBtn, [h('div', { class: 'ex-pop-title' }, h('b', null, 'Columns'), count), search, list, h('div', { class: 'ex-pick-foot' }, all, defaults)], 'ex-pop-picker');
    search.focus();
  }

  new ResizeObserver(() => { if (ds && active) { measure(); render(); scheduleFetch(); } }).observe(scroller);

  return {
    el: root,
    setDataset,
    activate,
    revealColumn,
    setHint(text) { hint = text || ''; statusHint.textContent = hint; },
    setDensity,
  };
}
