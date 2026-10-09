# Personas, rewritten for the AI era

Status as of 2026-10-08. Replaces the first version (Overview / Explore / Review as job titles), which was a 2023-style
BI checklist. This one starts from where tools sit now and what users fear about AI answers.

**What is built:** the shared shell (dataset bar, one notice slot, Activity slide-over, calm cards, single-hue charts) and
the Data grid + record view. **No persona-specific behaviour exists yet.**

## What the research says (searched 2026-10-08)

Sources are mostly vendor-written or affiliate comparisons (Tellius, Holistics, Dupple, Atlan, Toucan); survey and
benchmark figures are secondhand. No source defined personas like "vibe analyst" or "AI agent users": the personas below are
a synthesis of the lanes and the trust findings, not a published taxonomy.

- **Lanes:** chat-first (Claude, ChatGPT; one table lists ~30 MB per file, 20 files), notebooks (Hex, Deepnote; team tool,
  priced per seat), spreadsheet AI (Julius; uploads, can save repeatable analyses, no governance), warehouse-native
  (Snowflake Cortex, Databricks Genie, Power BI Copilot; answer from a semantic layer, need a warehouse).
- **Governance is the divide:** chat tools can reach warehouses over MCP, but "connecting is not governing". Enterprise tools
  answer from defined metrics, so repeated questions agree.
- **Trust is the blocker:** one piece cites a survey of 330+ data teams rating confidence in AI query results at 5.5/10, and
  more technical users trusting them less. Advice repeated across sources: show the generated SQL and its assumptions in plain
  language, validate (columns exist, joins sane, run a limited version first), return provenance, keep a human check, and
  tie finance/exec numbers to defined metrics. Text-to-SQL is safest when the reader can audit the query.
- **Local-first is a real lane:** DuckDB (embedded, CSV/Parquet, dbt-duckdb) is how analytics engineers work on one machine; it
  is not a multi-user BI tool.

**DataDrop's gap:** paste a link, nothing uploaded, huge Parquet read in place, and every number shows its work.

## The four personas

| Persona | Wants | Fears | Built | Planned earlier | New idea from the research |
|---|---|---|---|---|---|
| **Link-in explorer** (chat-AI user hitting file caps) | A big file or link, ask in plain English, no upload, no signup | Upload limits, privacy, waiting | Links from Drive/Sheets/S3/GitHub/HF · huge Parquet read in place + sampling · Ask box with own key | | Plan first ("I'll sum amount by month") then run · one clarifying question when ambiguous · "Copy context for Claude" (schema + profile + metrics) |
| **Verifier** (finance, ops, data lead) | Numbers he can trace and defend | A confident wrong number; sampled data passed off as full | SQL per chart · sample notice · money format, status pills, record view | **Fix first:** IDs treated as measures in auto charts · checks (duplicates, nulls, debit vs credit, totals) | Click a number to see the rows behind it · "Check this number" (re-query another way, flag sampling/rounding) |
| **SQL-native** (analytics engineer, local-first) | DuckDB speed and real SQL, AI as a copilot he reviews | Black boxes, lock-in | DuckDB-WASM · Data grid, column stats, sort/pin · CSV download, copy a card's SQL · working set | SQL box + query history · filters that drive charts · Parquet export | Metric definitions saved locally (mini semantic layer: "revenue = sum(amount) where completed") · saved analyses that re-run when the link's data changes |
| **Stakeholder with a link** (exec, client, teammate) | The gist, and what the numbers cover | Jargon, being asked for a key, not knowing the scope | Calm charts · plain-English errors · works on phones | Headline numbers strip · share link keeps view, filters, pinned charts · "Covers 5M of 6.1B rows" always visible | "What stands out" summary that cites its numbers · read-only view for people who just look |

## Trust layer (shared by all four, not a view)

Every number shows its work: SQL in plain words, the rows behind it, what it covers (sample label). A privacy ledger shows
what leaves the browser (today: schema and prompts to the chosen LLM; nothing else). Same engine, SQL and rows in every
view; a persona changes layout, defaults and wording only.

## Status (2026-10-08, end of the first build)

Built, in the plan's order: (1) ids are not measures, (2) drill-through, (3) plan and assumptions, (4) check this number, (5) SQL tab,
(6) metric definitions, (7) views and share links. See DEVLOG for each. Still open from the diagram: headline numbers strip, totals
footer and Checks tab (duplicates, nulls, debit vs credit), "copy context for Claude", plan-first before an AI query runs,
"what stands out" summary, saved analyses that re-run, privacy ledger, drill-through for AI-written charts.

## How it fits the build

The earlier plan (Overview / Explore / Review views, chosen by the user and suggested by the data) still works as the
*presentation* layer: Overview serves the stakeholder and link-in explorer, Explore the SQL-native, Review the verifier.
What changes is the *content*: the trust features (drill-through, check-this-number, plain-language plan, metric
definitions) matter more than layout variants, and they are what separates DataDrop from chat-first tools.

Suggested order: (1) fix IDs-as-measures in the chart suggester, (2) drill-through "rows behind this number", (3) plain-language
plan + assumptions under each answer, (4) check-this-number, (5) SQL box, (6) metric definitions, (7) views and share links.

Diagram: the Excalidraw "DataDrop in the AI era" made in the same session.
