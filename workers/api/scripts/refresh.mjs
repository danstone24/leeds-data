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
import { buildPotholes, mergePotholeRow } from "../src/potholes.js";
import { buildCollisions, isRealCollisionRow } from "../src/collisions.js";
import { accumulateCountRow, finaliseCounts, parseSites } from "../src/counts.js";
import { accumulateFootRow, finaliseFootfall } from "../src/footfall.js";
import { buildCouncilTax } from "../src/counciltax.js";
import {
  accumulateBidRow,
  parseStockRecords,
  accumulateTenantedRow,
  newTenantedAcc,
  finaliseHousing,
} from "../src/housing.js";
import { parsePrefsRecords, parseAllocRecords, buildSchools } from "../src/schools.js";
import { buildWaste } from "../src/waste.js";
import { buildAirQuality } from "../src/air.js";
import { buildPlanning, planitEntry, buildPlanitApps } from "../src/planning.js";
import { parseCsvObjects, parseCsvStream } from "../src/csv.js";

// Bump this when buildMonthlySummary's logic or output shape changes — it
// invalidates every stored hash so the next run re-aggregates everything.
const AGGREGATION_VERSION = "v4";
// Same idea for potholes: bump to force a re-aggregation of the pothole data.
const POTHOLES_VERSION = "v1";
const POTHOLES_DATASET_ID = "e7ylx";
// And collisions.
const COLLISIONS_VERSION = "v1";
const COLLISIONS_DATASET_ID = "2o11d";
// And the cycle/traffic counters (shared aggregator).
const COUNTS_VERSION = "v1";
const COUNTS_DATASETS = { cycle: "e1dmk", traffic: "e6q0n" };
// Site/metadata docs are tiny; the monthly count files are all >1 MB. We also
// skip the few giant historical dumps (8–30 MB) — different era, and the
// modal-shift story is about the recent monthly data.
const COUNTS_MIN_BYTES = 50_000;
const COUNTS_MAX_BYTES = 6_000_000;
// And footfall (the messy 575-file one).
const FOOTFALL_VERSION = "v1";
const FOOTFALL_DATASET_ID = "2rlld";
// And council tax (one small precepts file).
const COUNCILTAX_VERSION = "v1";
const COUNCILTAX_DATASET_ID = "24zz5";
// And council housing (three datasets on one page).
const HOUSING_VERSION = "v2";
const HOUSING_DATASETS = { bids: "20jjj", stock: "2o1gn", tenanted: "ep6qr" };
// And school places (four datasets, two phases).
const SCHOOLS_VERSION = "v3";
const SCHOOLS_DATASETS = {
  primaryPrefs: "24l45",
  primaryAlloc: "e6qpz",
  secondaryPrefs: "e619w",
  secondaryAlloc: "23ym1",
};
// And air quality (DEFRA UK-AIR, Leeds Centre — the first non-Datamillnorth
// source: plain fetch, one CSV per year, no API key).
const AIR_VERSION = "v1";
const AIR_FIRST_YEAR = 2007;
const AIR_SITE_ID = "LEED";
const airYearUrl = (year) =>
  `https://uk-air.defra.gov.uk/datastore/data_files/site_data/${AIR_SITE_ID}_${year}.csv?v=1`;
// And recycling & waste (two DEFRA sources — the first non-Datamillnorth
// data alongside air quality). Source URLs change every release, so both
// are re-discovered on each run.
const WASTE_VERSION = "v1";
const WASTE_CONTENT_API =
  "https://www.gov.uk/api/content/government/statistics/local-authority-collected-waste-management-annual-results";
const FLYTIP_DATASET_PAGE =
  "https://www.data.gov.uk/dataset/1388104c-3599-4cd2-abb5-ca8ddeeb4c9c/fly-tipping_in_england_";
// And planning (two external sources: MHCLG PS1/PS2 stats + PlanIt map layer).
const PLANNING_VERSION = "v1";
const PLANNING_CONTENT_API =
  "https://www.gov.uk/api/content/government/statistical-data-sets/live-tables-on-planning-application-statistics";
const PLANIT_PAGE_SIZE = 300;
// Stay well inside PlanIt's observed per-IP budget (~15–20 requests before a
// long Retry-After) — a night that hits this cap just leaves the rest to the
// cursor rotation.
const PLANIT_MAX_REQUESTS = 12;
const PLANIT_MAX_RECORDS = 15000;
// Monthly windows always fetched per nightly run (the freshest data); one
// older cursor window on top rotates through the rest of the year.
const PLANIT_RECENT_MONTHS = 2;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Datamillnorth 429s under burst load (it bit the schools dataset's ~30
// small files). Retry with a growing pause before giving up on a file.
async function streamCsvWithRetry(url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await streamCsv(env, url);
    } catch (err) {
      if (i >= attempts) throw err;
      const pause = 3000 * i * i;
      console.log(`    retrying in ${pause / 1000}s (${err.message})`);
      await sleep(pause);
    }
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

async function refreshSpending(startedAt) {
  console.log(`Spending: aggregating (version ${AGGREGATION_VERSION})…`);

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
      months: period.months,            // exposed so the UI can fan-out L4 fetches
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

// Potholes: merge every CSV in the dataset, dedupe by Reference, aggregate.
// The council republishes the whole record set quarterly, so the source is
// small enough to reprocess wholesale whenever its fingerprint changes.
async function refreshPotholes() {
  console.log(`Potholes: aggregating (version ${POTHOLES_VERSION})…`);
  const dataset = await getDataset(env, POTHOLES_DATASET_ID);
  const resources = listCsvResources(dataset);
  if (!resources.length) {
    console.warn("  no CSV resources found — skipping potholes");
    return;
  }

  const fingerprint =
    `${POTHOLES_VERSION}:` + resources.map((r) => r.hash || `${r.id}:${r.size}`).sort().join(",");
  const lastFingerprint = await kvGet("potholes:hash");
  if (FORCE !== "1" && lastFingerprint === fingerprint) {
    console.log("  ✓ unchanged, skipping");
    return;
  }

  const byRef = new Map();
  for (const r of resources) {
    let n = 0;
    const stream = await streamCsv(env, r.url);
    for await (const row of parseCsvObjects(stream)) {
      mergePotholeRow(byRef, row);
      n++;
    }
    console.log(`  parsed "${r.title}": ${n} rows`);
  }

  const rows = [...byRef.values()];
  const { summary, points } = buildPotholes(rows);
  console.log(
    `  ${rows.length} unique potholes · ${summary.fixedCount} fixed (median ${summary.medianFixDays}d) · ` +
    `£${summary.totalCost.toLocaleString("en-GB")} · ${points.length} map points`
  );

  await kvBulkPut([
    { key: "potholes:summary", value: JSON.stringify(summary) },
    { key: "potholes:points", value: JSON.stringify(points) },
    { key: "potholes:hash", value: fingerprint },
  ]);
  console.log("  wrote potholes:summary, potholes:points, potholes:hash");
}

// Collisions: one CSV per year (plus a Guidance file we ignore). Small enough
// to reprocess wholesale whenever the fingerprint changes.
async function refreshCollisions() {
  console.log(`Collisions: aggregating (version ${COLLISIONS_VERSION})…`);
  const dataset = await getDataset(env, COLLISIONS_DATASET_ID);
  // Keep only the per-year files (title is a 4-digit year, with or without .csv).
  const resources = listCsvResources(dataset).filter((r) =>
    /^\d{4}$/.test((r.title || "").replace(/\.csv$/i, "").trim())
  );
  if (!resources.length) {
    console.warn("  no year CSVs found — skipping collisions");
    return;
  }

  const fingerprint =
    `${COLLISIONS_VERSION}:` + resources.map((r) => r.hash || `${r.id}:${r.size}`).sort().join(",");
  const lastFingerprint = await kvGet("collisions:hash");
  if (FORCE !== "1" && lastFingerprint === fingerprint) {
    console.log("  ✓ unchanged, skipping");
    return;
  }

  const records = [];
  for (const r of resources) {
    const year = (r.title || "").replace(/\.csv$/i, "").trim();
    let n = 0;
    const stream = await streamCsv(env, r.url);
    for await (const row of parseCsvObjects(stream)) {
      if (!isRealCollisionRow(row)) continue; // skip padding rows
      records.push({ year, row });
      n++;
    }
    console.log(`  parsed ${year}: ${n} casualties`);
  }

  const { summary } = buildCollisions(records);
  console.log(
    `  ${summary.totalCasualties} casualties ${summary.coverage.from}–${summary.coverage.to} · ` +
    `${summary.totalKsi} KSI · ${(summary.changeSinceStart * 100).toFixed(0)}% vs first year`
  );

  await kvBulkPut([
    { key: "collisions:summary", value: JSON.stringify(summary) },
    { key: "collisions:hash", value: fingerprint },
  ]);
  console.log("  wrote collisions:summary, collisions:hash");
}

// Read a small metadata CSV to row objects, skipping any preamble lines before
// the real header (the cycle sites doc has a title row first).
async function fetchCsvRows(url) {
  const stream = await streamCsv(env, url);
  const reader = stream.getReader();
  const dec = new TextDecoder("windows-1252");
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  text += dec.decode();
  const lines = text.split(/\r?\n/);
  let headerIdx = lines.findIndex((l) => /site\s*id/i.test(l));
  if (headerIdx < 0) headerIdx = 0;
  const trimmed = lines.slice(headerIdx).join("\n");
  const rows = [];
  for await (const row of parseCsvObjects(new Response(trimmed).body)) rows.push(row);
  return rows;
}

// Cycle & traffic counters share one aggregator (identical schema). Each file is
// one month of hourly per-lane counts; we bucket by the in-row date rather than
// trusting the file titles, which are unreliable.
async function refreshCounts(kind) {
  const datasetId = COUNTS_DATASETS[kind];
  console.log(`Counts(${kind}): aggregating (version ${COUNTS_VERSION})…`);
  const dataset = await getDataset(env, datasetId);
  const resources = listCsvResources(dataset);
  const siteDocs = resources.filter((r) => (r.size || 0) < COUNTS_MIN_BYTES);
  const dataFiles = resources.filter(
    (r) => (r.size || 0) >= COUNTS_MIN_BYTES && (r.size || 0) <= COUNTS_MAX_BYTES
  );
  if (!dataFiles.length) {
    console.warn(`  no monthly count files found for ${kind} — skipping`);
    return;
  }

  const fingerprint =
    `${COUNTS_VERSION}:` +
    [...dataFiles, ...siteDocs].map((r) => r.hash || `${r.id}:${r.size}`).sort().join(",");
  const lastFingerprint = await kvGet(`counts:${kind}:hash`);
  if (FORCE !== "1" && lastFingerprint === fingerprint) {
    console.log("  ✓ unchanged, skipping");
    return;
  }

  // Recorder locations (may be spread across more than one small doc).
  const siteRows = [];
  for (const doc of siteDocs) {
    try {
      siteRows.push(...(await fetchCsvRows(doc.url)));
    } catch (err) {
      console.warn(`  couldn't read site doc "${doc.title}": ${err.message}`);
    }
  }
  const sites = parseSites(kind, siteRows);
  console.log(`  ${sites.size} recorder locations`);

  // Stream every monthly file through the accumulator.
  const acc = new Map();
  let ok = 0;
  for (const r of dataFiles) {
    try {
      const stream = await streamCsv(env, r.url);
      for await (const row of parseCsvObjects(stream)) accumulateCountRow(acc, row);
      ok++;
    } catch (err) {
      console.warn(`  failed on "${r.title}": ${err.message}`);
    }
  }

  const summary = finaliseCounts(kind, acc, sites);
  const latest = summary.latest;
  console.log(
    `  ${ok}/${dataFiles.length} files · ${summary.coverage.from}–${summary.coverage.to} · ` +
    `${summary.activeRecorders} recorders · latest ${latest?.year} mean daily flow ${latest?.meanDailyFlow} ${summary.unit}/recorder`
  );

  await kvBulkPut([
    { key: `counts:${kind}:summary`, value: JSON.stringify(summary) },
    { key: `counts:${kind}:hash`, value: fingerprint },
  ]);
  console.log(`  wrote counts:${kind}:summary, counts:${kind}:hash`);
}

// Footfall: ~575 overlapping CSVs across three schema eras. We ignore titles,
// key every row by (date, hour, camera) and keep the max on collision (see
// footfall.js), then aggregate the deduped slots.
async function refreshFootfall() {
  console.log(`Footfall: aggregating (version ${FOOTFALL_VERSION})…`);
  const dataset = await getDataset(env, FOOTFALL_DATASET_ID);
  const resources = listCsvResources(dataset); // CSV only — PDFs/xlsx ignored
  if (!resources.length) {
    console.warn("  no CSV resources found — skipping footfall");
    return;
  }

  const fingerprint =
    `${FOOTFALL_VERSION}:` + resources.map((r) => r.hash || `${r.id}:${r.size}`).sort().join(",");
  const lastFingerprint = await kvGet("footfall:hash");
  if (FORCE !== "1" && lastFingerprint === fingerprint) {
    console.log("  ✓ unchanged, skipping");
    return;
  }

  const map = new Map();
  let ok = 0;
  for (const r of resources) {
    try {
      const stream = await streamCsv(env, r.url);
      for await (const row of parseCsvObjects(stream)) accumulateFootRow(map, row);
      ok++;
    } catch (err) {
      console.warn(`  failed on "${r.title}": ${err.message}`);
    }
  }
  console.log(`  ${ok}/${resources.length} files → ${map.size.toLocaleString()} deduped hourly slots`);

  const summary = finaliseFootfall(map);
  console.log(
    `  ${summary.cameras} cameras · ${summary.coverage.from}–${summary.coverage.to} · ` +
    `latest ${summary.latest?.year} mean daily footfall ${summary.latest?.meanDaily}/camera`
  );

  await kvBulkPut([
    { key: "footfall:summary", value: JSON.stringify(summary) },
    { key: "footfall:hash", value: fingerprint },
  ]);
  console.log("  wrote footfall:summary, footfall:hash");
}

// Council tax: one small precepts CSV covering every year since 1993. The
// dataset also holds per-year "charges by band" and parish files, but the
// precepts file alone carries the whole story; the rest are ignored.
async function refreshCouncilTax() {
  console.log(`Council tax: aggregating (version ${COUNCILTAX_VERSION})…`);
  const dataset = await getDataset(env, COUNCILTAX_DATASET_ID);
  const resources = listCsvResources(dataset).filter((r) =>
    /major council tax precepts/i.test(r.title)
  );
  if (!resources.length) {
    console.warn("  no precepts CSV found — skipping council tax");
    return;
  }
  // Titles end "1993-2024", "1993-2026", … — the biggest end year is current.
  const endYear = (r) => Number((r.title.match(/-\s*(\d{4})/) || [])[1] || 0);
  resources.sort((a, b) => endYear(b) - endYear(a));
  const resource = resources[0];

  const fingerprint = `${COUNCILTAX_VERSION}:${resource.hash || `${resource.id}:${resource.size}`}`;
  const lastFingerprint = await kvGet("counciltax:hash");
  if (FORCE !== "1" && lastFingerprint === fingerprint) {
    console.log("  ✓ unchanged, skipping");
    return;
  }

  const rows = [];
  const stream = await streamCsv(env, resource.url);
  for await (const row of parseCsvObjects(stream)) rows.push(row);
  const summary = buildCouncilTax(rows, resource);
  console.log(
    `  "${resource.title}": ${summary.years.length} years · band D ${summary.latest?.year} ` +
    `£${summary.latest?.bandD.total} (${(summary.changeYoY * 100).toFixed(1)}% YoY)`
  );

  await kvBulkPut([
    { key: "counciltax:summary", value: JSON.stringify(summary) },
    { key: "counciltax:hash", value: fingerprint },
  ]);
  console.log("  wrote counciltax:summary, counciltax:hash");
}

// Council housing: bids (many quarterly/annual files), stock by ward (one
// cumulative file, latest wins), and the latest tenanted-stock snapshot.
async function refreshHousing() {
  console.log(`Housing: aggregating (version ${HOUSING_VERSION})…`);

  const [bidsDs, stockDs, tenDs] = await Promise.all([
    getDataset(env, HOUSING_DATASETS.bids),
    getDataset(env, HOUSING_DATASETS.stock),
    getDataset(env, HOUSING_DATASETS.tenanted),
  ]);

  // Bids: every data file (the two lookup-table "guidance" docs are not data).
  const bidFiles = listCsvResources(bidsDs).filter((r) => !/guidance/i.test(r.title));

  // Stock: cumulative re-publishes — the file with the biggest year wins.
  const maxYear = (r) => Math.max(0, ...(r.title.match(/\d{4}/g) || []).map(Number));
  const stockFile = listCsvResources(stockDs).sort((a, b) => maxYear(b) - maxYear(a))[0];

  // Tenanted: snapshots titled "31/03/2026.csv" — latest date wins.
  const snapDate = (r) => {
    const m = r.title.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
  };
  const tenFile = listCsvResources(tenDs).sort((a, b) => snapDate(b).localeCompare(snapDate(a)))[0];

  if (!bidFiles.length || !stockFile || !tenFile) {
    console.warn("  missing source files — skipping housing");
    return;
  }

  const fingerprint =
    `${HOUSING_VERSION}:` +
    [...bidFiles, stockFile, tenFile].map((r) => r.hash || `${r.id}:${r.size}`).sort().join(",");
  const lastFingerprint = await kvGet("housing:hash");
  if (FORCE !== "1" && lastFingerprint === fingerprint) {
    console.log("  ✓ unchanged, skipping");
    return;
  }

  // Some files (2019 Q3 on) drop the date column entirely — the fallback
  // period comes from the title ("01/07/2019 - 30/09/2019").
  const titlePeriod = (title) => {
    const m = title.match(/^(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m || m[3] !== m[6]) return null;
    const months = [];
    for (let mo = Number(m[2]); mo <= Number(m[5]); mo++) months.push(mo);
    return { year: Number(m[3]), months };
  };

  const bidsAcc = new Map();
  let ok = 0;
  for (const r of bidFiles) {
    const fallback = titlePeriod(r.title);
    try {
      const stream = await streamCsvWithRetry(r.url);
      for await (const row of parseCsvObjects(stream)) accumulateBidRow(bidsAcc, row, fallback);
      ok++;
    } catch (err) {
      console.warn(`  failed on bids "${r.title}": ${err.message}`);
    }
  }
  console.log(`  bids: ${ok}/${bidFiles.length} files`);
  const bidsIncomplete = ok < bidFiles.length;

  const stockRecords = [];
  for await (const rec of parseCsvStream(await streamCsv(env, stockFile.url))) stockRecords.push(rec);
  const stockYearly = parseStockRecords(stockRecords);
  console.log(`  stock: "${stockFile.title}" → ${stockYearly.length} years`);

  const tenAcc = newTenantedAcc();
  for await (const row of parseCsvObjects(await streamCsv(env, tenFile.url))) {
    accumulateTenantedRow(tenAcc, row);
  }
  console.log(`  tenanted: "${tenFile.title}" → ${tenAcc.total.toLocaleString()} properties`);

  const summary = finaliseHousing(bidsAcc, stockYearly, tenAcc, { snapshotDate: snapDate(tenFile) });
  const latestFull = summary.bids.yearly.filter((y) => y.monthsCovered === 12).pop();
  console.log(
    `  ${summary.bids.yearly.length} bid years · ${latestFull?.year}: ${latestFull?.lets} lets, ` +
    `mean ${latestFull?.meanEoi} bids · stock ${summary.stock.latest?.total?.toLocaleString()} ` +
    `(${(summary.stock.change * 100).toFixed(1)}% since ${summary.stock.first?.fy})`
  );

  // On partial fetches, publish the summary but withhold the fingerprint so
  // the next nightly run retries the missing files.
  const writes = [{ key: "housing:summary", value: JSON.stringify(summary) }];
  if (!bidsIncomplete) writes.push({ key: "housing:hash", value: fingerprint });
  await kvBulkPut(writes);
  console.log(`  wrote housing:summary${bidsIncomplete ? " (hash withheld — will retry files next run)" : ", housing:hash"}`);
}

// School places: one resource per entry year across four datasets. Files with
// unrecognisable schemas (the pre-2019 era) are skipped file-by-file — the
// parsers return null rather than guessing.
async function refreshSchools() {
  console.log(`Schools: aggregating (version ${SCHOOLS_VERSION})…`);

  const datasets = {};
  for (const [key, id] of Object.entries(SCHOOLS_DATASETS)) {
    datasets[key] = await getDataset(env, id);
  }
  const usable = (ds) =>
    listCsvResources(ds).filter(
      (r) => !/historical/i.test(r.title) && /20\d{2}/.test(r.title)
    );
  const files = Object.fromEntries(
    Object.entries(datasets).map(([key, ds]) => [key, usable(ds)])
  );

  const all = Object.values(files).flat();
  const fingerprint =
    `${SCHOOLS_VERSION}:` + all.map((r) => r.hash || `${r.id}:${r.size}`).sort().join(",");
  const lastFingerprint = await kvGet("schools:hash");
  if (FORCE !== "1" && lastFingerprint === fingerprint) {
    console.log("  ✓ unchanged, skipping");
    return;
  }

  let fetchFailures = 0;
  async function loadYearMap(resources, parse, label) {
    const byYear = new Map();
    for (const r of resources) {
      const year = Number((r.title.match(/20\d{2}/) || [])[0]);
      if (!year) continue;
      try {
        const records = [];
        for await (const rec of parseCsvStream(await streamCsvWithRetry(r.url))) records.push(rec);
        const rows = parse(records);
        if (rows) byYear.set(year, rows);
        else console.log(`  ${label} ${year}: schema not recognised, skipped ("${r.title}")`);
      } catch (err) {
        fetchFailures++;
        console.warn(`  ${label} failed on "${r.title}": ${err.message}`);
      }
    }
    return byYear;
  }

  const summary = buildSchools(
    {
      prefsByYear: await loadYearMap(files.primaryPrefs, parsePrefsRecords, "primary prefs"),
      allocByYear: await loadYearMap(files.primaryAlloc, parseAllocRecords, "primary alloc"),
    },
    {
      prefsByYear: await loadYearMap(files.secondaryPrefs, parsePrefsRecords, "secondary prefs"),
      allocByYear: await loadYearMap(files.secondaryAlloc, parseAllocRecords, "secondary alloc"),
    }
  );

  for (const phase of ["primary", "secondary"]) {
    const p = summary[phase];
    const latest = p.yearly.filter((y) => y.firstPrefs !== undefined).pop();
    console.log(
      `  ${phase}: ${p.yearly.length} years · ${latest?.year} first prefs ${latest?.firstPrefs?.toLocaleString()} · ` +
      `competition table ${p.competition.length} schools (${p.competitionYear})`
    );
  }

  // On partial fetches, publish the summary but withhold the fingerprint so
  // the next nightly run retries the missing files.
  const writes = [{ key: "schools:summary", value: JSON.stringify(summary) }];
  if (fetchFailures === 0) writes.push({ key: "schools:hash", value: fingerprint });
  await kvBulkPut(writes);
  console.log(`  wrote schools:summary${fetchFailures ? " (hash withheld — will retry files next run)" : ", schools:hash"}`);
}

// Air quality: DEFRA UK-AIR hourly CSVs for Leeds Centre, one per year,
// fetched directly (not a Datamillnorth resource). Ratified years never
// change, so the fingerprint is built from each year's ETag/Last-Modified
// via cheap HEAD requests; any header change (or a new year appearing)
// triggers a full re-aggregation, since the summary spans every year.
async function refreshAirQuality() {
  console.log(`Air quality: aggregating (version ${AIR_VERSION})…`);

  const currentYear = new Date().getUTCFullYear();
  const years = [];
  for (let y = AIR_FIRST_YEAR; y <= currentYear; y++) years.push(y);

  let headFailures = 0;
  const prints = await pMap(years, Number(CONCURRENCY), async (year) => {
    try {
      const res = await fetch(airYearUrl(year), { method: "HEAD" });
      if (!res.ok) return `${year}:absent`; // next year's file before it exists
      const sig =
        (res.headers.get("etag") || "") +
        ":" +
        (res.headers.get("last-modified") || "") +
        ":" +
        (res.headers.get("content-length") || "");
      // No usable headers → can't prove it's unchanged; force a refresh.
      return sig === "::" ? `${year}:unknown-${Date.now()}` : `${year}:${sig}`;
    } catch (err) {
      headFailures++;
      console.warn(`  HEAD failed for ${year}: ${err.message}`);
      return `${year}:error`;
    }
  });

  const fingerprint = `${AIR_VERSION}:` + prints.join(",");
  const lastFingerprint = await kvGet("air:hash");
  if (FORCE !== "1" && headFailures === 0 && lastFingerprint === fingerprint) {
    console.log("  ✓ unchanged, skipping");
    return;
  }

  let fetchFailures = 0;
  const yearFiles = [];
  for (const year of years) {
    try {
      const res = await fetch(airYearUrl(year));
      if (res.status === 404) continue; // year not published (yet)
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      yearFiles.push({ year, text: await res.text() });
    } catch (err) {
      fetchFailures++;
      console.warn(`  failed on ${year}: ${err.message}`);
    }
  }
  if (!yearFiles.length) {
    console.warn("  no year files fetched — skipping air quality");
    return;
  }

  const summary = await buildAirQuality(yearFiles);
  const latest = summary.years.filter((y) => y.no2.mean !== null).pop();
  console.log(
    `  ${yearFiles.length} year files · ${summary.coverage.from}–${summary.coverage.to} ` +
    `(readings to ${summary.coverage.latestReading}) · ` +
    `latest full year ${latest?.year}: NO₂ ${latest?.no2.mean}, PM2.5 ${latest?.pm25.mean}, ` +
    `PM10 ${latest?.pm10.mean} ${summary.unit}`
  );

  // On partial fetches, publish the summary but withhold the fingerprint so
  // the next nightly run retries the missing files.
  const partial = fetchFailures > 0 || headFailures > 0;
  const writes = [{ key: "air:summary", value: JSON.stringify(summary) }];
  if (!partial) writes.push({ key: "air:hash", value: fingerprint });
  await kvBulkPut(writes);
  console.log(`  wrote air:summary${partial ? " (hash withheld — will retry next run)" : ", air:hash"}`);
}

// Fetch a whole file with retries. Fingerprint = ETag (S3 sends one) or
// content-length — enough to detect a re-publish.
async function fetchBytesWithRetry(url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "leedsdata.co.uk nightly refresh" } });
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const fingerprint =
        res.headers.get("etag") || res.headers.get("content-length") || String(bytes.length);
      return { bytes, fingerprint };
    } catch (err) {
      if (i >= attempts) throw err;
      const pause = 3000 * i * i;
      console.log(`    retrying in ${pause / 1000}s (${err.message})`);
      await sleep(pause);
    }
  }
}

// Recycling & waste: DEFRA's LA-collected-waste ODS (recycling/landfill/
// residual indicators) + the two per-authority fly-tipping CSVs. The ODS
// media URL changes every March release, so it's discovered via the GOV.UK
// content API; the fly-tipping links move too (statistics_YYYY path) and the
// content API returns no attachments for that page, so they're scraped off
// the data.gov.uk dataset page. If ANY of the three fetches fails, we bail
// without writing summary or hash — the stored summary stays complete and
// the withheld hash makes the next nightly run retry everything.
async function refreshWaste() {
  console.log(`Waste: aggregating (version ${WASTE_VERSION})…`);

  const content = await (await fetch(WASTE_CONTENT_API)).json();
  const attachment = (content.details?.attachments || []).find((a) =>
    /^local authority collected waste generation annual results/i.test(a.title || "")
  );
  if (!attachment?.url) {
    console.warn("  waste ODS attachment not found on GOV.UK — skipping waste");
    return;
  }

  const page = await (await fetch(FLYTIP_DATASET_PAGE)).text();
  const csvUrl = (kind) => {
    const re = new RegExp(`https://[^"']*Local\\+authority\\+flytipping\\+${kind}[^"']*\\.csv`, "g");
    // Several releases can be linked; the sort makes the newest
    // (statistics_YYYY / year-range) win.
    return [...new Set(page.match(re) || [])].sort().pop() || null;
  };
  const incidentsUrl = csvUrl("incidents");
  const actionsUrl = csvUrl("actions");
  if (!incidentsUrl || !actionsUrl) {
    console.warn("  fly-tipping CSV links not found on data.gov.uk — skipping waste");
    return;
  }

  let ods, incidents, actions;
  try {
    ods = await fetchBytesWithRetry(attachment.url);
    incidents = await fetchBytesWithRetry(incidentsUrl);
    actions = await fetchBytesWithRetry(actionsUrl);
  } catch (err) {
    console.warn(`  fetch failed (${err.message}) — skipping waste, hash withheld so next run retries`);
    return;
  }

  const fingerprint =
    `${WASTE_VERSION}:` + [ods, incidents, actions].map((f) => f.fingerprint).join(",");
  const lastFingerprint = await kvGet("waste:hash");
  if (FORCE !== "1" && lastFingerprint === fingerprint) {
    console.log("  ✓ unchanged, skipping");
    return;
  }

  const summary = await buildWaste({
    odsBuffer: ods.bytes,
    incidentsCsv: incidents.bytes,
    actionsCsv: actions.bytes,
    meta: { odsUrl: attachment.url },
  });

  const latest = summary.recycling.leeds.at(-1);
  const england = summary.recycling.england.at(-1);
  console.log(
    `  recycling: ${summary.recycling.leeds.length} Leeds years · latest ${latest?.year} ` +
    `${latest?.recycling}% (England ${england?.rate}%) · landfill ${latest?.landfill}% · ` +
    `residual ${latest?.residualKg} kg/household`
  );
  console.log(
    `  fly-tipping: ${summary.flyTipping.yearly.length} years · ` +
    `${summary.flyTipping.latest?.year}: ${summary.flyTipping.latest?.incidents?.toLocaleString()} incidents`
  );

  await kvBulkPut([
    { key: "waste:summary", value: JSON.stringify(summary) },
    { key: "waste:hash", value: fingerprint },
  ]);
  console.log("  wrote waste:summary, waste:hash");
}

// Planning: the site's first non-Datamillnorth topic. Stats come from MHCLG's
// PS1/PS2 quarterly open-data CSVs (~12 MB + ~58 MB), discovered via the
// GOV.UK content API because the media URLs change every publication — which
// also makes the URL pair a free fingerprint (GOV.UK asset URLs are
// immutable), so the 70 MB download is skipped when nothing changed.
// The PlanIt map layer (last 12 months of Leeds applications) is fetched in
// monthly windows so no single query approaches PlanIt's 5,000-result cap.
// PlanIt is volunteer-run: its failure only logs a warning, keeps the
// last-good planning:apps blob, and never sinks the stats refresh.
async function refreshPlanning() {
  console.log(`Planning: aggregating (version ${PLANNING_VERSION})…`);
  let statsError = null;

  // --- MHCLG PS1/PS2 statistics --------------------------------------------
  try {
    const contentRes = await fetch(PLANNING_CONTENT_API, { headers: { accept: "application/json" } });
    if (!contentRes.ok) throw new Error(`GOV.UK content API ${contentRes.status}`);
    const content = await contentRes.json();
    const attachments = content.details?.attachments || [];
    // Anchored on "District" — the same page carries County (CPS1/CPS2) files.
    const findCsv = (re) => attachments.find((a) => re.test(a.title || ""))?.url;
    const ps1Url = findCsv(/^District planning application statistics \(PS1\) - full dataset$/);
    const ps2Url = findCsv(/^District planning application statistics \(PS2\) - full dataset$/);
    if (!ps1Url || !ps2Url) throw new Error("PS1/PS2 full-dataset attachments not found");

    const fingerprint = `${PLANNING_VERSION}:${ps1Url},${ps2Url}`;
    const lastFingerprint = await kvGet("planning:hash");
    if (FORCE !== "1" && lastFingerprint === fingerprint) {
      console.log("  ✓ MHCLG stats unchanged, skipping");
    } else {
      const download = async (url, label) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${label} fetch ${res.status}`);
        return res.text();
      };
      const [ps1Csv, ps2Csv] = await Promise.all([download(ps1Url, "PS1"), download(ps2Url, "PS2")]);
      const summary = await buildPlanning({ ps1Csv, ps2Csv, sources: { ps1: ps1Url, ps2: ps2Url } });
      console.log(
        `  ${summary.quarters.length} quarters ${summary.coverage.from} → ${summary.coverage.to} · ` +
        `latest ${summary.tiles?.quarter}: ${summary.tiles?.decisions} decisions, ` +
        `${Math.round((summary.tiles?.approvalShare ?? 0) * 100)}% approved`
      );
      // Summary and hash are written together, and only after a successful
      // aggregate of BOTH files — a partial fetch throws above, keeps the
      // last-good summary and withholds the hash so the next run retries.
      await kvBulkPut([
        { key: "planning:summary", value: JSON.stringify(summary) },
        { key: "planning:hash", value: fingerprint },
      ]);
      console.log("  wrote planning:summary, planning:hash");
    }
  } catch (err) {
    statsError = err;
    console.warn(`  MHCLG stats failed (hash withheld — will retry next run): ${err.message}`);
  }

  // --- PlanIt map layer (independent of the stats) -------------------------
  //
  // Incremental by design: PlanIt's per-IP rate budget (~15–20 requests
  // before a 12–20-minute Retry-After, observed July 2026 — and GitHub
  // Actions' shared egress IPs are often already drained or blocked) is
  // nowhere near a full 12-month sweep. So the canonical last-12-months
  // entry set lives in KV (planning:appsrc, keyed by application name), and
  // each night fetches only the two recent monthly windows PLUS one older
  // "backfill cursor" window that cycles 2→11 across nights (~9 requests
  // total). Full coverage assembles over ~10 nights, stale patches self-heal
  // on the same rotation, fetched entries merge over the stored ones,
  // anything past 12 months ages out, and the public planning:apps payload
  // is rebuilt from the merged set.
  const end = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const monthEdge = (m) => new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - m, end.getUTCDate()));

  let stored = {};
  try {
    stored = JSON.parse((await kvGet("planning:appsrc")) || "{}");
  } catch {
    stored = {};
  }
  const cursorRaw = Number(await kvGet("planning:planitcursor"));
  const cursor = cursorRaw >= PLANIT_RECENT_MONTHS && cursorRaw < 12 ? cursorRaw : PLANIT_RECENT_MONTHS;

  const records = [];
  let requests = 0;
  let cursorDone = false;
  let planitFailure = null;
  try {
    const planitGet = async (url) => {
      for (let attempt = 1; ; attempt++) {
        // PlanIt 403s Node's default "node" user-agent — identify ourselves.
        const res = await fetch(url, {
          headers: {
            accept: "application/json",
            "user-agent": "leedsdata.co.uk nightly refresh (github.com/danstone24/leeds-data)",
          },
        });
        if (res.status === 429 && attempt < 4) {
          const wait = Number(res.headers.get("retry-after")) || 30 * attempt;
          // The job runs under a 15-minute Actions timeout; a long Retry-After
          // means "not tonight" — merge whatever we already fetched and let
          // the next run continue rather than sleeping the workflow to death.
          if (wait > 180) throw new Error(`PlanIt rate-limited (retry-after ${wait}s) — giving up this run`);
          console.log(`    PlanIt 429 — waiting ${wait}s`);
          await sleep(wait * 1000);
          continue;
        }
        if (!res.ok) throw new Error(`PlanIt ${res.status}`);
        return res.json();
      }
    };

    const windows = [...Array(PLANIT_RECENT_MONTHS).keys(), cursor];
    outer: for (const m of windows) {
      const from = iso(monthEdge(m + 1));
      const to = iso(monthEdge(m));
      for (let page = 1; ; page++) {
        if (requests >= PLANIT_MAX_REQUESTS || records.length >= PLANIT_MAX_RECORDS) break outer;
        requests++;
        const body = await planitGet(
          `https://www.planit.org.uk/api/applics/json?auth=Leeds&pg_sz=${PLANIT_PAGE_SIZE}` +
          `&page=${page}&start_date=${from}&end_date=${to}`
        );
        records.push(...(body.records || []));
        if (!(body.records || []).length || (body.to ?? 0) + 1 >= (body.total ?? 0)) break;
        await sleep(3000); // polite paging, per PlanIt's API guidance
      }
      if (m === cursor) cursorDone = true; // fetched all of the cursor window's pages
      await sleep(3000);
    }
  } catch (err) {
    planitFailure = err;
  }

  try {
    // Merge fetched entries over the stored set — partial fetches are safe,
    // every fetched record is current. Then age out anything whose most
    // recent date is past the 12-month window.
    for (const r of records) {
      const entry = planitEntry(r);
      if (entry) stored[entry.name] = entry;
    }
    const cutoff = iso(monthEdge(12));
    const entries = Object.values(stored).filter(
      (e) => (e.decided || e.start || "9999") >= cutoff
    );

    if (records.length > 0) {
      const apps = buildPlanitApps(entries, { window: { from: cutoff, to: iso(end) } });
      console.log(
        `  PlanIt: ${requests} requests · ${records.length} fetched (cursor window ${cursor}` +
        `${cursorDone ? "" : " incomplete"}) · ${apps.count} in window · ` +
        `${apps.geocoded} geocoded · ${apps.large.length} large` +
        (planitFailure ? ` (partial: ${planitFailure.message})` : "")
      );
      const writes = [
        { key: "planning:appsrc", value: JSON.stringify(Object.fromEntries(entries.map((e) => [e.name, e]))) },
        { key: "planning:apps", value: JSON.stringify(apps) },
      ];
      if (cursorDone) {
        const next = cursor + 1 < 12 ? cursor + 1 : PLANIT_RECENT_MONTHS;
        writes.push({ key: "planning:planitcursor", value: String(next) });
      }
      await kvBulkPut(writes);
      console.log("  wrote planning:apps, planning:appsrc");
    } else {
      console.warn(
        `  PlanIt returned nothing usable — keeping last-good planning:apps` +
        (planitFailure ? ` (${planitFailure.message})` : "")
      );
    }
  } catch (err) {
    console.warn(`  PlanIt merge failed (map layer only — stats unaffected, keeping last-good planning:apps): ${err.message}`);
  }

  if (statsError) throw statsError; // surface in CI after PlanIt has had its go
}

function monthLabel(m) {
  const [y, mo] = m.split("-");
  const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${names[Number(mo) - 1]} ${y}`;
}

// Run every dataset. Each is isolated so one failing doesn't sink the others;
// we exit non-zero if any of them threw so CI surfaces the problem.
async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] Refresh started`);

  const datasets = [
    ["spending", () => refreshSpending(startedAt)],
    ["potholes", () => refreshPotholes()],
    ["collisions", () => refreshCollisions()],
    ["cycle", () => refreshCounts("cycle")],
    ["traffic", () => refreshCounts("traffic")],
    ["footfall", () => refreshFootfall()],
    ["counciltax", () => refreshCouncilTax()],
    ["housing", () => refreshHousing()],
    ["schools", () => refreshSchools()],
    ["air", () => refreshAirQuality()],
    ["waste", () => refreshWaste()],
    ["planning", () => refreshPlanning()],
  ];

  let failed = false;
  for (const [name, run] of datasets) {
    try {
      await run();
    } catch (err) {
      failed = true;
      console.error(`Dataset "${name}" failed:`, err);
    }
  }

  await kvBulkPut([{ key: "meta:last-refresh", value: startedAt }]);
  console.log(`[${new Date().toISOString()}] Refresh finished${failed ? " (with errors)" : ""}.`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error("Refresh failed:", err);
  process.exit(1);
});
