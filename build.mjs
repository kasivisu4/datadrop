// DataDrop build: esbuild bundle + copy static assets, DuckDB wasm/workers and Vega UMD into dist/.
//   node build.mjs            -> dist/
//   node build.mjs --minify   -> minified bundle
//   node build.mjs --stub     -> tests/ui-stubs/dist/, with src/data/* and src/agents/* swapped for tests/ui-stubs/*
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const stub = args.has('--stub');
const minify = args.has('--minify');
const outdir = stub ? path.join(root, 'tests/ui-stubs/dist') : path.join(root, 'dist');
const nm = (p) => path.join(root, 'node_modules', p);

// Redirect ../data/*.js and ../agents/*.js imports from src/ to the test stubs.
const stubPlugin = {
  name: 'ui-stubs',
  setup(build) {
    build.onResolve({ filter: /\/(data|agents)\/[\w-]+\.js$/ }, (a) => {
      if (!a.importer.startsWith(path.join(root, 'src'))) return;
      const m = a.path.match(/(data|agents)\/([\w-]+)\.js$/);
      const target = path.join(root, 'tests/ui-stubs', m[1], `${m[2]}.js`);
      return existsSync(target) ? { path: target } : undefined;
    });
  },
};

async function main() {
  const t0 = Date.now();
  await rm(outdir, { recursive: true, force: true });
  await mkdir(path.join(outdir, 'duckdb'), { recursive: true });
  await mkdir(path.join(outdir, 'vendor'), { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(root, 'src/main.js')],
    outfile: path.join(outdir, 'app.js'),
    bundle: true,
    format: 'esm',
    target: 'es2020',
    platform: 'browser',
    minify,
    sourcemap: !minify,
    logLevel: 'warning',
    // vega globals are provided by <script> tags; nothing to externalize for duckdb (bundled).
    plugins: stub ? [stubPlugin] : [],
  });

  await cp(path.join(root, 'public/index.html'), path.join(outdir, 'index.html'));
  await cp(path.join(root, 'src/ui/styles.css'), path.join(outdir, 'styles.css'));

  const duck = nm('@duckdb/duckdb-wasm/dist');
  for (const f of ['duckdb-eh.wasm', 'duckdb-mvp.wasm', 'duckdb-browser-eh.worker.js', 'duckdb-browser-mvp.worker.js']) {
    await cp(path.join(duck, f), path.join(outdir, 'duckdb', f));
  }
  for (const f of ['vega/build/vega.min.js', 'vega-lite/build/vega-lite.min.js', 'vega-embed/build/vega-embed.min.js']) {
    await cp(nm(f), path.join(outdir, 'vendor', path.basename(f)));
  }
  console.log(`built ${path.relative(root, outdir) || '.'}/ in ${Date.now() - t0}ms${stub ? ' (stub)' : ''}${minify ? ' (minified)' : ''}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
