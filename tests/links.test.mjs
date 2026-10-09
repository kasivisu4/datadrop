import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINK_SOURCES, linkSourceFor, shareLinkToDirect, sniffFormat } from '../src/data/links.js';
import { fetchGitHubFile, resolveRemoteFile } from '../src/data/github.js';

const enc = (s) => new TextEncoder().encode(s);
const direct = (s) => { const r = shareLinkToDirect(s); return { id: r.source.id, url: r.url, fileName: r.fileName, format: r.format }; };

test('Google Drive: every share-link shape -> drive.usercontent download (CORS + Range)', () => {
  const want = 'https://drive.usercontent.google.com/download?id=1AbC_d-9&export=download&confirm=t';
  assert.equal(direct('https://drive.google.com/file/d/1AbC_d-9/view?usp=sharing').url, want);
  assert.equal(direct('https://drive.google.com/file/d/1AbC_d-9/edit').url, want);
  assert.equal(direct('https://drive.google.com/open?id=1AbC_d-9').url, want);
  assert.equal(direct('https://drive.google.com/uc?export=download&id=1AbC_d-9').url, want);
  assert.match(direct('https://drive.google.com/file/d/X/view?resourcekey=0-k').url, /&resourcekey=0-k$/);
  assert.equal(direct('https://drive.google.com/file/d/X/view').format, undefined, 'format comes from the bytes');
  assert.throws(() => shareLinkToDirect('https://drive.google.com/drive/folders/abc'), /folder/);
  assert.throws(() => shareLinkToDirect('https://docs.google.com/document/d/abc/edit'), /aren't data files/);
});

test('Google Sheets: the open tab exported as CSV; published sheets too', () => {
  assert.deepEqual(direct('https://docs.google.com/spreadsheets/d/SID/edit#gid=42'),
    { id: 'gsheets', url: 'https://docs.google.com/spreadsheets/d/SID/export?format=csv&gid=42', fileName: 'google_sheet.csv', format: 'csv' });
  assert.equal(direct('https://docs.google.com/spreadsheets/d/SID/edit?usp=sharing').url, 'https://docs.google.com/spreadsheets/d/SID/export?format=csv');
  assert.equal(direct('https://docs.google.com/spreadsheets/d/e/2PACX-x/pubhtml?gid=7').url, 'https://docs.google.com/spreadsheets/d/e/2PACX-x/pub?output=csv&gid=7');
});

test('Dropbox: www.dropbox.com (no CORS) -> dl.dropboxusercontent.com, keeps rlkey; folders refused', () => {
  assert.deepEqual(direct('https://www.dropbox.com/scl/fi/ab12/sales%202024.csv?rlkey=zz&dl=0'),
    { id: 'dropbox', url: 'https://dl.dropboxusercontent.com/scl/fi/ab12/sales%202024.csv?rlkey=zz', fileName: 'sales 2024.csv', format: undefined });
  assert.equal(direct('https://www.dropbox.com/s/ab12/x.parquet?dl=1').url, 'https://dl.dropboxusercontent.com/s/ab12/x.parquet');
  assert.throws(() => shareLinkToDirect('https://www.dropbox.com/scl/fo/ab12/xyz?rlkey=1'), /folder/);
});

test('OneDrive: shares API with the base64url-encoded link; SharePoint gets download=1', () => {
  const r = direct('https://1drv.ms/u/s!AbCd?e=x');
  const b64 = Buffer.from('https://1drv.ms/u/s!AbCd?e=x').toString('base64url');
  assert.equal(r.url, `https://api.onedrive.com/v1.0/shares/u!${b64}/root/content`);
  assert.equal(direct('https://onedrive.live.com/?cid=1&resid=2').id, 'onedrive');
  assert.equal(direct('https://contoso.sharepoint.com/:x:/g/personal/a/Eab?e=1').url, 'https://contoso.sharepoint.com/:x:/g/personal/a/Eab?e=1&download=1');
});

test('code hosts: Gist, GitLab (files API, has CORS), Bitbucket, Hugging Face pages', () => {
  assert.deepEqual(direct('https://gist.github.com/curran/a08a1080'), { id: 'gist', url: 'https://gist.githubusercontent.com/curran/a08a1080/raw', fileName: 'gist_a08a1080', format: undefined });
  assert.equal(direct('https://gist.github.com/u/id1/raw/iris.csv').fileName, 'iris.csv');
  assert.deepEqual(direct('https://gitlab.com/g/sub/proj/-/blob/main/data/a%20b.csv'),
    { id: 'gitlab', url: 'https://gitlab.com/api/v4/projects/g%2Fsub%2Fproj/repository/files/data%2Fa%20b.csv/raw?ref=main', fileName: 'a b.csv', format: undefined });
  assert.match(direct('https://git.example.org/team/p/-/raw/v1/x.csv').url, /^https:\/\/git\.example\.org\/api\/v4\/projects\/team%2Fp\//, 'self-hosted GitLab');
  assert.equal(direct('https://bitbucket.org/w/r/src/main/d/x.csv').url, 'https://bitbucket.org/w/r/raw/main/d/x.csv');
  assert.equal(direct('https://huggingface.co/datasets/o/r/blob/main/d/x.parquet').url, 'https://huggingface.co/datasets/o/r/resolve/main/d/x.parquet');
  assert.throws(() => shareLinkToDirect('https://app.box.com/s/xyz'), /Direct link/);
});

test('links that need no rewriting', () => {
  for (const s of ['https://github.com/o/r/blob/main/a.csv', 's3://b/k.parquet', 'https://x.r2.dev/a.csv', 'https://example.com/a.csv', 'hf://datasets/o/r/a.csv', '']) {
    assert.equal(shareLinkToDirect(s), null, s);
  }
});

test('linkSourceFor: each link gets its own help; every source has a name, example and how-to', () => {
  const ids = (xs) => xs.map((s) => linkSourceFor(s)?.id);
  assert.deepEqual(ids(['https://github.com/o/r/blob/m/a.csv', 'o/r/blob/m/a.csv', 's3://b/k', 'gs://b/k', 'https://b.s3.us-east-2.amazonaws.com/k', 'https://pub-1.r2.dev/a', 'https://acct.blob.core.windows.net/c/a.csv', 'hf://datasets/o/r/x', 'https://example.com/a', '  ']),
    ['github', 'github', 'storage', 'storage', 'storage', 'storage', 'storage', 'hf', 'web', undefined]);
  for (const s of LINK_SOURCES) assert.ok(s.name && s.example && s.howTo, s.id);
});

test('sniffFormat', () => {
  assert.equal(sniffFormat(enc('PAR1....')), 'parquet');
  assert.equal(sniffFormat(enc('\uFEFFa,b\n1,2\n')), 'csv');
  assert.equal(sniffFormat(enc('a\tb\tc\n1\t2\t3\n')), 'tsv');
  assert.equal(sniffFormat(enc('  [{"a":1}]')), 'json');
  assert.equal(sniffFormat(enc('{"a":1}\n{"a":2}\n')), 'ndjson');
  assert.equal(sniffFormat(enc('{"a":[1,\n2]}')), 'json');
  assert.equal(sniffFormat(enc('<!DOCTYPE html><html>')), 'html');
  assert.equal(sniffFormat(new Uint8Array([0x50, 0x4b, 3, 4])), 'zip');
  assert.equal(sniffFormat(new Uint8Array([0, 1, 2, 3, 4])), null);
});

const respond = (body, status = 200, headers = {}) => ({ ok: status < 300, status, headers: new Headers(headers), arrayBuffer: async () => (typeof body === 'string' ? enc(body) : body).buffer });

test('fetchGitHubFile: Drive file without a name -> format sniffed, share link kept as the source', async () => {
  const seen = [];
  const r = await fetchGitHubFile('https://drive.google.com/file/d/1XyZ/view?usp=sharing', { fetchImpl: async (u) => { seen.push(u); return respond('a,b\n1,2\n'); } });
  assert.deepEqual(seen, ['https://drive.usercontent.google.com/download?id=1XyZ&export=download&confirm=t']);
  assert.equal(r.format, 'csv');
  assert.equal(r.fileName, 'google_drive_1XyZ.csv');
  assert.deepEqual(r.source, { url: 'https://drive.google.com/file/d/1XyZ/view?usp=sharing', host: 'drive.usercontent.google.com', path: 'google_drive_1XyZ.csv', provider: 'Google Drive', page: 'https://drive.google.com/file/d/1XyZ/view?usp=sharing' });
});

test('fetchGitHubFile: share-link failures explain what to do for that provider', async () => {
  const html = async () => respond('<!doctype html><html>Sign in</html>');
  await assert.rejects(fetchGitHubFile('https://docs.google.com/spreadsheets/d/S/edit', { fetchImpl: html }), /web page instead of a data file from Google Sheets.*Anyone with the link/);
  await assert.rejects(fetchGitHubFile('https://drive.google.com/file/d/S/view', { fetchImpl: async () => respond('', 403) }), /Access denied from Google Drive \(HTTP 403\)/);
  await assert.rejects(fetchGitHubFile('https://1drv.ms/u/s!x', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /Couldn't download the file from OneDrive.*drop it here/);
  await assert.rejects(fetchGitHubFile('https://example.com/data', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /CORS/);
  await assert.rejects(fetchGitHubFile('https://drive.google.com/file/d/S/view', { fetchImpl: async () => respond(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])) }), /\.zip or Excel/);
  await assert.rejects(fetchGitHubFile('https://www.dropbox.com/s/a/x.xlsx?dl=0', { fetchImpl: async () => assert.fail('no download for a known non-data extension') }), /a spreadsheet: export it as CSV/);
  await assert.rejects(fetchGitHubFile('https://drive.google.com/drive/folders/x'), /folder/);
});

test('resolveRemoteFile: a Drive link is probed for Parquet (read in place); a Sheet never is', async () => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(init?.method || 'GET');
    return init?.method === 'HEAD' ? respond('', 200, { 'content-length': '5000' }) : respond('PAR1', 206);
  };
  const r = await resolveRemoteFile('https://drive.google.com/file/d/PQ/view', { fetchImpl: impl });
  assert.equal(r.url, 'https://drive.usercontent.google.com/download?id=PQ&export=download&confirm=t');
  assert.equal(r.fileName, 'google_drive_PQ.parquet');
  assert.equal(r.source.provider, 'Google Drive');
  assert.equal(r.sizeBytes, 5000);
  const csv = await resolveRemoteFile('https://drive.google.com/file/d/CS/view', { fetchImpl: async () => respond('a,b', 206) });
  assert.equal(csv, null, 'not Parquet: downloaded instead');
  assert.equal(await resolveRemoteFile('https://docs.google.com/spreadsheets/d/S/edit', { fetchImpl: () => assert.fail('no probe') }), null);
  assert.equal(await resolveRemoteFile('https://drive.google.com/drive/folders/x', { fetchImpl: () => assert.fail('no probe') }), null);
});
