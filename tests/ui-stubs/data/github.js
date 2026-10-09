// UI test stub for src/data/github.js
export async function fetchGitHubFile(input, opts = {}) {
  window.__proxied = opts.proxied || null; // what the app asked to read through, if anything
  // "slow" in the URL holds the fetch step open for 1.6 s, to exercise the live trace timer
  await new Promise((r) => setTimeout(r, /slow/.test(input) ? 1600 : 60));
  const s = String(input).replace(/^https?:\/\/github\.com\//, '').replace(/^#?\/?/, '');
  if (/drive\.google\.com/.test(s)) throw new Error('Couldn\'t download the file from Google Drive (Failed to fetch). Check the file is shared with "Anyone with the link".');
  if ((/blocked-cors/.test(s) && !opts.proxied) || /blocked-everywhere/.test(s)) throw Object.assign(new Error('files.example.org is online, but it does not let other websites read its files (it sends no CORS headers), so no tool that runs in the browser can open this link directly. Download the file, then drop it on this page.'), { blocked: true, downloadUrl: String(input) });
  if (/does-not-exist/.test(s)) throw new Error('File not found on GitHub (404). Check the branch and path.');
  const [owner, repo, , ref, ...p] = s.split('/');
  const path = p.join('/');
  return { bytes: new Uint8Array(2048), format: 'csv', fileName: path.split('/').pop(), source: { owner, repo, ref, path }, url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`, sizeBytes: 31744 };
}
export function parseGitHubUrl() { return null; }
export async function resolveRemoteFile() { return null; }
