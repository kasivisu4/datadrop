# DEVLOG

What changed, why, and how it was verified. Newest first. The format is in [AGENTS.md](../AGENTS.md#devlog-entry-format).

## 2026-10-09: The address is the app, a slash, then the data link as pasted
- **Why:** the user pasted a raw.githubusercontent.com link and the box and address turned it into `github.com/…/blob/…` and `#/owner/repo/blob/…`. They want the link kept as pasted, in a friendly form: `https://kasivisu4.github.io/datadrop/<the link>`.
- **Changed:** `src/data/modes.js`: `linkFromLocation` (app folder + link from the path; the link's own `?query` belongs to it; `#` travels as `%23`; a squashed `//` is repaired), `linkPath`, `buildShareLink` now builds `<origin><app>/<link>#view=…&tab=…`, `parseShare` reads a hash too. `src/ui/app.js`: the box, the address and Share use the link as pasted (`state.dataset.link`); a boot from the path reads view/tab from the hash; `?url=` and `#/owner/repo/blob/…` still open and are rewritten to the new form. `public/index.html`: an inline script sets `<base>` to the app's folder so `./app.js`, `./duckdb/` resolve under any link; `src/data/duck.js` and the DuckDB URL in app.js resolve against `document.baseURI`. `build.mjs` also writes `404.html` (GitHub Pages serves it for `/datadrop/https://…`); `serve.mjs` serves the app for such paths.
- **Tests:** unit `linkFromLocation`, `buildShareLink` round trips (spaces, a Sheets `#gid`, a `?dl=1` query), `parseShare` from a hash; tier 2 `address is the app, then the data link`, share link exact string, `a pasted link is kept as pasted… older ?url= addresses still open`; tier 4 asserts the address path. `check:full` ✅ except two tier-2 checks that flaked under the parallel run and pass alone (`npm run test:ui` ✅).
- **Verified:** local server: `localhost:5173/https://raw.githubusercontent.com/BuzzFeedNews/…/refs/heads/master/data/nics-firearm-background-checks.csv` opens, box shows the raw link, 16,445 rows, 4 charts; the old `#/BuzzFeedNews/…` address loads and becomes `/https://github.com/…`.
- **Open:** on GitHub Pages a link-in-path address is answered with HTTP 404 (body is the app), harmless for browsers but link-preview bots may skip it.

## 2026-10-09: A deploy is picked up as a whole (versioned app.js / styles.css)
- **Why:** after the Review fix was deployed the user still saw blank charts on the live site: GitHub Pages serves every file with `max-age=600`, so a browser can keep running the old `app.js` for up to 10 minutes, or mix a new page with an old script.
- **Changed:** `build.mjs` writes `index.html` with `app.js?v=<hash>` and `styles.css?v=<hash>` (sha256 of the built file).
- **Tests:** `check:full` ✅ (all tiers load the stamped page).
- **Verified:** `dist/index.html` references `./app.js?v=fb1701c28e`, `./styles.css?v=6b001454ff`; the live `app.js` already had the Review fix (`_stale`) before this change.
- **Open:** `index.html` itself is still cached up to 10 minutes; a hard refresh (Ctrl+Shift+R) skips that.

## 2026-10-09: Charts no longer come out blank in the Review view
- **Why:** the user opened the NICS CSV on the live site and saw empty chart cards (titles, row counts, no marks). Their saved view was Review, which opens on the Data tab, so the charts were drawn while the Charts tab was hidden: Vega sized them to 0 px and nothing redrew them when the tab was opened.
- **Changed:** `src/ui/app.js`: `drawViz` skips drawing while the Charts tab is not shown and marks the card stale; `setView('charts')` draws stale cards at the real width.
- **Tests:** tier 2 `views: the choice is remembered…` now reloads in Review, opens Charts and asserts every chart has a real width (fails without the fix). `check:full` ✅.
- **Verified:** local build, NICS link, Review view saved, reload: opens on Data; Charts shows 4 charts 952 px wide (before: `width="0"`, as on the live site).
- **Open:** charts are still sized once; resizing the window doesn't redraw them. NICS `month` (`1998-11` text) is charted as ranked bars, not a time line.

## 2026-10-09: `npm run serve` opens blocked links by itself (local relay, no setup)
- **Why:** the user ran it locally and still got "online, but it doesn't let other websites read its files" for the NYC taxi link: the relay setting needs a worker they would have to deploy. Locally there is a server already.
- **Changed:** `serve.mjs` has `/__relay?url=<https address>`, the same code as `docs/cors-worker.js`, **answering this machine only** (loopback address, and an Origin other than the page it serves is refused with 403), so running it never makes you an open proxy; streams the body and stops pulling when the page stops reading. The app, on a blocked link with no proxy set, probes `/__relay?probe=1` (HEAD, marker header `x-datadrop-relay: local`; only on localhost) and retries through it. The deployed GitHub Pages site is static, so the probe fails there and the earlier behaviour (explanation + download link, or your own relay from Settings) stands. A proxy in Settings still wins.
- **Tests:** `serve-relay.test.mjs` (5: page still served, probe, https/ `?url=` only, another site's Origin refused, a LIVE Range request for the taxi file: 206 and `PAR1`); tier 2: a blocked link goes through `/__relay` with no setting; the "nothing can read it" error path now uses a URL the relay can't open either. `check:full` ✅.
- **Verified:** no mocks: the real `serve.mjs`, the real build, the real taxi link, Chromium, no settings: loads in about 11 s, 3.7M rows, 32 MB of the 64 MB read in place through 54 relay requests, charts fare_amount by week / by payment_type / distribution, no errors.
- **Open:** a dev-server convenience only (the project stays backend-free for users: AGENTS.md). Restart `npm run serve` to pick it up.

## 2026-10-09: Open blocked links through a relay you own; taxi-style code columns are categories
- **Why:** "so no fix?": the NYC TLC CloudFront link can't be read by any website (no CORS headers), and no public mirror with CORS exists (checked: the nyc-tlc S3 bucket answers 403; no Hugging Face / source.coop copy found). The real fix is a relay that adds the header.
- **Changed:**
  - **Settings → "Links that block browsers (optional)"**: the address of a relay you run yourself (`https://you.workers.dev/?url={url}`; https only, validated). Off by default. Only a link the server actually **blocks** is retried through it (blocked = online but no CORS, found by a no-cors probe); everything else goes straight from the browser. Parquet is still read in place through the relay (range requests); the file keeps its real name and source. `parseProxy` / `applyProxy` in `links.js`; `proxied` option in `resolveRemoteFile` / `fetchGitHubFile`.
  - **`docs/cors-worker.js`** (a ~50-line Cloudflare Worker: GET/HEAD + Range only, forwards no cookies or authorization, drops set-cookie, `ALLOWED_HOSTS` / `ALLOWED_ORIGIN`, https only, answers the preflight) and **`docs/CORS-PROXY.md`** (5-minute setup, privacy note). The privacy trade-off is explicit: for blocked links the data passes through your own Cloudflare account.
  - **Charts on taxi-style data**: camelCase ids (`VendorID`, `RatecodeID`, `PULocationID`) are identifiers (case-sensitive, so "paid" or "valid" are not); a whole-number `*_type` / `*_code` / `*_class`… (`payment_type`) is a category, not a number to add up (`isIdName`, `isCodeColumn` in `roles.js`).
- **Tests:** `cors-worker.test.mjs` (6: Range 206 + exposed headers, whole file and HEAD, preflight, no cookies/auth forwarded, https/method/bad-address, ALLOWED_HOSTS/ORIGIN; against a local origin with no CORS), `links.test.mjs` (+3: parseProxy, applyProxy, a proxied read keeps name and source), `roles.test.mjs` (+2), a taxi-profile chart test in `agents.test.mjs`; tier 2: a blocked link retried through the relay and only then, the Settings field validated and remembered. `check:full` ✅.
- **Verified:** the real thing: `docs/cors-worker.js` run in Node as the relay, the real 64 MB TLC file on CloudFront, the real build in Chromium (enforces CORS): loads in about 10 s, 3.7M rows, read in place (35 MB of the 64 MB through 36 relay requests), charts "fare_amount by week", "Top store_and_fwd_flag by count", "fare_amount by payment_type", "Distribution of fare_amount", no page errors.
- **Open:** the relay is yours to deploy (needs a Cloudflare account; not deployed by us). The Data tab's first remote page is slower through a relay.

## 2026-10-09: A link the browser is not allowed to read (NYC TLC CloudFront) now says so, with a way out
- **Why:** the user pasted `https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_2026-01.parquet` and it did not work. Checked the headers: the server answers GET/HEAD (206, 200) but sends **no `Access-Control-Allow-Origin`** and answers the browser's preflight with 403. A website cannot read such a file, whatever tool it is; DataDrop is browser-only by design, so it cannot proxy it.
- **Changed:** `fetchDirectFile` now tells "blocked" from "unreachable": after a failed fetch it sends a `no-cors` HEAD, which succeeds (opaque) only when the server is online. Blocked: "<host> is online, but it doesn't let other websites read its files (it sends no CORS headers)… Download the file, then drop it on this page." plus a **Download the file** link in the error (`setStatus` takes an action). Unreachable keeps the old message (with the CORS hint). Share links keep their provider-specific advice.
- **Tests:** `links.test.mjs` (+3: blocked, unreachable, share link unprobed); tier 2: the explanation and the download link. `check` ✅.
- **Verified:** real Chromium (enforces CORS) against the real build and the real URL: the new message and link; then the same file (64 MB) dropped on the page loads: 3.7M rows, charts drawn.
- **Open:** nothing in the browser can read this host directly. A hosted copy with CORS (R2, S3 with a CORS rule, Hugging Face) works; a user-supplied CORS proxy would be a privacy trade-off, so it is not built.

## 2026-10-08: Views and share links (step 7 of 7)
- **Why:** the persona plan: three arrangements of the same data (Overview, Explore, Review), chosen by the user and only *suggested* by the data, plus links that reopen a dataset in a view.
- **Changed:**
  - `src/data/modes.js` (pure): `MODES` (Overview: charts, columns list closed, comfortable; Explore: charts, list open, compact, "how this was calculated" open; Review: opens on the rows, list open, compact), `suggestMode` (an additive money column (amount, debit, fee…; not prices or balances) **plus** a status-like group or an account/transaction id: stock files and plain time series are not mistaken for ledgers), prefs under `datadrop.view.v1` (view + datasets whose suggestion was dismissed), `parseShare` / `buildShareLink`.
  - UI: **View** menu and **Share** button in the dataset bar (wraps to its own line on phones); `data-mode` / `data-density` on `.app` (compact tightens cards, metrics and the grid rows); a dismissible chip in the notice slot "Looks like transactions. Switch to Review?" (never switches by itself, dismissal remembered per dataset); switching view sets the tab and columns list; Review opens on the Data tab after a load.
  - **Share** copies `?url=<data url>&view=<view>[&tab=<tab>]` (GitHub files as their github.com URL, `s3://`, `gs://`, `hf://` too); disabled for a file from your computer. Opening such a link applies its view and tab **for that visit only**: the viewer's saved view is untouched.
  - **Invariant, tested:** a view never changes what the charts say: same titles, row counts and SQL in all three.
- **Tests:** `modes.test.mjs` (5, tier 1: the suggestion rules incl. stock/balance/bare-id negatives, prefs, share parse/build round trip, local file and `javascript:` links refused); tier 2: 6 checks (views and the invariant, remembered across reload, a link's view not saved, Share copies and reopens, suggestion chip + dismissal + switch, local file can't be shared). Updated one assertion: the dataset bar's first button is no longer Columns (it is found by class). `check:full` ✅ in 62 s (171 unit).
- **Verified:** real app, bank CSV: the chip offers Review; Review opens on the Data tab (money right-aligned, negatives red, status and account columns); Explore shows the same four charts with the plan open; the Share link reopens in the Data tab; no page errors.
- **Open:** a view does not yet change which charts the built-in suggester picks (Overview's headline numbers strip, Review's totals footer and Checks tab are not built); Share carries no filters or pinned charts (none exist to carry); density does not yet reach the SQL tab's result grid.

## 2026-10-08: Metric definitions: a name that always means the same number (step 6 of 7)
- **Why:** research finding: governed metrics are what make repeated AI answers agree; the SQL-native persona wants definitions as code. A tiny semantic layer that stays in the browser.
- **Changed:** `src/data/metrics.js` (pure): a metric is a name + one SQL aggregate (`SUM("amount") FILTER (WHERE "status" = 'completed')`), saved per dataset in `datadrop.metrics.v1` (key = table + its columns, so a reload of the same file finds them), `validateMetric` (one expression: no ; or comments, ≤ 60 / 600 chars), `metricSql`, `metricPrompt`, `metricSuggestions` (rows, total or **average for levels like balances**, a filtered total from a status column's top value, distinct keys), `formatMetricValue` (every digit). UI (`src/ui/metrics.js`): "+ Metric" in the tab row; metric cards (name, value, definition, edit, remove) appear above the charts only once one exists (no extra height before); the form offers one-click starting points, **Try it** shows the value or the DuckDB error, and a definition that doesn't run is not saved; duplicate names refused; values computed on load for downloaded files, on request ("Compute") for remote ones. **The AI uses them:** the planner and SQL prompts quote the definitions ("when a question mentions one by name, use exactly this expression, and say in assumptions that you used it"), so the plan/assumptions block shows it. The SQL tab's Examples gain "Metric: <name>". `pipeline.setMetrics`, re-applied when the pipeline is rebuilt.
- **Tests:** `metrics.test.mjs` (9, tier 1); real DuckDB in `agents.test.mjs`: every suggested definition runs and equals the hand-written number (the FILTER version equals a plain WHERE), and the AI's system prompt carries the definitions (planner and question) and drops them when none; tier 2: 3 checks (ideas → card, remembered across reload, define/try/save, a failing or non-expression definition not saved, duplicate, edit, remove, the AI pipeline is told, SQL examples, hidden outside Charts). `check` ✅ (166 unit).
- **Verified:** real app, bank CSV: Rows 50,000; Total amount 13,878,092.93 (equals the drill/check totals); Completed amount 7,049,584.10 (equals the "completed" bar and the SQL-tab result).
- **Open:** a metric is one aggregate over one table (no ratios between metrics yet, no filters shared across metrics); definitions are per browser (no sharing), and they are not yet used by the built-in (non-AI) charts.

## 2026-10-08: SQL tab: your own query over the table (step 5 of 7)
- **Why:** the SQL-native persona wants real SQL, with the result in the same grid; also the trust answer for AI-written charts ("let me read and edit the query").
- **Changed:** third tab **SQL** (Charts / Data / SQL). `src/ui/sqlbox.js`: editor (Run, Ctrl or ⌘+Enter, Cancel, Copy SQL), table-name chip that inserts at the cursor, **Examples** written from the profile (`src/data/sqlexamples.js`: first 100 rows, row count, rows per status, total or average of the main measure per group and per month, repeated key values, empty values per column), history of the last 15 queries (local, `datadrop.sqlhistory.v1`, clearable), status with timing and "cut off at 100,000: add a LIMIT". Results are held in memory and shown by the same grid as the Data tab (sort, pin, resize, picker, record view): `profileFromResult` / `pageFromRows` in `gridmodel.js`; the results grid is built on the first run. Only read-only SELECT/WITH runs: the guard moved to `src/data/sqlguard.js` (re-exported from `pipeline.js`) and is shared with the agents. Queries read the file for columns outside a working set and never extend it. Each chart's ⋯ menu has **Edit in SQL tab**. Arrow keys cycle the three tabs.
- **Tests:** tier 1: `sqlexamples.test.mjs` (4, incl. guard), `gridmodel.test.mjs` (+3: kindFromType, profileFromResult, pageFromRows); real DuckDB in `agents.test.mjs`: every starter query on a bank table is valid, passes the guard and returns rows (the repeated-ids one correctly returns none). Tier 2: 6 checks (run, sort result, guard, examples/chip/history, CSV download, Edit in SQL tab, tab keys); updated the card-menu assertion (+ "Edit in SQL tab"). `check` ✅ (156 unit).
- **Verified:** real app, 50,000-row bank CSV: all 7 starter queries run (0.00–0.01 s), no page errors, status pills and money format in the result grid, account number range now full.
- **Open:** no syntax highlighting or autocomplete (plain textarea); the result is capped at 100,000 rows in memory; one statement at a time.

## 2026-10-08: Trust layer: rows behind a number, plan and assumptions, "Check this number" (steps 2-4)
- **Why:** the user approved the AI-era plan (docs/PERSONAS.md): every number should show its work. Steps 2, 3 and 4 of 7.
- **Changed:**
  - **Drill-through** (`src/data/drill.js`, pure): built-in charts carry a `drill` descriptor (table, base filter, dims: value / time bucket / bin range, measure). Click a bar, point or cell: `drillWhere` builds the WHERE ("Other" = every row not among the other bars, last bin includes its upper edge, time buckets cast safely), the card shows the rows and a one-line check "✓ 8,953 rows: exactly the count on the chart" or "⚠ … Treat this chart with care". Numbers are shown in full (no 1.4M) and ids/account numbers are never compact ("401B" is gone from the drill table and the columns list). The rows query never extends the working set.
  - **Plan + assumptions** (`src/agents/explain.js`, pure): "How this was calculated" under each chart. Built-in charts: one true sentence written from the descriptor ("Adds up amount for each month of posted_at."), what the numbers cover (all N rows, or "a sample: 5,007,360 of 6.1B rows, spread evenly… describes the sample, not the whole file"), caveats from the profile (rows with an empty group column are left out, averaged-not-added). AI answers: the SQL prompt now asks for ONE plain sentence plus 0-3 assumptions ("\"revenue\" is taken to be the amount column") and never to invent facts; replayed in follow-ups; our coverage lines are added. Open by default under your own questions, closed under suggested charts.
  - **Check this number** (`src/data/check.js`, pure + a button on each card): re-runs one aggregate query per mark (an even spread of 40, or 8 on a remote file; the rest reported as not re-checked) and, for counts and sums, a whole-table total, then says in plain words what holds: every mark adds up, the marks sum to a direct total, rows left out because the group column is empty (counted, with %), groups cut off by LIMIT, a sample, an empty result. An AI answer gets only the basics and says so ("Only basic checks were possible"). It also says what it cannot do: it confirms the chart matches its data, not that the data is right.
- **Tests:** tier 1 `drill.test.mjs` (10), `explain.test.mjs` (6), `check.test.mjs` (10); real DuckDB in `agents.test.mjs`: **every mark of every built-in chart on bank-style data reconciles with its rows (checked 20+ marks)**, the check passes on all four charts, finds the 12 rows with no timestamp, and names a tampered bar; ask()/suggest() carry the explanation. Tier 2: drill (click a mark, mismatch warning, close), explain (closed/open, contents), check (verdict, warning, partial for an AI answer). Updated one assertion: the card footer now has Pin, Check this number and ⋯ (3 buttons, was 2). `check` ✅ (148 unit).
- **Verified:** real app, 50,000-row bank CSV: all 38 marks sampled across the four charts reconcile (e.g. type = debit: 41,047 rows = chart; amount by month adds to 13,878,092.93 = direct total); "Check this number" takes 45-77 ms per chart.
- **Open:** AI-written charts and answers have no drill descriptor yet (no click-through, basic checks only); a plan-first step (show the plan, then run) is not built; drill is skipped for raw scatter points and for the Data tab.

## 2026-10-08: Charts: identifiers are not measures (step 1 of the trust plan)
- **Why:** on the bank-style CSV the automatic charts summed and binned `account_number` ("account_number by month" = 1.8 trillion) and missed the useful ones. The Data tab already knew account numbers are identifiers; the chart suggester did not.
- **Changed:** `src/data/roles.js` (new, pure): `ID_NAME`, `MONEY_NAME`, `NON_ADDITIVE`, `STATUS_NAME`, `isIdLike`, `aggregateFor`, `measureRank`; the Data tab (`gridmodel.js`) and `heuristicCharts` now share them. In `heuristicCharts`: ids (by name or unique-per-row) are never a measure; a few-valued id (7 accounts) is a category; the headline measure is additive money first (amount), levels (balance, price, rate, Close) last and **averaged, not summed** (title "Average balance by month"); status-like columns (status, type, category…) are preferred for the breakdown when their distinct count is known; new chart "amount by status" (measure by category) before the histogram; the scatter of two ordinary measures stays but is dropped first.
- **Tests:** `tests/roles.test.mjs` (6, tier 1); in `tests/agents.test.mjs` a bank-transactions test on real DuckDB (exact 4 plans, no account_number as a number, no summed balance, every SQL runs and validates), the average-balance case and the few-valued-account/row-key cases. 119 unit, UI tier ✅.
- **Verified:** the real app on the 50,000-row bank CSV: amount by month (about 1.2M per month, was 1.8T), Top type by count, amount by status, Distribution of amount.
- **Open:** the scatter and "top N by count" still use only the first good nominal; `Close`/`open`/`high`/`low` are treated as levels for every file (right for prices, wrong for a column literally named "open" that counts something).

## 2026-10-08: Gates run their tiers in parallel
- **Why:** the user found the test run slow and sequential.
- **Changed:** `scripts/check.mjs` builds (stub + real, in parallel) then runs unit, stubbed UI and, with `--full`, the DuckDB harness and full-stack tiers at the same time, printing each tier with its time. `npm run check` / `check:full` use it; the old one-after-another runs are `check:serial` / `check:full:serial`. The UI test that waited 4.5 s for a cancelled build now waits 1.9 s (stub build 1.5 s); `TIMING=1 node tests/ui.e2e.mjs` prints each check's time.
- **Tests:** no test logic changed. `check:full` ✅ in 48.8 s (was about 65 s serial): unit 1.7 s, full stack 7.3 s, DuckDB 9.3 s, UI 48.6 s.
- **Open:** the UI tier (75 checks, about 25 browser sessions one after another) is now the floor. Next step if wanted: shard `tests/ui.e2e.mjs` across processes (needs the sections split into functions, since they share a `page` variable and some `const`s).

## 2026-10-08: Layout and styling pass: tokens + calmer cards, one shared shell, 12-column grid
- **Why:** the user found the layout and styling "too bad". An audit found: a 3-column layout (the 320 px trace column was empty
  or developer-facing, charts got ~800 of 1440 px), ~265 px of chrome before the first chart, examples and "Which links work?" twice,
  notices styled five ways, the sample warning buried in the sidebar (below every chart on a phone), 14 font sizes, rainbow bars,
  crowded time ticks, raw Binder errors on cards, holes in the card grid. Steps 1-3 of the audit were approved (baseline, tokens +
  cards, shared shell). The persona "views" (Overview / Explore / Review) are not built; nothing here blocks them.
- **Changed (step 1: tokens + cards):**
  - `styles.css`: spacing `--s-0..6` (2, 4, 8, 12, 16, 24, 32) and type `--t-xs..xl` (11.5, 12.5, 14, 16, 20, 28) tokens; surfaces
    (light bg #f3f3f1 / surface #fff; dark bg #0f0f0f / surface #181817), cards = 1px border + 10px radius, shadows only on popovers
    and drawers, `--text-3` darkened for contrast. Every `font-size`, `padding` and `gap` in the file moved to the tokens (one-off script,
    then the file was reorganised by hand).
  - `src/ui/chartstyle.js` (new, pure): `prepareSpec` / `vegaConfig` moved out of `app.js`. Single hue: a colour that only repeats an
    x / y / facet field is dropped (theme colour instead); colour that encodes anything else (series, stacks, a measure, pie slices) stays.
    Time axes get `tickCount = clamp(width / 90, 3, 8)` and `labelOverlap: greedy` unless the spec sets its own. The spec the agents made
    is never mutated (the Log x toggle relies on that). Heuristic specs in `pipeline.js` were not changed: they never set colour on an
    axis field; the rainbow came from the viz agent / stub answers.
  - Cards: footer = **Pin**, row count and a "⋯" menu (`popover.js`: Escape, outside click, arrows, focus returns): View SQL / Show data /
    Log x / **Download data** (`csv.js`, client-side Blob, file named after the title) / Remove. Uppercase tags only for errors and for
    running / queued on pending cards (which keep SQL, Cancel and the label). Titles 16 px.
  - Failed cards: "This chart couldn't be built from this data." (or "That question couldn't be answered…") plus a native
    `<details>` "Show technical details" holding the raw error (`.err-msg`) and the SQL. SQL no longer opens by itself on errors.
- **Changed (step 2: shared shell):**
  - Layout is now rail | workspace. The third column is gone. The trace is an **Activity** slide-over (`.slideover`, same scrim / Escape /
    focus pattern as the settings drawer) opened from a low-key pill beside the tabs; `.trace`, `.panel-toggle`, `.collapsed`, `.trace-live`
    and the `.run` / `.event` markup are unchanged. New setting **Show agent steps** (default off): off = the pill says "working…" only
    while a run is going; on = "N runs · show steps" always. It does not trigger the pipeline rebuild that provider changes do.
  - **Dataset bar** (after a load): name (title = full name), source link, "N rows × M columns · size", **Columns** toggle,
    **Examples ▾** menu. Sticky under the top bar; on phones the top bar scrolls away and the bar stays at the top. Wording is rows /
    columns everywhere (the architect's mock said "Fields"; per the user's decision the button is **Columns**).
  - **One notice slot** (`.notices`, sticky with the bar): `.status`, a new `.sample-notice` ("Sample: 5M of 6.1B rows, spread across the
    file. [Change]", also shown in the Data tab; Change opens the rail / sheet focused on the full controls), `.cache-banner`
    (`data-status` unchanged, `.cache-progress`, buttons), `.link-hint`. One `.notice` look, tinted info / warn / error / ok. A "Loading …"
    status shows while a first file loads (the start page is replaced and no bar exists yet).
  - **Columns rail** (260 px, collapsible, remembered in `localStorage` `datadrop.rail.v1`): sample controls, table name, column list. At
    ≤ 900 px it is a bottom sheet (scrim, Escape, closes when a column is picked).
  - **Start page**: one 720 px column, headline "Paste a data link. Get a dashboard.", one line + the single "Which links work?",
    four large chips, three trust points, the (disabled) ask bar. No rail, dataset bar or tabs. Provider pill is "AI on" / "AI off" (title
    explains). Top bar: link + **Open**, labelled **File**. Ask bar is one 34-40 px bar; its hint moved to a tooltip.
  - **Card grid**: 12 columns, `grid-auto-flow: dense`, s = 3 / m = 6 / l = 12, answers always 12; below a 700 px workspace (container
    query) m = 12 and s = 6.
- **Tests:**
  - Tier 1 `tests/chartstyle.test.mjs` (new, 8): colour dropped when it repeats an axis, kept for series / stacks / a measure / pies, layered
    specs + input not mutated, tick count by width, explicit ticks / values / hidden axis respected, `prepareSpec`, `toCSV`, `csvFileName`.
  - Tier 2 (`tests/ui.e2e.mjs`), new: card footer + menu contents + 16 px title + no tags; menu keyboard / Escape / outside click; Download
    data (header, row, file name); plain-text failed card + details; single hue (light and dark); thinned time axis (<= 8 labels);
    start page (one column, 3 trust points, no jargon, one link-help entry); shell metrics (workspace >= 1100 px, first card < 200 px,
    2-column grid); dataset bar; Examples menu (Escape, focus, loads an example); rail collapse persists across a reload; Show agent steps;
    full rows next to an answer card (bounding boxes, with an asked card); phone: name in the first screen and sticky while scrolling,
    topbar with labelled File and no horizontal scroll at 375, columns bottom sheet (Escape, scrim, pick a column); sample notice in the
    slot, in Charts and Data, visible after scrolling, Change opens the rail (even when collapsed), on desktop and phone. Mutation check:
    with `.chrome` made non-sticky and the chart rules commented out, 6 of these fail as they should.
  - Assertions I changed (intent kept, listed so nobody has to diff):
    1. The three `.chips.compact` clicks after a load (streaming test, "loading another dataset returns to Charts", "loading a normal file
       clears the banner") now open the **Examples ▾** menu first (`exampleInMenu`).
    2. Provider pill text: `'Heuristic mode · switch to AI'` -> `'AI off'` (+ the title mentions built-in rules); `/^AI mode · /` ->
       `'AI on'` (+ title names Anthropic).
    3. "the agent trace steps aside" in the Data tab (`.trace` hidden) -> workspace width is identical in Charts and Data (>= 1100 px) and the
       Activity slide-over is closed but its pill is still visible. The old behaviour no longer exists; this proves the layout does not jump.
    4. "trace collapses after the first charts, with a 'show steps' summary" (`/2 runs · show steps/` with default settings) -> "activity: a
       low-key pill (closed by default)…": closed, no count by default, opens a slide-over containing a `.run`, focus moves in and back,
       Escape and the scrim close it. The count text is now asserted in the new `"Show agent steps"` test (`/\d+ runs? · show steps/`), since
       it only shows when that setting is on.
    5. Mobile "trace collapsible" -> "activity slide-over opens and closes" (also presses Escape so the scrim doesn't cover the screenshot).
    6. Error card: `.card.error .err-msg` visible -> first asserts it is collapsed, opens "Show technical details", then asserts it is visible
       and contains the Binder error and the SQL. The raw error is still reachable; the plain-English line is asserted too.
    7. Card actions: `getByRole('button', { name: 'SQL' | 'Data' | 'Log x' })` and `.remove` -> the same actions through the "⋯" menu
       (`menuitem` / `menuitemcheckbox`; Log x asserts `aria-checked`, the label flips View SQL / Hide SQL).
  - Gates: `npm run check` ✅ (110 unit, all UI checks, build), `npm run check:full` ✅ (duck e2e + full-stack e2e).
- **Verified:** measured with `layout-metrics.mjs` (stub build, after loading the first example; visible elements; computed values):

  | | before | after step 1 | after step 2 |
  |---|---|---|---|
  | first chart card top, 1440x900 | 215 px | 223 px | **195 px** |
  | first chart card top, 375x812 | 271 px | 279 px | 236 px |
  | workspace width, 1440 | 796 px | 796 px | **1132 px** |
  | distinct font sizes (computed, visible) | 10 | 4 | 4 |
  | distinct padding values (computed, visible) | 15 desktop / 13 phone | 6 / 6 | 8 / 6 |
  | `font-size` values declared in styles.css | 15 | 7 (6 tokens + inherit) | 7 |
  | distinct padding tokens/values declared | 19 | 10 | 10 |
  | dataset name in the first screen, phone | no (1297 px down) | no (1251) | **yes (104 px)** |
  | dataset name top, desktop | 168 px | 176 px | 63 px |

  Step 1 costs 8 px (taller card titles and footers) before step 2 wins ~30. Screenshots in `tests/screens/`: `before-*`, `step1-*`,
  `step2-*` (metric runs), `shell-*` (stub: start, sampled, activity, card menu, examples, data, phone sheet; light and dark). Real app
  (`npm run build`, real DuckDB): the 50,000-row bank CSV and the apple-stock example at 1440x900 and 375x812, light and dark
  (`real-*.png`): 4 and 2 cards, no failed cards, no console errors, no horizontal scroll, one colour for the category bars, time axes
  at 4 labels, Data tab grid at the full workspace width, first card 195 px (desktop) / 236 px (phone) down, bank CSV ready in 2.0 s.
  The Examples menu, Activity slide-over and columns sheet were checked in the stub build only.
- **Open:**
  - Not done on purpose: persona views (Overview / Explore / Review); no per-mode CSS hooks were added (not free).
  - Sticky chrome costs vertical space on a phone when several notices stack (dataset bar + sample + working-set ready is ~190 px of
    812). "Working set ready" is dismissible; a compact mobile notice (or auto-dismiss) is the next step.
  - The Data tab toolbar still has its own "Columns · 11 of 11" picker next to the new **Columns** toggle in the dataset bar; same word,
    different jobs (grid columns vs the side list). Worth renaming one. The record view still says "record" in aria labels
    ("Close record"): left alone (existing tests, and it is not user-visible text).
  - Tick thinning uses the card width at first draw (the width is unknown for a card drawn while hidden, then it uses 6). A resize
    doesn't redraw charts.
  - The grid's explorer height (`100vh - 360px`) leaves a small gap under the grid now that chrome is shorter.
  - Heuristic charts still choose odd things on some data (e.g. total of an account number); not part of this pass.

## 2026-10-08: Data tab: a grid and a record view for exploring the rows
- **Why:** the user wanted better ways to look at the actual data (grid, single-record view, other easy ways to explore),
  asked for 1 (grid) and 3 (record view) with good styling and ease, and said banking data in particular should be easy to explore.
- **Changed:**
  - **Charts / Data tabs** in the workspace (the Data tab shows the row count). Opening Data gives the grid the width (the
    agent trace steps aside); loading a file or asking a question switches back to Charts, where progress and answers show.
  - `src/ui/explorer.js` (new): virtualized grid. Sticky header and row-number gutter, fixed row height (comfortable /
    compact), pages of 200 rows cached (30 pages), only visible rows in the DOM; past ~220k rows the scrollbar is scaled so
    5M rows are still reachable. Header: name, type/role + range or distinct count + null %, sort (click: asc, desc, off),
    ⋮ menu (stats, sort, pin left, hide, copy name), drag to resize. Toolbar: column picker (search, show all, defaults),
    row density, go to row, sort chip, reset view. Keyboard: ↑↓/PageUp/PageDown/Ctrl+Home/End move the row, Enter opens
    the record, Esc closes it. Double-click a cell copies it. Skeleton rows while a page loads; a failed page shows an
    inline retry. Clicking a column in the schema panel opens the Data tab at it.
  - **Record view**: side panel (full-screen over the grid when the grid area is under 760 px): every field of the row,
    formatted, prev/next, find a field, hide empty fields, click a value to copy, Copy JSON, URLs become links, nested
    values pretty-printed.
  - `src/ui/gridmodel.js` (new, pure): `columnRole` (money, decimal, int, id, date, datetime, bool, category, json, text),
    `formatCell`: amounts with 2 decimals, grouping and negatives red (only DOUBLE/DECIMAL columns with money-like names,
    so integer counts don't get ".00"), IDs and account numbers never grouped, timestamps as `YYYY-MM-DD HH:MM:SS`,
    statuses and credit/debit as colour-coded pills (`statusTone`), nulls dimmed; `windowFor`/`scrollTopFor`, `pagesFor`,
    `columnGroups`.
  - `Duck.pageRows` (new): the one way the grid reads rows. **Found by the first real-DuckDB check:** plain
    `LIMIT/OFFSET` pages came back in a different order from the file than from the working set (the working set is built
    out of order by parallel lanes), so building one while scrolling would have duplicated and skipped rows. Now a remote
    table's natural order is file order in both, a page is read by `file_row_number` range (row groups are skipped instead
    of scanned up to the offset), and sorting breaks ties by file row. It uses the working set only when it holds every
    column involved, and never extends it.
  - Remote files: only the 12 first columns are shown at first (each is a download). A page is fetched in column groups
    (working-set columns first, then groups of 4, in parallel across the lanes) and the cells fill in as groups land.
    A hint says rows come straight from the file until a working set exists.
  - `sliceRanges` in `sample.js`; `h()` moved to `src/ui/dom.js`.
- **Tests:** `tests/gridmodel.test.mjs` (13, tier 1) and `sliceRanges` in `tests/sample.test.mjs`; 20 `Data tab …` checks in
  `tests/ui.e2e.mjs` (stub `Duck.pageRows` over 240 rows, a 40-column wide table, delayed and failing pages; light, dark,
  phone); the `grid:` block in the DuckDB harness (pages cover every row once, same order from the file and the working
  set, ties, record = row at offset, past-the-end and last page, a downloaded table). `check` ✅, `check:full` ✅ (102 unit).
- **Verified:** a 50,000-row bank-style CSV (amounts, balances, account numbers, timestamps, statuses, credit/debit, memos):
  money right-aligned with negatives red, pills, sticky gutter and pinned column, sort by amount, jump to row 40,000 and
  to the end, record view. The chutes S3 file (5M-row sample of 6.1B): the 4 working-set columns paint in 0.12 s and the
  other 8 columns at 12.4 s (one row group's worth of 8 columns, in parallel groups). Before column groups, a page of 14
  columns took about 17 s at any new position, and 23 s while the working set was still building. Back to a cached page: 0.1 s.
- **Open:**
  - A page of a remote file outside the working set costs a row group per column group (~12 s here). Next step: a button
    that adds the visible columns to the working set (memory-guarded) for instant scrolling.
  - Sorting a 5M-row remote sample by a column outside the working set scans that column over the whole sample (not measured).
  - Filters (and linking them with the charts) are the next planned step, then group-by and a SQL box.

## 2026-10-08: Share links from Google Drive, Sheets, Dropbox, OneDrive and others, with help for each
- **Why:** the user asked for direct Microsoft OneDrive, Google Drive and "any" links, with help text for each.
- **Changed:**
  - New `src/data/links.js`: `LINK_SOURCES` (name, example, how to share, what to do if blocked), `linkSourceFor`,
    `shareLinkToDirect`, `sniffFormat`. Rewrites: Drive -> `drive.usercontent.google.com/download` (CORS + Range;
    `drive.google.com/uc` has neither); Sheets -> `export?format=csv&gid=` / published `pub?output=csv`; Dropbox ->
    `dl.dropboxusercontent.com` (keeps `rlkey`); OneDrive -> `api.onedrive.com/v1.0/shares/u!<b64url>/root/content`;
    SharePoint -> `download=1`; Gist -> `gist.githubusercontent.com/…/raw`; GitLab (any host) -> files API (raw URLs
    have no CORS); Bitbucket `src` -> `raw`; Hugging Face `blob` pages -> `resolve`. Folders, Box share pages and
    Google Docs/Slides get a clear error before any download.
  - `github.js`: `fetchDirectFile` detects the format from the bytes when the link has no extension, rejects HTML
    (sign-in / quota pages) with the provider's advice, and gives per-provider network/403 errors. Known non-data
    extensions (.xlsx, .zip, .md…) are refused before downloading. `resolveRemoteFile` probes Drive links for Parquet,
    so a Parquet file on Drive is read in place with range requests.
  - UI: a hint under the link bar for the kind of link being pasted (also shown next to a load error), and a
    "Which links work?" panel (examples row and start page) listing every source with an example. New placeholder.
- **Tests:** `tests/links.test.mjs` (11, tier 1: every rewrite, refusals, sniffing, Drive sniff + source, error
  messages, Drive Parquet probe); tier 2: link hint + error, help panel, hint hidden after load. `check` ✅, `check:full` ✅.
- **Verified:** the real app loads a public Google Sheet from its `/edit#gid=0` link (30 rows, `google_sheet.csv`).
  Real downloads in Node through `fetchGitHubFile`: Gist, GitLab, a Hugging Face `blob` page. Help panel checked
  at desktop and 375 px (no sideways scroll). A Drive link whose file is over Google's quota shows the Drive error + hint.
- **Open:**
  - A healthy public Drive file wasn't downloaded end to end: every public test file found was over its download quota.
    A Range request to one returned 206 with `access-control-allow-origin: *` before the quota kicked in.
  - OneDrive personal and Dropbox weren't tried with a real shared file (none available). The URL rewrites are unit
    tested, and the CORS headers were checked on the endpoints.
  - Drive doesn't expose the file name to the browser (Content-Disposition isn't CORS-exposed), so tables are named
    `google_drive_<id>`.

## 2026-10-08: Working set: cache only the columns the charts use, built in parallel
- **Why:** the user asked whether Mosaic could coordinate the chart queries, wanted to see the approach first, then
  set the order: column-union planning → single-lane copy → parallel + combine cost → incremental columns → result cache
  → memory guard, with the UX: "Building working set (N columns)…" + bar, "Working set ready" chip, "Adding N columns…",
  Settings "Clear working set" / "Prefer low memory".
- **Mosaic (read its source):**
  - `QueryConsolidator` merges only queries with the same FROM and GROUP BY that differ only in SELECT, and bails on
    WHERE/HAVING/ORDER BY/DISTINCT. Our 4 charts group differently, so it would merge nothing.
  - Pre-aggregation is for cross-filtering.
  - It needs DuckDB-WASM 1.33-dev and one DuckDB instance.
  - Not adopted. Worth revisiting for linked brushing.
- **Changed:**
  - `src/data/workset.js`: `columnsInSql` (strips literals and comments; `SELECT *` / `table.*` / alias.* / DESCRIBE =
    every column; a CTE's `x.*` is not), `unionColumns`, `splitGroups`.
  - `Duck`:
    - `buildWorkingSet` copies `__row` + columns into `<t>__ws`. The rows are cut into units of row groups (≥2 per
      lane); free lanes pull the next unit; lane 0 inserts its own units, the other lanes ship Parquet bytes that lane 0
      inserts. Lane 0's `<t>` view then reads the working set; `<t>__remote` keeps the file view.
    - `extendWorkingSet` joins on `__row`; over budget it drops non-kept columns, and if that's not enough it refuses.
    - Also `clearWorkingSet`, `missingColumns`, `memoryMB` (`pragma_database_size`), `workingSetDownloadMB` (+ footer
      bytes × workers, measured at attach), and `onWorkingSet` events.
    - `query()` routes working-set columns to lane 0 and auto-extends for others (or reads the file on lanes 1+). Results
      are cached by (data generation, SQL), LRU of 64, with in-flight de-dup. Every data change bumps the generation.
    - Lanes start their workers during attach and are ready once the file is registered. Their views are created lazily,
      on the first query that needs one.
    - Fast mode = a working set of every column.
  - Pipeline: `suggest(…, { beforeRun })`, `buildWorkingSet`, `clearWorkingSet`.
  - UI: the decision moves to plan time (the charts' column union → estimate → tier); green builds before the charts
    run. A banner shows building (bar from finished units) / asking / ready chip / extending / light. Settings has
    "Working set (recommended) / Fast mode / Prefer low memory" and a "Clear working set" button.
- **Bugs found by the tests:**
  - The LIMIT wrapper (`SELECT * FROM (…) LIMIT n`) made every query look like "all columns", which silently
    turned any working set into a full copy. Column analysis now uses the original SQL.
  - `x.*` on a CTE counted as `SELECT *`.
  - The Clear button was dropped by `field()` (only one extra element).
  - Progress from byte counters stalled: busy workers don't answer, so progress now comes from finished units.
- **Tests:**
  - Tier 1: `tests/workset.test.mjs` (including the chutes dashboard → exactly 4 columns), plus memory budget/estimate tests.
  - Tier 3 `workingset:` block: single / parallel = the sample; no growth from the LIMIT wrapper; parallel split +
    progress 33/67/100; auto-extend answers like the file, with events; result cache hit / in-flight / invalidation;
    the guard refuses an extension (query reads the file), keeps kept columns, and abandons an oversized build.
  - Tier 2: green/yellow/red/phone, extension banner, Clear working set, low-memory + build, fast mode = every
    column, cancel.
  - `check:full` ✅ (77 unit).
- **Measured (chutes, 5M spread sample, cold, this machine):**
  - Working set of 4 columns, single lane: 29.2 s. Parallel: 15.4–17.4 s. Combine: 0.4–0.9 s. Memory: 247 MB
    (estimated 283). The 4 charts then took 0.55 s.
  - In the app: dashboard complete at **28.7 s** (vs 53.5 s with parallel file reads, 88.6 s serial). Re-runs are
    instant, and repeats come from the result cache.
- **Open:**
  - Progress is coarse with few slices (5 units here).
  - Shrinking drops columns but doesn't reduce rows.
  - Mosaic-style cross-filtering is not started.

## 2026-10-08: Fast mode: cache a big file's sample in memory, decided by a memory check
- **Why:** each query on the sampled 6.1B-row trace paid ~6 s of footer processing (5 slices × ~1.2 s). The user specified
  the flow: check memory first; green → cache automatically with progress; yellow → one-click "uses ~700 MB" offer;
  red → light mode; a "Cache ready" badge after; a setting for always fast, always low memory, or ask. It has to work on
  phones and tablets.
- **Changed:**
  - New `src/data/memory.js` (pure):
    - `estimateSample(profile)` = Σ compressed bytes/row × rows × 1.45 read overhead, then × 7 for memory. Calibrated on
      the chutes sample: estimated 104 MB / 731 MB vs measured 105 MB / 741 MiB.
    - `readMemorySignals()` reads `navigator.deviceMemory`, `performance.memory` and mobile (`userAgentData`, else a
      coarse pointer without hover). `window.__memorySignals` overrides it.
    - `memoryTier`: green ≤15% of RAM, yellow ≤30%, else red; half on mobile; red above 2 GB (32-bit WASM). Without a
      signal: desktop → yellow, phone → red unless under 300 MB.
    - `cacheDecision(tier, preference)`: "fast" never overrides red.
  - `Duck.materialize(table, { signal, onProgress })`: `CREATE TABLE <t>__cache AS SELECT * FROM <view>` on lane 0 via
    `send()`, so DuckDB's file statistics can be polled for real progress. The view is then repointed at the cache, the
    other lanes are retired, and waiting queries go to lane 0. `resample` drops the cache and restores the remote view
    and lanes. `isCached()`.
  - `pipeline.materialize()`.
  - UI: a non-blocking banner in the workspace (visible on phones, where the dataset panel collapses). States:
    running (MB of ~MB + progress bar + Cancel), asking (Cache it / Keep light mode), done ("Sample cached · charts and
    questions are now instant"), light (memory / preference / cancelled / error, with "Cache now" except on memory).
  - Settings: "Large files: Ask when it needs a lot of memory / Always prefer fast mode / Always prefer low memory".
    Changing only this setting doesn't rebuild the pipeline (which would drop the cache).
  - Queued cards now say "starts when a DuckDB worker is free".
- **Tests:**
  - Tier 1: `tests/memory.test.mjs` (estimate, tiers incl. mobile / no-signal / WASM ceiling, decisions, signal reader).
  - Tier 2: green auto with progress → done; yellow waits for a click; red has no offer; phone without signals →
    light and fits 390 px; the low-memory setting + "Cache now"; cancel mid-copy stays light; a normal file clears the
    banner. The UI stub treats a file named "big…" as a sampled file.
  - Tier 3: the materialize block (same rows as the sample, lane 0 afterwards, lanes retired, resample drops the cache
    and brings the lanes back).
  - `check:full` ✅ (72 unit).
- **Verified (chutes, this machine: deviceMemory 32 → green):**
  - Caching started automatically at 7.8 s, with progress shown live, and was done at 85 s.
  - It ran alongside the charts (all 4 in by 51 s); standalone it takes ~42 s.
  - After caching, the 4 charts re-ran in 91 / 124 / 448 / 875 ms (vs 17–44 s each). A 375 px yellow banner was checked by screenshot.
- **Open:**
  - While caching, the cache and the charts share bandwidth. Charts could wait for a green cache instead (~same total,
    but no progressive charts).
  - The estimate's 1.45 / 7 factors come from one file; check them on other shapes.

## 2026-10-08: Parallel queries: DuckDB worker pool ("lanes") for remote Parquet
- **Why:** the user wanted chart queries in parallel, not one by one.
- **Changed:** `duck.js`: up to `REMOTE_LANES` (4) DuckDB workers for the attached remote file. Each opens the same URL
  under the same file name and runs the same view SQL; they come up in the background after attach. Pooled queries
  (SQL that mentions the table) wait in a shared queue, and the first ready, idle lane takes the next one. Everything else
  uses lane 0. Resample re-spreads the view, and new attaches take stale lanes out of rotation. `onStart(laneId)`.
- **Bugs found while building it:**
  - Lanes chosen at enqueue time all landed on lane 0 (others weren't up yet): now a shared queue.
  - A lane-creation race created duplicate workers.
  - Holes in the lane array crashed dispatch and flipped finished cards back to "running": the UI now ignores late onStart.
  - Stale lanes still had the previous file's view.
  - The DuckDB e2e silently skipped its whole Parquet block on any error. It now fails unless the error is a genuine
    extension/network problem.
- **Tests:** tier 3 `lanes:` block: 4 lanes ready; 4 concurrent heavy queries run on 4 lanes in ~1× the time of one;
  queries sent before the lanes are up still spread out; same answers; resample reaches every lane.
  `test:duck` ✅. `check` was not re-run after the last edit (usage limit).
- **Verified (chutes, fresh page):** charts done at 26.4 / 33.2 / 39.8 / 53.5 s, against 30.6 / 42.0 / 60.6 / 88.6 s serial.
- **Found, not fixed:** each `read_parquet` open of this 6,114-row-group file costs ~1.2 s of footer processing (0 MB
  read), so a 5-slice spread sample pays ~6 s per query; `enable_object_cache` barely helps. Materializing the sample
  once took 42 s, read 105 MB and used 741 MiB of memory. After that, queries took 0.12–0.25 s. Open decision: offer it
  (memory!), use fewer slices, or both.

## 2026-10-07: Charts stream in, can be cancelled; dashboard layout model
- **Why:** the user saw "Suggest 66.4 s" with nothing on screen until the last query finished, and asked for instant
  feedback, the running query and label, a way to cancel or delete a chart, and a better layout model for future AI.
  They then asked why queries run one by one.
- **Changed:**
  - `Duck.query` is queued (one statement at a time; DuckDB-WASM has one single-threaded worker anyway) and runs via
    `conn.send()`, so `conn.cancelSent()` can interrupt it. `signal` drops a queued query or cancels a running one.
    `onStart` fires when it runs. Loads wait for the queue to drain.
  - `pipeline.suggest(onTrace, { onPlans, onStart, onCard, signalFor })` streams. A cancel marks the card `cancelled` (not
    an error, no SQL repair). `pipeline.run(plan)` re-runs one chart.
  - UI: placeholder cards appear at once with title, question and SQL, tagged queued / running (live timer), with Cancel
    and ×. Each is swapped in place when its chart is done, without redrawing the others. Cancelled cards offer "Run
    again". The grid releases "busy" once placeholders show, and a new load or resample cancels pending charts.
  - New `src/agents/layout.js`: `{ section, size, priority }` per chart; `inferLayout(spec)`, `normalizeLayout` (for LLM
    hints), `orderCards`, and `LAYOUT_PROMPT`. The planner prompt asks for a layout. The grid orders by section and
    priority, and size `l` spans both columns.
  - `renderGrid` now moves existing card elements instead of finalizing every Vega view on each render.
  - Fixes found on real data:
    - Near-constant numbers (`rehash_round`, 0.0002 B/row) are categories, not measures; they were driving 3 of 4 charts.
    - Crowded symlog axis labels: now `~s` format with greedy overlap removal.
    - A stray "null" in the dataset panel: native `append(null)`.
    - Null % from cumulative footer counts (NYC file: 309%): groups claiming more nulls than rows now mean unknown.
- **Tests:**
  - Tier 1: `tests/layout.test.mjs`, `suggest streams…` (plans first, per-card events, pre-cancelled chart never starts,
    `run()`), `planner layout hints…`, `near-constant number…`.
  - Tier 2: `charts stream in…` (placeholders with SQL, queued/running, cancel a queued chart, first chart draws while
    others run, Run again, full-width trend). The UI stub pipeline now streams.
  - Tier 3: cancel block (a running query is cancelled within ~10 ms of abort; a queued one never starts; the connection
    is fine after), plus a null-% fixture.
  - `check:full` ✅ (68 unit, 23 UI, duck, full).
- **Verified (chutes trace, 5M spread sample, cold):** placeholders at 8.3 s; charts at 31 / 42 / 61 / 90 s. Before,
  nothing appeared until ~66 s and later. Titles: it by month, Top function_name, Distribution of it (log), it vs ot
  (log×log density). The screenshot was checked.
- **Open:**
  - Queries are still serial. A pool of 2–3 DuckDB workers for remote Parquet would let them overlap network waits. Not
    built yet; it needs measuring (memory per worker vs speed-up).
  - Totals in a time trend over a spread sample are sample totals (5 slices), so a line between slices implies
    continuity that isn't there.

## 2026-10-07: Review round: chart quality, schema polish, softer AI prompt, pin/remove
- **Why:** items 2–6 of the pasted product review.
- **Changed:**
  - Heuristics (`pipeline.js`):
    - **Time trend:** with under 3 periods, the card shows a note ("No clear time trend…") instead of a one-point line.
    - **Top N:** shows the top 9 + "Other", so the bars add up to every row.
    - **Histogram:** uses log bins (`ln(1+x)`) and a symlog axis when a column is heavy-tailed (non-negative, with 90% of values
      in the bottom 10% of the range); this is decided in the same SQL via `approx_quantile`.
    - **Scatter:** over 5,000 rows it becomes a 30×30 density grid over every row, with the same per-axis log rule.
    - Plans can carry `adapt(result, spec)` and `minRows` / `note`, which `runPlan` honours.
  - Cards: `Log x` toggle (any quantitative x), `Pin` (kept across re-suggest and resample), `×` remove.
  - Schema: columns ≥50% null are dimmed and tagged "mostly null" / "empty". Schemas with over 20 columns are grouped into
    collapsible Timestamps / Identifiers / Metrics / Text / Other sections.
  - AI: the API-key banner is gone. Without a key the ask box is hidden, and a small "Enable AI questions" chip opens
    Settings. The mode pill is a button: "Heuristic mode · switch to AI" or "AI mode · <provider> · <model>".
  - The trace collapses once after the first successful charts; its header reads "N runs · show steps".
    A manual toggle sticks.
  - New example chip: "LLM trace, 6.1B rows" (the S3 chutes file).
- **Tests:** tier 1 on real DuckDB: heavy tail → log bins + symlog, plus a density grid that counts every row;
  linear data stays linear and small tables keep the scatter; top 9 + Other; the time-trend note. These caught
  `SUM()` → HUGEINT, which arrived as a Uint32Array; it's now cast to BIGINT. Tier 2: AI chip / no banner / 4 chips /
  mode pill text, trace auto-collapse, mostly-null tag, pin / log x / remove. `check:full` ✅ (61 unit, 22 UI).
- **Verified:** tests only so far. The browser check is folded into the streaming work below.
- **Not done from the review:** "estimated RAM" (not applicable, see the sampling entry); the AI asking for a different
  sample (needs a tool-use loop); hour-of-day as an alternative trend.

## 2026-10-07: hf:// URIs, including globs
- **Why:** the user asked for `hf://datasets/harvardMadsys/freeinference_agentic_trace/release/*/processed/sessions.parquet`.
- **Changed:**
  - New `src/data/hf.js`: `parseHfUri` (datasets/models/spaces, `@rev`), `globToRegExp` (`*`, `?`, `**`),
    `hfListGlob` (Hub tree API, follows `Link` pagination), `hfResolveUrl` and `hfPageUrl`.
  - A single-file `hf://` maps to its `/resolve/` URL, so it gets the normal paths (download, or a big Parquet file read in place).
  - A glob downloads every match (same format, 200 MB total, ≤500 files, 6 parallel downloads) as `parts`.
    `Duck._loadParts` combines them with `UNION ALL BY NAME` and adds a `source_file` column.
  - The UI shows "sessions.parquet × 16 files", links to the Hub folder, and keeps the `hf://` URI in the share link.
- **Tests:** new `tests/hf.test.mjs` (parse, glob, URLs, paginated listing, glob → parts, friendly errors, LIVE listing).
  Tier 3: parts with different columns are combined by name, with `source_file`. `check:full` ✅ (57 unit).
- **Verified:** the user's URI → 16 files, 333.9 KB, 14,036 rows, 3 charts, in 1.8 s.
- **Open:** a glob of big Parquet files is still downloaded, not read in place (needs multi-file sampling).

## 2026-10-07: Sampling for huge remote Parquet: spread / first / next, sizes
- **Why:** review item 1. The first 5M rows of the chutes trace are its first day, which biases answers: `chat_stream`
  topped function counts in the head, while a spread sample says `chat`.
- **Found:** DuckDB 1.1.1 prunes row groups for `file_row_number >= a AND < b`. A 1M-row window at row 3B read
  11 MB in 4.6 s. It does **not** prune for ORs of ranges: that ran 80+ s, scanning the whole column. Hence one SELECT
  per range joined with `UNION ALL`.
- **Changed:**
  - New `src/data/sample.js`: `withStarts`, `pickRowGroups` (spread / window), `rowRanges`.
  - `Duck.attachUrl({ sample })` and `Duck.resample()`. The view is the sampled whole row groups, and the profile
    takes its stats from those groups only. The default for big files is now **spread** (was: first rows).
  - `pipeline.resample()`.
  - UI: a prominent sample panel (warn colour) shows rows of total and how they were picked, plus an estimated
    download per chart. Buttons: Spread / First rows / Next rows →, and a size select (1M/5M/10M). It re-runs charts.
  - The prompt note describes the sample.
  - The review's "show memory pressure (~X GB RAM)" doesn't apply: remote Parquet isn't held in memory, so the panel
    shows the download cost instead.
  - `?debug` exposes the app as `window.__datadrop` for agents and DevTools.
- **Tests:** new `tests/sample.test.mjs`. Tier 3 rewritten on a 5-row-group fixture: spread picks groups 1 and 3,
  first / next windows, profile min/max from the sampled groups only.
- **Verified:** chutes trace → "Sample: 5M of 6.1B rows, spread across the file in 5 slices… about 9.9 MB per chart".
  Cost of spreading, cold, count + min/max of started_at over the 5M-row sample: 5 unaligned 1M windows read 55.9 MB in 27.2 s; aligned to whole row groups (shipped) they read 27.9 MB in 16.4 s. The first-5M-rows head read 29 MB in 8.5 s: spread needs a similar download, but more round trips.

## 2026-10-07: s3:// and gs:// links; row cap for huge remote Parquet
- **Why:** `s3://harvardsys-datasets/2026_chutes_anonymized/chutes_trace.parquet` was rejected. Once it was accepted,
  it turned out to be 84.8 GB with 6.1B rows in 6,114 row groups. Any default chart would scan a 10–24 GB column.
- **Changed:**
  - `storageToHttps` (github.js): `s3://b/k` → `https://b.s3.amazonaws.com/k` (path style when the bucket has dots),
    and `gs://b/k` → `https://storage.googleapis.com/b/k`.
  - `attachUrl`: files over `REMOTE_ROW_CAP` (5M rows) get a view over their first 5M rows. The profile uses footer
    stats from just those row groups and adds `totalRows`.
  - The UI shows "5M of 6.1B" rows plus a note that these are the first rows, not a random sample. The AI prompt
    gets the same note.
  - The time-series heuristic gained hour and minute grains; the head of the trace spans ~22 h, which made a 1-point day chart.
  - Sizes now display in GB, and the trace prints large counts with separators.
- **Tests:** tier 1 `storageToHttps: *`, `s3:// URIs load like https links…`, `…hour / minute grain…`.
  Tier 3: row cap (`rowCap: 100` on the 240-row fixture). `check:full` ✅ (46 unit, 18 UI, duck, full).
- **Verified (cold, S3 us-east, the chutes trace):**
  - Footer: 6 s. Dataset panel: ~15 s. 4 charts by ~29–37 s, all fine, with "it by hour" showing 23 points.
  - Measured beforehand: a 1M-row head read 22 MB in 7 s, and a 5M-row head read about 29 MB more.
- **Open:**
  - The first N rows are biased: here the trace is time-ordered, so it's the first day. A row-group sample spread
    across the file would be more representative.
  - The cap and the 5M value are not user-adjustable.
  - The share link switches to the https form of the URL.

## 2026-10-07: Rename to DataDrop; testing strategy; agent docs
- **Why:** the name "gitviz" undersold the app now that any URL works. Incremental changes also needed a
  per-feature testing strategy, and agents needed an easy way to see what happened before them.
- **Changed:**
  - Name, title, header, empty-state copy and URL placeholder now say DataDrop. The URL field's aria-label is now
    "Data file URL", and the download step in the trace is labelled `fetch` instead of `github`.
  - Settings key `gitviz.settings.v1` → `datadrop.settings.v1`. The old key is still read, so saved API keys carry over.
  - Added `TESTING.md` (tiers, feature → test map, rules), `AGENTS.md` (+ `CLAUDE.md` → `@AGENTS.md`) and this log.
  - `playwright@1.48.2` is now a devDependency, so the browser tiers run on any machine (they used to assume a
    Linux dev container). New scripts: `test:ui` (builds stubs first), `test:duck`, `test:full`, `check`, `check:full`.
  - CI (`pages.yml`) runs `npm run check:full` before it deploys. It used to run unit tests only.
- **Tests:**
  - Tier 1: `heuristicCharts on a remote Parquet profile…`. It fails on the old sort, which picked `pickup_datetime`.
  - Tier 2: `DataDrop branding`, `pre-rename settings migrate`, `trace timer counts up live past 1 s, then freezes`
    (checked by disabling the timer: the test fails), plus a `fetch` chip check.
  - Tier 3: remote Parquet over a local Range-capable server (footer stats, no sample, same answer as the
    downloaded table, Range reads, CSV fallback, a table replacing the view).
  - `check` ✅ (43 unit, 18 UI checks, 14 s). `test:e2e` ✅ (duck + full, 9 s).
- **Verified:** the full gate passed locally on Windows. The renamed UI was not re-checked by hand beyond the tier-2 screenshots.
- **Open:** product ideas from the review, not started: softer API-key banner; collapse the trace after success;
  size warnings for very large files; export (Vega-Lite JSON / PNG); smarter defaults (geo scatter for lat/lon,
  time series first); pin/unpin charts; collapsible schema panel on small screens. The repo folder is still
  named `gitviz`, and the project is not under git yet.

## 2026-10-07: Remote Parquet is queried in place, not downloaded
- **Why:** the user asked why the whole file is loaded when Parquet allows reading only the metadata and the
  columns each query needs.
- **Changed:**
  - `resolveRemoteFile` (github.js) checks that the server supports Range requests: a 4-byte probe must return 206
    and start with `PAR1`, and a Git LFS pointer moves on to the media URL. The size comes from `content-range` or a HEAD request.
  - `Duck.attachUrl` creates a VIEW over `read_parquet` via `registerFileURL(HTTP)`.
  - `_profileRemote` reads only the footer: row count, nulls, min/max and `bytesPerRow`, with no distinct counts and no sample rows.
  - `heuristicCharts` uses `bytesPerRow` in place of the missing distinct counts.
  - Everything else (CSV/JSON, no range support, token) still downloads in full.
- **Tests:** tier 1 `resolveRemoteFile: *` (3 tests). Tier 3 coverage was added in the entry above.
- **Verified (cold cache, R2, NYC rides 2010, 48.6 MB, 1M rows × 18 cols):**
  - Dataset panel ready in 1.5 s (the profile took 49 ms). Three charts by 8.7 s, against ~30 s for the full download.
  - DuckDB's file statistics: the profile read 0 MB of column data; the 3 chart queries read 4.5 MB.
  - A first version also scanned the small columns and pulled 5 sample rows. That took 27.6 s cold, because every
    column chunk is a separate round trip and `SELECT * LIMIT 5` read ahead ~23 MB. Hence the footer-only profile.
- **Open:** nothing is cached between queries, so every question downloads its columns again (~8 MB for a lat/long
  column). Options: cache column chunks, or download the full file in the background.

## 2026-10-07: Live timer in the agent trace
- **Why:** the user wanted to see time pass while a step runs, in seconds once a step passes 1 s.
- **Changed:** `app.js` has one shared 100 ms ticker while any run is active. An open step shows `…` until 1 s, then
  `1.0 s`, `1.1 s`… The run header ticks the same way. The ticker stops when nothing is running.
- **Tests:** tier 2 `trace timer counts up live…`, added in the entry above.
- **Verified:** during a 48 MB download the step counted 4.0 s → 5.5 s over 1.5 s. Final times froze at the end.

## 2026-10-07: Any https data URL, not just GitHub
- **Why:** an R2 link failed with "Not a recognised GitHub file URL".
- **Changed:**
  - `fetchGitHubFile` fetches any non-GitHub http(s) URL directly, with a CORS hint when the network fails.
  - The UI shows the host as the source link and shares the view as `?url=`.
- **Tests:** tier 1 `fetchGitHubFile: non-GitHub https URL is fetched directly`; updated the bad-URL assertions.
- **Verified:** the R2 parquet loaded (1M rows) and GitHub examples still worked.

## 2026-10-07: First local run
- **Changed:** ran `npm ci` + `npm run build`, and added `.claude/launch.json` (serves `dist/` on :5173).
- **Verified:** the Apple stock example loaded and drew 2 heuristic charts.
