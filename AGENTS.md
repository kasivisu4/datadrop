# AGENTS.md: start here

Instructions for any coding agent (and person) working on DataDrop. Claude Code loads this file through `CLAUDE.md`.

## What this is

DataDrop: paste any public data URL (GitHub, Google Drive, Dropbox, S3, R2…) or drop a file, get a dashboard. It is 100% client-side:
DuckDB-WASM for data, Vega-Lite for charts, and LLM agents called straight from the browser with the user's own key.
**There is no backend.** Don't add one, and don't add a runtime CDN dependency: everything is vendored into `dist/`.

Module contracts are in [CONTRACT.md](CONTRACT.md). The user-facing overview is in [README.md](README.md).

## Map

| Path | Role |
|---|---|
| `src/main.js` | Wires the modules into `mountApp` |
| `src/data/github.js` | URL parsing, downloads (GitHub, LFS, any https URL), `resolveRemoteFile` for in-place Parquet |
| `src/data/duck.js` | DuckDB-WASM wrapper: `loadFile` (+ multi-file parts), `attachUrl` / `resample` (remote Parquet view), queued cancellable `query`, `profile` |
| `src/data/links.js` | Share links (Drive, Sheets, Dropbox, OneDrive, GitLab…) -> direct URLs, per-provider help text, format sniffing |
| `src/data/hf.js`, `src/data/sample.js`, `src/data/memory.js`, `src/data/workset.js` | `hf://` URIs + globs; row-group sampling; memory check; working-set column planning |
| `src/agents/` | `llm.js` clients, `prompts.js`, `pipeline.js` (agents, streaming orchestrator, `heuristicCharts`), `layout.js` (dashboard layout model) |
| `src/ui/app.js`, `styles.css` | All DOM: top bar, dataset bar, notice slot, columns rail, cards, ask box, Charts/Data tabs, Activity slide-over, settings. Tokens (`--s-*` spacing, `--t-*` type) are at the top of `styles.css`: use them, not raw px |
| `src/ui/chartstyle.js`, `csv.js`, `popover.js` | Pure chart styling (single hue, tick thinning, theme config), CSV export, popover/menu behaviour |
| `src/ui/explorer.js`, `src/ui/gridmodel.js`, `src/ui/dom.js` | The Data tab (virtualized grid + record view); its pure logic (column roles, cell formatting, scroll window, column groups); the shared `h()` helper |
| `tests/` | See [TESTING.md](TESTING.md) |
| `docs/DEVLOG.md` | What changed, why, and how it was verified, newest first |

## Every task

1. **Before you start:** read the top entries of [docs/DEVLOG.md](docs/DEVLOG.md) to see recent work and open items.
2. **While working:** follow [TESTING.md](TESTING.md). Each change gets a test in the matching tier, and each
   feature has a row in its feature → test map.
2b. **Architecting:** for a non-trivial feature, refactor or performance/memory decision, get the design from the `architect` subagent (`.claude/agents/architect.md`, Opus) before building. It recommends an approach, build order and test plan; it writes no code.
2c. **Building:** the implementation goes to the `builder` subagent (`.claude/agents/builder.md`, Sonnet), following the architect's plan: code, tests in the right tier, docs and DEVLOG.
3. **Testing:** run the gates through the `tester` subagent (`.claude/agents/tester.md`, Haiku): it runs `check` / `check:full` and reports pass/fail without editing code. Use it from now on instead of running the suites in the main session.
4. **Before you say it's done:**
   - `npm run check` passes (unit + stubbed UI + build).
   - `npm run check:full` also passes if you touched `src/data/`, `src/agents/`, `build.mjs` or the tests.
   - For UI or data-path changes, check the real app in a browser (`npm run build`, then `npm run serve`).
5. **Log it:** add an entry at the top of `docs/DEVLOG.md` in the format below. This is how the next agent
   knows what happened.

### DEVLOG entry format

```md
## YYYY-MM-DD: <short title>
- **Why:** the user's request or the problem.
- **Changed:** files and behaviour, in a few bullets.
- **Tests:** tests added or changed (name + tier); gate results such as `check` ✅, `check:full` ✅.
- **Verified:** what you saw in the real app (numbers, screenshots), or "not checked in a browser" and why.
- **Open:** follow-ups, known gaps, risks. Omit the line if there are none.
```

## Conventions

- Match the surrounding code: vanilla ESM, no framework, small helpers, comments only where the code doesn't say it.
- Don't edit generated output: `dist/`, `tests/ui-stubs/dist/`, `tests/duck-harness/out/`.
- `localStorage` keys are prefixed `datadrop.`. If you rename a key, migrate the old one (see `OLD_SETTINGS_KEY` in `app.js`).
- Never commit API keys. Tests use fake keys and mock providers at the HTTP boundary.
- Performance claims need a cold-cache measurement (see TESTING.md → Manual check).
- Debugging in a browser: open the app with `?debug` to get `window.__datadrop` (`state.duck`, `state.pipeline`,
  `loadUrl`, `ask`). DuckDB's `db.collectFileStatistics(file, true)` / `exportFileStatistics(file)` measure bytes read.
- Long probes in the browser tool: start them in the background (store results on `window`), then poll. A query
  that never ends blocks the DuckDB worker; reload the page to kill it.
