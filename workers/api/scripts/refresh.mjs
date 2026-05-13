// Refresh script — runs on GitHub Actions (or locally).
//
// Fetches every monthly spending CSV that we care about, aggregates each one
// in Node, and uploads the resulting summary blobs to Workers KV via
// Cloudflare's REST API. Idempotent: skips a month if the source CSV's hash
// hasn't changed since the last run.
//
// All the parsing/aggregation logic is shared with the Worker (src/spending.js,
// src/csv.js, src/datamillnorth.js) so there's one source of truth.
//
// Required env vars:
//   CLOUDFLARE_API_TOKEN   — scoped to Workers KV Storage: Edit
//   CLOUDFLARE_ACCOUNT_ID  — your Cloudflare account id
//   KV_NAMESPACE_ID        — the CACHE namespace id (300899a1aa20400e988b897f8d111674)
// Optional:
//   DATAMILLNORTH_TOKEN    — DataPress API token (lifts rate limits)
//   MONTHS                 — how many recent months to consider (default 24)
//   CONCURRENCY            — parallel month processing (default 3)

import { listCsvResources, getDataset, streamCsv } from "../src/datamillnorth.js";
import { buildMonthlySummary } from "../src/spending.js";

// Bump this when buildMonthlySummary's logic or output shape changes — it
// invalidates every stored hash so the next run re-aggregates everything.
const AGGREGATION_VERSION = "v2";

const {
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID,
  KV_NAMESPACE_ID,
  DATAMILLNORTH_TOKEN,
  MONTHS = "24",
  CONCURRENCY = "3",
  FORCE = "0", // set to "1" to ignore hash matching and reprocess every month
} = process.env;

if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !KV_NAMESPACE_ID) {
  console.error("Missing required env vars: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, KV_NAMESPACE_ID");
  process.exit(1);
}

const DATASET_ID = "2gpp0";
const KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}`;
const env = { DATAMILLNORTH_TOKEN }; // used by datamillnorth.js as `env.DATAMILLNORTH_TOKEN`

// KV REST helpers ------------------------------------------------------------

async function kvGet(key) {
  const res = await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV GET ${key}: ${res.status} ${await res.text()}`);
  return res.text();
}

async function kvBulkPut(entries) {
  if (!entries.length) return;
  // Cloudflare bulk endpoint accepts up to 10k keys, 100MB per request.
  const chunks = [];
  for (let i = 0; i < entries.length; i += 1000) chunks.push(entries.slice(i, i + 1000));
  for (const chunk of chunks) {
    const res = await fetch(`${KV_BASE}/bulk`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`KV bulk PUT: ${res.status} ${await res.text()}`);
  }
}

// Concurrency-limited parallel map -------------------------------------------

async function pMap(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Main -----------------------------------------------------------------------

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] Refresh started`);

  const dataset = await getDataset(env, DATASET_ID);
  const resources = listCsvResources(dataset);

  // One resource per month — keep the larger of the two when duplicates exist.
  const byMonth = new Map();
  for (const r of resources) {
    if (!r.timeframeTo) continue;
    const month = r.timeframeTo.slice(0, 7);
    const existing = byMonth.get(month);
    if (!existing || r.size > existing.size) byMonth.set(month, r);
  }

  const months = [...byMonth.keys()].sort().reverse().slice(0, Number(MONTHS));
  console.log(`Considering ${months.length} months: ${months[months.length - 1]} → ${months[0]}`);

  // Decide which months actually need work. We compare the stored hash with
  // a synthetic value that embeds AGGREGATION_VERSION, so any change to the
  // aggregator forces a clean re-run automatically.
  const force = FORCE === "1";
  const work = [];
  for (const month of months) {
    const resource = byMonth.get(month);
    const expected = `${AGGREGATION_VERSION}:${resource.hash || ""}`;
    const lastHash = await kvGet(`spending:hash:${month}`);
    if (!force && lastHash === expected) {
      console.log(`  ✓ ${month}  (unchanged, skipping)`);
    } else {
      const reason = force ? "force" : lastHash ? "logic/data changed" : "new";
      console.log(`  ⟳ ${month}  (${(resource.size / 1024 / 1024).toFixed(1)} MB, ${reason})`);
      work.push({ month, resource, expectedHash: expected });
    }
  }

  if (!work.length) {
    console.log("Nothing to do — all hashes match.");
    await kvBulkPut([{ key: "meta:last-refresh", value: startedAt }]);
    return;
  }

  console.log(`Aggregating ${work.length} months (concurrency ${CONCURRENCY})…`);

  const summaries = await pMap(work, Number(CONCURRENCY), async ({ month, resource }) => {
    const t0 = Date.now();
    const stream = await streamCsv(env, resource.url);
    const summary = await buildMonthlySummary(month, resource, stream);
    console.log(`    ${month}: £${summary.totalAmount.toLocaleString("en-GB")} across ${summary.transactionCount} txns (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return { month, resource, summary };
  });

  // Build the rolling trend from BOTH freshly-aggregated AND already-cached months
  // so the trend stays complete even when only some months were re-processed.
  const trendMap = new Map();
  for (const { month, summary } of summaries) {
    trendMap.set(month, { month, total: summary.totalAmount, txnCount: summary.transactionCount });
  }
  for (const month of months) {
    if (trendMap.has(month)) continue;
    const cached = await kvGet(`spending:summary:${month}`);
    if (!cached) continue;
    const s = JSON.parse(cached);
    trendMap.set(month, { month, total: s.totalAmount, txnCount: s.transactionCount });
  }
  const trend = [...trendMap.values()].sort((a, b) => a.month.localeCompare(b.month));

  // Compose the KV writes.
  const writes = [];
  for (const { month, resource, summary } of summaries) {
    const expected = `${AGGREGATION_VERSION}:${resource.hash || ""}`;
    writes.push({ key: `spending:summary:${month}`, value: JSON.stringify(summary), expiration_ttl: 60 * 60 * 24 * 365 });
    writes.push({ key: `spending:hash:${month}`, value: expected });
  }
  writes.push({ key: "spending:trend", value: JSON.stringify({ months: trend, updated: startedAt }) });
  writes.push({ key: "spending:latest", value: months[0] });
  writes.push({ key: "meta:last-refresh", value: startedAt });

  console.log(`Writing ${writes.length} keys to KV…`);
  await kvBulkPut(writes);
  console.log(`Done. Latest month is now ${months[0]}.`);
}

main().catch((err) => {
  console.error("Refresh failed:", err);
  process.exit(1);
});
