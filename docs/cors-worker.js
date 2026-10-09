// A tiny CORS relay for DataDrop, for servers that don't let websites read their files (the NYC taxi files on
// CloudFront, many S3 buckets). Deploy it on your own free Cloudflare account (docs/CORS-PROXY.md), then paste
//   https://<your-worker>.workers.dev/?url={url}
// into DataDrop's Settings. It forwards GET/HEAD (with Range, so Parquet is still read in place), adds the CORS headers
// the origin forgot, and nothing else: no logging, no storage, no cookies.
//
// Settings (Worker variables, all optional):
//   ALLOWED_HOSTS   comma-separated hosts it may fetch, e.g. "d37ci6vzurychx.cloudfront.net". Strongly recommended:
//                   without it, anyone who finds the address can use your worker to fetch any https URL.
//   ALLOWED_ORIGIN  the website allowed to call it, e.g. "https://kasivisu4.github.io" (default: any)

const EXPOSE = 'content-range, content-length, accept-ranges, content-type, etag, last-modified';

export default {
  async fetch(request, env = {}) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'range, if-range, if-none-match, if-modified-since',
      'access-control-expose-headers': EXPOSE,
      'access-control-max-age': '86400',
      vary: 'Origin',
    };
    const fail = (status, text) => new Response(text, { status, headers: { ...cors, 'content-type': 'text/plain' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'GET and HEAD only');

    const raw = new URL(request.url).searchParams.get('url');
    let target;
    try { target = new URL(raw); } catch { return fail(400, 'Add ?url=<an https address>'); }
    if (target.protocol !== 'https:') return fail(400, 'Only https addresses');
    if (env.ALLOWED_HOSTS) {
      const allowed = env.ALLOWED_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
      if (!allowed.includes(target.host.toLowerCase())) return fail(403, `${target.host} is not in ALLOWED_HOSTS`);
    }

    const headers = {};
    for (const h of ['range', 'if-range', 'if-none-match', 'if-modified-since']) {
      const v = request.headers.get(h);
      if (v) headers[h] = v;
    }
    const upstream = await fetch(target.href, { method: request.method, headers, redirect: 'follow' });
    const out = new Headers();
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
  },
};
