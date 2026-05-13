# Leeds Data API Worker

Cloudflare Worker that proxies and caches data from [Datamillnorth.org](https://datamillnorth.org) (CKAN).

## Routes

- `GET /api/health` — returns `{ ok, service, updated }`. `updated` is the last cron refresh.
- `GET /api/dataset/<name>` — returns `{ data, updated, source }`. `<name>` must be a key in the `DATASETS` registry in [src/index.js](src/index.js).

## Adding a dataset

1. Find the resource on Datamillnorth and grab its `resource_id` (use `package_show?id=<dataset-slug>`).
2. Add an entry to `DATASETS` in `src/index.js`:
   ```js
   "potholes": { resourceId: "abc-123-...", ttlSeconds: 3600 }
   ```
3. Document the dataset in [../../docs/data-sources.md](../../docs/data-sources.md).
4. Push. Workers Builds (or the GitHub Action) redeploys.

## Local dev

```sh
npx wrangler dev
# then GET http://127.0.0.1:8787/api/health
```

KV is not bound in `wrangler dev` by default — calls to `env.CACHE` will fall through. That's fine for local testing of the route logic; it just means every request hits Datamillnorth. Use `wrangler dev --remote` to test against real KV.

## First-time setup

```sh
# 1. Create the KV namespace and paste the id into wrangler.toml
npx wrangler kv:namespace create CACHE

# 2. Deploy
npx wrangler deploy
```

After deploy, in the Cloudflare dashboard:
- Map the Worker to `leedsdata.co.uk/api/*` (Workers → leeds-data-api → Triggers → Routes).
- Confirm the Cron Trigger is firing (Workers → leeds-data-api → Triggers → Cron Triggers).
