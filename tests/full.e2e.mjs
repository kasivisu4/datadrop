// Full-stack e2e: real dist/ build, real DuckDB-WASM, real GitHub CSV, real llm.js.
// Only api.anthropic.com is mocked (page.route), so every agent runs for real.
// Run: npm run build && node tests/full.e2e.mjs
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.map': 'application/json' };

const server = await new Promise((ok) => {
  const s = createServer(async (req, res) => {
    let f = join(dist, normalize(new URL(req.url, 'http://x').pathname));
    try {
      if ((await stat(f)).isDirectory()) f = join(f, 'index.html');
      res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
      res.end(await readFile(f));
    } catch { res.writeHead(404); res.end(); }
  });
  s.listen(0, '127.0.0.1', () => ok(s));
});
const base = `http://127.0.0.1:${server.address().port}/`;

let pw; try { pw = await import('playwright'); } catch { pw = createRequire('/opt/npm-tools/node_modules/')('playwright'); }

// ---- mock Claude: answers by which agent's system prompt it sees ----
const calls = { planner: 0, sql: 0, repair: 0, viz: 0 };
function mockAnswer(system, userText) {
  const T = (system.match(/table "([^"]+)"/) || [])[1] || 't_2014_apple_stock';
  if (system.startsWith('You are a senior data analyst')) {
    calls.planner++;
    return JSON.stringify({ charts: [
      { title: 'Monthly average close', question: 'How did the price trend by month?',
        sql: `SELECT date_trunc('month', "AAPL_x") AS month, AVG("AAPL_y") AS avg_close FROM "${T}" GROUP BY 1 ORDER BY 1`,
        spec: { mark: 'line', encoding: { x: { field: 'month', type: 'temporal' }, y: { field: 'avg_close', type: 'quantitative' } } } },
      // Deliberately broken column name -> exercises executor + repair agent
      { title: 'Highest closing days', question: 'Which days closed highest?',
        sql: `SELECT "AAPL_x" AS day, "close_price" AS close FROM "${T}" ORDER BY close DESC LIMIT 10`,
        spec: { mark: 'bar', encoding: { x: { field: 'DAY', type: 'nominal' }, y: { field: 'close', type: 'quantitative' } } } },
    ] });
  }
  if (system.startsWith('You fix broken DuckDB')) {
    calls.repair++;
    return '```json\n' + JSON.stringify({ sql: `SELECT "AAPL_x" AS day, "AAPL_y" AS close FROM "${T}" ORDER BY close DESC LIMIT 10` }) + '\n```';
  }
  if (system.startsWith('You translate natural-language')) {
    calls.sql++;
    return JSON.stringify({ sql: `SELECT strftime("AAPL_x", '%Y-Q') || CAST(quarter("AAPL_x") AS VARCHAR) AS qtr, MAX("AAPL_y") AS max_close FROM "${T}" GROUP BY 1 ORDER BY 1`, rationale: 'quarterly max' });
  }
  if (system.startsWith('You choose the best Vega-Lite')) {
    calls.viz++;
    return 'Here you go: ' + JSON.stringify({ title: 'Max close by quarter', spec: { mark: 'bar', encoding: { x: { field: 'qtr', type: 'ordinal' }, y: { field: 'max_close', type: 'quantitative' } } } });
  }
  throw new Error('unknown agent prompt: ' + system.slice(0, 60));
}

const browser = await pw.chromium.launch();
const results = {};
try {
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, colorScheme: scheme });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Chromium here can't use the container proxy: relay GitHub fetches through Node.
    await page.route(/^https:\/\/(raw|media)\.githubusercontent\.com\//, async (route) => {
      const r = await fetch(route.request().url());
      await route.fulfill({ status: r.status, headers: { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }, body: Buffer.from(await r.arrayBuffer()) });
    });
    await page.route('https://api.anthropic.com/**', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      const body = JSON.parse(route.request().postData());
      assert.equal(route.request().headers()['anthropic-dangerous-direct-browser-access'], 'true');
      const text = mockAnswer(body.system || '', body.messages.at(-1).content);
      await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
        body: JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) });
    });
    await page.addInitScript(() => localStorage.setItem('datadrop.settings.v1', JSON.stringify({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-sonnet-4-5' })));

    const url = 'https://github.com/plotly/datasets/blob/master/2014_apple_stock.csv';
    await page.goto(base + '?url=' + encodeURIComponent(url));
    await page.waitForFunction(() => document.querySelectorAll('.card svg, .card .vega-embed svg').length >= 2, null, { timeout: 90000 });

    // Ask a question through the real NL2SQL path
    const ask = page.locator('input[placeholder*="Ask"], textarea[placeholder*="Ask"]').first();
    await ask.fill('What was the highest close each quarter?');
    await ask.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => /quarter/i.test(c.textContent) && c.querySelector('svg')), null, { timeout: 60000 });
    await page.waitForTimeout(600);

    const info = await page.evaluate(() => ({
      cards: [...document.querySelectorAll('.card')].map((c) => ({ title: c.querySelector('h3,h2,.card-title')?.textContent?.trim(), svg: !!c.querySelector('svg'), err: /error|couldn/i.test(c.className + ' ' + (c.querySelector('.card-error,.error')?.textContent || '')) })),
      trace: [...document.querySelectorAll('[class*="trace"] li, .trace-item, .trace-event')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()).slice(0, 40),
      path: location.pathname,
      hscroll: document.scrollingElement.scrollWidth > innerWidth,
    }));
    await mkdir(join(here, 'screens'), { recursive: true });
    await page.screenshot({ path: join(here, `screens/full-${scheme}.png`), fullPage: true });
    results[scheme] = { ...info, errors };
    await page.close();
  }
  console.log(JSON.stringify({ calls, results }, null, 2));
  const r = results.light;
  assert.ok(calls.planner >= 1 && calls.repair >= 1 && calls.sql >= 1 && calls.viz >= 1, 'all LLM agents called');
  assert.ok(r.cards.filter((c) => c.svg).length >= 3, 'three rendered charts');
  assert.ok(r.trace.some((t) => /repair/i.test(t)), 'repair visible in trace');
  assert.deepEqual(r.errors, []);
  assert.equal(r.path, '/https://github.com/plotly/datasets/blob/master/2014_apple_stock.csv', 'the address is the app, then the link');
  console.log('FULL E2E PASSED');
} finally {
  await browser.close();
  server.close();
}
