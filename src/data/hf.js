// Hugging Face Hub URIs: hf://datasets/owner/repo[@revision]/path, where path may contain globs (* ** ?).
// The Hub API and resolve URLs (which redirect to the CDN) both send CORS headers, so this works in the browser.

const HF = 'https://huggingface.co';
const KINDS = { datasets: 'datasets', spaces: 'spaces', models: '' }; // URL prefix per repo type

/** hf://<kind>/<owner>/<repo>[@rev]/<path> -> { kind, repo, rev, path } or null. */
export function parseHfUri(input) {
  const m = /^hf:\/\/(datasets|models|spaces)\/([^/@\s]+\/[^/@\s]+)(?:@([^/\s]+))?\/(.+)$/i.exec(String(input).trim());
  if (!m) return null;
  return { kind: m[1].toLowerCase(), repo: m[2], rev: m[3] ? decodeURIComponent(m[3]) : 'main', path: m[4] };
}

export const hasGlob = (path) => /[*?[]/.test(path);

const repoBase = ({ kind, repo }) => `${HF}/${KINDS[kind] ? KINDS[kind] + '/' : ''}${repo}`;
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** Download URL for one file (redirects to the CDN, which supports Range requests). */
export function hfResolveUrl(src, path = src.path) {
  return `${repoBase(src)}/resolve/${encodeURIComponent(src.rev)}/${encPath(path)}`;
}

/** Page on the Hub for the file, or for the folder a glob starts in. */
export function hfPageUrl(src) {
  const fixed = globPrefix(src.path);
  return hasGlob(src.path)
    ? `${repoBase(src)}/tree/${encodeURIComponent(src.rev)}/${encPath(fixed)}`
    : `${repoBase(src)}/blob/${encodeURIComponent(src.rev)}/${encPath(src.path)}`;
}

/** Folder before the first glob segment: "release/*\/x.parquet" -> "release". */
export function globPrefix(path) {
  const segs = path.split('/');
  const i = segs.findIndex((s) => hasGlob(s));
  return (i < 0 ? segs.slice(0, -1) : segs.slice(0, i)).join('/');
}

/** Glob -> RegExp over full paths: "*" and "?" stay within a segment, "**" spans segments. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Expand a glob into matching file paths (sorted) via the Hub tree API, following Link pagination.
 * Returns [{ path, size }].
 */
export async function hfListGlob(src, doFetch) {
  const re = globToRegExp(src.path);
  const prefix = globPrefix(src.path);
  let url = `${HF}/api/${src.kind}/${src.repo}/tree/${encodeURIComponent(src.rev)}${prefix ? '/' + encPath(prefix) : ''}?recursive=true`;
  const out = [];
  for (let page = 0; url && page < 50; page++) {
    let res;
    try { res = await doFetch(url); } catch (e) { throw new Error(`Network error listing ${hfPageUrl(src)}: ${e?.message || e}`); }
    if (res.status === 404) throw new Error(`Not found on Hugging Face: ${src.kind}/${src.repo}@${src.rev}/${prefix}. Check the repo name and path.`);
    if (res.status === 401 || res.status === 403) throw new Error(`Hugging Face refused access (HTTP ${res.status}): the repo may be private or gated.`);
    if (!res.ok) throw new Error(`Listing ${hfPageUrl(src)} failed (HTTP ${res.status}).`);
    for (const e of await res.json()) if (e.type === 'file' && re.test(e.path)) out.push({ path: e.path, size: e.size });
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers?.get?.('link') || '')?.[1] || null;
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
