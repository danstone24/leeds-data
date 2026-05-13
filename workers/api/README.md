# Leeds Data API Worker

Cloudflare Worker that serves precomputed Leeds City Council data summaries from Workers KV.

**Important architecture note**: aggregation happens OUTSIDE the Worker. Workers Free caps CPU at 10ms per invocation, which isn't enough to parse a 6MB spending CSV. So the heavy lifting runs in **GitHub Actions** (see [.github/workflows/refresh-data.yml](../../.github/workflows/refresh-data.yml)) and writes the results to KV via the Cloudflare REST API. This Worker only reads.

## Routes

| Route | Returns |
|---|---|
| `GET  /api/health` | Liveness + `updated` (last refresh) + latest spending month |
| `GET  /api/spending/summary` | Latest month summary blob |
| `GET  /api/spending/summary/<yyyy-mm>` | Summary for a specific month |
| `GET  /api/spending/trend` | Rolling 24-month totals |
| `GET  /api/spending/months` | List of months we have summaries for |

All responses are JSON. Summary shape — see `buildMonthlySummary` in `src/spending.js`.

## Code layout

- `src/index.js` — routes
- `src/datamillnorth.js` — DataPress API client (used by the refresh script only; lives here so Worker + script share one source of truth for the data layer)
- `src/csv.js` — streaming CSV parser
- `src/spending.js` — pure aggregation function + Worker route handlers
- `scripts/refresh.mjs` — Node script run by GitHub Actions; downloads CSVs, aggregates, writes to KV

## How the data pipeline works

```
┌────────────────────────────┐
│ GitHub Actions             │
│ .github/workflows/         │   nightly cron + manual trigger
│   refresh-data.yml         │
└──────────┬─────────────────┘
           │ runs `npm run refresh`
           ▼
┌────────────────────────────┐
│ scripts/refresh.mjs        │
│  • fetch dataset metadata  │
│  • compare hashes to KV    │
│  • stream-parse changed    │
│    months in Node          │
│  • bulk-PUT JSON to KV     │
└──────────┬─────────────────┘
           │ Cloudflare REST API
           ▼
┌────────────────────────────┐
│ Workers KV (CACHE)         │
│  spending:summary:YYYY-MM  │
│  spending:hash:YYYY-MM     │
│  spending:trend            │
│  spending:latest           │
│  meta:last-refresh         │
└──────────┬─────────────────┘
           │ read-only
           ▼
┌────────────────────────────┐
│ This Worker (src/index.js) │
│  serves /api/* from KV     │
└────────────────────────────┘
```

## Adding a new dataset

1. Find the dataset id on Datamillnorth (short code at the end of the URL).
2. Add aggregation + handlers in a new `src/<name>.js`, modelled on `src/spending.js`. Export a pure `build...Summary` function.
3. Extend `scripts/refresh.mjs` to call it.
4. Add routes in `src/index.js`.
5. Document it in [../../docs/data-sources.md](../../docs/data-sources.md).

## Deployment

- **Worker code** auto-deploys via **Workers Builds** (Cloudflare-native git connection). Push to `main` with any change under `workers/api/` and the dashboard handles the rest. No secrets to manage.
- **Data refresh** auto-runs via the **Refresh data** GitHub workflow (daily 04:00 UTC, or manually via the Actions UI). Requires three GitHub repo secrets — see [../../docs/deployment.md](../../docs/deployment.md).

## Local dev

```sh
# Worker
npx wrangler dev
# GET http://127.0.0.1:8787/api/health  (will 503 spending routes if KV is empty locally)

# Refresh script (talks to live KV — be careful)
CLOUDFLARE_API_TOKEN=... \
CLOUDFLARE_ACCOUNT_ID=... \
KV_NAMESPACE_ID=300899a1aa20400e988b897f8d111674 \
DATAMILLNORTH_TOKEN=... \
MONTHS=3 \
npm run refresh
```
