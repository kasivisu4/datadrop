# DataDrop

Paste any public data URL and get an instant, interactive dashboard. No upload, no backend, no account.
Links can point to GitHub, Google Drive or Sheets, Dropbox, OneDrive, GitLab, Hugging Face, S3, R2 or any server that allows cross-origin reads. Everything runs in your browser:

- **DuckDB-WASM** loads and profiles the file (CSV, TSV, JSON, NDJSON, Parquet; Git LFS works too).
- **Agents** suggest charts and turn plain-English questions into SQL, run it, pick a Vega-Lite chart and
  check it against the result columns. **Activity** shows each step live.
- With no API key, DataDrop still works: heuristics pick a time series, a top-10 bar chart and a histogram.

There is no backend. Your API key is kept in this browser's localStorage and sent only to the provider you pick.

## Use it

- Paste a URL such as `https://github.com/plotly/datasets/blob/master/2014_apple_stock.csv` and press **Open**
  (or pick one of the four examples on the start page).
- **The layout:** after a load, a **dataset bar** under the top bar shows the file name, its source, "N rows × M
  columns" and size, with **Columns** (show or hide the column list on the left; on a phone it opens as a sheet) and
  **Examples ▾**. One **notice line** below it carries everything that needs attention: loading and errors, the working
  set, and for a huge Parquet file "Sample: 5M of 6.1B rows" with a **Change** button, so you always know how much of the
  file the numbers come from. The **ask bar** (plain-English questions, needs an API key; without one it shows how to
  add it) sits above the **Charts / Data** tabs. Charts use the full width.
- **Cards:** each chart has **Pin** and a "⋯" menu: View SQL, Show data, Log x, **Download data** (CSV of the chart's
  rows), Remove. A chart that can't be built says so in plain words, with "Show technical details" for the raw error.
- **Activity** (small button beside the tabs): a slide-over with what the agents did, step by step, with timings.
  Settings › "Show agent steps" keeps a run count next to the button.
- Any other direct `https://` link to a data file works too (S3, R2, etc.), as long as the server sends CORS headers. If a server doesn't (the NYC taxi files on CloudFront don't), DataDrop says so and offers a download link: save the file and drop it on the page.
- Share links are turned into direct downloads: Google Drive (`/file/d/<id>/view`), Google Sheets (the open tab, as
  CSV), Dropbox, OneDrive, SharePoint, Box direct links, GitHub Gist, GitLab, Bitbucket and Hugging Face file pages.
  Links without a file extension are detected from the file's first bytes. **Which links work?** in the app shows how
  to share from each one, and a hint under the dataset bar explains the link you paste.
  Checked by hand (2026-10-08): Sheets, Drive (direct endpoint), Dropbox (`dl.dropboxusercontent.com`), Gist, the
  GitLab files API and Hugging Face send CORS headers. www.dropbox.com, GitLab raw URLs and Box share pages don't.
  OneDrive personal goes through its shares API, which Microsoft sometimes blocks; work/school SharePoint usually blocks it.
- Parquet links on a server with HTTP range requests (R2, S3, GitHub) aren't downloaded: the profile comes from the
  file's footer, and each chart or question fetches only the columns it uses. Other files are downloaded once.
- Or drop a local file onto the page.
- **Every number shows its work.** Click a bar, point or cell on a built-in chart to see the rows behind it and whether they
  add up to the number on the chart. Each chart has "How this was calculated" (a plain sentence, what it covers, what it
  assumes; open under your own questions) and **Check this number**, which re-derives the chart another way and says what
  holds, what is left out and whether it reads a sample. AI answers show the model's own one-line plan and assumptions.
- **Views and sharing**: pick **Overview** (the gist), **Explore** (compact, with the calculation shown) or **Review** (opens on the rows) from the dataset bar. A view only rearranges: the charts, SQL and rows are identical. Transaction-like tables get a one-click suggestion for Review. **Share** copies a link that reopens the dataset in that view; opening someone's link does not change your own saved view.
- **Metrics**: name a number you care about ("Net revenue" = `SUM("amount") FILTER (WHERE "status" = 'completed')`) with **+ Metric**. It shows as a card, the AI uses exactly that definition when you mention it, and it appears in the SQL tab's examples. Saved in this browser, per dataset.
- **SQL tab**: write a read-only query over the table (starter examples, history, Ctrl/⌘+Enter), see the result in the same grid, download it as CSV. Each chart's menu has "Edit in SQL tab".
- **Data tab** (next to Charts): the rows themselves. A virtualized grid (millions of rows scroll smoothly) with a sticky
  header and row numbers; click a header to sort, resize or pin columns, pick which columns to show, go to a row number.
  Cells are formatted by what the column is: amounts with 2 decimals and negatives in red, integers grouped,
  account numbers and IDs never grouped, timestamps tidy, statuses ("completed", "pending", "declined", credit/debit) as
  colour-coded pills, nulls dimmed. Click a row (or press Enter, ↑/↓ to move) to open the **record view**: every
  value of that row as a readable list, with prev/next, find, hide empty values, click a value to copy, Copy JSON.
  Click a column in the columns list to jump to it. On a big remote file the grid reads only the visible columns, a page
  at a time (working-set columns appear instantly, the rest fill in as they download).
- Share links: `/#/owner/repo/blob/<ref>/<path>` or `/?url=<any data url>`. The hash updates after each load.
- **Settings**: provider (Anthropic, any OpenAI-compatible endpoint, or None), API key, model, base URL.

## Develop

Read [AGENTS.md](AGENTS.md) first (it applies to people too), then [TESTING.md](TESTING.md).

```sh
npm ci
npx playwright install chromium   # once, for the browser test tiers
npm run build          # -> dist/  (add --minify via `npm run build:min`)
npm run serve          # http://localhost:5173  (serves dist/, application/wasm MIME)
npm run check          # unit + stubbed UI (Playwright) + build: run after every change
npm run check:full     # + real DuckDB-WASM and full-stack browser tests: what CI runs before deploying
```

Tiers, the feature → test map and the rules are in [TESTING.md](TESTING.md). Changes are logged in [docs/DEVLOG.md](docs/DEVLOG.md).

## Layout

```
src/main.js            entry: wires Duck, fetchGitHubFile, resolveRemoteFile, createLLM, createPipeline into mountApp
src/data/              github.js (URL resolution + fetch, remote Parquet probe), duck.js (DuckDB-WASM wrapper)
src/agents/            llm.js (Anthropic / OpenAI-compatible client), prompts.js, pipeline.js (agents)
src/ui/                app.js (DOM), styles.css (design tokens), explorer.js + gridmodel.js (Data tab), chartstyle.js, csv.js, popover.js
public/index.html      page shell; Vega, Vega-Lite and vega-embed load as vendored UMD scripts
build.mjs              esbuild bundle + copies DuckDB wasm/workers to dist/duckdb and Vega to dist/vendor
serve.mjs              tiny static server
```

Everything is vendored into `dist/`, with no CDN at runtime. `.github/workflows/pages.yml` builds and deploys
`dist/` to GitHub Pages on every push to `main`. Turn Pages on in the repo settings, with "GitHub Actions" as the source.
