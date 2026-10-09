// Bundles tests/duck-harness/harness.js and copies DuckDB wasm/worker files into tests/duck-harness/out/.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const harness = join(root, 'tests/duck-harness');
const out = join(harness, 'out');
mkdirSync(join(out, 'duckdb'), { recursive: true });

await build({
  entryPoints: [join(harness, 'harness.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: join(out, 'harness.bundle.js'),
  logLevel: 'warning',
});

const dist = join(root, 'node_modules/@duckdb/duckdb-wasm/dist');
for (const f of ['duckdb-eh.wasm', 'duckdb-mvp.wasm', 'duckdb-browser-eh.worker.js', 'duckdb-browser-mvp.worker.js']) {
  copyFileSync(join(dist, f), join(out, 'duckdb', f));
}
writeFileSync(join(out, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>duck harness</title><script type="module" src="./harness.bundle.js"></script>\n');
console.log('built', out);
