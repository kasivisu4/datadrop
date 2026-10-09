import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnsInSql, unionColumns, splitGroups } from '../src/data/workset.js';
import { heuristicCharts } from '../src/agents/pipeline.js';
import { withStarts } from '../src/data/sample.js';

const COLS = ['invocation_id', 'function_name', 'chute_id', 'started_at', 'it', 'ot', 'ct', 'My Col', 'ttft'];

test('columnsInSql: quoted and bare identifiers, whole words only', () => {
  assert.deepEqual(columnsInSql('SELECT "function_name", count(*) FROM "t" GROUP BY 1', COLS), ['function_name']);
  assert.deepEqual(columnsInSql('select it, ot from t where it > 0', COLS), ['it', 'ot']);
  assert.deepEqual(columnsInSql('SELECT "My Col" FROM t', COLS), ['My Col']);
  assert.deepEqual(columnsInSql('SELECT ttft_avg FROM t', COLS), [], 'ttft_avg is not ttft');
  assert.deepEqual(columnsInSql('SELECT "it_x" FROM t', COLS), [], 'quoted it_x is not it');
});

test('columnsInSql: ignores string literals and comments; * means every column; count(*) does not', () => {
  assert.deepEqual(columnsInSql("SELECT count(*) FROM t WHERE function_name = 'chute_id ot' -- it\n", COLS), ['function_name']);
  assert.deepEqual(columnsInSql('SELECT * FROM t LIMIT 5', COLS), COLS);
  assert.deepEqual(columnsInSql('SELECT t.* FROM t', COLS, 't'), COLS);
  assert.deepEqual(columnsInSql('SELECT a.* FROM "t" AS a', COLS, 't'), COLS, 'alias of the table');
  assert.deepEqual(columnsInSql('SELECT a.* FROM "t" a WHERE a.it > 0', COLS, 't'), COLS, 'alias without AS');
  assert.deepEqual(columnsInSql('WITH e AS (SELECT min(it) lo FROM t) SELECT e.*, ot FROM t, e', COLS, 't'), ['it', 'ot'], 'x.* on a CTE is not the table');
  assert.deepEqual(columnsInSql('SELECT it FROM t WHERE ot > 1 GROUP BY 1', COLS, 't'), ['it', 'ot'], 'WHERE is not an alias');
  assert.deepEqual(columnsInSql('DESCRIBE t', COLS), COLS);
  assert.deepEqual(columnsInSql('SELECT count(*) AS n FROM t', COLS), []);
});

test('unionColumns: the heuristic dashboard for the chutes shape needs 4 of its columns', () => {
  const col = (name, kind, bytesPerRow, type) => ({ name, type: type || (kind === 'quantitative' ? 'FLOAT' : 'VARCHAR'), kind, nullPct: 0, distinct: null, min: kind === 'temporal' ? '1970-03-01T00:00:00Z' : null, max: kind === 'temporal' ? '1970-11-11T00:00:00Z' : null, bytesPerRow });
  const columns = [col('invocation_id', 'quantitative', 1.0, 'BIGINT'), col('function_name', 'nominal', 0.22), col('rehash_round', 'quantitative', 0.0002, 'INTEGER'),
    col('started_at', 'temporal', 2.2, 'TIMESTAMP'), col('it', 'quantitative', 1.9), col('ot', 'quantitative', 1.5), col('user_id', 'nominal', 1.0)];
  const plans = heuristicCharts({ table: 'chutes', rowCount: 5e6, sample: [], remote: true, columns });
  assert.deepEqual(unionColumns(plans.map((p) => p.sql), columns.map((c) => c.name), 'chutes'), ['function_name', 'started_at', 'it', 'ot']);
});

test('splitGroups: n parts of about equal rows, in file order, no empty parts', () => {
  const g = withStarts([100, 100, 100, 100, 100].map((rows, id) => ({ id, rows })));
  assert.deepEqual(splitGroups(g, 4).map((p) => p.map((x) => x.id)), [[0, 1], [2], [3], [4]]);
  assert.deepEqual(splitGroups(g, 1).map((p) => p.length), [5]);
  assert.deepEqual(splitGroups(g.slice(0, 2), 4).map((p) => p.map((x) => x.id)), [[0], [1]]);
  assert.deepEqual(splitGroups([], 3), []);
});
