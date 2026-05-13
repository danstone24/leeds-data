# Leeds Data API Worker

Cloudflare Worker that fetches, aggregates, and caches Leeds City Council data from [Datamillnorth.org](https://datamillnorth.org) (DataPress API).

## Routes

| Route | Returns |
|---|---|
| `GET  /api/health` | Liveness + `updated` (last cron run) + latest spending month |
| `GET  /api/spending/summary` | Latest month summary blob |
| `GET  /api/spending/summary/<yyyy-mm>` | Summary for a specific month |
| `GET  /api/spending/trend` | Rolling 24-month totals |
| `GET  /api/spending/months` | List of months we have summaries for |
| `POST /api/admin/refresh` | Kick off the same job the cron runs. Returns immediately; refresh continues in the background. Requires `Authorization: Bearer ${ADMIN_TOKEN}`. |

All responses are JSON. Summary shape — see `src/spending.js`.

## Code layout

- `src/index.js` — routes + cron entry point
- `src/datamillnorth.js` — DataPress API client (dataset metadata, CSV stream fetch)
- `src/csv.js` — streaming CSV parser (no whole-file buffering)
- `src/spending.js` — council spending aggregator + KV writes

## Adding a new dataset

1. Find the dataset id on Datamillnorth (the short code at the end of the URL).
2. Add a new `src/<name>.js` modelled on `src/spending.js` — implement a `refresh<Name>(env)` function and route handlers.
3. Wire routes + cron call in `src/index.js`.
4. Document it in [../../docs/data-sources.md](../../docs/data-sources.md).

## First-time setup

```sh
# from this directory (workers/api/)

# 1. Login (one-off)
npx wrangler login

# 2. Create the KV namespace
npx wrangler kv:namespace create CACHE
#  → paste the `id` into wrangler.toml (replace REPLACE_WITH_KV_NAMESPACE_ID)

# 3. Add the Datamillnorth API token as a secret
npx wrangler secret put DATAMILLNORTH_TOKEN
#  → paste the token when prompted

# 4. Add an admin token (random string, your choice). Used to manually
#    trigger refreshes via POST /api/admin/refresh.
npx wrangler secret put ADMIN_TOKEN
#  → paste any strong random string (e.g. openssl rand -hex 32)

# 5. Deploy
npx wrangler deploy

# 6. Prime the cache on first deploy (cron does this nightly, but you want
#    data now). Replace <admin-token> with the value you set above.
curl -X POST -H "Authorization: Bearer <admin-token>" \
  https://leedsdata.co.uk/api/admin/refresh
#  → returns immediately; watch progress in the Cloudflare dashboard:
#    Workers & Pages → leeds-data-api → Logs → Live tail
```

After deploy, in the Cloudflare dashboard:
- Map the Worker to `leedsdata.co.uk/api/*` (Workers → leeds-data-api → Settings → Triggers → Routes).
- Confirm the Cron Trigger is enabled (Workers → leeds-data-api → Settings → Triggers → Cron Triggers).

## Local dev

```sh
npx wrangler dev
# GET http://127.0.0.1:8787/api/health
```

To test the scheduled handler locally:
```sh
npx wrangler dev --test-scheduled
# then hit http://127.0.0.1:8787/__scheduled
```

KV operates against the real namespace by default in `wrangler dev`. If you want a clean local-only cache, add `--persist-to=.wrangler/state` (already gitignored).
