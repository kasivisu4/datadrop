// GitHub URL parsing/resolution, plus direct, cloud-storage and Hugging Face URLs. Pure ESM, no DOM, no deps.
import { parseHfUri, hasGlob, hfResolveUrl, hfPageUrl, hfListGlob } from './hf.js';
import { linkSourceFor, shareLinkToDirect, sniffFormat, FORMAT_EXT } from './links.js';

const MAX_BYTES = 200 * 1024 * 1024;
const LFS_PREFIX = 'version https://git-lfs.github.com/spec/';

const FORMATS = {
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  jsonl: 'ndjson',
  ndjson: 'ndjson',
  parquet: 'parquet',
};

function stripQueryHash(s) {
  return s.replace(/[?#].*$/, '');
}

function decodeSegs(segs) {
  return segs.map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

/**
 * Parse a GitHub file URL into its parts.
 * Accepts github.com blob/raw/tree URLs, raw.githubusercontent.com URLs,
 * and the hash-route form "o/r/blob/<ref>/<path>" (optionally prefixed with "#/" or "/").
 * Refs are assumed to be a single path segment (branch names with "/" are ambiguous).
 */
export function parseGitHubUrl(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;

  let host = null;
  let pathPart;
  const m = s.match(/^(?:https?:\/\/)?((?:www\.)?github\.com|raw\.githubusercontent\.com)(\/.*)?$/i);
  if (m) {
    host = m[1].toLowerCase().replace(/^www\./, '');
    pathPart = stripQueryHash(m[2] || '');
  } else if (/^[a-z]+:\/\//i.test(s)) {
    return null; // some other host
  } else {
    // hash-route form: strip leading "#", "/" and any query
    s = s.replace(/^#/, '').replace(/^\/+/, '');
    pathPart = '/' + stripQueryHash(s);
  }

  const segs = decodeSegs(pathPart.split('/').filter(Boolean));

  if (host === 'raw.githubusercontent.com') {
    // /o/r/<ref>/<path...>  (also tolerate /o/r/refs/heads/<ref>/<path...>)
    if (segs.length < 4) return null;
    let [owner, repo, ...rest] = segs;
    if (rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags') && rest.length >= 4) {
      rest = rest.slice(2);
    }
    const [ref, ...p] = rest;
    if (!p.length) return null;
    return { owner, repo, ref, path: p.join('/'), kind: 'raw' };
  }

  // github.com or hash-route: /o/r/(blob|raw|tree)/<ref>/<path...>
  if (segs.length < 4) return null;
  const [owner, repo, kind, ref, ...p] = segs;
  if (!['blob', 'raw', 'tree'].includes(kind)) return null;
  if (kind !== 'tree' && !p.length) return null;
  return { owner, repo: repo.replace(/\.git$/, ''), ref, path: p.join('/'), kind };
}

function encPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function rawUrl({ owner, repo, ref, path }) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${encPath(path)}`;
}

export function lfsMediaUrl({ owner, repo, ref, path }) {
  return `https://media.githubusercontent.com/media/${owner}/${repo}/${encodeURIComponent(ref)}/${encPath(path)}`;
}

function apiContentsUrl({ owner, repo, ref, path }) {
  return `https://api.github.com/repos/${owner}/${repo}/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`;
}

export function detectFormat(path) {
  if (typeof path !== 'string') return null;
  const clean = stripQueryHash(path).toLowerCase();
  const m = clean.match(/\.([a-z0-9]+)$/);
  return (m && FORMATS[m[1]]) || null;
}

export function isLfsPointer(bytes) {
  if (!bytes || bytes.length < LFS_PREFIX.length || bytes.length > 1024) return false;
  for (let i = 0; i < LFS_PREFIX.length; i++) {
    if (bytes[i] !== LFS_PREFIX.charCodeAt(i)) return false;
  }
  return true;
}

/** Safe SQL identifier from a file name: "data/Sales 2024.csv" -> "sales_2024". */
export function tableNameFor(path) {
  const base = String(path || '').split(/[\\/]/).pop().replace(/[?#].*$/, '');
  let name = base.replace(/\.[^.]*$/, '') || base;
  name = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!name) name = 'data';
  if (/^[0-9]/.test(name)) name = 't_' + name;
  return name.slice(0, 63);
}

async function readBody(res, url) {
  const len = Number(res.headers?.get?.('content-length'));
  if (len && len > MAX_BYTES) {
    throw new Error(`File is too large (${(len / 1e6).toFixed(0)} MB); the limit is 200 MB.`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) {
    throw new Error(`File is too large (${(bytes.length / 1e6).toFixed(0)} MB); the limit is 200 MB.`);
  }
  return bytes;
}

function httpError(res, src, url) {
  if (res.status === 404) {
    return new Error(
      `File not found: ${src.owner}/${src.repo}@${src.ref}/${src.path}. ` +
      `Check the URL, branch name, and that the repository is public (or supply a token).`
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(`GitHub refused access (HTTP ${res.status}) to ${url}. The repo may be private or rate-limited; try a token.`);
  }
  return new Error(`Failed to fetch ${url} (HTTP ${res.status}).`);
}

/**
 * Public https URL for a storage URI the browser can't fetch: s3://bucket/key, gs://bucket/key and
 * hf://datasets/owner/repo[@rev]/path (a single file; globs go through fetchGitHubFile's multi-file path).
 * Other input is returned unchanged. S3 uses the virtual-hosted endpoint (works for every region),
 * or path style when the bucket name has dots (they break the TLS wildcard certificate).
 */
export function storageToHttps(input) {
  const hf = parseHfUri(input);
  if (hf && !hasGlob(hf.path)) return hfResolveUrl(hf);
  const m = /^(s3|gs):\/\/([^/?#]+)\/([^?#]+)$/i.exec(String(input).trim());
  if (!m) return input;
  const [, scheme, bucket, key] = m;
  const k = key.split('/').map((s) => encodeURIComponent(decodeURIComponentSafe(s))).join('/');
  if (scheme.toLowerCase() === 'gs') return `https://storage.googleapis.com/${bucket}/${k}`;
  return bucket.includes('.') ? `https://s3.amazonaws.com/${bucket}/${k}` : `https://${bucket}.s3.amazonaws.com/${k}`;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** A non-GitHub http(s) URL to fetch as-is (e.g. an S3/R2 bucket, or an s3:// / gs:// URI), or null. */
export function parseDirectUrl(input) {
  if (typeof input !== 'string') return null;
  let u;
  try { u = new URL(storageToHttps(input.trim())); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (/^((www\.)?github\.com|raw\.githubusercontent\.com)$/i.test(u.hostname)) return null;
  return u;
}

const SUPPORTED = 'Supported: .csv, .tsv, .json, .jsonl, .ndjson, .parquet';
// extensions that are certainly not a data file we read (anything else without a known extension is sniffed)
const NOT_DATA = /^(xlsx?|xlsm|ods|numbers|zip|gz|7z|rar|tar|pdf|docx?|pptx?|png|jpe?g|gif|svg|webp|mp[34]|md|rst|html?|ipynb|py|js|ts)$/;

/** What to tell the user when the browser can't download a link: the source's own advice, or the generic CORS one. */
function blockedHelp(input) {
  const src = linkSourceFor(input);
  return src?.blocked || LINK_FALLBACK_HELP;
}
const LINK_FALLBACK_HELP = 'The server may not allow downloads from other websites (CORS). Download the file and drop it here instead.';

/** True when the server answers a no-cors request: it is online, and a normal request failed only for want of CORS headers. */
async function reachable(url, doFetch) {
  try { const r = await doFetch(url, { method: 'HEAD', mode: 'no-cors' }); return r?.type === 'opaque' || r?.status === 0; } catch { return false; }
}

/**
 * Download a data file from any http(s) URL. The server must send CORS headers. `share` is shareLinkToDirect's result
 * for a cloud-drive link: its file name and format (if known) win, and `input` (the share link) stays the source URL.
 * Without a known format, the format is detected from the first bytes.
 */
async function fetchDirectFile(u, doFetch, { input = u.href, share = null, proxied = null } = {}) {
  const url = u.href;
  const path = decodeSegs(u.pathname.split('/').filter(Boolean)).join('/');
  const named = share?.fileName || path.split('/').pop() || u.hostname;
  let format = share?.format || detectFormat(named) || (share ? null : detectFormat(path));
  const via = share ? ` from ${share.source.name}` : '';
  const ext = /\.([a-z0-9]+)$/i.exec(named)?.[1]?.toLowerCase();
  if (!format && NOT_DATA.test(ext || '')) {
    throw new Error(`Unsupported file type for "${share ? input : url}"${/^(xlsx?|xlsm|ods|numbers)$/.test(ext) ? ' (a spreadsheet: export it as CSV, or put it in Google Sheets)' : ''}. ${SUPPORTED}`);
  }
  let res;
  try {
    res = await doFetch(proxied || url);
  } catch (e) {
    if (proxied) throw new Error(`Couldn't download through your CORS proxy (${e?.message || e}). Check its address in Settings, and that it passes Range requests and the file's host.`);
    // A blocked request and an unreachable server look the same to fetch(). A "no-cors" request tells them apart: it
    // succeeds (opaque) when the server is there but sends no CORS headers, which no browser-only tool can get around.
    if (!share && await reachable(url, doFetch)) {
      throw Object.assign(new Error(`${u.host} is online, but it doesn't let other websites read its files (it sends no CORS headers), so no tool that runs in the browser can open this link directly. Download the file, then drop it on this page.`), { blocked: true, downloadUrl: url });
    }
    throw new Error(`Couldn't download ${share ? 'the file' + via : url} (${e?.message || e}). ${blockedHelp(input)}`);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(`Access denied${via} (HTTP ${res.status}). ${share?.source.blocked || share?.source.howTo || 'The file must be public.'}`);
    throw new Error(res.status === 404 ? `File not found${via}: ${share ? input : url}` : `Failed to fetch ${url} (HTTP ${res.status}).`);
  }
  const bytes = await readBody(res, url);
  const sniffed = sniffFormat(bytes);
  if (sniffed === 'html' && format !== 'parquet') {
    throw new Error(`Got a web page instead of a data file${via}: the link probably isn't public, or isn't a direct file link. ${share?.source.blocked || share?.source.howTo || ''}`.trim());
  }
  if (!format) format = FORMAT_EXT[sniffed] ? sniffed : null;
  if (!format) throw new Error(`Unsupported file type for "${share ? input : url}"${sniffed === 'zip' ? ' (it looks like a .zip or Excel file; export it as CSV)' : ''}. ${SUPPORTED}`);
  const fileName = detectFormat(named) ? named : `${named}.${FORMAT_EXT[format]}`;
  const source = { url: input, host: u.host, path: share ? fileName : path, ...(share ? { provider: share.source.name, page: input } : {}) };
  return { bytes, format, fileName, source, url, sizeBytes: bytes.length };
}

/**
 * Parquet only: find a URL that DuckDB can query in place with HTTP range requests, so only the
 * footer and the column chunks each query needs are downloaded. Probes the first 4 bytes for "PAR1"
 * (a Git LFS pointer fails that, so the LFS media URL is tried next).
 * Returns { url, format, fileName, source, sizeBytes? }, or null to fall back to a full download.
 */
export async function resolveRemoteFile(input, { fetchImpl, token, proxied } = {}) {
  if (token) return null; // DuckDB's HTTP reader can't send the Authorization header
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  let source;
  let urls;
  const gh = parseGitHubUrl(input);
  if (gh) {
    if (gh.kind === 'tree') return null;
    source = { owner: gh.owner, repo: gh.repo, ref: gh.ref, path: gh.path };
    urls = [rawUrl(source), lfsMediaUrl(source)];
  } else {
    let share = null;
    try { share = shareLinkToDirect(input); } catch { return null; }
    const u = parseDirectUrl(share ? share.url : input);
    if (!u) return null;
    if (share) {
      if (share.format && share.format !== 'parquet') return null;
      const name = share.fileName || 'file';
      if (detectFormat(name) && detectFormat(name) !== 'parquet') return null;
      source = { url: String(input).trim(), host: u.host, path: detectFormat(name) ? name : `${name}.parquet`, provider: share.source.name, page: String(input).trim() };
    } else {
      source = { url: u.href, host: u.host, path: decodeSegs(u.pathname.split('/').filter(Boolean)).join('/') };
    }
    urls = [!share && proxied ? proxied : u.href]; // a proxy address is only for reading; the file keeps its own name and source
  }
  if (detectFormat(source.path) !== 'parquet') return null;
  for (const url of urls) {
    let res;
    try { res = await doFetch(url, { headers: { Range: 'bytes=0-3' } }); } catch { return null; }
    if (res.status !== 206) return null;
    const head = new Uint8Array(await res.arrayBuffer());
    if (String.fromCharCode(...head.slice(0, 4)) === 'PAR1') {
      // content-range is often not CORS-exposed; content-length on a HEAD always is
      let total = Number(res.headers?.get?.('content-range')?.split('/')[1]);
      if (!(total > 0)) {
        try { total = Number((await doFetch(url, { method: 'HEAD' })).headers?.get?.('content-length')); } catch { /* size stays unknown */ }
      }
      return { url, format: 'parquet', fileName: source.path.split('/').pop(), source, sizeBytes: total > 0 ? total : undefined };
    }
  }
  return null;
}

/**
 * Every file matching an hf:// glob, downloaded: { parts: [{ bytes, path }], format, fileName, source, url, sizeBytes }.
 * All matches must share a format; together they count against the 200 MB limit.
 */
async function fetchHfGlob(input, src, doFetch) {
  const files = await hfListGlob(src, doFetch);
  if (!files.length) throw new Error(`No files on Hugging Face match ${input}.`);
  const formats = new Set(files.map((f) => detectFormat(f.path)));
  const format = files.length && formats.size === 1 ? [...formats][0] : null;
  if (!format) {
    throw new Error(`The ${files.length} matching files must all be one supported type (.csv, .tsv, .json, .jsonl, .ndjson, .parquet); narrow the pattern.`);
  }
  if (files.length > 500) throw new Error(`${files.length} files match; narrow the pattern to 500 or fewer.`);
  const total = files.reduce((n, f) => n + (f.size || 0), 0);
  if (total > MAX_BYTES) throw new Error(`The ${files.length} matching files total ${(total / 1e6).toFixed(0)} MB; the limit is 200 MB.`);
  const parts = new Array(files.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < files.length; i = next++) {
      const url = hfResolveUrl(src, files[i].path);
      let res;
      try { res = await doFetch(url); } catch (e) { throw new Error(`Network error fetching ${url}: ${e?.message || e}`); }
      if (!res.ok) throw new Error(`Failed to fetch ${files[i].path} from Hugging Face (HTTP ${res.status}).`);
      parts[i] = { bytes: await readBody(res, url), path: files[i].path };
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker));
  const sizeBytes = parts.reduce((n, p) => n + p.bytes.length, 0);
  if (sizeBytes > MAX_BYTES) throw new Error(`The matching files total ${(sizeBytes / 1e6).toFixed(0)} MB; the limit is 200 MB.`);
  return {
    parts, format, fileName: src.path.split('/').pop(), fileCount: parts.length,
    source: { url: input, host: 'huggingface.co', path: src.path, page: hfPageUrl(src) }, url: hfPageUrl(src), sizeBytes,
  };
}

/**
 * Resolve and download a GitHub file. Follows Git LFS pointers to media.githubusercontent.com.
 * With a token, uses the contents API (works for private repos).
 * Any other http(s) URL is fetched directly; its source is { url, host, path } instead of { owner, repo, ref, path }.
 */
export async function fetchGitHubFile(input, { fetchImpl, token, proxied } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const hf = parseHfUri(input);
  if (hf && hasGlob(hf.path)) return fetchHfGlob(String(input).trim(), hf, doFetch);
  const src = parseGitHubUrl(input);
  if (!src) {
    const raw = String(input ?? '').trim();
    const share = shareLinkToDirect(raw); // throws for links that can't work (folders, Box share pages)
    if (share) return fetchDirectFile(new URL(share.url), doFetch, { input: raw, share });
    const direct = parseDirectUrl(input);
    if (direct) return fetchDirectFile(direct, doFetch, { input: direct.href, proxied });
    throw new Error(`Not a recognised file URL: "${input}". Paste a share link (GitHub, Google Drive or Sheets, Dropbox, OneDrive…), a direct https:// link, or an s3://, gs:// or hf:// URI for a public object. See "Which links work?" for details.`);
  }
  if (src.kind === 'tree') throw new Error('That URL points to a folder. Open a specific data file and paste its URL.');

  const format = detectFormat(src.path);
  if (!format) {
    throw new Error(`Unsupported file type for "${src.path}". Supported: .csv, .tsv, .json, .jsonl, .ndjson, .parquet`);
  }
  const source = { owner: src.owner, repo: src.repo, ref: src.ref, path: src.path };

  let url;
  let res;
  try {
    if (token) {
      url = apiContentsUrl(source);
      res = await doFetch(url, {
        headers: { Accept: 'application/vnd.github.raw', Authorization: `Bearer ${token}` },
      });
    } else {
      url = rawUrl(source);
      res = await doFetch(url);
    }
  } catch (e) {
    throw new Error(`Network error fetching ${url}: ${e?.message || e}`);
  }
  if (!res.ok) throw httpError(res, source, url);
  let bytes = await readBody(res, url);

  if (isLfsPointer(bytes)) {
    url = lfsMediaUrl(source);
    let lfsRes;
    try {
      lfsRes = await doFetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    } catch (e) {
      throw new Error(`Network error fetching Git LFS object ${url}: ${e?.message || e}`);
    }
    if (!lfsRes.ok) throw httpError(lfsRes, source, url);
    bytes = await readBody(lfsRes, url);
  }

  const fileName = source.path.split('/').pop();
  return { bytes, format, fileName, source, url, sizeBytes: bytes.length };
}
