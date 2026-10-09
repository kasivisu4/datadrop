// Share links from cloud drives and code hosts -> a direct download URL the browser can fetch, plus help text for each.
// Pure ESM, no DOM. Whether a host allows browser downloads (CORS) was checked by hand; see `cors` on each source.

const b64url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const lastSeg = (p) => decode(String(p).split('/').filter(Boolean).pop() || '');

function asUrl(input) {
  try {
    const u = new URL(String(input).trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch { return null; }
}

/**
 * Every kind of link DataDrop understands, in the order the help lists them.
 * - test(u): does this URL belong to the source (u is a URL, or null for non-http input such as s3://)
 * - direct(u): { url, fileName?, format? } to download, or { error } when the link can't work (e.g. a folder)
 * - howTo: how to get a link that works; blocked: what to do when the browser can't download it
 */
export const LINK_SOURCES = [
  {
    id: 'github', name: 'GitHub', example: 'https://github.com/owner/repo/blob/main/data.csv',
    test: (u, s) => /^(www\.)?github\.com$|^raw\.githubusercontent\.com$/i.test(u?.hostname || '') || /^#?\/?[^/:]+\/[^/]+\/blob\//.test(s),
    howTo: 'Open the file on GitHub and copy the address bar. Public repos only (or add a token in Settings). Git LFS files work too.',
  },
  {
    id: 'gist', name: 'GitHub Gist', example: 'https://gist.github.com/user/0123abcd',
    test: (u) => /^gist\.github(usercontent)?\.com$/i.test(u?.hostname || ''),
    direct(u) {
      if (/^gist\.githubusercontent\.com$/i.test(u.hostname)) return { url: u.href };
      const [user, id, ...rest] = u.pathname.split('/').filter(Boolean);
      if (!user || !id) return { error: 'Open a specific gist and paste its address.' };
      // /raw is the gist's first file; /raw/<file> a specific one
      const file = rest[0] === 'raw' ? rest.slice(1).join('/') : '';
      return { url: `https://gist.githubusercontent.com/${user}/${id}/raw${file ? '/' + file : ''}`, fileName: file ? lastSeg(file) : `gist_${id.slice(0, 8)}` };
    },
    howTo: 'Paste the gist address. DataDrop reads its first file; use the file\'s "Raw" link for another one.',
  },
  {
    id: 'gsheets', name: 'Google Sheets', example: 'https://docs.google.com/spreadsheets/d/<id>/edit#gid=0',
    test: (u) => /^docs\.google\.com$/i.test(u?.hostname || '') && /^\/spreadsheets\/d\//.test(u.pathname),
    direct(u) {
      const gid = /[#&?]gid=(\d+)/.exec(u.hash + u.search)?.[1];
      const pub = /^\/spreadsheets\/d\/e\/([^/]+)/.exec(u.pathname);
      if (pub) return { url: `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv${gid ? `&gid=${gid}` : ''}`, fileName: 'google_sheet.csv', format: 'csv' };
      const id = /^\/spreadsheets\/d\/([^/]+)/.exec(u.pathname)?.[1];
      return { url: `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`, fileName: 'google_sheet.csv', format: 'csv' };
    },
    howTo: 'Share → General access → "Anyone with the link" (Viewer), then paste the sheet\'s address. The tab open in the link (#gid=…) is loaded as CSV. "File → Share → Publish to web" links work too.',
    blocked: 'Make sure the sheet is shared with "Anyone with the link"; a private sheet returns a sign-in page.',
  },
  {
    id: 'gdrive', name: 'Google Drive', example: 'https://drive.google.com/file/d/<id>/view?usp=sharing',
    test: (u) => /^(drive|docs)\.google\.com$|^drive\.usercontent\.google\.com$/i.test(u?.hostname || '') && !/^\/spreadsheets\//.test(u.pathname),
    direct(u) {
      if (/^\/(document|presentation|forms)\//.test(u.pathname)) return { error: 'Google Docs, Slides and Forms aren\'t data files. For a table, use Google Sheets, or upload a CSV to Drive.' };
      if (/\/drive\/(u\/\d+\/)?folders\//.test(u.pathname)) return { error: 'That is a Google Drive folder. Open the file itself and copy its share link.' };
      const id = /\/file\/d\/([^/]+)/.exec(u.pathname)?.[1] || u.searchParams.get('id');
      if (!id) return { error: 'Couldn\'t find a file id in that Google Drive link. Use Share → Copy link on the file.' };
      const key = u.searchParams.get('resourcekey');
      // drive.usercontent.google.com sends CORS headers and supports Range requests (drive.google.com/uc does neither)
      return { url: `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t${key ? `&resourcekey=${encodeURIComponent(key)}` : ''}`, fileName: `google_drive_${id.slice(0, 6)}` };
    },
    howTo: 'Right-click the file → Share → General access → "Anyone with the link", then Copy link. Upload CSV/Parquet files as they are; Google Docs formats other than Sheets aren\'t supported.',
    blocked: 'Check the file is shared with "Anyone with the link". Google may also block files flagged by its virus scan or over its download quota.',
  },
  {
    id: 'dropbox', name: 'Dropbox', example: 'https://www.dropbox.com/scl/fi/<id>/data.csv?rlkey=…&dl=0',
    test: (u) => /^(www\.)?dropbox\.com$|^dl\.dropbox(usercontent)?\.com$/i.test(u?.hostname || ''),
    direct(u) {
      if (/^\/(sh|home)\//.test(u.pathname) || /^\/scl\/fo\//.test(u.pathname)) return { error: 'That is a Dropbox folder. Share the file itself.' };
      // www.dropbox.com has no CORS headers; dl.dropboxusercontent.com does
      const d = new URL(u.href);
      d.hostname = 'dl.dropboxusercontent.com';
      d.searchParams.delete('dl');
      d.searchParams.delete('raw');
      return { url: d.href, fileName: lastSeg(u.pathname) };
    },
    howTo: 'Share → Copy link (anyone with the link can view). Paste it as is; DataDrop turns it into a direct download.',
  },
  {
    id: 'onedrive', name: 'OneDrive (personal)', example: 'https://1drv.ms/u/s!…',
    test: (u) => /^1drv\.ms$|^(onedrive\.live\.com|api\.onedrive\.com)$/i.test(u?.hostname || ''),
    direct(u) {
      if (/^api\.onedrive\.com$/i.test(u.hostname)) return { url: u.href };
      // OneDrive's shares API: /shares/u!<base64url of the share link>/root/content redirects to the file
      return { url: `https://api.onedrive.com/v1.0/shares/u!${b64url(u.href)}/root/content`, fileName: 'onedrive_file' };
    },
    howTo: 'Share → "Anyone with the link can view" → Copy link, then paste it. Microsoft sometimes blocks these downloads from other websites.',
    blocked: 'OneDrive refused the download from this page. Check the link is "Anyone with the link"; if it still fails, download the file and drop it here.',
  },
  {
    id: 'sharepoint', name: 'OneDrive for work / SharePoint', example: 'https://contoso.sharepoint.com/:x:/g/…',
    test: (u) => /\.sharepoint\.com$/i.test(u?.hostname || ''),
    direct(u) {
      const d = new URL(u.href);
      d.searchParams.set('download', '1');
      return { url: d.href, fileName: lastSeg(u.pathname).includes('.') ? lastSeg(u.pathname) : 'sharepoint_file' };
    },
    howTo: 'Share → "Anyone with the link" (if your organisation allows it) → Copy link.',
    blocked: 'Work and school OneDrive/SharePoint usually block downloads from other websites. Download the file and drop it here instead.',
  },
  {
    id: 'box', name: 'Box', example: 'https://app.box.com/shared/static/<id>.csv',
    test: (u) => /(^|\.)box\.com$/i.test(u?.hostname || ''),
    direct(u) {
      if (!/\/shared\/static\//.test(u.pathname)) return { error: 'Box share pages (box.com/s/…) can\'t be downloaded directly. In the shared link settings, copy the "Direct link" (…/shared/static/…), or download the file and drop it here.' };
      return { url: u.href, fileName: lastSeg(u.pathname) };
    },
    howTo: 'Shared link settings → copy the "Direct link" (app.box.com/shared/static/…). Box may still block browser downloads.',
    blocked: 'Box blocked the download from this page. Download the file and drop it here instead.',
  },
  {
    id: 'gitlab', name: 'GitLab', example: 'https://gitlab.com/group/project/-/blob/main/data.csv',
    test: (u) => !!u && /\/-\/(blob|raw)\//.test(u.pathname),
    direct(u) {
      // raw files have no CORS headers; the files API does
      const m = /^\/(.+?)\/-\/(?:blob|raw)\/([^/]+)\/(.+)$/.exec(u.pathname);
      if (!m) return { error: 'Open a specific file in the GitLab project and paste its address.' };
      const [, project, ref, path] = m;
      return { url: `${u.origin}/api/v4/projects/${encodeURIComponent(decode(project))}/repository/files/${encodeURIComponent(decode(path))}/raw?ref=${encodeURIComponent(decode(ref))}`, fileName: lastSeg(path) };
    },
    howTo: 'Open the file in a public project and copy the address bar (…/-/blob/<branch>/<path>).',
  },
  {
    id: 'bitbucket', name: 'Bitbucket', example: 'https://bitbucket.org/workspace/repo/src/main/data.csv',
    test: (u) => /^bitbucket\.org$/i.test(u?.hostname || ''),
    direct(u) {
      const m = /^\/([^/]+)\/([^/]+)\/(?:src|raw)\/([^/]+)\/(.+)$/.exec(u.pathname);
      if (!m) return { error: 'Open a specific file in the Bitbucket repository and paste its address.' };
      return { url: `https://bitbucket.org/${m[1]}/${m[2]}/raw/${m[3]}/${m[4]}`, fileName: lastSeg(m[4]) };
    },
    howTo: 'Open the file in a public repository and copy the address bar.',
  },
  {
    id: 'hf', name: 'Hugging Face', example: 'hf://datasets/owner/repo/data/*.parquet',
    test: (u, s) => /^hf:\/\//i.test(s) || /^huggingface\.co$/i.test(u?.hostname || ''),
    direct(u) {
      if (!u) return null; // hf:// URIs are handled by hf.js
      const m = /^\/((?:datasets|spaces)\/)?([^/]+\/[^/]+)\/(?:blob|resolve)\/([^/]+)\/(.+)$/.exec(u.pathname);
      if (!m) return { error: 'Open a specific file on the Hub (…/blob/main/<file>) or use an hf://datasets/owner/repo/<path> URI.' };
      return { url: `https://huggingface.co/${m[1] || ''}${m[2]}/resolve/${m[3]}/${m[4]}`, fileName: lastSeg(m[4]) };
    },
    howTo: 'Paste a file page (…/blob/main/data.parquet) or an hf://datasets/owner/repo/path URI. Globs like */*.parquet load every matching file.',
  },
  {
    id: 'storage', name: 'S3, Google Cloud Storage, R2, Azure Blob', example: 's3://bucket/path/data.parquet',
    test: (u, s) => /^(s3|gs):\/\//i.test(s) || /(\.s3[.-][^.]*\.?amazonaws\.com|^s3\.amazonaws\.com|^storage\.googleapis\.com|\.r2\.dev|\.r2\.cloudflarestorage\.com|\.blob\.core\.windows\.net)$/i.test(u?.hostname || ''),
    howTo: 'Paste an s3:// or gs:// URI or the object\'s https URL. The object must be public, and the bucket needs a CORS rule allowing GET (and HEAD, with Range) from any origin.',
    blocked: 'The bucket must allow cross-origin GET requests: add a CORS rule with AllowedOrigins "*", AllowedMethods GET and HEAD, AllowedHeaders "Range".',
  },
  {
    id: 'web', name: 'Any other https link', example: 'https://example.com/data.csv',
    test: (u) => !!u,
    howTo: 'Any direct link to a .csv, .tsv, .json, .jsonl or .parquet file works if the server allows cross-origin requests (CORS). Links without an extension are detected from the file\'s contents.',
    blocked: 'The server doesn\'t allow downloads from other websites (no CORS headers). Download the file and drop it here instead.',
  },
];

/**
 * Settings: "CORS proxy". The address of a small relay you run yourself (docs/CORS-PROXY.md) that adds the CORS headers a
 * server forgot. A template with {url}, or an address that ends in "=" or "/" and takes the encoded URL after it.
 * -> { template } or { error }
 */
export function parseProxy(input) {
  const t = String(input ?? '').trim();
  if (!t) return { template: '' };
  let u;
  try { u = new URL(t.replace('{url}', 'x')); } catch { return { error: 'That is not a web address.' }; }
  if (u.protocol !== 'https:') return { error: 'The proxy must be an https:// address.' };
  if (!t.includes('{url}') && !/[=/]$/.test(t)) return { error: 'Put {url} where the data link goes, e.g. https://my-proxy.workers.dev/?url={url}' };
  return { template: t };
}

/** The address to fetch for `url` through a proxy template (see parseProxy). */
export function applyProxy(template, url) {
  const enc = encodeURIComponent(url);
  return template.includes('{url}') ? template.replace('{url}', enc) : template + enc;
}

/** The LINK_SOURCES entry a pasted link belongs to, or null for empty input. */
export function linkSourceFor(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const u = asUrl(s);
  return LINK_SOURCES.find((src) => src.test(u, s)) || null;
}

/**
 * A share link from a provider that needs rewriting -> { source, url, fileName?, format? }.
 * Throws for links that can't work (folders, Box share pages). null when the link needs no rewriting.
 */
export function shareLinkToDirect(input) {
  const s = String(input ?? '').trim();
  const src = linkSourceFor(s);
  if (!src?.direct) return null;
  const r = src.direct(asUrl(s));
  if (!r) return null;
  if (r.error) throw new Error(r.error);
  return { source: src, ...r };
}

/**
 * Guess a file's format from its first bytes: parquet, json, ndjson, tsv or csv; 'html' for a web page (usually a
 * sign-in or "can't preview" page instead of the file); null when it isn't text.
 */
export function sniffFormat(bytes) {
  if (!bytes?.length) return null;
  if (bytes.length >= 4 && String.fromCharCode(...bytes.slice(0, 4)) === 'PAR1') return 'parquet';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip';
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 64 * 1024)).replace(/^\uFEFF/, '');
  const head = text.trimStart();
  if (/^<(!doctype|html|head|body|\?xml)/i.test(head)) return 'html';
  const sample = text.slice(0, 4096);
  if (/[\x00-\x08\x0e-\x1a]/.test(sample)) return null; // binary
  if (head[0] === '[') return 'json';
  if (head[0] === '{') {
    const lines = head.split(/\r?\n/).filter((l) => l.trim());
    return lines.length > 1 && lines.slice(0, 5).every((l) => l.trim().startsWith('{')) ? 'ndjson' : 'json';
  }
  const first = head.split(/\r?\n/)[0];
  return (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? 'tsv' : 'csv';
}

export const FORMAT_EXT = { csv: 'csv', tsv: 'tsv', json: 'json', ndjson: 'jsonl', parquet: 'parquet' };
