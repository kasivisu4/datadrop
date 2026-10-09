import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, coverage, caveats, explainCard } from '../src/agents/explain.js';
import { heuristicCharts } from '../src/agents/pipeline.js';
import { sqlPrompt } from '../src/agents/prompts.js';

const col = (name, type, kind, extra = {}) => ({ name, type, kind, ...extra });
const bank = {
  table: 'bank', rowCount: 50000,
  columns: [
    col('txn_id', 'VARCHAR', 'nominal', { distinct: 47000, nullPct: 0 }),
    col('account_number', 'BIGINT', 'quantitative', { distinct: 7, min: 4010, max: 4090, nullPct: 0 }),
    col('posted_at', 'TIMESTAMP', 'temporal', { distinct: 48000, min: '2025-01-01', max: '2025-12-14', nullPct: 2 }),
    col('amount', 'DOUBLE', 'quantitative', { distinct: 36000, min: -898, max: 4999, nullPct: 0.5 }),
    col('balance', 'DOUBLE', 'quantitative', { distinct: 50000, min: 8708, max: 13900000, nullPct: 0 }),
    col('status', 'VARCHAR', 'nominal', { distinct: 4, nullPct: 0 }),
    col('type', 'VARCHAR', 'nominal', { distinct: 2, nullPct: 0 }),
  ],
};

test('describe: one true sentence per built-in chart, from its drill descriptor', () => {
  const plans = Object.fromEntries(heuristicCharts(bank).map((p) => [p.title, p]));
  assert.equal(describe(plans['amount by month'].drill), 'Adds up amount for each month of posted_at.');
  assert.equal(describe(plans['Top type by count'].drill), 'Counts the rows for each type, showing the 9 most common and grouping the rest as "Other".');
  assert.equal(describe(plans['amount by status'].drill), 'Adds up amount for each status, biggest first, up to 15 groups.');
  assert.equal(describe(plans['Distribution of amount'].drill), 'Splits amount into 20 ranges and counts the rows in each.');
  assert.match(describe(plans['Distribution of amount'].drill, [{ x_scale: 'log' }]), /log scale because the values are very skewed/);
  assert.equal(describe(null), null);
});

test('describe: averages and the two-measure grid', () => {
  const avg = heuristicCharts({ table: 'a', rowCount: 400, sample: [], columns: [col('day', 'DATE', 'temporal', { distinct: 400, min: '2025-01-01', max: '2026-02-04' }), col('balance', 'DOUBLE', 'quantitative', { distinct: 400, min: 1, max: 9 })] })[0];
  assert.equal(describe(avg.drill), 'Averages balance for each month of day.');
  const dense = heuristicCharts({ table: 'g', rowCount: 9000, sample: [], columns: [col('a', 'DOUBLE', 'quantitative', { distinct: 9000, min: 0, max: 5 }), col('b', 'DOUBLE', 'quantitative', { distinct: 9000, min: 0, max: 5 })] }).find((p) => /vs/.test(p.title));
  assert.equal(describe(dense.drill), 'Splits a and b into a 30 × 30 grid and counts the rows in each cell.');
});

test('coverage: all rows, or the sample and how it was picked', () => {
  assert.equal(coverage({ rowCount: 50000 }), 'Uses all 50,000 rows.');
  assert.equal(coverage({ rowCount: 5007360, totalRows: 6122413756, sampleInfo: { mode: 'spread' } }),
    'This reads a sample: 5,007,360 of 6,122,413,756 rows, spread evenly across the file. Totals describe the sample, not the whole file.');
  assert.match(coverage({ rowCount: 10, totalRows: 100, sampleInfo: { mode: 'window' } }), /a consecutive stretch of the file/);
  assert.equal(coverage(null), null);
});

test('caveats: empty values left out, averages explained', () => {
  const plans = Object.fromEntries(heuristicCharts(bank).map((p) => [p.title, p]));
  const c = caveats(plans['amount by month'].drill, bank);
  assert.ok(c.some((x) => /About 1,000 rows have no posted_at, so they are left out of the groups/.test(x)), c.join(' | '));
  assert.ok(c.some((x) => /250 rows have no amount; they add nothing to the result/.test(x)), c.join(' | '));
  const avg = caveats({ dims: [], measure: { fn: 'AVG', column: 'balance' } }, bank);
  assert.match(avg.join(' '), /Averaged, not added up: balance is a level/);
  assert.deepEqual(caveats(null, bank), []);
});

test('explainCard: built-in chart = rules; AI answer = its own sentence + assumptions + our coverage', () => {
  const plan = heuristicCharts(bank).find((p) => p.title === 'amount by status');
  const rules = explainCard({ drill: plan.drill, rows: [] }, bank);
  assert.equal(rules.source, 'rules');
  assert.equal(rules.how, 'Adds up amount for each status, biggest first, up to 15 groups.');
  assert.equal(rules.coverage, 'Uses all 50,000 rows.');
  const ai = explainCard({ rationale: ' Adds up the amount of completed payments. ', assumptions: ['"Revenue" means amount.', '', 'Refunds are included.'] }, bank);
  assert.equal(ai.source, 'ai');
  assert.equal(ai.how, 'Adds up the amount of completed payments.');
  assert.deepEqual(ai.assumptions, ['"Revenue" means amount.', 'Refunds are included.']);
  const sampled = explainCard({ rationale: 'x' }, { ...bank, rowCount: 5, totalRows: 50 });
  assert.match(sampled.coverage, /This reads a sample/);
  assert.equal(explainCard(null, bank), null);
  assert.equal(explainCard({}, null), null);
  assert.equal(explainCard({ assumptions: ['a', 'b', 'c', 'd', 'e', 'f'] }, null).assumptions.length, 4, 'at most four assumptions');
});

test('the SQL prompt asks for a plain sentence and assumptions, and replays them in follow-ups', () => {
  const { system, messages } = sqlPrompt(bank, 'revenue by status', [{ question: 'q1', sql: 'SELECT 1', rationale: 'r1', assumptions: ['a1'] }]);
  assert.match(system, /"assumptions":string\[\]/);
  assert.match(system, /ONE plain sentence/);
  assert.match(system, /Never invent facts about the data/);
  assert.ok(messages.some((m) => m.role === 'assistant' && m.content.includes('"assumptions":["a1"]')));
});
