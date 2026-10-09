# DataDrop — contract (Option 1: swap the URL, get a dashboard)

Static, all-in-browser app. Paste a GitHub file URL (or open `/?url=<github url>`, or
`/#/owner/repo/blob/branch/path`) → DuckDB-WASM loads the file → agents propose charts → user
asks questions in English → NL2SQL → chart.

No backend. LLM is called from the browser with the user's own API key (stored in localStorage).

## Layout

```
src/
  main.js                 entry, bundled by esbuild -> dist/app.js
  data/github.js          GitHub URL parsing/resolution (pure, no DOM)
  data/links.js           share links (Drive, Sheets, Dropbox, OneDrive…) -> direct URLs, help text, format sniffing
  data/duck.js            DuckDB-WASM wrapper
  agents/llm.js           LLM client (Anthropic + OpenAI-compatible) + mock
  agents/prompts.js       prompt builders (pure strings)
  agents/pipeline.js      agents + orchestrator
  ui/app.js               DOM, rendering, events
  ui/explorer.js          Data tab: virtualized grid + record view (createExplorer)
  ui/gridmodel.js         Data tab logic, pure: column roles, formatCell, windowFor, pagesFor, columnGroups
  ui/dom.js               h() DOM helper
  data/roles.js           column meaning: identifier, additive vs level measure, status-like (shared by charts and the Data tab)
  data/modes.js           views (Overview/Explore/Review), suggestMode, prefs, share links (pure)
  data/metrics.js         metric definitions: validate, save per dataset, prompt block, suggestions (pure)
  ui/metrics.js           metric cards + define form
  data/sqlguard.js        read-only SQL guard (agents + SQL box)
  data/sqlexamples.js     starter queries from a profile
  ui/sqlbox.js            SQL tab
  data/drill.js           click on a mark -> WHERE + the rows + reconcile (pure)
  data/check.js           "Check this number": plan the re-queries, summarize the verdict (pure)
  agents/explain.js       "How this was calculated": plan sentence, coverage, caveats (pure)
  ui/chartstyle.js        chart styling, pure: theme config, single hue, time-tick thinning (prepareSpec)
  ui/csv.js               CSV export of a card's rows, pure (toCSV, csvFileName)
  ui/popover.js           popover / menu behaviour (card "⋯" menu, Examples menu)
  ui/styles.css           copied to dist/
public/index.html         copied to dist/
tests/                    node tests (node --test) + playwright e2e
build.mjs                 esbuild bundle + copy duckdb wasm/worker + vega UMD into dist/
```

Libraries (already in node_modules): `@duckdb/duckdb-wasm@1.29.0`, `vega@5.30.0`,
`vega-lite@5.21.0`, `vega-embed@6.26.0`, `esbuild@0.24.0`. NOTE: cdn.jsdelivr is NOT reachable
from the dev container; everything is vendored into dist/. raw.githubusercontent.com IS reachable
and sends `access-control-allow-origin: *`.

Vega is loaded as UMD `<script>` tags in index.html (globals `vega`, `vegaLite`, `vegaEmbed`),
files copied to `dist/vendor/`. DuckDB is bundled by esbuild via import; its worker + wasm are
copied to `dist/duckdb/` (eh + mvp variants).

## Module interfaces

### data/github.js  (pure functions, ESM exports)
```js
parseGitHubUrl(input: string) -> { owner, repo, ref, path, kind: 'blob'|'raw'|'tree' } | null
  // accepts: https://github.com/o/r/blob/<ref>/<path>, https://raw.githubusercontent.com/o/r/<ref>/<path>,
  // https://github.com/o/r/raw/<ref>/<path>, "o/r/blob/<ref>/<path>" (hash-route form), with ?query/#hash stripped.
rawUrl({owner, repo, ref, path}) -> 'https://raw.githubusercontent.com/o/r/<ref>/<path>'
lfsMediaUrl({owner, repo, ref, path}) -> 'https://media.githubusercontent.com/media/o/r/<ref>/<path>'
detectFormat(path: string) -> 'csv'|'tsv'|'json'|'ndjson'|'parquet'|null   // by extension (.csv .tsv .json .jsonl .ndjson .parquet)
isLfsPointer(bytes: Uint8Array) -> boolean   // starts with "version https://git-lfs.github.com/spec/"
async fetchGitHubFile(input: string, {fetchImpl=fetch, token}={}) ->
   { bytes: Uint8Array, format, fileName, source: {owner,repo,ref,path}, url, sizeBytes }
   // resolves raw URL, fetches, if LFS pointer refetches media URL; throws Error with friendly message
   // on 404 / unsupported format / > 200MB. If token given, uses api.github.com contents endpoint with
   // Accept: application/vnd.github.raw and Authorization: Bearer.
tableNameFor(path) -> safe SQL identifier from file name, e.g. "sales_2024"
async resolveRemoteFile(input, {fetchImpl, token}) -> { url, format: 'parquet', fileName, source, sizeBytes? } | null
   // Parquet only: probes "bytes=0-3" for a 206 + "PAR1" (LFS pointer -> media URL). null = fall back to fetchGitHubFile.
```

### data/links.js  (pure)
```js
LINK_SOURCES: [{ id, name, example, howTo, blocked?, test(url|null, raw), direct?(url) }]   // in help order; 'web' last
linkSourceFor(input) -> LINK_SOURCES entry | null       // which help applies to a pasted link
shareLinkToDirect(input) -> { source, url, fileName?, format? } | null
   // null = no rewriting needed; throws a friendly Error for links that can't work (folders, Box share pages, Docs)
sniffFormat(bytes) -> 'parquet'|'csv'|'tsv'|'json'|'ndjson'|'html'|'zip'|null
```
fetchGitHubFile and resolveRemoteFile use shareLinkToDirect first. For share links `source` is
`{ url: <the share link>, host, path: fileName, provider, page }`, so reloads and ?url= keep the link the user pasted.

### data/duck.js
```js
class Duck {
  async pageRows(table, { columns: string[] | null, sort: {column, dir:'asc'|'desc'} | null, offset, limit, signal, onStart }) -> { rows, columns }
    // Browsing (Data tab). Stable order: downloaded tables keep insertion order; a remote table's natural order is FILE
    // order with or without a working set (page read by file_row_number, so row groups are skipped, not scanned up to
    // the offset); sorting breaks ties by file row. Uses the working set when it holds every column involved, else
    // reads the file; never extends the working set. columns null = all (record view).
  static async create({ baseUrl = './duckdb/' } = {}) -> Duck     // selectBundle over eh/mvp, Worker from baseUrl
  async attachUrl({ url, tableName, fileName, rowCap = REMOTE_ROW_CAP (5M) }) -> { tableName, rowCount, totalRows }
     // files over rowCap rows: the view is the first rowCap rows; profile() adds totalRows and uses those row groups' stats
     // remote Parquet as a VIEW over HTTP range reads; profile() then reads only the footer (sample: [], distinct: null)
  async loadFile({ bytes, format, tableName, fileName }) -> { tableName, rowCount }
     // registerFileBuffer + CREATE OR REPLACE TABLE <t> AS SELECT * FROM read_csv_auto / read_json_auto / read_parquet
  async query(sql: string, { limit = 5000, signal?: AbortSignal, onStart?: () => void } = {}) -> { columns: [{name, type}], rows: object[] }
     // queued: one statement at a time on the single connection. Runs via conn.send() so it can be cancelled:
     // signal drops a queued query or cancels a running one (rejects with name 'AbortError'). onStart fires when it runs.
  async resample(tableName, { mode: 'spread'|'window', rows, offset }) -> { tableName, rowCount, totalRows, sample }
     // also drops a fast-mode cache and restores the remote view on every lane
  async buildWorkingSet(t, columns, { signal, onProgress({ fraction }), parallel = true, memoryBudgetMB }) -> { columns, rowCount, ms, parts, units, combineMs }
     // copies __row + columns of the sample into <t>__ws (units of row groups pulled by free lanes; other lanes ship Parquet
     // bytes to lane 0); lane 0's <t> view then reads it. MemoryError if DuckDB ends up over memoryBudgetMB (it is dropped).
  async extendWorkingSet(t, columns, { keep, memoryBudgetMB }) -> boolean   // joins on __row; shrinks non-kept columns or refuses
  async clearWorkingSet(t); workingSet(t) -> { columns, rowCount } | null; missingColumns(t, sql) -> string[] | null
  // query() routes: working-set columns -> lane 0 locally; other columns -> auto-extend (budget permitting) or read the file
  // on lanes 1+ (or lane 0 via <t>__remote). Results cached by (data generation, SQL); in-flight duplicates shared.
  // onWorkingSet({ type: 'extend', phase: 'start'|'done'|'refused'|'error', columns }) is called on extensions.
  async materialize(tableName, opts) -> { tableName, rowCount, cached }   // fast mode = working set of every column
  // remote Parquet runs on a pool of REMOTE_LANES (4) DuckDB workers; queries mentioning the table go to the first free lane
     // rows are plain JS objects; BigInt -> Number (or string if unsafe); Date/timestamps -> ISO string
  async profile(tableName) -> Profile
}
Profile = {
  table: string, rowCount: number,
  columns: [{ name, type, kind: 'quantitative'|'temporal'|'nominal'|'boolean',
              nullPct, distinct, min, max, mean?, topValues?: [{value, count}] }],
  sample: object[]   // first 5 rows
}
```

### agents/llm.js
```js
createLLM({ provider: 'anthropic'|'openai'|'mock', apiKey, model, baseUrl, mockHandler }) -> LLM
LLM.complete({ system: string, messages: [{role:'user'|'assistant', content:string}], maxTokens=2000 }) -> Promise<string>
LLM.completeJSON(args) -> Promise<any>   // complete() then tolerant JSON extraction (whole / ```json fence / first {..last} or [..])
// anthropic: POST https://api.anthropic.com/v1/messages, headers x-api-key, anthropic-version: 2023-06-01,
//   anthropic-dangerous-direct-browser-access: true. Default model 'claude-sonnet-4-5'.
// openai: POST {baseUrl||'https://api.openai.com/v1'}/chat/completions, default model 'gpt-4o-mini'.
// mock: mockHandler({system, messages}) -> string|Promise<string>
```

### agents/pipeline.js — the agents
Every agent is `async (ctx, input) -> output` and reports via `ctx.trace(event)`.
`ctx = { llm, duck, profile, trace }`.
TraceEvent = `{ agent: string, status: 'start'|'done'|'error'|'retry', message: string, detail?: any, ms?: number }`.

1. **profilerAgent(ctx)** -> Profile (deterministic, no LLM; calls duck.profile)
2. **chartPlannerAgent(ctx)** -> ChartPlan[] (LLM; 4 charts max)
3. **sqlAgent(ctx, {question, history})** -> { sql, rationale } (LLM, NL2SQL with schema + sample)
4. **executorAgent(ctx, {sql})** -> Result; on SQL error calls **repairAgent** (LLM, given sql+error+schema) up to 2 times
5. **vizAgent(ctx, {question, sql, result})** -> VizSpec (LLM; picks mark + encodings for the result columns)
6. **validatorAgent(ctx, {spec, result})** -> VizSpec (deterministic: every encoding field must be a result column, else fall back to a table/heuristic spec; enforces `data.values` injection, width 'container')

ChartPlan = `{ title, question, sql, spec }` where spec is a Vega-Lite spec WITHOUT data
(field names must equal SQL result column names).
VizSpec = `{ title, spec (vega-lite, data omitted), fallback?: boolean }` — UI injects `data: {values: rows}`.

Orchestrator:
```js
createPipeline({ llm, duck }) -> {
  async load(input: string|{bytes,format,fileName}|{parts,format,fileName}|{remoteUrl,fileName,sample}, onTrace) -> { profile, tableName }
  async resample(sample, onTrace) -> { profile, tableName }           // large remote Parquet only
  async suggest(onTrace, { onPlans, onStart, onCard, signalFor }?) -> Card[]
     // streams: onPlans(plans with id + layout) before any query; onStart(id) when a chart's query runs;
     // onCard(card) as each finishes; signalFor(id) -> AbortSignal cancels one chart (card.cancelled, not error)
  async run(plan, onTrace, { signal, onStart }?) -> Card                // one chart on its own ("Run again")
  async ask(question, onTrace) -> Card                 // sql -> executor(+repair) -> viz -> validator
}
Card = { id, title, question, sql, spec, rows, columns, layout, error?: string, fallback?: boolean, note?: string, cancelled?: boolean }
Layout (agents/layout.js) = { section: overview|trends|breakdowns|distributions|relationships|details, size: s|m|l, priority: 1-9 }
   // planner output includes it (validated by normalizeLayout, else inferLayout(spec)); the grid renders orderCards(cards)
```
Also export `heuristicCharts(profile)` -> ChartPlan[] used when no API key is set (no LLM): e.g.
time-series line for first temporal+quantitative pair, bar of top-10 of first nominal by count,
histogram of first quantitative. So the app is useful with zero setup.

### ui/app.js
`mountApp(rootEl, { createPipeline, createLLM, fetchGitHubFile, Duck })` renders one shell, top to bottom:

- **Top bar** (sticky on desktop): logo, link box + **Open**, **File** (labelled upload), the **AI on / AI off** pill
  (click: Settings), Settings.
- **Sticky stack** (`.chrome`, under the top bar; on phones the top bar scrolls away and this stays at the top):
  - **Dataset bar** (`.databar`, only after a load): file name (`.ds-name`, full name in `title`), source link
    (`.ds-source`), "N rows × M columns · size" (`.ds-meta`), **Columns** (toggles the rail) and **Examples ▾** (a
    popover with the example chips and the one "Which links work?" entry).
  - **Notice slot** (`.notices`): every transient message, one line each, tinted by severity (`.notice` + info / warn /
    error / ok): `.status` (loading, errors), `.sample-notice` (sample summary with **Change**), `.cache-banner`
    (`data-status`), `.link-hint`. Notices are never placed anywhere else.
- **Start page** (nothing loaded or loading, root class `is-start`): one 720 px column: headline, one supporting line
  with "Which links work?", four large example chips, three trust points, the disabled ask bar (`.ai-chip`). No rail,
  dataset bar or tabs.
- **Columns rail** (`.dataset`, 260 px, collapsible; the choice is stored in `localStorage` `datadrop.rail.v1`): the
  sample controls (`.sample-panel`, when the file is sampled), the table name, every column (click = Data tab at that
  column). At 900 px and below it is a bottom sheet (scrim, Escape closes, not remembered).
- **Workspace**: the ask bar (`.ask`; with no API key the `.ai-chip` takes its slot), then the tab row: **Charts** /
  **Data** tabs and the low-key **Activity** pill (`.trace` > `.panel-toggle`), then the card grid or the explorer. The
  workspace is the same width in both tabs; there is no third column.
- **Activity slide-over** (`.slideover`, opened by the pill; Escape or the scrim closes; focus goes in and back):
  the run list (`.run` > `.event`, live timers). The pill only says "working…" while something runs; Settings ›
  "Show agent steps" (`showSteps`) keeps "N runs · show steps" visible.
- **Cards** (12-column grid, `grid-auto-flow: dense`; layout size s = 3, m = 6, l = 12 columns, answers span 12): title
  (16 px), chart, footer with **Pin**, the row count and a "⋯" menu (View SQL, Show data, Log x, Download data (CSV),
  Remove). A tag shows only for errors and for the running / queued state of pending cards (those keep SQL and Cancel
  visible). A failed card says "This chart couldn't be built from this data." with "Show technical details" (raw
  message + SQL) behind a `<details>`.
- **Settings drawer** (provider, API key, model, base URL, show agent steps, large files; `localStorage` in try/catch).
  Drag-and-drop / file input load a local file. The initial URL comes from `?url=` or `#/owner/repo/blob/...`.

### ui/chartstyle.js, ui/csv.js, ui/popover.js  (no app state; the first two are pure)
```js
prepareSpec(spec, rows, { getVar?, width? }) -> Vega-Lite spec    // data, size, theme config, singleHue, thinTimeAxes
   // never mutates `spec`. singleHue: colour that only repeats an x/y/facet field is dropped (theme colour); colour that
   // encodes another field (series, stack, measure, arc slices) stays. thinTimeAxes: temporal axes get tickCount =
   // clamp(width / 90, 3, 8) (6 if unknown) and labelOverlap 'greedy' unless the spec sets its own.
vegaConfig(getVar) -> config   // from the --series-N / --text / --grid tokens
toCSV(rows, columns) -> string; csvFileName(title) -> 'revenue-by-sector.csv'
attachPopover(trigger, panel, { onOpen, onClose }) -> { open, close, toggle, isOpen }   // Escape, outside click, arrows
```
Design tokens (spacing `--s-0..--s-6`, type `--t-xs..--t-xl`, surfaces, `--series-N`) are in `styles.css` `:root`; use
them instead of raw px.
