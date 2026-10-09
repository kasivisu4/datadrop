import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGitHubUrl, rawUrl, lfsMediaUrl, detectFormat, isLfsPointer, fetchGitHubFile, tableNameFor, resolveRemoteFile, storageToHttps,
} from '../src/data/github.js';

const enc = (s) => new TextEncoder().encode(s);

test('parseGitHubUrl: blob URL', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/plotly/datasets/blob/master/2014_apple_stock.csv'), {
    owner: 'plotly', repo: 'datasets', ref: 'master', path: '2014_apple_stock.csv', kind: 'blob',
  });
});

test('parseGitHubUrl: nested path, query and hash stripped', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/o/r/blob/main/data/sub/x.csv?plain=1#L10'), {
    owner: 'o', repo: 'r', ref: 'main', path: 'data/sub/x.csv', kind: 'blob',
  });
});

test('parseGitHubUrl: raw.githubusercontent', () => {
  assert.deepEqual(parseGitHubUrl('https://raw.githubusercontent.com/o/r/main/a/b.parquet?token=abc'), {
    owner: 'o', repo: 'r', ref: 'main', path: 'a/b.parquet', kind: 'raw',
  });
  assert.equal(parseGitHubUrl('https://raw.githubusercontent.com/o/r/refs/heads/dev/a.csv').ref, 'dev');
});

test('parseGitHubUrl: /raw/ form and SHA ref', () => {
  const sha = '3f2a9c1d0b8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a';
  assert.deepEqual(parseGitHubUrl(`https://github.com/o/r/raw/${sha}/x.json`), {
    owner: 'o', repo: 'r', ref: sha, path: 'x.json', kind: 'raw',
  });
});

test('parseGitHubUrl: hash-route forms and no scheme', () => {
  const want = { owner: 'o', repo: 'r', ref: 'main', path: 'd/x.tsv', kind: 'blob' };
  assert.deepEqual(parseGitHubUrl('o/r/blob/main/d/x.tsv'), want);
  assert.deepEqual(parseGitHubUrl('#/o/r/blob/main/d/x.tsv'), want);
  assert.deepEqual(parseGitHubUrl('/o/r/blob/main/d/x.tsv?x=1'), want);
  assert.deepEqual(parseGitHubUrl('github.com/o/r/blob/main/d/x.tsv'), want);
  assert.deepEqual(parseGitHubUrl('https://www.github.com/o/r/blob/main/d/x.tsv'), want);
});

test('parseGitHubUrl: percent-encoded path decoded', () => {
  assert.equal(parseGitHubUrl('https://github.com/o/r/blob/main/my%20file.csv').path, 'my file.csv');
});

test('parseGitHubUrl: tree and invalid', () => {
  assert.equal(parseGitHubUrl('https://github.com/o/r/tree/main/data').kind, 'tree');
  assert.equal(parseGitHubUrl('https://github.com/o/r'), null);
  assert.equal(parseGitHubUrl('https://gitlab.com/o/r/blob/main/x.csv'), null);
  assert.equal(parseGitHubUrl('https://github.com/o/r/issues/1/x'), null);
  assert.equal(parseGitHubUrl(''), null);
  assert.equal(parseGitHubUrl(null), null);
});

test('rawUrl / lfsMediaUrl', () => {
  const s = { owner: 'o', repo: 'r', ref: 'main', path: 'a/my file.csv' };
  assert.equal(rawUrl(s), 'https://raw.githubusercontent.com/o/r/main/a/my%20file.csv');
  assert.equal(lfsMediaUrl(s), 'https://media.githubusercontent.com/media/o/r/main/a/my%20file.csv');
});

test('detectFormat', () => {
  assert.equal(detectFormat('a/b.csv'), 'csv');
  assert.equal(detectFormat('B.CSV'), 'csv');
  assert.equal(detectFormat('x.tsv'), 'tsv');
  assert.equal(detectFormat('x.json'), 'json');
  assert.equal(detectFormat('x.jsonl'), 'ndjson');
  assert.equal(detectFormat('x.ndjson'), 'ndjson');
  assert.equal(detectFormat('x.parquet'), 'parquet');
  assert.equal(detectFormat('x.csv?raw=1'), 'csv');
  assert.equal(detectFormat('x.xlsx'), null);
  assert.equal(detectFormat('README'), null);
});

test('tableNameFor', () => {
  assert.equal(tableNameFor('data/Sales 2024.csv'), 'sales_2024');
  assert.equal(tableNameFor('2014_apple_stock.csv'), 't_2014_apple_stock');
  assert.equal(tableNameFor('weird--name!!.json'), 'weird_name');
  assert.equal(tableNameFor('x.tar.gz'), 'x_tar');
  assert.equal(tableNameFor('...csv'), 'data');
  assert.match(tableNameFor('a'.repeat(200) + '.csv'), /^a{63}$/);
});

test('isLfsPointer', () => {
  assert.equal(isLfsPointer(enc('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n')), true);
  assert.equal(isLfsPointer(enc('a,b\n1,2\n')), false);
  assert.equal(isLfsPointer(new Uint8Array()), false);
});

function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) return new Response('Not Found', { status: 404 });
    return new Response(r, { status: 200 });
  };
  return { impl, calls };
}

test('fetchGitHubFile: plain file', async () => {
  const { impl, calls } = mockFetch({ 'https://raw.githubusercontent.com/o/r/main/d/x.csv': 'a,b\n1,2\n' });
  const f = await fetchGitHubFile('https://github.com/o/r/blob/main/d/x.csv', { fetchImpl: impl });
  assert.equal(f.format, 'csv');
  assert.equal(f.fileName, 'x.csv');
  assert.equal(f.sizeBytes, 8);
  assert.deepEqual(f.source, { owner: 'o', repo: 'r', ref: 'main', path: 'd/x.csv' });
  assert.equal(new TextDecoder().decode(f.bytes), 'a,b\n1,2\n');
  assert.equal(calls.length, 1);
});

test('fetchGitHubFile: follows LFS pointer', async () => {
  const { impl, calls } = mockFetch({
    'https://raw.githubusercontent.com/o/r/main/big.parquet': 'version https://git-lfs.github.com/spec/v1\noid sha256:x\nsize 4\n',
    'https://media.githubusercontent.com/media/o/r/main/big.parquet': 'PAR1',
  });
  const f = await fetchGitHubFile('o/r/blob/main/big.parquet', { fetchImpl: impl });
  assert.equal(new TextDecoder().decode(f.bytes), 'PAR1');
  assert.equal(f.url, 'https://media.githubusercontent.com/media/o/r/main/big.parquet');
  assert.equal(calls.length, 2);
});

test('fetchGitHubFile: non-GitHub https URL is fetched directly', async () => {
  const url = 'https://pub-x.r2.dev/data/nyc-rides-2010.parquet';
  const { impl, calls } = mockFetch({ [url]: 'PAR1' });
  const f = await fetchGitHubFile(`${url}`, { fetchImpl: impl });
  assert.equal(f.format, 'parquet');
  assert.equal(f.fileName, 'nyc-rides-2010.parquet');
  assert.deepEqual(f.source, { url, host: 'pub-x.r2.dev', path: 'data/nyc-rides-2010.parquet' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, url);
  await assert.rejects(fetchGitHubFile('https://pub-x.r2.dev/missing.csv', { fetchImpl: impl }), /not found/i);
});

test('fetchGitHubFile: 404 gives friendly error', async () => {
  const { impl } = mockFetch({});
  await assert.rejects(fetchGitHubFile('https://github.com/o/r/blob/main/nope.csv', { fetchImpl: impl }), /not found/i);
});

test('fetchGitHubFile: unsupported format / bad URL / folder', async () => {
  const { impl, calls } = mockFetch({});
  await assert.rejects(fetchGitHubFile('https://github.com/o/r/blob/main/x.xlsx', { fetchImpl: impl }), /Unsupported file type/);
  await assert.rejects(fetchGitHubFile('not a url', { fetchImpl: impl }), /Not a recognised/);
  await assert.rejects(fetchGitHubFile('ftp://example.com/x.csv', { fetchImpl: impl }), /Not a recognised/);
  await assert.rejects(fetchGitHubFile('https://example.com/x.xlsx', { fetchImpl: impl }), /Unsupported file type/);
  await assert.rejects(fetchGitHubFile('https://github.com/o/r/tree/main/data', { fetchImpl: impl }), /folder/);
  assert.equal(calls.length, 0);
});

test('fetchGitHubFile: too large via content-length', async () => {
  const impl = async () => new Response('x', { status: 200, headers: { 'content-length': String(300 * 1024 * 1024) } });
  await assert.rejects(fetchGitHubFile('o/r/blob/main/x.csv', { fetchImpl: impl }), /too large/);
});

test('fetchGitHubFile: token uses contents API', async () => {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return new Response('a\n1\n'); };
  await fetchGitHubFile('o/r/blob/dev/d/x.csv', { fetchImpl: impl, token: 'tkn' });
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/contents/d/x.csv?ref=dev');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tkn');
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github.raw');
});

test('LIVE: fetch plotly 2014_apple_stock.csv', { timeout: 30000 }, async () => {
  const f = await fetchGitHubFile('https://github.com/plotly/datasets/blob/master/2014_apple_stock.csv');
  assert.equal(f.format, 'csv');
  assert.ok(f.sizeBytes > 1000);
  const head = new TextDecoder().decode(f.bytes.slice(0, 40));
  assert.match(head, /AAPL_x/);
});

// Serves `files` with Range support (206 + content-range), like R2/S3/raw.githubusercontent.com.
function rangeFetch(files, { ranges = true } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const body = files[url];
    if (body == null) return new Response('Not Found', { status: 404 });
    const m = /^bytes=(\d+)-(\d+)$/.exec(init?.headers?.Range || '');
    if (!m || !ranges) return new Response(body, { status: 200 });
    const part = body.slice(Number(m[1]), Number(m[2]) + 1);
    return new Response(part, { status: 206, headers: { 'content-range': `bytes ${m[1]}-${m[2]}/${body.length}` } });
  };
  return { impl, calls };
}

test('resolveRemoteFile: parquet with range support is read in place', async () => {
  const url = 'https://pub-x.r2.dev/data/rides.parquet';
  const { impl, calls } = rangeFetch({ [url]: 'PAR1' + 'x'.repeat(96) });
  const r = await resolveRemoteFile(url, { fetchImpl: impl });
  assert.deepEqual(r, { url, format: 'parquet', fileName: 'rides.parquet', source: { url, host: 'pub-x.r2.dev', path: 'data/rides.parquet' }, sizeBytes: 100 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Range, 'bytes=0-3');
});

test('resolveRemoteFile: GitHub LFS pointer falls through to the media URL', async () => {
  const raw = 'https://raw.githubusercontent.com/o/r/main/big.parquet';
  const media = 'https://media.githubusercontent.com/media/o/r/main/big.parquet';
  const { impl } = rangeFetch({ [raw]: 'version https://git-lfs.github.com/spec/v1\n', [media]: 'PAR1....' });
  const r = await resolveRemoteFile('https://github.com/o/r/blob/main/big.parquet', { fetchImpl: impl });
  assert.equal(r.url, media);
  assert.deepEqual(r.source, { owner: 'o', repo: 'r', ref: 'main', path: 'big.parquet' });
});

test('resolveRemoteFile: null (full download) for CSV, no range support, a token or a 404', async () => {
  const pq = 'https://h.example/x.parquet';
  const { impl, calls } = rangeFetch({ 'https://h.example/x.csv': 'a,b\n', [pq]: 'PAR1....' });
  assert.equal(await resolveRemoteFile('https://h.example/x.csv', { fetchImpl: impl }), null);
  assert.equal(calls.length, 0); // CSV never probed
  assert.equal(await resolveRemoteFile(pq, { fetchImpl: impl, token: 't' }), null);
  assert.equal(await resolveRemoteFile('https://h.example/missing.parquet', { fetchImpl: impl }), null);
  assert.equal(await resolveRemoteFile(pq, { fetchImpl: rangeFetch({ [pq]: 'PAR1....' }, { ranges: false }).impl }), null);
});

test('storageToHttps: s3:// and gs:// map to public https endpoints', () => {
  assert.equal(storageToHttps('s3://harvardsys-datasets/2026_chutes_anonymized/chutes_trace.parquet'),
    'https://harvardsys-datasets.s3.amazonaws.com/2026_chutes_anonymized/chutes_trace.parquet');
  assert.equal(storageToHttps('s3://my.dotted.bucket/a b/x.csv'), 'https://s3.amazonaws.com/my.dotted.bucket/a%20b/x.csv');
  assert.equal(storageToHttps('gs://bkt/dir/x.parquet'), 'https://storage.googleapis.com/bkt/dir/x.parquet');
  assert.equal(storageToHttps('https://example.com/x.csv'), 'https://example.com/x.csv');
  assert.equal(storageToHttps('s3://bucket-only'), 's3://bucket-only');
});

test('s3:// URIs load like https links (download and in-place parquet)', async () => {
  const https = 'https://b.s3.amazonaws.com/d/x.csv';
  const { impl, calls } = mockFetch({ [https]: 'a\n1\n' });
  const f = await fetchGitHubFile('s3://b/d/x.csv', { fetchImpl: impl });
  assert.equal(calls[0].url, https);
  assert.equal(f.source.url, https);
  const pq = 'https://b.s3.amazonaws.com/d/x.parquet';
  const r = await resolveRemoteFile('s3://b/d/x.parquet', { fetchImpl: rangeFetch({ [pq]: 'PAR1....' }).impl });
  assert.equal(r.url, pq);
  await assert.rejects(fetchGitHubFile('s3://bucket-only', { fetchImpl: impl }), /Not a recognised.*s3:\/\//);
});
