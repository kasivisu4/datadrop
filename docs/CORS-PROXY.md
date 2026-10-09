# A CORS relay for links that block browsers

Some servers don't let websites read their files: they send no `Access-Control-Allow-Origin` header, so a browser refuses to
hand the file to any page, DataDrop included. Examples: the NYC taxi files on `d37ci6vzurychx.cloudfront.net`, many S3 buckets.

DataDrop has no server, so it can't fix this for you. If you want such links to open by link, run a small relay **of your own**:
a Cloudflare Worker (free plan is plenty) that fetches the file and adds the missing header. DataDrop uses it **only for links
the server blocks**, and only if you paste its address in Settings. Everything else still goes straight from your browser.

**What it means for privacy:** for those links the file passes through your worker (your Cloudflare account, nothing of
ours). Nobody else sees it. The worker in this repo logs nothing and stores nothing.

**Running locally?** You don't need this: `npm run serve` has the same relay built in (it answers only your own machine) and DataDrop uses it automatically for blocked links. This page is for the deployed site.

## Set it up (about 5 minutes)

1. Sign in at <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Create Worker**. Name it, e.g. `datadrop-relay`, and deploy the starter.
2. **Edit code**, replace everything with the contents of [`cors-worker.js`](cors-worker.js), and **Deploy**.
3. **Settings → Variables and Secrets** → add:
   - `ALLOWED_HOSTS` = the hosts you want to open, comma separated, e.g. `d37ci6vzurychx.cloudfront.net`.
     **Don't skip this**: without it anyone who finds your worker's address can use it to fetch any https URL.
   - `ALLOWED_ORIGIN` (optional) = the site that may call it, e.g. `https://kasivisu4.github.io`.
4. Copy the worker's address (`https://datadrop-relay.<you>.workers.dev`).
5. In DataDrop: **Settings → Links that block browsers** → paste `https://datadrop-relay.<you>.workers.dev/?url={url}` → Save.
6. Paste the blocked link again. DataDrop tries it directly, sees it is blocked, and retries through your worker.
   Parquet files are still read in place with range requests, so only the columns you use are downloaded (through the worker).

## Notes

- Cloudflare's free plan allows 100,000 requests a day; a Parquet file read in place uses a handful per chart.
- The worker only forwards `GET` and `HEAD` (with `Range`). It never forwards cookies or authorization headers.
- To stop using it, clear the field in Settings, or delete the worker.
