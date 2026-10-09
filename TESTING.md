# Testing DataDrop

Every change ships with a test in the right tier, and `npm run check` passes before the change counts as done.
CI runs `npm run check:full` and deploys only if it passes.

## Tiers

| Tier | Command | What it runs | Network | Time |
|---|---|---|---|---|
| 1. Unit | `npm test` | `tests/*.test.mjs` with `node --test`: pure logic (URL parsing, fetch with a mocked `fetch`, prompts, SQL guard, validator, heuristics, pipeline with a mock LLM over real DuckDB in Node) | one `LIVE:` test hits GitHub | ~3 s |
| 2. UI (stubbed) | `npm run test:ui` | `tests/ui.e2e.mjs` in Chromium against the `--stub` build: real UI, fake data and agent modules from `tests/ui-stubs/` | none | ~10 s |
| 3. DuckDB (browser) | `npm run test:duck` | `tests/duck.e2e.mjs`: `src/data/*` in Chromium with real DuckDB-WASM: CSV/JSON/TSV/Parquet loads, profile, type mapping, remote Parquet over a local Range-capable server | GitHub (live CSV) | ~5 s |
| 4. Full stack | `npm run test:full` | `tests/full.e2e.mjs`: real `dist/`, real DuckDB, real GitHub CSV, real `llm.js`; only `api.anthropic.com` is mocked | GitHub | ~5 s |

- `npm run check` = tiers 1 + 2 + build. Run it after every change.
- Both run their tiers in parallel (`scripts/check.mjs`; `check:serial` / `check:full:serial` are the old one-at-a-time runs). `TIMING=1 node tests/ui.e2e.mjs` prints each UI check's time.
- `npm run check:full` = all four tiers. Run it before you hand work over and whenever `src/data/`, `src/agents/` or the build changes.
- One-time setup: `npm ci && npx playwright install chromium`.
- UI screenshots land in `tests/screens/`. Look at them after visual changes; a passing check doesn't prove a page looks right.

## Which tier for which change

| You changed… | Add or update a test in… |
|---|---|
| A pure function (`github.js` parsing/fetching, `prompts.js`, pipeline helpers, heuristics) | Tier 1 |
| DOM, layout, events, routing, settings, trace rendering (`src/ui/`) | Tier 2. Extend the stubs in `tests/ui-stubs/` if the UI needs new data behaviour (e.g. `slow` in the URL holds the fetch open for 1.6 s). |
| How DuckDB loads, queries or profiles data (`duck.js`) | Tier 3 |
| How modules work together, or anything the stubs fake | Tier 4 |
| A bug | A test in the lowest tier that reproduces it. Watch it fail before you fix it. |

## Feature → test map

Keep this table current: a new feature adds a row, and a changed feature updates its row.

| Feature | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|
| GitHub URL parsing (blob/raw/tree, hash route, encoding) | `parseGitHubUrl: *`, `rawUrl / lfsMediaUrl` | hash route autoload | | |
| GitHub fetch, Git LFS, token, size limit, friendly errors | `fetchGitHubFile: *`, `LIVE: fetch plotly…` | 404 inline error | live CSV load | live CSV load |
| Any https URL (S3, R2…) downloaded directly | `fetchGitHubFile: non-GitHub https URL…`, `…bad URL…` | | | |
| Share links (Drive, Sheets, Dropbox, OneDrive, SharePoint, Box, Gist, GitLab, Bitbucket, HF pages) -> direct URL, format sniffing, per-provider errors and help | `tests/links.test.mjs` | link hint + error, "Which links work?" panel, hint hidden after load | | |
| `s3://` / `gs://` URIs mapped to public https | `storageToHttps: *`, `s3:// URIs load like https links…` | | | |
| `hf://` URIs (single file + globs, pagination, parts) | `tests/hf.test.mjs` (incl. LIVE listing) | | parts combined by name + `source_file` | |
| Sampling huge remote Parquet (spread / first / next) | `tests/sample.test.mjs` | | 5-row-group fixture: spread, windows, sampled-group stats | |
| Remote Parquet read in place (Range probe, footer-only profile) | `resolveRemoteFile: *` | | `remote:` block (footer stats = full data, no sample, same query answer, Range reads, CSV falls back, table replaces view, row cap via `rowCap: 100`) | |
| Chart heuristics (no API key) | `heuristicCharts *` incl. remote-profile ranking and hour/minute grain | example → 3 cards | | |
| LLM clients (Anthropic, OpenAI-compatible) | `anthropic request shape…`, `openai-compatible…`, `extractJSON…` | | | mocked Anthropic |
| Agents: planner, SQL, executor + repair, viz, validator | `planner…`, `repair loop…`, `validator…`, `suggest…`, `ask()…` | ask → new card | | planner + repair + validator run for real |
| SQL safety guard | `SQL guard…`, `executor refuses unsafe SQL…`, `unsafe SQL from LLM…` | | | |
| DuckDB load/profile/types (CSV, JSON, NDJSON, TSV, Parquet) | | | main assertions | |
| Activity slide-over (pill, runs, statuses, live timer past 1 s, Escape/scrim close, "Show agent steps") | | `trace groups…`, `trace timer counts up live…`, `activity: a low-key pill…`, `"Show agent steps"…`, `…activity slide-over opens and closes` (phone) | | trace contents |
| Shell: dataset bar, notice slot, examples menu, columns rail, start page | | `start page: one centred column…`, `shell: the workspace is wide…`, `dataset bar: …`, `Examples menu: …`, `columns rail: collapses … survives a reload`, `sample notice: …` (desktop + phone), `phone: dataset name is in the first screen…`, `phone: the columns list opens as a bottom sheet…` | | |
| Card grid (12 columns, dense, answers full width) | `tests/layout.test.mjs` (order) | `every row of cards is full…`, widths in `charts stream in…` | | |
| Chart styling (single hue, tick thinning) | `tests/chartstyle.test.mjs` (colour dropped when it repeats an axis, kept for series / stacks / measures / pies, spec not mutated, tick count by width, explicit ticks respected) | `time axis is thinned…`, `single hue: …`, `dark: bars use the dark theme's first series colour…` | | |
| Card actions menu + download | `toCSV…`, `csvFileName…` in `tests/chartstyle.test.mjs` | `card footer: Pin + a "⋯" menu…`, `card menu is keyboard accessible…`, `SQL toggle + Data toggle (from the menu)`, `Download data: a CSV…`, `cards: pin, log x, remove` | | |
| Failed card disclosure | | `click example -> cards render` (plain line, raw error + SQL behind "Show technical details") | | |
| Streaming charts (placeholders with SQL, draw as each finishes) + cancel / run again | `suggest streams…` | `charts stream in…` | | |
| Cancellable queries (queued dropped, running cancelled) | | | `cancel:` block | |
| Parallel worker pool for remote Parquet ("lanes") | | | `lanes:` block (4 lanes, parallel timing, early queries spread, resample reaches all) | |
| Fast mode / memory check (tiers, budget, signals) | `tests/memory.test.mjs` | `"Fast mode" setting…` | `materialize:` block | |
| Data tab: grid (formatting by column role, sort, pin/hide/resize, picker, go to row, keyboard, virtualization) + record view | `tests/gridmodel.test.mjs`, `sliceRanges` in `tests/sample.test.mjs` | `Data tab …` (20 checks: format, sort, record, copy, menu, picker, wide table, error/retry, phone, dark, ask switches tab, remote column groups) | `grid:` block: `Duck.pageRows` pages cover every row once, same order from the file and the working set, sorted ties, record = row at offset | |
| Column roles (ids, additive vs level measures, status-like) + heuristic chart choice | `tests/roles.test.mjs`, bank/balance/account tests in `tests/agents.test.mjs` | | | |
| Trust layer: drill-through, plan + assumptions, check this number | `tests/drill.test.mjs`, `tests/explain.test.mjs`, `tests/check.test.mjs`, real-DuckDB drill/check blocks in `tests/agents.test.mjs` | `drill-through…`, `how this was calculated…`, `check this number…` | | |
| SQL tab: examples, guard, run, result grid, history, CSV | `tests/sqlexamples.test.mjs`, in-memory grid tests in `tests/gridmodel.test.mjs`, starter-query run in `tests/agents.test.mjs` | `SQL tab: …` (6 checks) | | |
| Metric definitions (validate, save per dataset, values, AI prompts, SQL examples) | `tests/metrics.test.mjs`, metric blocks in `tests/agents.test.mjs` | `metrics: …` (3 checks) | | |
| Views (Overview / Explore / Review), Review suggestion, share links | `tests/modes.test.mjs` | `views: …` (5 checks), `share…` (2) | | |
| Working set: column union, single + parallel build, auto-extend, result cache, memory guard | `tests/workset.test.mjs` | `working set, green/yellow/red…`, `extending the working set…`, `"Clear working set"…`, `phone…`, `"Prefer low memory"…`, `cancel while building…` | `workingset:` block | |
| Layout model (sections, sizes, priority; planner hints) | `tests/layout.test.mjs`, `planner layout hints…` | full-width trend card in `charts stream in…` | | |
| Heuristic chart quality (log bins, density, top 9 + Other, no-trend note, near-constant numbers) | `histogram uses log bins…`, `top-N bar…`, `time trend…`, `near-constant number…` | `cards: pin, log x, remove` | | |
| Schema polish (mostly-null tags, grouping over 20 columns) | | `mostly-null columns…` (grouping: not yet) | | |
| Settings (provider/key/model, storage, gitviz → DataDrop migration) | | `settings drawer…`, `pre-rename settings migrate` | | |
| Sharing (`#/owner/repo/blob/…`, `?url=`) | | `hash updated…`, `?url= autoloads…` | | hash after load |
| Branding / copy | | `DataDrop branding` | | |
| Responsive + dark theme | | `400px * no horizontal scroll`, `activity slide-over opens and closes`, `dark: themed axis labels`, `phone: topbar is logo + link + File…`, `Data tab … phone` | | |

### Known gaps (good next tests)

- Local file drop / file picker: no automated test.
- UI for non-GitHub URLs (`?url=` share link, host shown as the source link): the UI stub only understands GitHub links.
- OpenAI-compatible provider end to end in a browser (tier 4 mocks Anthropic only).
- UI for a sampled file (sample panel buttons, size select): checked by hand only.
- Footer null counts that are cumulative (seen in the NYC rides file): DuckDB's writer can't produce such a file,
  so the "distrust impossible null counts" rule is verified by hand only.
- Schema grouping over 20 columns: no stub profile that wide yet.
- Remote Parquet against a real slow server: tier 3 uses localhost, so latency costs only show up in manual checks.

## Manual check in the browser (after UI or data-path changes)

1. `npm run build`, then `npm run serve` (or the `datadrop` entry in `.claude/launch.json`).
2. Load an example chip and one non-GitHub link. A good remote Parquet case:
   `https://pub-1da360b43ceb401c809f68ca37c7f8a4.r2.dev/data/nyc-rides-2010.parquet`
3. For performance claims, test with a cold cache: add a throwaway query string such as `?cold=123` to the data URL.
   A warm browser cache once made a slow profile look fast.
4. Note what you saw (timings, screenshots) in the DEVLOG entry.

## Rules

- No change is done until `npm run check` passes. Data-path, agent or build changes also need `npm run check:full`.
- A new test must fail without the change. For anything subtle, briefly break the code and watch the test fail.
- Don't weaken or delete an assertion to make a run pass. Fix the code, or explain the change in the DEVLOG.
- Keep tiers 2–4 free of real LLM calls. Mock at the HTTP boundary (`page.route`) or use the stubs.
