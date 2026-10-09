import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHfUri, globToRegExp, globPrefix, hfResolveUrl, hfPageUrl, hfListGlob } from '../src/data/hf.js';
import { fetchGitHubFile, resolveRemoteFile, storageToHttps } from '../src/data/github.js';

const URI = 'hf://datasets/harvardMadsys/freeinference_agentic_trace/release/*/processed/sessions.parquet';

test('parseHfUri: kinds, revision, path', () => {
  assert.deepEqual(parseHfUri(URI), { kind: 'datasets', repo: 'harvardMadsys/freeinference_agentic_trace', rev: 'main', path: 'release/*/processed/sessions.parquet' });
  assert.equal(parseHfUri('hf://datasets/o/r@refs%2Fconvert%2Fparquet/x.parquet').rev, 'refs/convert/parquet');
  assert.equal(parseHfUri('hf://models/o/r/w.json').kind, 'models');
  assert.equal(parseHfUri('hf://datasets/o/r'), null);
  assert.equal(parseHfUri('https://huggingface.co/x'), null);
});

test('globToRegExp: * and ? stay in a segment, ** spans segments', () => {
  const re = globToRegExp('release/*/processed/sessions.parquet');
  assert.ok(re.test('release/2026-05-17_2026-05-23/processed/sessions.parquet'));
  assert.ok(!re.test('release/a/b/processed/sessions.parquet'));
  assert.ok(!re.test('release/a/processed/sessions_parquet'), 'dot is literal');
  const deep = globToRegExp('data/**/*.csv');
  assert.ok(deep.test('data/x.csv') && deep.test('data/a/b/x.csv') && !deep.test('other/x.csv'));
  assert.ok(globToRegExp('f?.csv').test('f1.csv') && !globToRegExp('f?.csv').test('f12.csv'));
  assert.equal(globPrefix('release/*/processed/s.parquet'), 'release');
  assert.equal(globPrefix('*.csv'), '');
});

test('hf URLs: resolve (download) and page (link)', () => {
  const src = parseHfUri('hf://datasets/o/r/dir/a b.parquet');
  assert.equal(hfResolveUrl(src), 'https://huggingface.co/datasets/o/r/resolve/main/dir/a%20b.parquet');
  assert.equal(hfPageUrl(src), 'https://huggingface.co/datasets/o/r/blob/main/dir/a%20b.parquet');
  assert.equal(hfPageUrl(parseHfUri(URI)), 'https://huggingface.co/datasets/harvardMadsys/freeinference_agentic_trace/tree/main/release');
  assert.equal(hfResolveUrl(parseHfUri('hf://models/o/r/w.json')), 'https://huggingface.co/o/r/resolve/main/w.json');
  assert.equal(storageToHttps('hf://datasets/o/r/x.csv'), 'https://huggingface.co/datasets/o/r/resolve/main/x.csv', 'single file maps to https');
  assert.equal(storageToHttps(URI), URI, 'globs are not single URLs');
});

// Hub mock: tree API (paginated by Link header) + resolve downloads
function hubFetch(files, { pageSize = 2 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const tree = /\/api\/datasets\/(.+?)\/tree\/main(?:\/(.*?))?\?recursive=true(?:&cursor=(\d+))?$/.exec(url);
    if (tree) {
      const entries = Object.keys(files).filter((p) => !tree[2] || p.startsWith(tree[2] + '/')).map((path) => ({ type: 'file', path, size: files[path].length }));
      entries.push({ type: 'directory', path: 'release' });
      const at = Number(tree[3] || 0);
      const headers = at + pageSize < entries.length ? { link: `<${url.replace(/&cursor=\d+$/, '')}&cursor=${at + pageSize}>; rel="next"` } : {};
      return new Response(JSON.stringify(entries.slice(at, at + pageSize)), { status: 200, headers });
    }
    const dl = /\/resolve\/main\/(.+)$/.exec(url);
    const body = dl && files[decodeURIComponent(dl[1])];
    return body != null ? new Response(body, { status: 200 }) : new Response('nf', { status: 404 });
  };
  return { impl, calls };
}

test('hfListGlob: follows pagination, filters by the glob, sorts', async () => {
  const { impl } = hubFetch({
    'release/w2/processed/sessions.parquet': 'PAR1b', 'release/w1/processed/sessions.parquet': 'PAR1a',
    'release/w1/processed/other.parquet': 'x', 'release/w1/raw/sessions.parquet': 'x',
  });
  const files = await hfListGlob(parseHfUri('hf://datasets/o/r/release/*/processed/sessions.parquet'), impl);
  assert.deepEqual(files.map((f) => f.path), ['release/w1/processed/sessions.parquet', 'release/w2/processed/sessions.parquet']);
});

test('fetchGitHubFile: hf:// glob downloads every match as parts', async () => {
  const { impl } = hubFetch({ 'release/w1/processed/sessions.parquet': 'PAR1a', 'release/w2/processed/sessions.parquet': 'PAR1bb' });
  const uri = 'hf://datasets/o/r/release/*/processed/sessions.parquet';
  const f = await fetchGitHubFile(uri, { fetchImpl: impl });
  assert.equal(f.format, 'parquet');
  assert.equal(f.fileName, 'sessions.parquet');
  assert.equal(f.fileCount, 2);
  assert.deepEqual(f.parts.map((p) => [p.path, p.bytes.length]), [['release/w1/processed/sessions.parquet', 5], ['release/w2/processed/sessions.parquet', 6]]);
  assert.equal(f.sizeBytes, 11);
  assert.deepEqual(f.source, { url: uri, host: 'huggingface.co', path: 'release/*/processed/sessions.parquet', page: 'https://huggingface.co/datasets/o/r/tree/main/release' });
  assert.equal(await resolveRemoteFile(uri, { fetchImpl: impl }), null, 'globs are downloaded, not read in place');
});

test('fetchGitHubFile: hf:// glob errors are friendly', async () => {
  const { impl } = hubFetch({ 'release/a.csv': 'x', 'release/b.parquet': 'y' });
  await assert.rejects(fetchGitHubFile('hf://datasets/o/r/release/*.json', { fetchImpl: impl }), /No files on Hugging Face match/);
  await assert.rejects(fetchGitHubFile('hf://datasets/o/r/release/*', { fetchImpl: impl }), /must all be one supported type/);
});

test('LIVE: hf:// glob lists the freeinference trace', { timeout: 30000 }, async () => {
  const files = await hfListGlob(parseHfUri(URI), globalThis.fetch);
  assert.ok(files.length >= 16, `${files.length} files`);
  assert.ok(files.every((f) => /^release\/[^/]+\/processed\/sessions\.parquet$/.test(f.path)));
});
