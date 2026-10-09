// UI end-to-end check against the stubbed build (no DuckDB / LLM needed).
//   node build.mjs --stub && node tests/ui.e2e.mjs
// Uses the project's Playwright (devDependency), else a global one (NODE_PATH or /opt/npm-tools/node_modules).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
let playwright;
for (const p of [root, process.env.NODE_PATH, '/opt/npm-tools/node_modules'].filter(Boolean)) {
  try { playwright = require(require.resolve('playwright', { paths: [p] })); break; } catch { /* try next */ }
}
if (!playwright) playwright = require('playwright');
if (existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers'; // dev container

const PORT = 5199;
const BASE = `http://localhost:${PORT}/`;
const shots = path.join(here, 'screens');
await mkdir(shots, { recursive: true });

const server = spawn(process.execPath, [path.join(root, 'serve.mjs'), path.join(root, 'tests/ui-stubs/dist')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.once('data', res));

const browser = await playwright.chromium.launch();
const errors = [];
let failed = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try { await fn(); console.log(`ok   ${name}${process.env.TIMING ? ` (${Date.now() - t0} ms)` : ""}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
}
async function newPage(opts = {}, settings) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...opts });
  if (settings) await ctx.addInitScript((s) => localStorage.setItem('datadrop.settings.v1', JSON.stringify(s)), settings);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${opts.colorScheme || 'light'}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return page;
}
const AI = { provider: 'anthropic', apiKey: 'sk-ant-test', model: '', baseUrl: '' };
const BIG_URL = 'https://github.com/o/r/blob/main/big.parquet'; // the 'big' stub stands in for a sampled 6.1B-row Parquet file
// after a load the example chips live in the dataset bar's "Examples" menu
const exampleInMenu = async (p, n) => { await p.locator('.examples-btn').click(); await p.locator('.examples-menu .chip').nth(n).click(); };

try {
  // ---- heuristic mode, empty state ----
  let page = await newPage();
  await page.goto(BASE);
  await check('DataDrop branding', async () => {
    assert.equal(await page.title(), 'DataDrop');
    assert.equal((await page.locator('.brand').textContent()).trim(), 'DataDrop');
    assert.equal(await page.locator('.url-input').getAttribute('aria-label'), 'Data file URL');
  });
  await check('empty state: AI chip instead of an API-key banner + 4 example chips', async () => {
    await page.locator('.empty h1').waitFor();
    assert.equal(await page.locator('.banner').count(), 0, 'no banner');
    assert.ok(await page.locator('.ai-chip').isVisible(), 'small "Enable AI questions" chip');
    assert.ok(await page.locator('.ask').isHidden(), 'no ask box without a key');
    assert.equal(await page.locator('.chips.large .chip').count(), 4);
    assert.match(await page.locator('.chips.large .chip').nth(3).getAttribute('data-url'), /^s3:\/\//, 'S3 demo example');
    assert.equal(await page.locator('.provider-pill').textContent(), 'AI off');
    assert.match(await page.locator('.provider-pill').getAttribute('title'), /heuristic|built-in rules/i);
  });
  await check('start page: one centred column, no rail / dataset bar / ask box, headline + 3 trust points', async () => {
    assert.equal(await page.locator('.empty h1').textContent(), 'Paste a data link. Get a dashboard.');
    assert.ok(await page.locator('.databar').isHidden(), 'no dataset bar');
    assert.ok(await page.locator('.dataset').isHidden(), 'no columns rail');
    assert.ok(await page.locator('.view-row').isHidden(), 'no tabs / activity');
    const trust = await page.locator('.trust li').allTextContents();
    assert.deepEqual(trust, ['Stays in your browser', 'No account', 'Huge Parquet files are sampled']);
    assert.equal(await page.locator('.link-help-btn:visible').count(), 1, 'one "Which links work?" entry point');
    const box = await page.locator('.layout').boundingBox();
    assert.ok(box.width <= 720 && Math.abs(box.x + box.width / 2 - 720) < 2, `centred 720px column: ${JSON.stringify(box)}`);
    const jargon = await page.locator('.empty').innerText();
    assert.ok(!/CORS|DuckDB|NL2SQL/.test(jargon), 'no jargon on the start page');
  });
  await page.screenshot({ path: path.join(shots, 'empty-light.png') });
  await check('click example -> cards render', async () => {
    await page.locator('.chips.large .chip').first().click();
    await page.locator('.card:not(.skeleton)').first().waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.card:not(.skeleton)').count(), 3);
    await page.locator('.card .vega-embed svg').first().waitFor({ timeout: 10000 });
    assert.ok(await page.locator('.card .viz-table table').count() >= 1, 'fallback table');
    // a failed card: plain words first, the raw Binder error behind "Show technical details" (still reachable)
    assert.match(await page.locator('.card.error .err-title').textContent(), /couldn't be built from this data/);
    assert.ok(await page.locator('.card.error .err-msg').isHidden(), 'raw error is collapsed');
    await page.locator('.card.error .err-details summary').click();
    assert.ok(await page.locator('.card.error .err-msg').isVisible(), 'error card');
    assert.match(await page.locator('.card.error .err-msg').textContent(), /Binder Error: Referenced column "Revenue"/);
    assert.ok((await page.locator('.card.error .err-sql').textContent()).includes('SELECT'), 'the SQL is in the details too');
  });
  await check('time axis is thinned: 120 daily points show at most 8 x labels', async () => {
    const n = await page.locator('.card', { hasText: 'Closing price over time' }).locator('.role-axis[aria-label^="X-axis"] .role-axis-label text').count();
    assert.ok(n >= 3 && n <= 8, `${n} x labels`);
  });
  await check('hash updated for sharing', async () => {
    assert.equal(new URL(page.url()).hash, '#/plotly/datasets/blob/master/2014_apple_stock.csv');
  });
  await check('dataset panel', async () => {
    assert.ok(!/(^|\n)null(\n|$)/.test(await page.locator('.dataset-body').innerText()), 'no stray "null" text');
    assert.equal(await page.locator('.dataset .col').count(), 6);
    assert.ok((await page.locator('.ds-source').getAttribute('href')).startsWith('https://github.com/plotly/datasets/blob/master/'));
    assert.ok(await page.locator('.kind-time').count() === 1);
  });
  await check('activity: a low-key pill (closed by default); it opens a slide-over with the runs, Escape closes it', async () => {
    assert.ok(await page.locator('.trace').evaluate((n) => n.classList.contains('collapsed')));
    assert.equal((await page.locator('.trace .pill-label').textContent()).trim(), 'Activity');
    assert.equal(await page.locator('.trace .trace-live').textContent(), '', 'no count unless "Show agent steps" is on');
    assert.ok(await page.locator('.slideover').isHidden(), 'closed by default');
    assert.ok(await page.locator('.trace .run').first().isHidden());
    await page.locator('.trace .panel-toggle').click();
    assert.ok(await page.locator('.slideover').isVisible(), 'slide-over opens');
    assert.ok(await page.locator('.trace .run').first().isVisible(), 'with the runs in it');
    assert.equal(await page.locator('.trace .panel-toggle').getAttribute('aria-expanded'), 'true');
    assert.ok(await page.locator('.slideover-head .btn').evaluate((b) => b === document.activeElement), 'focus moves into it');
    assert.ok(!(await page.locator('.trace').evaluate((n) => n.classList.contains('collapsed'))));
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('.slideover').isHidden(), 'Escape closes it');
    assert.ok(await page.locator('.trace').evaluate((n) => n.classList.contains('collapsed')));
    assert.ok(await page.locator('.trace .panel-toggle').evaluate((b) => b === document.activeElement), 'focus returns to the pill');
    await page.locator('.trace .panel-toggle').click();
    await page.locator('.slideover-scrim').click({ position: { x: 20, y: 300 } });
    assert.ok(await page.locator('.slideover').isHidden(), 'a click on the scrim closes it too');
  });
  await check('mostly-null columns are tagged and dimmed', async () => {
    const col = page.locator('.dataset .col.mostly-null');
    assert.equal(await col.count(), 1);
    assert.equal(await col.locator('.null-tag').textContent(), 'mostly null');
  });
  await check('trace groups Load + Suggest with statuses', async () => {
    const labels = await page.locator('.run-label').allTextContents();
    assert.deepEqual(labels, ['Suggest', 'Load']);
    assert.ok(await page.locator('.event.done').count() >= 2);
    assert.ok(await page.locator('.event.error').count() >= 1);
    assert.ok(await page.locator('.agent-chip').filter({ hasText: 'profiler' }).count() >= 0);
    assert.equal(await page.locator('.agent-chip').filter({ hasText: 'fetch' }).count(), 1, 'download step is labelled fetch');
  });
  await check('trace timer counts up live past 1 s, then freezes', async () => {
    await page.fill('.url-input', 'https://github.com/o/r/blob/main/slow.csv');
    await page.click('.loadbar button[type=submit]');
    const ms = page.locator('.run').first().locator('.event.start .ev-ms').first();
    assert.equal(await ms.textContent(), '…', 'under 1 s shows …');
    await page.waitForFunction(() => /^1\.\d s$/.test(document.querySelector('.run .event.start .ev-ms')?.textContent || ''), null, { timeout: 3000 });
    assert.match(await page.locator('.run').first().locator('.run-time').textContent(), /^1\.\d s$/, 'run total ticks too');
    await page.waitForFunction(() => !document.querySelector('.run.running'));
    const fetchMs = await page.locator('.run').nth(1).locator('.event.done .ev-ms').first().textContent();
    assert.match(fetchMs, /^1\.\d s$/, 'finished step keeps its time in seconds');
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.run').nth(1).locator('.event.done .ev-ms').first().textContent(), fetchMs, 'frozen after done');
  });
  // the card footer: Pin and a "⋯" menu (View SQL, Show data, Log x, Download data, Remove)
  const openMenu = async (card) => { await card.locator('.card-menu-btn').click(); await card.locator('.card-menu:not([hidden])').waitFor(); };
  await check('card footer: Pin + a "⋯" menu; no uppercase tags on normal cards', async () => {
    const card = page.locator('.card:not(.error):not(.skeleton)').first();
    assert.ok(await card.locator('.pin').isVisible());
    assert.ok(await card.locator('.card-menu-btn').isVisible());
    assert.equal(await card.locator('.card-foot .btn').count(), 3, 'Pin, Check this number and the menu button: nothing else competes in the footer');
    assert.ok(await card.locator('.card-foot .check-btn').isVisible());
    assert.ok(await card.locator('.card-menu').isHidden(), 'menu starts closed');
    assert.equal(await page.locator('.card:not(.error) .tag').count(), 0, 'no HEURISTIC / TABLE tags');
    assert.ok(await page.locator('.card.error .tag-error').isVisible(), 'an error keeps its tag');
    assert.equal(await card.locator('h3').evaluate((n) => getComputedStyle(n).fontSize), '16px', 'card title is 16px');
    await openMenu(card);
    const items = await card.locator('.card-menu [role^=menuitem]').allTextContents();
    assert.deepEqual(items, ['View SQL', 'Show data', 'Download data', 'Edit in SQL tab', 'Remove']);
  });
  await check('card menu is keyboard accessible: arrows move, Escape closes and returns focus, outside click closes', async () => {
    const card = page.locator('.card:not(.error):not(.skeleton)').first();
    if (await card.locator('.card-menu').isHidden()) await openMenu(card);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'View SQL', 'focus lands on the first item');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Show data');
    await page.keyboard.press('Escape');
    assert.ok(await card.locator('.card-menu').isHidden());
    assert.ok(await card.locator('.card-menu-btn').evaluate((b) => b === document.activeElement), 'focus returns to the ⋯ button');
    await openMenu(card);
    await page.locator('.brand').dispatchEvent('pointerdown');
    assert.ok(await card.locator('.card-menu').isHidden(), 'a click outside closes it');
  });
  await check('SQL toggle + Data toggle (from the menu)', async () => {
    const card = page.locator('.card:not(.error):not(.skeleton)').first();
    await openMenu(card);
    await card.getByRole('menuitem', { name: 'View SQL' }).click();
    assert.ok((await card.locator('pre.sql').textContent()).includes('SELECT'));
    assert.ok(await card.getByRole('button', { name: 'Copy' }).isVisible());
    await openMenu(card);
    assert.ok(await card.getByRole('menuitem', { name: 'Hide SQL' }).isVisible(), 'the label flips');
    await card.getByRole('menuitem', { name: 'Show data' }).click();
    assert.ok(await card.locator('.data-panel table').isVisible());
  });
  await check('Download data: a CSV named after the card, header + rows', async () => {
    const card = page.locator('.card:not(.error):not(.skeleton)').first();
    await openMenu(card);
    const [dl] = await Promise.all([page.waitForEvent('download'), card.getByRole('menuitem', { name: 'Download data' }).click()]);
    assert.equal(dl.suggestedFilename(), 'closing-price-over-time.csv');
    const text = (await readFile(await dl.path(), 'utf8')).split('\r\n');
    assert.equal(text[0], 'Date,Close');
    assert.match(text[1], /^2014-01-02,\d+(\.\d+)?$/);
    assert.equal(text.length, 120 + 2, '120 rows + header + trailing newline');
  });
  await check('cards: pin, log x, remove', async () => {
    const card = page.locator('.card:not(.error):not(.skeleton)').first();
    await card.locator('.pin').click();
    assert.equal(await card.locator('.pin').getAttribute('aria-pressed'), 'true');
    assert.ok(await card.evaluate((n) => n.classList.contains('pinned')));
    const logCard = page.locator('.card', { has: page.locator('.act-logx') }).first();
    if (await logCard.count()) {
      await openMenu(logCard);
      await logCard.getByRole('menuitemcheckbox', { name: 'Log x' }).click();
      await openMenu(logCard);
      assert.equal(await logCard.getByRole('menuitemcheckbox', { name: 'Log x' }).getAttribute('aria-checked'), 'true');
      await page.keyboard.press('Escape');
      await logCard.locator('.vega-embed svg').waitFor();
    }
    const n = await page.locator('.card').count();
    const last = page.locator('.card').last();
    await openMenu(last);
    await last.locator('.remove').click();
    assert.equal(await page.locator('.card').count(), n - 1);
  });
  await page.screenshot({ path: path.join(shots, 'desktop-light-heuristic.png'), fullPage: true });
  await check('charts stream in: placeholders with SQL at once, each drawn when done, cancel + run again', async () => {
    await page.evaluate(() => { window.__stubChartDelay = 1200; });
    await exampleInMenu(page, 0);
    // placeholders: every planned chart, with its title and SQL, before any query finishes
    await page.locator('.card.pending').first().waitFor();
    assert.equal(await page.locator('.card.pending').count(), 3);
    assert.ok((await page.locator('.card.pending .pending-sql').first().textContent()).includes('SELECT'));
    assert.equal(await page.locator('.card.pending .tag-queued').count(), 2, 'one runs, the rest wait');
    await page.waitForFunction(() => /^\d/.test(document.querySelector('.card.pending .pending-time')?.textContent || ''));
    // cancel the last queued chart
    await page.locator('.card.pending', { hasText: 'Revenue by sector' }).getByRole('button', { name: 'Cancel' }).click();
    // the first chart draws while the second is still running
    await page.locator('.card:not(.pending) .vega-embed svg').first().waitFor({ timeout: 5000 });
    assert.ok(await page.locator('.card.pending').count() >= 1, 'others still pending');
    await page.waitForFunction(() => !document.querySelector('.card.pending'), null, { timeout: 8000 });
    const cancelled = page.locator('.card', { hasText: 'Revenue by sector' });
    assert.match(await cancelled.locator('.card-note').textContent(), /Cancelled/);
    await page.evaluate(() => { window.__stubChartDelay = 60; });
    await cancelled.getByRole('button', { name: 'Run again' }).click();
    await page.locator('.card.error', { hasText: 'Revenue by sector' }).waitFor({ timeout: 5000 });
    // layout: the trend chart is full width
    const widths = await page.$$eval('.grid > .card', (els) => els.map((e) => [e.querySelector('h3').textContent, Math.round(e.getBoundingClientRect().width)]));
    const w = Object.fromEntries(widths);
    assert.ok(w['Closing price over time'] > w['Monthly average close'] * 1.6, JSON.stringify(widths));
  });
  await check('404 shows inline error, no alert', async () => {
    page.once('dialog', () => { throw new Error('alert() used'); });
    await page.fill('.url-input', 'https://github.com/o/r/blob/main/does-not-exist.csv');
    await page.click('.loadbar button[type=submit]');
    await page.locator('.status.error').waitFor();
    assert.match(await page.locator('.status.error').textContent(), /^Couldn't load that file: .*404/);
  });
  await check('link help: the pasted link gets its how-to; a failed load keeps it next to the error', async () => {
    await page.fill('.url-input', 'https://drive.google.com/file/d/1AbC/view?usp=sharing');
    await page.locator('.link-hint:not([hidden])').waitFor();
    assert.match(await page.locator('.link-hint').textContent(), /^Google Drive · .*Anyone with the link/);
    await page.fill('.url-input', 'https://www.dropbox.com/s/x/a.csv?dl=0');
    assert.match(await page.locator('.link-hint').textContent(), /^Dropbox · /);
    await page.fill('.url-input', '');
    assert.ok(await page.locator('.link-hint').isHidden(), 'no hint for an empty box');
    await page.fill('.url-input', 'https://drive.google.com/file/d/1AbC/view');
    await page.click('.loadbar button[type=submit]');
    await page.locator('.status.error').waitFor();
    assert.match(await page.locator('.status.error').textContent(), /from Google Drive.*Anyone with the link/);
    assert.ok(await page.locator('.link-hint').isVisible());
  });
  await check('"Which links work?" lists every link type with an example, and closes', async () => {
    await page.locator('.link-hint .link-help-btn').click();
    await page.locator('.link-help:not([hidden])').waitFor();
    const names = await page.locator('.link-help-list dt').allTextContents();
    for (const n of ['GitHub', 'Google Sheets', 'Google Drive', 'Dropbox', 'OneDrive (personal)', 'GitLab', 'Hugging Face', 'Any other https link']) assert.ok(names.includes(n), n);
    assert.equal(await page.locator('.link-help-list .link-example').count(), names.length);
    await page.locator('.link-help').getByRole('button', { name: 'Close' }).click();
    assert.ok(await page.locator('.link-help').isHidden());
  });
  await check('a successful load hides the link hint', async () => {
    await page.fill('.url-input', 'https://github.com/o/r/blob/main/ok.csv');
    assert.ok(await page.locator('.link-hint').isVisible());
    await page.click('.loadbar button[type=submit]');
    await page.waitForFunction(() => document.title.startsWith('ok.csv'));
    assert.ok(await page.locator('.link-hint').isHidden());
  });
  await page.context().close();

  // ---- settings saved under the old gitviz key carry over ----
  page = await newPage();
  await page.addInitScript(() => { if (!localStorage.getItem('datadrop.settings.v1')) localStorage.setItem('gitviz.settings.v1', JSON.stringify({ provider: 'anthropic', apiKey: 'sk-ant-old', model: '', baseUrl: '' })); });
  await page.goto(BASE);
  await check('pre-rename settings migrate', async () => {
    assert.ok(await page.locator('.ai-chip').isHidden(), 'old key counts as configured: no AI chip');
  });
  await page.context().close();

  // ---- AI mode via ?url= + ask ----
  page = await newPage({}, AI);
  await page.goto(`${BASE}?url=${encodeURIComponent('https://github.com/plotly/datasets/blob/master/2014_apple_stock.csv')}`);
  await check('?url= autoloads; no banner with key', async () => {
    await page.locator('.card .vega-embed svg').first().waitFor({ timeout: 10000 });
    assert.ok(await page.locator('.ai-chip').isHidden());
    assert.ok(await page.locator('.ask-input').isEnabled());
    assert.equal(await page.locator('.provider-pill').textContent(), 'AI on');
    assert.match(await page.locator('.provider-pill').getAttribute('title'), /Anthropic/);
  });
  await check('ask -> new card at top + Ask trace run', async () => {
    await page.fill('.ask-input', 'Which sector trades the most volume?');
    await page.press('.ask-input', 'Enter');
    await page.locator('.card.asked:not(.skeleton) .vega-embed svg').waitFor({ timeout: 10000 });
    assert.ok(await page.locator('.grid > .card').first().evaluate((n) => n.classList.contains('asked')));
    assert.match(await page.locator('.run-label').first().textContent(), /^Ask: Which sector/);
  });
  await check('single hue: bars whose colour only repeated the axis share one colour, with no rainbow legend', async () => {
    const fills = await page.locator('.card.asked .vega-embed svg .mark-rect.role-mark path').evaluateAll((els) => els.map((e) => e.getAttribute('fill')));
    assert.equal(fills.length, 4, 'one bar per sector');
    assert.equal(new Set(fills).size, 1, fills.join(','));
    assert.equal(fills[0].toLowerCase(), '#2a78d6', 'the first series colour of the theme');
    assert.equal(await page.locator('.card.asked .role-legend').count(), 0);
  });
  await page.screenshot({ path: path.join(shots, 'desktop-light.png'), fullPage: true });
  await check('settings drawer opens, saves, rebuilds pipeline', async () => {
    const before = await page.evaluate(() => window.__stubPipelines);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('.drawer-panel').waitFor();
    assert.ok((await page.locator('.drawer .note').textContent()).includes('Key stays in this browser'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, 'settings-light.png') });
    await page.selectOption('#gv-provider', 'openai');
    assert.ok(await page.locator('#gv-base').isVisible());
    await page.click('.drawer-actions .btn.primary');
    assert.ok(await page.locator('.drawer').isHidden());
    const after = await page.evaluate(() => window.__stubPipelines);
    assert.ok(after > before, 'pipeline recreated');
    await page.locator('.run-label', { hasText: 'Suggest' }).first().waitFor({ state: 'attached' }); // trace may be collapsed
    await page.waitForFunction(() => !document.querySelector('.run.running'));
    assert.ok(await page.locator('.card.asked').count() === 1, 'asked card kept');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('datadrop.settings.v1')));
    assert.equal(saved.provider, 'openai');
  });
  await page.context().close();

  // ---- dark ----
  page = await newPage({ colorScheme: 'dark' }, AI);
  await page.goto(`${BASE}#/plotly/datasets/blob/master/2014_apple_stock.csv`);
  await check('dark: hash route autoload + themed axis labels', async () => {
    await page.locator('.card .vega-embed svg').first().waitFor({ timeout: 10000 });
    const fill = await page.locator('.card .vega-embed svg .role-axis-label text').first().getAttribute('fill');
    assert.equal(fill?.toLowerCase(), '#c3c2b7');
  });
  await page.fill('.ask-input', 'Which sector trades the most volume?');
  await page.press('.ask-input', 'Enter');
  await page.locator('.card.asked:not(.skeleton) .vega-embed svg').waitFor({ timeout: 10000 });
  await check('dark: bars use the dark theme\'s first series colour (one hue), text stays readable', async () => {
    const fills = await page.locator('.card.asked .vega-embed svg .mark-rect.role-mark path').evaluateAll((els) => els.map((e) => e.getAttribute('fill')));
    assert.equal(new Set(fills).size, 1, fills.join(','));
    assert.equal(fills[0].toLowerCase(), '#3987e5');
    const title = await page.locator('.card.asked h3').evaluate((n) => getComputedStyle(n).color);
    assert.equal(title, 'rgb(241, 240, 236)');
  });
  await page.screenshot({ path: path.join(shots, 'desktop-dark.png'), fullPage: true });
  await page.context().close();

  // ---- mobile ----
  for (const [w, scheme] of [[400, 'light'], [400, 'dark']]) {
    page = await newPage({ viewport: { width: w, height: 860 }, colorScheme: scheme, isMobile: true, hasTouch: true }, scheme === 'light' ? undefined : AI);
    await page.goto(BASE);
    await page.screenshot({ path: path.join(shots, `mobile-empty-${scheme}.png`), fullPage: true });
    await page.locator('.chips.large .chip').nth(1).click();
    await page.locator('.card .vega-embed svg').first().waitFor({ timeout: 10000 });
    await page.waitForFunction(() => !document.querySelector('.run.running'));
    await check(`${w}px ${scheme}: no horizontal scroll`, async () => {
      const r = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth }));
      assert.ok(r.sw <= r.iw, `scrollWidth ${r.sw} > innerWidth ${r.iw}`);
    });
    await check(`${w}px ${scheme}: activity slide-over opens and closes`, async () => {
      assert.ok(await page.locator('.trace').evaluate((n) => n.classList.contains('collapsed')));
      await page.locator('.trace .panel-toggle').click();
      assert.ok(await page.locator('.trace .run').first().isVisible());
      await page.keyboard.press('Escape');
      assert.ok(await page.locator('.slideover').isHidden());
    });
    await page.screenshot({ path: path.join(shots, `mobile-${scheme}.png`), fullPage: true });
    await page.context().close();
  }

  // ---- shell: dataset bar, notice slot, examples menu, columns rail ----
  async function loaded(opts = {}, settings, url) {
    const p = await newPage(opts, settings);
    await p.addInitScript(() => { window.__memorySignals = { deviceMemoryGB: 32, mobile: false }; window.__stubCacheMs = 300; });
    await p.goto(url ? `${BASE}?url=${encodeURIComponent(url)}` : BASE);
    if (!url) await p.locator('.chips.large .chip').first().click();
    await p.locator('.card:not(.skeleton):not(.pending)').first().waitFor({ timeout: 10000 });
    await p.waitForFunction(() => !document.querySelector('.run.running'));
    return p;
  }
  page = await loaded({ viewport: { width: 1440, height: 900 } });
  await check('shell: the workspace is wide (>= 1100px), the first chart is near the top (< 200px), no third column', async () => {
    const m = await page.evaluate(() => ({
      ws: document.querySelector('.workspace').getBoundingClientRect().width,
      top: document.querySelector('.card:not(.skeleton)').getBoundingClientRect().top + scrollY,
      cols: getComputedStyle(document.querySelector('.layout')).gridTemplateColumns.split(' ').length,
    }));
    assert.ok(m.ws >= 1100, `workspace ${m.ws}`);
    assert.ok(m.top < 200, `first card top ${m.top}`);
    assert.equal(m.cols, 2, 'rail | workspace');
  });
  await check('dataset bar: name, source, "N rows × M columns", size; the examples row is gone after a load', async () => {
    assert.ok(await page.locator('.databar').isVisible());
    assert.equal(await page.locator('.databar .ds-name').textContent(), '2014_apple_stock.csv');
    assert.equal(await page.locator('.databar .ds-name').getAttribute('title'), '2014_apple_stock.csv');
    assert.ok((await page.locator('.databar .ds-source').getAttribute('href')).startsWith('https://github.com/plotly/datasets/'));
    assert.match(await page.locator('.databar .ds-meta').textContent(), /^240 rows × 6 columns · 31\.0 KB$/);
    assert.equal(await page.locator('.examples-row').count(), 0);
    assert.ok(await page.locator('.chips.large').isHidden(), 'no big chips after a load');
    assert.equal(await page.locator('.databar .fields-toggle').textContent(), 'Columns');
    assert.ok(!/\b(records?|fields?)\b/i.test(await page.locator('.databar').innerText()), 'rows and columns wording');
  });
  await check('Examples menu: opens from the dataset bar, Escape closes it, a chip loads that example; one "Which links work?" entry', async () => {
    await page.locator('.examples-btn').click();
    assert.ok(await page.locator('.examples-menu').isVisible());
    assert.equal(await page.locator('.examples-menu .chip').count(), 4);
    assert.equal(await page.locator('.link-help-btn:visible').count(), 1, 'a single entry point while the menu is open');
    assert.ok(await page.locator('.examples-menu .chip').first().evaluate((b) => b === document.activeElement), 'focus lands on the first example');
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('.examples-menu').isHidden());
    assert.ok(await page.locator('.examples-btn').evaluate((b) => b === document.activeElement), 'focus returns to the button');
    assert.equal(await page.locator('.link-help-btn:visible').count(), 0, 'none visible with the menu closed (the start page is gone)');
    await page.locator('.examples-btn').click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.title.startsWith('gapminder'));
    assert.ok(await page.locator('.examples-menu').isHidden(), 'closes after choosing');
  });
  await check('columns rail: collapses from the dataset bar and the choice survives a reload', async () => {
    await page.locator('.card:not(.skeleton):not(.pending)').first().waitFor();
    assert.ok(await page.locator('.dataset').isVisible());
    const w0 = await page.locator('.workspace').evaluate((n) => n.getBoundingClientRect().width);
    await page.locator('.fields-toggle').click();
    assert.ok(await page.locator('.dataset').isHidden());
    assert.equal(await page.locator('.fields-toggle').getAttribute('aria-expanded'), 'false');
    assert.ok(await page.locator('.workspace').evaluate((n) => n.getBoundingClientRect().width) > w0 + 200, 'the workspace takes the width');
    assert.equal(await page.evaluate(() => localStorage.getItem('datadrop.rail.v1')), 'closed');
    await page.reload();
    await page.locator('.card:not(.skeleton)').first().waitFor({ timeout: 10000 });
    assert.ok(await page.locator('.dataset').isHidden(), 'still collapsed after reload');
    await page.locator('.fields-toggle').click();
    assert.ok(await page.locator('.dataset').isVisible());
    assert.equal(await page.evaluate(() => localStorage.getItem('datadrop.rail.v1')), 'open');
  });
  await check('"Show agent steps" (Settings) keeps the run count beside Activity', async () => {
    await page.waitForFunction(() => !document.querySelector('.run.running'));
    assert.equal(await page.locator('.trace .trace-live').textContent(), '', 'off by default');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('#gv-steps').check();
    await page.click('.drawer-actions .btn.primary');
    assert.match(await page.locator('.trace .trace-live').textContent(), /\d+ runs? · show steps/);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('datadrop.settings.v1')).showSteps), true);
  });
  await page.screenshot({ path: path.join(shots, 'shell-desktop-light.png') });
  await page.context().close();

  page = await loaded({ viewport: { width: 1440, height: 900 } }, AI);
  await page.fill('.ask-input', 'Which sector trades the most volume?');
  await page.press('.ask-input', 'Enter');
  await page.locator('.card.asked:not(.skeleton) .vega-embed svg').waitFor({ timeout: 10000 });
  await check('every row of cards is full: no half-empty row next to an answer card', async () => {
    const rows = async () => {
      const boxes = await page.$$eval('.grid > .card', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), w: Math.round(r.width) }; }));
      const gridW = await page.locator('.grid').evaluate((g) => Math.round(g.getBoundingClientRect().width));
      const byTop = new Map();
      for (const b of boxes) byTop.set(b.top, (byTop.get(b.top) || 0) + b.w);
      return [...byTop.values()].map((sum) => sum / gridW);
    };
    const fr = await rows();
    assert.ok(fr.length >= 3, 'answer, trend and the pair: ' + fr.length);
    for (const f of fr) assert.ok(f > 0.97, `a row is only ${Math.round(f * 100)}% full`);
  });
  await page.context().close();

  page = await loaded({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  await check('phone: dataset name is in the first screen and the dataset bar stays put while scrolling', async () => {
    const vis = () => page.locator('.ds-name').evaluate((n) => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, ih: innerHeight, sy: scrollY }; });
    const a = await vis();
    assert.ok(a.top >= 0 && a.bottom <= a.ih, `name at ${a.top}`);
    await page.evaluate(() => window.scrollTo(0, 700));
    const b = await vis();
    assert.ok(b.sy > 300, 'the page scrolled');
    assert.ok(b.top >= 0 && b.bottom <= 60, `sticky dataset bar: name at ${b.top} after scrolling ${b.sy}px`);
  });
  await check('phone: topbar is logo + link + File + settings; the upload control has a visible label', async () => {
    assert.equal((await page.locator('.file-btn').textContent()).trim(), 'File');
    assert.ok(await page.locator('.file-btn span:not(.icon)').isVisible());
    assert.ok(await page.locator('.url-input').isVisible());
    assert.ok(await page.getByRole('button', { name: 'Settings' }).isVisible());
    assert.equal(await page.locator('.examples-row').count(), 0, 'no examples row');
    const r = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth }));
    assert.ok(r.sw <= r.iw, `no horizontal scroll at 375: ${JSON.stringify(r)}`);
  });
  await check('phone: the columns list opens as a bottom sheet, and Escape or the scrim closes it', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.ok(await page.locator('.dataset').isHidden(), 'not below the charts any more');
    await page.locator('.fields-toggle').click();
    assert.ok(await page.locator('.dataset').isVisible());
    const r = await page.locator('.dataset').evaluate((n) => { const b = n.getBoundingClientRect(); return { bottom: Math.round(b.bottom), ih: innerHeight, w: Math.round(b.width), iw: innerWidth }; });
    assert.equal(r.bottom, r.ih, 'docked to the bottom');
    assert.equal(r.w, r.iw);
    assert.equal(await page.locator('.dataset .col').count(), 6);
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('.dataset').isHidden());
    await page.locator('.fields-toggle').click();
    await page.locator('.sheet-scrim').click({ position: { x: 20, y: 40 } });
    assert.ok(await page.locator('.dataset').isHidden(), 'scrim closes it');
    await page.locator('.fields-toggle').click();
    await page.locator('.dataset .col', { hasText: 'Volume' }).first().click();
    assert.ok(await page.locator('.dataset').isHidden(), 'picking a column closes the sheet');
    assert.equal(await page.locator('.view-tab[data-view=data]').getAttribute('aria-selected'), 'true');
  });
  await page.context().close();

  // the sample notice (the 'big' stub stands in for a sampled 6.1B-row Parquet file)
  page = await loaded({ viewport: { width: 1440, height: 600 } }, undefined, BIG_URL);
  await check('sample notice: in the notice slot, visible in Charts and Data, and it stays visible while scrolling', async () => {
    const n = page.locator('.notices .sample-notice');
    assert.ok(await n.isVisible());
    assert.match(await n.textContent(), /^Sample: 5M of 6\.1B rows, spread across the file\./);
    assert.ok(await page.locator('.notices .cache-banner').isVisible(), 'the working-set banner is in the same slot');
    await page.locator('.view-tab[data-view=data]').click();
    assert.ok(await n.isVisible(), 'visible in the Data tab');
    await page.locator('.view-tab[data-view=charts]').click();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const r = await n.evaluate((el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, ih: innerHeight, sy: scrollY }; });
    assert.ok(r.sy > 100, `page scrolled ${r.sy}px`);
    assert.ok(r.top >= 0 && r.bottom <= r.ih, JSON.stringify(r));
  });
  await check('sample notice: "Change" opens the columns rail on the sample controls (also when it was collapsed)', async () => {
    await page.locator('.fields-toggle').click();
    assert.ok(await page.locator('.dataset').isHidden());
    await page.locator('.sample-notice .sample-change').click();
    assert.ok(await page.locator('.dataset').isVisible());
    assert.ok(await page.locator('.sample-panel').evaluate((n) => n === document.activeElement), 'focus is on the sample controls');
    assert.ok(await page.locator('.sample-panel .sample-actions').isVisible());
  });
  await page.context().close();

  page = await loaded({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }, undefined, BIG_URL);
  await check('phone: the sample notice is under the dataset bar, sticky, and "Change" opens the sheet', async () => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const r = await page.locator('.sample-notice').evaluate((el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, ih: innerHeight }; });
    assert.ok(r.top >= 0 && r.bottom <= r.ih, JSON.stringify(r));
    await page.locator('.sample-notice .sample-change').click();
    assert.ok(await page.locator('.dataset').isVisible());
    assert.ok(await page.locator('.sample-panel').isVisible());
  });
  await page.context().close();

  // ---- Data tab: grid + record view (stub table: 240 rows; Close is an amount, Volume an integer, Sector a category) ----
  const CLIP = { permissions: ['clipboard-read', 'clipboard-write'] };
  async function dataPage(opts = {}, settings) {
    const p = await newPage({ ...CLIP, ...opts }, settings);
    await p.goto(BASE);
    await p.locator('.chips.large .chip').first().click();
    await p.locator('.card:not(.skeleton)').first().waitFor({ timeout: 10000 });
    return p;
  }
  const rowTexts = (p, i) => p.locator('.ex-row[data-i="' + i + '"] .ex-cell').allTextContents();
  const openData = async (p) => { await p.locator('.view-tab[data-view=data]').click(); await p.locator('.ex-row:not(.failed) .ex-cell.r-money').first().waitFor(); };
  const num = (s) => Number(s.replace(/,/g, ''));
  page = await dataPage();
  await check('Data tab appears after a load, with the row count; the grid starts hidden', async () => {
    assert.ok(await page.locator('.view-tabs').isVisible());
    assert.match(await page.locator('.view-tab[data-view=data]').textContent(), /^Data\s*240$/);
    assert.equal(await page.locator('.view-tab[data-view=charts]').getAttribute('aria-selected'), 'true');
    assert.ok(await page.locator('.explorer').isHidden());
  });
  await check('opening it shows the table, only the visible columns are selected; the layout does not jump between tabs', async () => {
    const wsWidth = () => page.locator('.workspace').evaluate((n) => Math.round(n.getBoundingClientRect().width));
    const chartsW = await wsWidth();
    await openData(page);
    assert.ok(await page.locator('.grid').isHidden());
    // was: "the agent trace steps aside" (the trace column no longer exists). The same idea, now provable:
    // the workspace is the same width in both tabs and the Activity slide-over stays closed.
    assert.equal(await wsWidth(), chartsW, 'workspace width is identical in Charts and Data');
    assert.ok(chartsW >= 1100, `workspace is ${chartsW}px at 1440`);
    assert.ok(await page.locator('.slideover').isHidden(), 'Activity is closed by default in the Data tab too');
    assert.ok(await page.locator('.trace .panel-toggle').isVisible(), 'and still one click away');
    assert.equal(await page.locator('.view-tab[data-view=data]').getAttribute('aria-selected'), 'true');
    const q = JSON.parse(await page.evaluate(() => window.__gridQueries[0]));
    assert.deepEqual(q, { columns: ['Date', 'Close', 'Volume', 'Sector', 'Up', 'a_rather_long_column_name_for_overflow'], sort: null, offset: 0, limit: 200 }, 'a page of 200, just the visible columns');
    assert.match(await page.locator('.ex-status-left').textContent(), /^Rows 1–\d+ of 240$/);
  });
  await check('cells are formatted by what the column is: amounts, integers, pills, booleans, nulls, dates', async () => {
    const [n, date, close, volume, sector, up, long] = await rowTexts(page, 0);
    assert.equal(n, '1');
    assert.equal(date, '2014-01-02');
    assert.equal(close, '-40.00', 'an amount: 2 decimals');
    assert.equal(volume, '40,000,000', 'an integer: grouped, no decimals');
    assert.equal(sector, 'Tech');
    assert.equal(up, 'false');
    assert.equal(long, 'null');
    assert.ok(await page.locator('.ex-row[data-i="0"] .ex-cell.r-money.neg').isVisible(), 'negative amounts are red');
    assert.ok(await page.locator('.ex-row[data-i="0"] .ex-cell.r-category .pill-v').isVisible(), 'category as a pill');
    assert.ok(await page.locator('.ex-row[data-i="0"] .ex-cell.null').count() === 1, 'a null is dimmed');
    assert.ok(await page.locator('.ex-hcell[data-col=Close]').evaluate((el) => el.classList.contains('num')), 'amount header is right-aligned');
    assert.match(await page.locator('.ex-hcell[data-col=Close] .ex-hmeta').textContent(), /^amount/);
  });
  await check('virtualized: only the rows on screen are in the DOM', async () => {
    const n = await page.locator('.ex-row').count();
    assert.ok(n > 5 && n <= 45, String(n));
  });
  await check('click a header to sort: asc, desc, then off; the query orders on the server', async () => {
    const settled = () => page.waitForFunction(() => document.querySelector('.ex-loader')?.hidden && document.querySelector('.ex-row[data-i="0"] .ex-cell.r-money:not(.sk)'));
    const close = () => rowTexts(page, 0).then((c) => num(c[2]));
    await page.locator('.ex-hcell[data-col=Close] .ex-hname').click();
    await page.locator('.ex-sortchip:not([hidden])').waitFor();
    assert.match(await page.locator('.ex-sortchip').textContent(), /Sorted by Close ↑/);
    await settled();
    const a0 = await close();
    const a1 = await rowTexts(page, 1).then((c) => num(c[2]));
    assert.ok(a0 <= a1, 'ascending');
    assert.equal(await page.locator('.ex-hcell[data-col=Close]').getAttribute('aria-sort'), 'ascending');
    assert.ok((await page.evaluate(() => window.__gridQueries)).map((s) => JSON.parse(s)).some((q) => q.sort?.column === 'Close' && q.sort.dir === 'asc' && q.offset === 0), 'the server orders');
    await page.locator('.ex-hcell[data-col=Close] .ex-hname').click();
    await settled();
    assert.match(await page.locator('.ex-sortchip').textContent(), /↓/);
    const d0 = await close();
    assert.ok(d0 >= (await rowTexts(page, 1).then((c) => num(c[2]))), 'descending');
    await page.locator('.ex-hcell[data-col=Close] .ex-hname').click();
    await page.locator('.ex-sortchip').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.ex-hcell[data-col=Close]').getAttribute('aria-sort'), 'none');
  });
  await check('a row opens in the record view: every field, formatted, with prev/next', async () => {
    await page.locator('.ex-row[data-i="2"]').click();
    await page.locator('.ex-record:not([hidden])').waitFor();
    assert.equal(await page.locator('.ex-rec-title').textContent(), 'Row 3 of 240');
    assert.equal(await page.locator('.ex-field').count(), 6);
    assert.ok(await page.locator('.ex-row[data-i="2"]').evaluate((el) => el.classList.contains('sel')), 'row highlighted');
    assert.match(await page.locator('.ex-field[data-col=Volume] dd').textContent(), /^\d{2},\d{3},000$/);
    await page.locator('.ex-record').getByRole('button', { name: 'Next row' }).click();
    assert.equal(await page.locator('.ex-rec-title').textContent(), 'Row 4 of 240');
    await page.locator('.ex-record').getByRole('button', { name: 'Previous row' }).click();
    assert.equal(await page.locator('.ex-rec-title').textContent(), 'Row 3 of 240');
  });
  await check('keyboard: arrows move the record, Escape closes it', async () => {
    await page.locator('.ex-scroll').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.ex-rec-title').textContent(), 'Row 5 of 240');
    await page.keyboard.press('Escape');
    await page.locator('.ex-record').waitFor({ state: 'hidden' });
    await page.keyboard.press('Enter');
    await page.locator('.ex-record:not([hidden])').waitFor();
    assert.equal(await page.locator('.ex-rec-title').textContent(), 'Row 5 of 240', 'Enter reopens the selected row');
  });
  await check('record: find a field, hide empty fields, click a value to copy it', async () => {
    await page.locator('.ex-row[data-i="0"]').click();
    assert.equal(await page.locator('.ex-field').count(), 6);
    await page.locator('.ex-rec-empty input').check();
    assert.equal(await page.locator('.ex-field').count(), 5, 'the null long-name field is hidden');
    await page.locator('.ex-rec-empty input').uncheck();
    await page.locator('.ex-rec-filter').fill('vol');
    assert.equal(await page.locator('.ex-field').count(), 1);
    await page.locator('.ex-field[data-col=Volume] .ex-fval').click();
    await page.locator('.ex-toast:not([hidden])').waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '40000000');
    await page.locator('.ex-rec-filter').fill('');
    await page.locator('.ex-record').getByRole('button', { name: 'Copy JSON' }).click();
    const json = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    assert.equal(json.Sector, 'Tech');
    assert.equal(json.Close, -40);
  });
  await check('double-click a cell copies it', async () => {
    await page.locator('.ex-record').getByRole('button', { name: 'Close record' }).click();
    await page.locator('.ex-row[data-i="1"] .ex-cell').nth(4).dblclick();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Retail');
  });
  await check('column menu: stats, pin to the left, hide', async () => {
    await page.locator('.ex-hcell[data-col=Sector] .ex-hmenu').click();
    assert.match(await page.locator('.ex-pop').textContent(), /Distinct4/);
    await page.getByRole('button', { name: 'Pin column to the left' }).click();
    const order = await page.locator('.ex-hcell[data-col]').evaluateAll((els) => els.map((e) => e.dataset.col));
    assert.equal(order[0], 'Sector', 'pinned columns come first');
    assert.ok(await page.locator('.ex-hcell[data-col=Sector]').evaluate((e) => e.classList.contains('pin')));
    await page.locator('.ex-hcell[data-col=Up] .ex-hmenu').click();
    await page.getByRole('button', { name: 'Hide column' }).click();
    assert.equal(await page.locator('.ex-hcell[data-col=Up]').count(), 0);
    assert.match(await page.locator('.ex-columns').textContent(), /5 of 6/);
  });
  await check('column picker: search, bring a hidden column back (its data was kept), Reset view', async () => {
    await page.locator('.ex-columns').click();
    await page.locator('.ex-pick-search').fill('up');
    assert.equal(await page.locator('.ex-pick-row').count(), 1);
    const before = (await page.evaluate(() => window.__gridQueries)).length;
    await page.locator('.ex-pick-row input').check();
    await page.locator('.ex-hcell[data-col=Up]').waitFor();
    assert.equal((await page.evaluate(() => window.__gridQueries)).length, before, 'already fetched: no new query');
    assert.match(await rowTexts(page, 1).then((c) => c.join('|')), /true|false/);
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('.ex-pop').count() === 0, 'Escape closes the picker');
    await page.getByRole('button', { name: 'Reset view' }).click();
    assert.equal(await page.locator('.ex-hcell[data-col]').first().getAttribute('data-col'), 'Date');
    assert.ok(await page.locator('.ex-reset').isHidden());
  });
  await check('go to row: jumps, selects, loads the page that row is on', async () => {
    await page.locator('.ex-jump').fill('230');
    await page.locator('.ex-jump').press('Enter');
    await page.waitForFunction(() => document.querySelector('.ex-row[data-i="229"] .ex-cell.r-money:not(.sk)'));
    assert.match(await page.locator('.ex-status-left').textContent(), /^Rows 2[12]\d–240 of 240$/, 'the last page is clamped so the table ends at the bottom');
    assert.ok((await page.evaluate(() => window.__gridQueries)).map((s) => JSON.parse(s)).some((q) => q.offset === 200), 'page 2 was fetched');
    assert.equal((await rowTexts(page, 229))[0], '230');
  });
  await check('a column in the schema panel opens the Data tab at that column', async () => {
    await page.locator('.view-tab[data-view=charts]').click();
    assert.ok(await page.locator('.grid').isVisible());
    await page.locator('.dataset .col', { hasText: 'Volume' }).first().click();
    assert.equal(await page.locator('.view-tab[data-view=data]').getAttribute('aria-selected'), 'true');
    assert.ok(await page.locator('.ex-hcell[data-col=Volume]').isVisible());
  });
  await check('loading another dataset returns to Charts, where the progress shows', async () => {
    await exampleInMenu(page, 1);
    await page.locator('.view-tab[data-view=charts]').waitFor();
    assert.equal(await page.locator('.view-tab[data-view=charts]').getAttribute('aria-selected'), 'true');
    await page.locator('.card:not(.skeleton)').first().waitFor({ timeout: 10000 });
  });
  await page.screenshot({ path: path.join(shots, 'data-light.png') });
  await page.context().close();

  page = await dataPage({ colorScheme: 'dark' });
  await check('loading rows show skeletons; a failing page shows an inline error you can retry', async () => {
    await page.evaluate(() => { window.__stubGridMs = 500; window.__stubGridFail = true; }); // only pages past the first fail
    await page.locator('.view-tab[data-view=data]').click();
    await page.locator('.ex-cell.sk').first().waitFor();
    await page.locator('.ex-row:not(.failed) .ex-cell.r-money:not(.sk)').first().waitFor();
    await page.evaluate(() => { window.__stubGridMs = 0; });
    await page.locator('.ex-jump').fill('230');
    await page.locator('.ex-jump').press('Enter');
    await page.locator('.ex-row.failed').first().waitFor();
    assert.match(await page.locator('.ex-status-err').textContent(), /boom: the file moved/);
    await page.evaluate(() => { window.__stubGridFail = false; });
    await page.locator('.ex-row.failed').first().click();
    await page.waitForFunction(() => document.querySelector('.ex-row[data-i="229"] .ex-cell.r-money:not(.sk)'));
    assert.equal(await page.locator('.ex-status-err').textContent(), '');
  });
  await page.screenshot({ path: path.join(shots, 'data-dark.png') });
  await page.context().close();

  page = await dataPage({ viewport: { width: 390, height: 844 } });
  await check('phone: the grid scrolls inside itself, the record covers it, nothing overflows the page', async () => {
    await openData(page);
    await page.locator('.ex-row[data-i="1"]').click();
    await page.locator('.ex-record:not([hidden])').waitFor();
    const r = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth, rec: document.querySelector('.ex-record').getBoundingClientRect().width, body: document.querySelector('.ex-body').getBoundingClientRect().width }));
    assert.ok(r.sw <= r.iw, JSON.stringify(r));
    assert.ok(Math.abs(r.rec - r.body) < 2, 'record view is full width: ' + JSON.stringify(r));
    await page.locator('.ex-record').getByRole('button', { name: 'Close record' }).click();
    assert.ok(await page.locator('.ex-scroll').isVisible());
  });
  await page.context().close();

  page = await dataPage();
  await check('drill-through: click a mark, see the rows behind it and that they add up to the chart', async () => {
    const marks = page.locator('.card[data-id="c1"] svg g.mark-symbol path');
    await marks.first().waitFor();
    assert.ok(await page.locator('.card[data-id="c1"] .viz.drillable').count() === 1, 'a chart with a drill descriptor is drillable');
    assert.match(await page.locator('.card[data-id="c1"] .drill-hint').textContent(), /Click a mark/);
    assert.equal(await page.locator('.card[data-id="c2"] .drillable').count(), 0, 'no hint on a chart that cannot drill');
    await marks.first().click({ force: true });
    const panel = page.locator('.card[data-id="c1"] .drill-panel');
    await panel.locator('.drill-check.ok').waitFor();
    assert.match(await panel.locator('.drill-head').textContent(), /Date \(day\): 2014-01-02/);
    assert.match(await panel.locator('.drill-check').textContent(), /✓ 1 rows, and their average Close is [\d.]+: the same as the chart/);
    assert.equal(await panel.locator('tbody tr').count(), 1, 'the rows behind that mark');
    assert.match(await panel.locator('thead').textContent(), /Close/);
    await marks.nth(10).click({ force: true });
    await page.waitForFunction(() => /2014-01-12/.test(document.querySelector('.card[data-id="c1"] .drill-label')?.textContent || ''));
  });
  await check('drill-through: when the rows do not add up it says so; the panel closes', async () => {
    await page.evaluate(() => { window.__stubDrillOff = true; });
    await page.locator('.card[data-id="c1"] svg g.mark-symbol path').nth(3).click({ force: true });
    const warn = page.locator('.card[data-id="c1"] .drill-check.warn');
    await warn.waitFor();
    assert.match(await warn.textContent(), /but the chart shows .*Treat this chart with care/);
    await page.locator('.card[data-id="c1"] .drill-head').getByRole('button', { name: /Close the rows/ }).click();
    assert.ok(await page.locator('.card[data-id="c1"] .drill-panel').isHidden());
  });
  await page.context().close();

  page = await dataPage({}, AI);
  await check('how this was calculated: closed under suggested charts, open under your own question, with plan, coverage, assumptions', async () => {
    const sug = page.locator('.card[data-id="c1"] details.explain');
    assert.ok(await sug.count() === 1);
    assert.equal(await sug.evaluate((el) => el.open), false, 'closed on a suggested chart');
    await sug.locator('summary').click();
    assert.match(await sug.textContent(), /Averages Close for each day of Date\./);
    assert.match(await sug.textContent(), /Uses all 240 rows\./);
    assert.match(await sug.textContent(), /Averaged, not added up/);
    assert.equal(await page.locator('.card[data-id="c2"] details.explain').count(), 0, 'nothing to say, nothing shown');
    await page.fill('.ask-input', 'Which sector trades the most volume?');
    await page.click('.ask button[type=submit]');
    const ans = page.locator('.card.asked details.explain');
    await ans.waitFor();
    assert.equal(await ans.evaluate((el) => el.open), true, 'open on an answer to your own question');
    assert.match(await ans.textContent(), /Adds up the volume for each sector/);
    assert.match(await ans.textContent(), /the AI's own description of its query/);
    assert.match(await ans.locator('.explain-assume').textContent(), /"Trades the most" is taken to mean the largest total volume/);
  });
  await page.context().close();

  page = await dataPage({}, AI);
  await check('check this number: re-checks the chart and says what holds; names what does not; an AI answer gets only the basics', async () => {
    const card = page.locator('.card[data-id="c1"]');
    assert.equal(await page.locator('.card[data-id="c2"] .check-btn').count(), 1, 'every chart with rows has the button');
    assert.equal(await page.locator('.card[data-id="c3"] .check-btn').count(), 0, 'a failed chart has nothing to check');
    await card.locator('.check-btn').click();
    const verdict = card.locator('.check-verdict');
    await verdict.waitFor();
    await page.waitForFunction(() => document.querySelector('.card[data-id="c1"] .check-verdict')?.classList.contains('ok'));
    assert.match(await verdict.textContent(), /✓ Checks out/);
    assert.match(await card.locator('.check-list').textContent(), /40 of 120 marks checked: the rows behind each one add up to the number shown/);
    assert.match(await card.locator('.check-list').textContent(), /80 other marks were not re-checked/);
    assert.match(await card.locator('.check-foot').textContent(), /can't tell you whether the data itself is right/);
    await page.evaluate(() => { window.__stubDrillOff = true; });
    await card.locator('.check-btn').click();
    await page.waitForFunction(() => document.querySelector('.card[data-id="c1"] .check-verdict')?.classList.contains('warn'));
    assert.match(await card.locator('.check-verdict').textContent(), /⚠ Needs a look/);
    assert.match(await card.locator('.check-list li.warn').first().textContent(), /the chart shows .* but its rows give/);
    await card.locator('.drill-head').getByRole('button', { name: /Close the check/ }).click();
    assert.ok(await card.locator('.check-panel').isHidden());
    await page.evaluate(() => { window.__stubDrillOff = false; });
    await page.fill('.ask-input', 'Which sector trades the most volume?');
    await page.click('.ask button[type=submit]');
    const ans = page.locator('.card.asked');
    await ans.locator('.check-btn').click();
    await ans.locator('.check-verdict.partial').waitFor();
    assert.match(await ans.locator('.check-verdict').textContent(), /Only basic checks were possible/);
    assert.match(await ans.locator('.check-list').textContent(), /written by the AI, so its marks can't be traced to rows/);
  });
  await page.context().close();

  page = await dataPage({ acceptDownloads: true });
  await check('SQL tab: starter query for the table, Run (button and Ctrl+Enter), results in the same grid, sortable', async () => {
    await page.locator('.view-tab[data-view=sql]').click();
    assert.equal(await page.locator('.view-tab[data-view=sql]').getAttribute('aria-selected'), 'true');
    assert.ok(await page.locator('.grid').isHidden());
    const input = page.locator('.sql-input');
    assert.match(await input.inputValue(), /^SELECT \* FROM "apple_stock" LIMIT 100$/);
    assert.equal(await page.locator('.sql-table-chip').textContent(), 'apple_stock');
    assert.ok(await page.locator('.sqlbox .explorer').isHidden(), 'no results yet');
    await page.getByRole('button', { name: 'Run' }).click();
    await page.locator('.sqlbox .ex-row').first().waitFor();
    assert.match(await page.locator('.sql-status').textContent(), /^120 rows · [\d.]+ s$/);
    assert.ok((await page.locator('.sqlbox .ex-hcell[data-col]').count()) >= 5, 'result columns in the grid header');
    const first = await page.locator('.sqlbox .ex-row[data-i="0"] .ex-cell').nth(1).textContent();
    await page.locator('.sqlbox .ex-hcell[data-col="Date"] .ex-hname').click();
    await page.locator('.sqlbox .ex-hcell[data-col="Date"] .ex-hname').click();
    await page.waitForFunction((f) => document.querySelector('.sqlbox .ex-row[data-i="0"] .ex-cell:nth-child(2)')?.textContent !== f, first);
    await input.fill('SELECT "Date" FROM "apple_stock" LIMIT 5');
    await input.press('Control+Enter');
    await page.waitForFunction(() => /^120 rows/.test(document.querySelector('.sql-status').textContent) && document.querySelectorAll('.sqlbox .ex-hcell[data-col]').length >= 1);
  });
  await check('SQL tab: only read-only queries; the guard stops the rest before anything runs', async () => {
    const input = page.locator('.sql-input');
    await input.fill('DROP TABLE apple_stock');
    await page.getByRole('button', { name: 'Run' }).click();
    const err = page.locator('.sql-error');
    await err.waitFor();
    assert.match(await err.textContent(), /Only read-only queries \(SELECT or WITH\) are allowed here\./);
    await input.fill('SELECT 1; SELECT 2');
    await page.getByRole('button', { name: 'Run' }).click();
    assert.match(await err.textContent(), /multiple statements/);
  });
  await check('SQL tab: examples fill the editor, the table name inserts at the cursor, history remembers what ran', async () => {
    const input = page.locator('.sql-input');
    const opts = await page.locator('.sql-examples option').allTextContents();
    assert.deepEqual(opts.slice(0, 3), ['Examples…', 'First 100 rows', 'How many rows']);
    assert.ok(opts.includes('Empty values per column'));
    await page.locator('.sql-examples').selectOption({ label: 'How many rows' });
    assert.match(await input.inputValue(), /^SELECT COUNT\(\*\) AS row_count FROM "apple_stock"$/);
    await input.fill('SELECT * FROM ');
    await input.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
    await page.locator('.sql-table-chip').click();
    assert.equal(await input.inputValue(), 'SELECT * FROM "apple_stock"');
    await page.getByRole('button', { name: 'Run' }).click();
    await page.waitForFunction(() => /rows? ·/.test(document.querySelector('.sql-status').textContent));
    const hist = await page.locator('.sql-history option').allTextContents();
    assert.ok(hist.includes('SELECT * FROM "apple_stock"'), hist.join(' | '));
    assert.ok(hist.includes('Clear history'));
    await input.fill('');
    await page.locator('.sql-history').selectOption({ index: 1 });
    assert.notEqual(await input.inputValue(), '', 'picking an earlier query fills the editor');
  });
  await check('SQL tab: download the result as CSV; copy the SQL', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
    assert.equal(dl.suggestedFilename(), 'sql_result.csv');
    const stream = await dl.createReadStream();
    let body = '';
    for await (const c of stream) body += c;
    assert.match(body.split('\n')[0], /Date/);
    assert.ok(body.split('\n').length > 100, 'every row');
  });
  await check('a chart\'s "Edit in SQL tab" opens its SQL in the editor', async () => {
    await page.locator('.view-tab[data-view=charts]').click();
    const card = page.locator('.card[data-id="c2"]');
    await card.locator('.card-menu-btn').click();
    await card.getByRole('menuitem', { name: 'Edit in SQL tab' }).click();
    assert.equal(await page.locator('.view-tab[data-view=sql]').getAttribute('aria-selected'), 'true');
    assert.match(await page.locator('.sql-input').inputValue(), /date_trunc\('month', "Date"\) AS month/);
  });
  await check('arrow keys cycle Charts, Data, SQL', async () => {
    await page.locator('.view-tab[data-view=sql]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('.view-tab[data-view=charts]').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('.view-tab[data-view=sql]').getAttribute('aria-selected'), 'true');
  });
  await page.context().close();

  page = await dataPage({}, AI);
  await check('metrics: one-click starting points, values, saved per dataset, shown again after a reload', async () => {
    const panel = page.locator('.metrics');
    assert.ok(await panel.isHidden(), 'nothing above the charts until there is a metric');
    await page.locator('.view-row .metric-add').click();
    assert.ok(await panel.isVisible());
    const ideas = await panel.locator('.metric-idea').allTextContents();
    assert.deepEqual(ideas.slice(0, 2), ['Rows', 'Total Volume']);
    assert.equal(await panel.locator('.metric').count(), 0);
    await panel.locator('.metric-idea', { hasText: 'Rows' }).click();
    const card = panel.locator('.metric[data-name="Rows"]');
    await card.locator('.metric-value:not(.muted)').waitFor();
    assert.equal(await card.locator('.metric-value').textContent(), '240');
    assert.equal(await card.locator('.metric-def').textContent(), 'COUNT(*)');
    assert.ok(await panel.locator('.metric-form').isHidden(), 'choosing an idea closes the form');
    await page.locator('.view-row .metric-add').click();
    assert.equal(await panel.locator('.metric-idea', { hasText: 'Rows' }).count(), 0, 'a saved idea is no longer offered');
    await panel.getByRole('button', { name: 'Cancel' }).click();
    assert.deepEqual((await page.evaluate(() => window.__stubMetrics)).map((m) => m.name), ['Rows'], 'the AI pipeline is told about it');
    await page.reload(); // the address keeps the dataset, so it loads again by itself
    await page.locator('.metrics .metric[data-name="Rows"] .metric-value:not(.muted)').waitFor();
    assert.equal(await page.locator('.metrics .metric').count(), 1, 'remembered for this dataset');
    assert.deepEqual((await page.evaluate(() => window.__stubMetrics)).map((m) => m.name), ['Rows'], 'and handed to the pipeline again after the reload');
  });
  await check('metrics: define one (try it first), a definition that does not run is not saved, edit, remove', async () => {
    const panel = page.locator('.metrics');
    await page.locator('.view-row .metric-add').click();
    await panel.locator('.metric-name').fill('Big days');
    await panel.locator('.metric-expr').fill('SUM("Volume") FILTER (WHERE "Close" > 100)');
    await panel.getByRole('button', { name: 'Try it' }).click();
    await panel.locator('.metric-preview.ok').waitFor();
    assert.equal(await panel.locator('.metric-preview').textContent(), '= 1,234.50');
    await panel.getByRole('button', { name: 'Save' }).click();
    await panel.locator('.metric[data-name="Big days"] .metric-value').waitFor();
    assert.equal(await panel.locator('.metric[data-name="Big days"] .metric-value').textContent(), '1,234.50');
    assert.ok(await panel.locator('.metric-form').isHidden(), 'the form closes after saving');
    // a definition that fails: shown plainly, not saved
    await page.locator('.view-row .metric-add').click();
    await panel.locator('.metric-name').fill('Broken');
    await panel.locator('.metric-expr').fill('SUM("NOPE")');
    await panel.getByRole('button', { name: 'Save' }).click();
    await panel.locator('.metric-preview.err').waitFor();
    assert.match(await panel.locator('.metric-preview').textContent(), /Binder Error: Referenced column "NOPE"/);
    assert.equal(await panel.locator('.metric[data-name="Broken"]').count(), 0);
    // not an expression: stopped before it runs
    await panel.locator('.metric-expr').fill('1); DROP TABLE apple_stock --');
    await panel.getByRole('button', { name: 'Save' }).click();
    assert.match(await panel.locator('.metric-preview').textContent(), /One expression only/);
    // a duplicate name
    await panel.locator('.metric-name').fill('rows');
    await panel.locator('.metric-expr').fill('COUNT(*)');
    await panel.getByRole('button', { name: 'Save' }).click();
    assert.match(await panel.locator('.metric-preview').textContent(), /already exists/);
    await panel.getByRole('button', { name: 'Cancel' }).click();
    // edit
    await panel.getByRole('button', { name: 'Edit Big days' }).click();
    assert.equal(await panel.locator('.metric-name').inputValue(), 'Big days');
    await panel.locator('.metric-name').fill('Busy days');
    await panel.getByRole('button', { name: 'Save' }).click();
    await panel.locator('.metric[data-name="Busy days"]').waitFor();
    assert.equal(await panel.locator('.metric[data-name="Big days"]').count(), 0);
    assert.deepEqual((await page.evaluate(() => window.__stubMetrics)).map((m) => m.name), ['Rows', 'Busy days']);
    // remove
    await panel.getByRole('button', { name: 'Remove Busy days' }).click();
    assert.equal(await panel.locator('.metric').count(), 1);
  });
  await check('metrics join the SQL tab examples, and the cards belong to the Charts tab', async () => {
    await page.locator('.view-tab[data-view=data]').click();
    assert.ok(await page.locator('.metrics').isHidden());
    await page.locator('.view-tab[data-view=sql]').click();
    const opts = await page.locator('.sql-examples option').allTextContents();
    assert.ok(opts.includes('Metric: Rows'), opts.join(' | '));
    await page.locator('.sql-examples').selectOption({ label: 'Metric: Rows' });
    assert.equal(await page.locator('.sql-input').inputValue(), 'SELECT COUNT(*) AS "Rows" FROM "apple_stock"');
    await page.locator('.view-tab[data-view=charts]').click();
    assert.ok(await page.locator('.metrics').isVisible());
  });
  await page.context().close();

  page = await dataPage({ ...CLIP }, AI);
  const snapshot = (p) => p.evaluate(() => [...document.querySelectorAll('.card:not(.skeleton)')].map((c) => ({ title: c.querySelector('h3')?.textContent, count: c.querySelector('.card-count')?.textContent, sql: c.querySelector('.sql-panel code')?.textContent || null })));
  await check('views: Overview by default; Explore is compact with the plan open; Review opens on the rows; the same cards in all three', async () => {
    assert.equal(await page.locator('.view-select').inputValue(), 'overview');
    assert.equal(await page.locator('.app').getAttribute('data-mode'), 'overview');
    assert.equal(await page.locator('.app').getAttribute('data-density'), 'comfortable');
    assert.deepEqual(await page.locator('.view-select option').allTextContents(), ['Overview', 'Explore', 'Review']);
    const before = await snapshot(page);
    assert.ok(before.length >= 3);
    assert.equal(await page.locator('.card[data-id="c1"] details.explain').evaluate((el) => el.open), false);
    await page.locator('.view-select').selectOption('explore');
    assert.equal(await page.locator('.app').getAttribute('data-density'), 'compact');
    assert.equal(await page.locator('.card[data-id="c1"] details.explain').evaluate((el) => el.open), true, 'Explore opens "how this was calculated"');
    assert.equal(await page.locator('.view-tab[data-view=charts]').getAttribute('aria-selected'), 'true');
    assert.ok(await page.locator('.databar .fields-toggle').getAttribute('aria-expanded') === 'true', 'the columns list is open in Explore');
    await page.locator('.view-select').selectOption('review');
    assert.equal(await page.locator('.view-tab[data-view=data]').getAttribute('aria-selected'), 'true', 'Review opens on the rows');
    await page.locator('.ex-row').first().waitFor();
    await page.locator('.view-select').selectOption('overview');
    assert.equal(await page.locator('.view-tab[data-view=charts]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.databar .fields-toggle').getAttribute('aria-expanded'), 'false', 'the columns list is closed in Overview');
    assert.equal(await page.locator('.card[data-id="c1"] details.explain').evaluate((el) => el.open), false);
    assert.deepEqual(await snapshot(page), before, 'a view never changes what the charts say: same titles, same row counts, same SQL');
  });
  await check('views: the choice is remembered; a share link\'s view applies to that visit only', async () => {
    await page.locator('.view-select').selectOption('review');
    await page.reload();
    await page.locator('.view-select').waitFor();
    assert.equal(await page.locator('.view-select').inputValue(), 'review', 'remembered across a reload');
    await page.locator('.view-tab[data-view=data]').waitFor();
    // a link with ?view=explore: that visit is Explore, the saved choice stays Review
    await page.goto(BASE + '?url=' + encodeURIComponent('https://github.com/o/r/blob/main/ok.csv') + '&view=explore&tab=sql');
    await page.locator('.view-tab[data-view=sql]').waitFor();
    await page.waitForFunction(() => document.querySelector('.view-tab[data-view=sql]')?.getAttribute('aria-selected') === 'true');
    assert.equal(await page.locator('.view-select').inputValue(), 'explore');
    assert.equal(await page.locator('.app').getAttribute('data-density'), 'compact');
    await page.goto(BASE);
    await page.locator('.chips.large .chip').first().click();
    await page.locator('.view-select').waitFor();
    assert.equal(await page.locator('.view-select').inputValue(), 'review', 'the link did not overwrite the saved view');
  });
  await check('share: copies a link with the dataset, view and tab; it reopens the same way', async () => {
    await page.locator('.view-select').selectOption('explore');
    await page.locator('.view-tab[data-view=sql]').click();
    await page.getByRole('button', { name: 'Share' }).click();
    await page.getByRole('button', { name: 'Link copied' }).waitFor();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    const u = new URL(link);
    assert.equal(u.searchParams.get('url'), 'https://github.com/plotly/datasets/blob/master/2014_apple_stock.csv');
    assert.equal(u.searchParams.get('view'), 'explore');
    assert.equal(u.searchParams.get('tab'), 'sql');
    await page.goto(link);
    await page.waitForFunction(() => document.querySelector('.view-tab[data-view=sql]')?.getAttribute('aria-selected') === 'true');
    assert.equal(await page.locator('.view-select').inputValue(), 'explore');
    assert.match(await page.locator('.databar .ds-name').textContent(), /2014_apple_stock\.csv/);
  });
  await page.context().close();

  page = await newPage();
  await page.addInitScript(() => { window.__stubBank = true; });
  await page.goto(BASE);
  await page.locator('.chips.large .chip').first().click();
  await page.locator('.card:not(.skeleton)').first().waitFor({ timeout: 10000 });
  await check('views: a transactions-like table gets a suggestion to switch to Review, dismissible and remembered', async () => {
    const chip = page.locator('.mode-chip');
    await chip.waitFor();
    assert.match(await chip.textContent(), /Looks like transactions\./);
    assert.equal(await page.locator('.view-select').inputValue(), 'overview', 'suggested, never switched');
    await chip.getByRole('button', { name: 'Not now' }).click();
    assert.ok(await chip.isHidden());
    await page.reload();
    await page.locator('.card:not(.skeleton)').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
    assert.ok(await page.locator('.mode-chip').isHidden(), 'dismissal remembered for this dataset');
  });
  await page.context().close();

  page = await newPage();
  await page.addInitScript(() => { window.__stubBank = true; });
  await page.goto(BASE);
  await page.locator('.chips.large .chip').first().click();
  await check('views: switching from the suggestion opens Review on the rows', async () => {
    await page.locator('.mode-chip').getByRole('button', { name: 'Switch to Review' }).click();
    assert.equal(await page.locator('.view-select').inputValue(), 'review');
    assert.equal(await page.locator('.view-tab[data-view=data]').getAttribute('aria-selected'), 'true');
    assert.ok(await page.locator('.mode-chip').isHidden());
  });
  await page.context().close();

  page = await newPage({}, undefined);
  await page.goto(BASE);
  await check('share is unavailable for a file from your computer', async () => {
    assert.ok(await page.locator('.share-btn').isHidden() || await page.locator('.share-btn').isDisabled());
    await page.locator('input[type=file]').setInputFiles({ name: 'mine.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') });
    await page.locator('.databar .ds-name').waitFor();
    assert.ok(await page.locator('.share-btn').isDisabled());
    assert.match(await page.locator('.share-btn').getAttribute('title'), /can't be shared by link/);
  });
  await page.context().close();

  page = await newPage();
  await page.addInitScript(() => { window.__stubWide = true; });
  await page.goto(BASE);
  await page.locator('.chips.large .chip').first().click();
  await page.locator('.card:not(.skeleton)').first().waitFor({ timeout: 10000 });
  await check('wide table: 30 columns to start, more on demand (fetched when shown), columns can be searched', async () => {
    await page.locator('.view-tab[data-view=data]').click();
    await page.locator('.ex-row:not(.failed) .ex-cell.r-int:not(.sk)').first().waitFor();
    assert.match(await page.locator('.ex-columns').textContent(), /30 of 40/);
    const first = (await page.evaluate(() => window.__gridQueries))[0];
    assert.ok(first.includes('"c29"') && !first.includes('"c30"'), first.slice(0, 120));
    await page.locator('.ex-columns').click();
    await page.locator('.ex-pick-search').fill('c35');
    await page.locator('.ex-pick-row input').check();
    await page.locator('.ex-hcell[data-col=c35]').waitFor();
    await page.waitForFunction(() => window.__gridQueries.at(-1).includes('"c35"'));
    assert.match(await page.locator('.ex-columns').textContent(), /31 of 40/);
    await page.locator('.ex-pop-picker').getByRole('button', { name: 'Show all' }).click();
    assert.match(await page.locator('.ex-columns').textContent(), /40 of 40/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.ex-row[data-i="0"] .ex-cell').count(), 41, 'gutter + 40 columns');
  });
  await page.context().close();

  page = await dataPage({}, AI);
  await check('asking a question from the Data tab switches to Charts to show the answer', async () => {
    await openData(page);
    await page.fill('.ask-input', 'Which sector trades the most volume?');
    await page.click('.ask button[type=submit]');
    assert.equal(await page.locator('.view-tab[data-view=charts]').getAttribute('aria-selected'), 'true');
    await page.locator('.card.asked:not(.skeleton)').waitFor({ timeout: 10000 });
  });
  await page.context().close();

  // ---- working set for big remote files: decided from the charts' columns and a memory check ----
  // stub charts use 3 columns of a 5M-row sample (~457 MB): green on 32 GB, yellow on 2 GB, red on 1 GB and phones without signals
  const BIG = 'https://github.com/o/r/blob/main/big.parquet';
  async function bigPage(signals, settings, viewport, cacheMs = 600) {
    const p = await newPage(viewport ? { viewport } : {}, settings);
    await p.addInitScript(([s, ms]) => { window.__memorySignals = s; window.__stubCacheMs = ms; }, [signals, cacheMs]);
    await p.goto(`${BASE}?url=${encodeURIComponent(BIG)}`);
    await p.locator('.cache-banner:not([hidden])').waitFor();
    return p;
  }
  page = await bigPage({ deviceMemoryGB: 32, mobile: false });
  await check('working set, green: builds the charts\' columns with progress, charts wait, then "Working set ready"', async () => {
    assert.equal(await page.locator('.cache-banner').getAttribute('data-status'), 'building');
    assert.match(await page.locator('.cache-banner').textContent(), /Building working set \(3 columns\)…/);
    assert.ok(await page.locator('.cache-progress').isVisible());
    assert.ok(await page.locator('.card.pending').count() > 0, 'charts wait for the working set');
    assert.deepEqual(await page.evaluate(() => window.__stubWorkingSet), ['Date', 'Close', 'Sector'], 'only the columns the charts use');
    await page.locator('.cache-banner[data-status="ready"]').waitFor({ timeout: 5000 });
    assert.match(await page.locator('.cache-banner').textContent(), /Working set ready · charts instant \(3 columns in memory\)/);
    await page.waitForFunction(() => !document.querySelector('.card.pending'));
  });
  await page.context().close();

  page = await bigPage({ deviceMemoryGB: 32, mobile: false }, AI);
  await check('extending the working set for a question', async () => {
    await page.locator('.cache-banner[data-status="ready"]').waitFor({ timeout: 5000 });
    await page.fill('.ask-input', 'Which sector trades the most volume?');
    await page.click('.ask button[type=submit]');
    await page.locator('.cache-banner[data-status="extending"]').waitFor({ timeout: 3000 });
    assert.match(await page.locator('.cache-banner').textContent(), /Adding 1 column to working set…/);
    await page.locator('.cache-banner[data-status="ready"]').waitFor({ timeout: 3000 });
    assert.match(await page.locator('.cache-banner').textContent(), /4 columns in memory/);
  });
  await check('Settings: "Clear working set" drops it (light mode, can rebuild)', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('.drawer-panel').waitFor();
    assert.ok(await page.getByRole('button', { name: 'Clear working set' }).isEnabled());
    await page.getByRole('button', { name: 'Clear working set' }).click();
    await page.locator('.drawer-actions .btn:not(.primary)').click();
    await page.locator('.cache-banner[data-status="light"]').waitFor({ timeout: 3000 });
    assert.match(await page.locator('.cache-banner').textContent(), /Working set cleared/);
    assert.ok(await page.getByRole('button', { name: 'Build working set' }).isVisible());
  });
  await page.context().close();

  page = await bigPage({ deviceMemoryGB: 2, mobile: false });
  await check('working set, yellow: one-click offer with the memory cost; charts read the file meanwhile', async () => {
    assert.equal(await page.locator('.cache-banner').getAttribute('data-status'), 'asking');
    assert.match(await page.locator('.cache-banner').textContent(), /3 columns these charts use takes about \d+ MB of memory/);
    await page.waitForFunction(() => !document.querySelector('.card.pending'), null, { timeout: 5000 });
    assert.equal(await page.locator('.cache-banner').getAttribute('data-status'), 'asking', 'nothing built without a click');
    await page.getByRole('button', { name: 'Build it' }).click();
    await page.locator('.cache-banner[data-status="ready"]').waitFor({ timeout: 5000 });
  });
  await page.context().close();

  page = await bigPage({ deviceMemoryGB: 1, mobile: false });
  await check('working set, red: light mode explained, no build offered', async () => {
    assert.equal(await page.locator('.cache-banner').getAttribute('data-status'), 'light');
    assert.match(await page.locator('.cache-banner').textContent(), /limited memory.*light mode/);
    assert.equal(await page.locator('.cache-banner button').count(), 0);
  });
  await page.context().close();

  page = await bigPage({ deviceMemoryGB: 1, mobile: false });
  await check('Data tab on a big remote file in light mode says rows are read from the file', async () => {
    await page.locator('.view-tab[data-view=data]').click();
    await page.locator('.ex-status-hint').waitFor();
    assert.match(await page.locator('.ex-status-hint').textContent(), /straight from the file/);
  });
  await page.context().close();

  page = await bigPage({ deviceMemoryGB: 1, mobile: false });
  await check('Data tab on a remote file: columns arrive in groups (working-set columns first), cells fill in as they land', async () => {
    await page.evaluate(() => { window.__stubFast = ['Date', 'Close']; window.__stubSlowCol = 'Up'; window.__stubSlowMs = 900; });
    await page.locator('.view-tab[data-view=data]').click();
    await page.locator('.ex-row[data-i="0"] .ex-cell.r-money:not(.sk)').waitFor();
    const q = (await page.evaluate(() => window.__gridQueries)).map((s) => JSON.parse(s));
    assert.deepEqual(q[0].columns, ['Date', 'Close'], 'the working-set columns are asked for first');
    assert.deepEqual(q[1].columns, ['Volume', 'Sector', 'Up', 'a_rather_long_column_name_for_overflow'], 'the rest in a group of 4');
    assert.ok(await page.locator('.ex-row[data-i="0"] .ex-cell.sk').count() > 0, 'columns still on their way are skeletons');
    assert.ok(await page.locator('.ex-loader').isVisible(), 'and the grid says it is loading');
    await page.waitForFunction(() => document.querySelector('.ex-row[data-i="0"]') && !document.querySelector('.ex-row[data-i="0"] .ex-cell.sk'));
    assert.equal(((await rowTexts(page, 0)))[4], 'Tech', 'the late group filled in');
    await page.locator('.ex-hcell[data-col=Close] .ex-hname').click(); // a sorted page is one query: the sort isn't repeated per group
    await page.waitForFunction(() => document.querySelector('.ex-loader')?.hidden);
    const sorted = (await page.evaluate(() => window.__gridQueries)).map((s) => JSON.parse(s)).filter((x) => x.sort);
    assert.equal(sorted.length > 0 && sorted.every((x) => x.columns.length === 6), true, 'sorted pages fetch every column in one query');
  });
  await page.context().close();

  page = await bigPage({ deviceMemoryGB: null, mobile: true }, undefined, { width: 390, height: 844 });
  await check('phone without memory signals: light mode, banner fits, no sideways scroll', async () => {
    assert.equal(await page.locator('.cache-banner').getAttribute('data-status'), 'light');
    const r = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth, bw: document.querySelector('.cache-banner').getBoundingClientRect().right }));
    assert.ok(r.sw <= r.iw && r.bw <= r.iw, JSON.stringify(r));
  });
  await page.context().close();

  page = await bigPage({ deviceMemoryGB: 32, mobile: false }, { provider: 'none', apiKey: '', model: '', baseUrl: '', cacheMode: 'light' });
  await check('"Prefer low memory" setting: light mode, with a one-click build', async () => {
    assert.equal(await page.locator('.cache-banner').getAttribute('data-status'), 'light');
    assert.match(await page.locator('.cache-banner').textContent(), /your Large files setting/);
    await page.getByRole('button', { name: 'Build working set' }).click();
    await page.locator('.cache-banner[data-status="ready"]').waitFor({ timeout: 5000 });
  });
  await check('loading a normal file clears the banner', async () => {
    await exampleInMenu(page, 0);
    await page.locator('.cache-banner').waitFor({ state: 'hidden' });
  });
  await page.context().close();

  page = await bigPage({ deviceMemoryGB: 32, mobile: false }, { provider: 'none', apiKey: '', model: '', baseUrl: '', cacheMode: 'fast' });
  await check('"Fast mode" setting: the working set takes every column', async () => {
    await page.locator('.cache-banner[data-status="ready"]').waitFor({ timeout: 5000 });
    assert.equal((await page.evaluate(() => window.__stubWorkingSet)).length, 6);
  });
  await page.context().close();

  page = await bigPage({ deviceMemoryGB: 32, mobile: false }, undefined, undefined, 1500);
  await check('cancel while building: light mode, charts still load, can build again', async () => {
    assert.equal(await page.locator('.cache-banner').getAttribute('data-status'), 'building');
    await page.locator('.cache-banner').getByRole('button', { name: 'Cancel' }).click();
    await page.locator('.cache-banner[data-status="light"]').waitFor({ timeout: 3000 });
    await page.waitForFunction(() => !document.querySelector('.card.pending'), null, { timeout: 5000 });
    await page.waitForTimeout(1900);
    assert.equal(await page.locator('.cache-banner').getAttribute('data-status'), 'light', 'the cancelled build does not finish later');
    assert.ok(await page.getByRole('button', { name: 'Build working set' }).isVisible());
  });
  await page.context().close();

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall UI checks passed');
console.log(`screenshots: ${path.relative(process.cwd(), shots)}/`);
process.exit(failed ? 1 : 0);
