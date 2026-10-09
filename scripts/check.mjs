// Runs the test gates with the independent tiers in parallel.
//   node scripts/check.mjs          unit + stubbed UI + real build        (npm run check)
//   node scripts/check.mjs --full   also the DuckDB harness + full stack  (npm run check:full)
// Builds first (they write different folders), then every tier at once. Each tier's output is printed when it ends,
// with its time; the exit code is non-zero if any tier failed. The old one-after-another run is `npm run check:serial`.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const full = process.argv.includes('--full');
const node = process.execPath;

function run(name, args) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(node, args, { cwd: root, env: process.env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ name, code, out, ms: Date.now() - t0 }));
  });
}

const summary = (r) => r.out.split('\n').filter((l) => /^(ℹ (pass|fail)|FAIL|all UI|ALL DUCK|FULL E2E|not ok)|AssertionError|Error:/.test(l) || /^\s{5}\S/.test(l)).join('\n');
function show(r) {
  console.log(`\n=== ${r.name}: ${r.code === 0 ? 'PASS' : 'FAIL'} (${(r.ms / 1000).toFixed(1)} s) ===`);
  console.log(r.code === 0 ? summary(r) : r.out.trim().split('\n').slice(-60).join('\n'));
}

const t0 = Date.now();
// the stub build (UI tests) and the real build (dist, full-stack tests) write different folders
const builds = await Promise.all([run('build:stub', ['build.mjs', '--stub']), run('build', ['build.mjs'])]);
const failedBuild = builds.filter((b) => b.code !== 0);
if (failedBuild.length) { failedBuild.forEach(show); process.exit(1); }

const tiers = [
  run('unit (tier 1)', ['--test', ...await listUnitTests()]),
  run('stubbed UI (tier 2)', ['tests/ui.e2e.mjs']),
];
if (full) {
  tiers.push(run('DuckDB harness (tier 3)', ['tests/duck.e2e.mjs']));
  tiers.push(run('full stack (tier 4)', ['tests/full.e2e.mjs']));
}
const results = [];
for (const t of tiers) t.then((r) => { results.push(r); show(r); });
await Promise.all(tiers);

const bad = results.filter((r) => r.code !== 0 || /^FAIL /m.test(r.out));
console.log(`\n${bad.length ? 'FAILED' : 'ALL PASSED'}: ${results.map((r) => `${r.name} ${r.code === 0 ? 'ok' : 'FAIL'}`).join(' · ')}  (${((Date.now() - t0) / 1000).toFixed(1)} s total)`);
process.exit(bad.length ? 1 : 0);

async function listUnitTests() {
  const { readdir } = await import('node:fs/promises');
  return (await readdir(path.join(root, 'tests'))).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join('tests', f));
}
