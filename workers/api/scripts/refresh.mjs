// Refresh script — runs on GitHub Actions (or locally).
//
// 1. Fetch monthly spending CSVs from Datamillnorth.
// 2. Aggregate each one in Node (Workers Free CPU is too tight).
// 3. Build period summaries (tax year, calendar year, year-to-date) by
//    combining the per-month summaries.
// 4. Bulk-write all results to Workers KV via the Cloudflare REST API.
//
// Idempotent: monthly aggregations are skipped if the source CSV hash is
// unchanged AND the AGGREGATION_VERSION is unchanged.

import { listCsvResources, getDataset, streamCsv } from "../src/datamillnorth.js";
import { buildMonthlySummary, combineSummaries } from "../src/spending.js";

// Bump this when buildMonthlySummary's logic or output shape changes — it
// invalidates every stored hash so the next run re-aggregates everything.
const AGGREGATION_VERSION = "v4";

const {
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID,
  KV_NAMESPACE_ID,
  DATAMILLNORTH_TOKEN,
  MONTHS = "24",
  CONCURRENCY = "3",
  FORCE = "0",
} = process.env;

if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !KV_NAMESPACE_ID) {
  console.error("Missing required env vars: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, KV_NAMESPACE_ID");
  process.exit(1);
}

const DATASET_ID = "2gpp0";
const KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}`;
const env = { DATAMILLNORTH_TOKEN };

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
    const body = await res.json();
    if (!body.success) throw new Error(`KV bulk PUT reported failure: ${JSON.stringify(body.errors)}`);
  }
}

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

// Period selection ----------------------------------------------------------

// Build the catalogue of periods we want to aggregate from the available months.
// Returns array of { id, kind, label, months: [yyyy-mm, …] }
function planPeriods(months) {
  const set = new Set(months);
  const periods = [];

  // Year-to-date for the current calendar year (the calendar year of the latest month).
  if (months.length) {
    const [latestYear] = months[0].split("-");
    const ytdMonths = months
      .filter((m) => m.startsWith(`${latestYear}-`))
      .sort();
    if (ytdMonths.length) {
      periods.push({
        id: `ytd:${latestYear}`,
        kind: "ytd",
        label: `Year to date — ${latestYear}`,
        months: ytdMonths,
      });
    }
  }

  // Calendar years: any year for which we have at least one month.
  const cyMap = new Map();
  for (const m of months) {
    const [y] = m.split("-");
    if (!cyMap.has(y)) cyMap.set(y, []);
    cyMap.get(y).push(m);
  }
  for (const [y, ms] of cyMap) {
    ms.sort();
    // Only emit complete years (all 12 months) OR explicitly the YTD year above.
    if (ms.length >= 12) {
      periods.push({
        id: `cy:${y}`,
        kind: "cy",
        label: `Calendar year ${y}`,
        months: ms,
      });
    }
  }

  // UK tax years (Apr → Mar). Label by start year: "2024-25" etc.
  const fyMap = new Map();
  for (const m of months) {
    const [yStr, moStr] = m.split("-");
    const y = Number(yStr);
    const mo = Number(moStr);
    // Apr-Dec falls into FY <year>; Jan-Mar falls into FY <year-1>.
    const fyStart = mo >= 4 ? y : y - 1;
    if (!fyMap.has(fyStart)) fyMap.set(fyStart, []);
    fyMap.get(fyStart).push(m);
  }
  for (const [fyStart, ms] of fyMap) {
    ms.sort();
    if (ms.length >= 12) {
      const endYearShort = String(fyStart + 1).slice(2);
      periods.push({
        id: `fy:${fyStart}`,
        kind: "fy",
        label: `Tax year ${fyStart}–${endYearShort} (Apr ${fyStart}–Mar ${fyStart + 1})`,
        months: ms,
      });
    }
  }

  // Sort: YTD first, then FY most-recent-first, then CY most-recent-first.
  periods.sort((a, b) => {
    const order = { ytd: 0, fy: 1, cy: 2 };
    if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
    return b.id.localeCompare(a.id);
  });

  return periods;
}

// Main ----------------------------------------------------------------------

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] Refresh started (aggregation ${AGGREGATION_VERSION})`);

  const dataset = await getDataset(env, DATASET_ID);
  const resources = listCsvResources(dataset);

  const byMonth = new Map();
  for (const r of resources) {
    if (!r.timeframeTo) continue;
    const month = r.timeframeTo.slice(0, 7);
    const existing = byMonth.get(month);
    if (!existing || r.size > existing.size) byMonth.set(month, r);
  }

  const allMonths = [...byMonth.keys()].sort().reverse().slice(0, Number(MONTHS));
  console.log(`Considering ${allMonths.length} months: ${allMonths[allMonths.length - 1]} → ${allMonths[0]}`);

  // Decide which months need to be re-aggregated.
  const force = FORCE === "1";
  const work = [];
  for (const month of allMonths) {
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

  let processed = [];
  if (work.length) {
    console.log(`Aggregating ${work.length} months (concurrency ${CONCURRENCY})…`);
    processed = await pMap(work, Number(CONCURRENCY), async ({ month, resource, expectedHash }) => {
      const t0 = Date.now();
      const stream = await streamCsv(env, resource.url);
      const { summary, transactions } = await buildMonthlySummary(month, resource, stream);
      console.log(`    ${month}: £${summary.totalAmount.toLocaleString("en-GB")} across ${summary.transactionCount} txns (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return { month, resource, expectedHash, summary, transactions };
    });
  }

  // Re-read existing summaries for the months we didn't reprocess — needed
  // to build the period aggregates and the trend.
  const summariesByMonth = new Map(processed.map((p) => [p.month, p.summary]));
  for (const month of allMonths) {
    if (summariesByMonth.has(month)) continue;
    const cached = await kvGet(`spending:summary:${month}`);
    if (cached) summariesByMonth.set(month, JSON.parse(cached));
  }

  // Build trend (rolling totals — only need amount and count).
  const trend = allMonths
    .filter((m) => summariesByMonth.has(m))
    .map((m) => {
      const s = summariesByMonth.get(m);
      return { month: m, total: s.totalAmount, txnCount: s.transactionCount };
    })
    .sort((a, b) => a.month.localeCompare(b.month));

  // Build period summaries (YTD, FY, CY).
  const periods = planPeriods(allMonths);
  console.log(`Building ${periods.length} period summaries:`);
  const periodSummaries = [];
  for (const p of periods) {
    const monthSummaries = p.months
      .map((m) => summariesByMonth.get(m))
      .filter(Boolean);
    if (!monthSummaries.length) continue;
    const summary = combineSummaries(monthSummaries, p.id, p.kind, p.label);
    periodSummaries.push({ period: p, summary });
    console.log(`  ${p.id} → ${p.label}: £${summary.totalAmount.toLocaleString("en-GB")} across ${monthSummaries.length} months`);
  }

  // Build the catalogue of every period the UI can offer.
  const catalogue = {
    months: allMonths.map((m) => ({
      id: m,
      kind: "month",
      label: monthLabel(m),
    })),
    periods: periodSummaries.map(({ period, summary }) => ({
      id: period.id,
      kind: period.kind,
      label: period.label,
      monthCount: period.months.length,
      totalAmount: summary.totalAmount,
    })),
    aggregationVersion: AGGREGATION_VERSION,
    updated: startedAt,
  };

  // Compose KV writes.
  const writes = [];
  for (const { month, resource, expectedHash, summary, transactions } of processed) {
    writes.push({ key: `spending:summary:${month}`, value: JSON.stringify(summary) });
    writes.push({ key: `spending:transactions:${month}`, value: JSON.stringify(transactions) });
    writes.push({ key: `spending:hash:${month}`, value: expectedHash });
  }
  for (const { period, summary } of periodSummaries) {
    writes.push({ key: `spending:summary:${period.id}`, value: JSON.stringify(summary) });
  }
  writes.push({ key: "spending:trend", value: JSON.stringify({ months: trend, updated: startedAt }) });
  writes.push({ key: "spending:periods", value: JSON.stringify(catalogue) });
  writes.push({ key: "spending:latest", value: allMonths[0] });
  writes.push({ key: "meta:last-refresh", value: startedAt });

  console.log(`Writing ${writes.length} keys to KV…`);
  await kvBulkPut(writes);
  console.log(`Done. Latest month is now ${allMonths[0]}. Periods: ${catalogue.periods.map((p) => p.id).join(", ") || "(none)"}.`);
}

function monthLabel(m) {
  const [y, mo] = m.split("-");
  const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${names[Number(mo) - 1]} ${y}`;
}

main().catch((err) => {
  console.error("Refresh failed:", err);
  process.exit(1);
});
