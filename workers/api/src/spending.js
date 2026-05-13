// Council spending aggregator.
//
// Datamillnorth dataset: council-spending (id 2gpp0). Monthly CSVs of every
// council transaction. We stream-parse each month, build a compact summary,
// and stash it in KV. The Worker serves those precomputed blobs to the
// frontend so we never have to send the raw CSV to the browser.
//
// Schema (see docs/data-sources.md for the long version):
//   Effective Date, Organisational Unit, Service Division Label,
//   Category Internal Name, Purpose, Amount, Beneficiary Name,
//   Capital Or Revenue, Procurement Card, …

import { getDataset, listCsvResources, streamCsv } from "./datamillnorth.js";
import { parseCsvObjects } from "./csv.js";

const DATASET_ID = "2gpp0";
const TOP_SUPPLIERS = 20;
const LARGEST_TXNS = 10;

// Per month: keep one summary blob in KV at key `spending:summary:<yyyy-mm>`.
// Rolling trend: `spending:trend` — an array of { month, total, txnCount }.
// Latest pointer: `spending:latest` — `<yyyy-mm>` of the most recent month available.

export async function refreshSpending(env) {
  const dataset = await getDataset(env, DATASET_ID);
  const resources = listCsvResources(dataset);

  // Group by month, prefer the larger of the two CSVs published for each month.
  const byMonth = new Map();
  for (const r of resources) {
    if (!r.timeframeTo) continue;
    const month = r.timeframeTo.slice(0, 7); // YYYY-MM
    const existing = byMonth.get(month);
    if (!existing || r.size > existing.size) byMonth.set(month, r);
  }

  const months = [...byMonth.keys()].sort().reverse();
  const trend = [];
  let latestMonth = null;

  // Process the most recent 24 months. For older months we trust whatever's
  // already in the trend cache from previous runs (idempotent — full backfill
  // happens via scripts/backfill.js on first deploy).
  const target = months.slice(0, 24);

  for (const month of target.reverse()) {
    const resource = byMonth.get(month);
    const summaryKey = `spending:summary:${month}`;
    const hashKey = `spending:hash:${month}`;
    const lastHash = await env.CACHE.get(hashKey);

    if (lastHash === resource.hash) {
      // Unchanged — pull the existing trend entry from the stored summary.
      const cached = await env.CACHE.get(summaryKey, { type: "json" });
      if (cached) {
        trend.push({ month, total: cached.totalAmount, txnCount: cached.transactionCount });
        latestMonth = month;
        continue;
      }
    }

    const summary = await buildMonthlySummary(env, month, resource);
    await env.CACHE.put(summaryKey, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 90 });
    await env.CACHE.put(hashKey, resource.hash || "");
    trend.push({ month, total: summary.totalAmount, txnCount: summary.transactionCount });
    latestMonth = month;
  }

  await env.CACHE.put("spending:trend", JSON.stringify({ months: trend, updated: new Date().toISOString() }));
  if (latestMonth) await env.CACHE.put("spending:latest", latestMonth);
  await env.CACHE.put("meta:last-refresh", new Date().toISOString());
}

async function buildMonthlySummary(env, month, resource) {
  const stream = await streamCsv(env, resource.url);

  const byUnit = new Map();   // unit -> { amount, divisions: Map<name, amount> }
  const bySupplier = new Map(); // name -> { amount, count }
  let totalAmount = 0;
  let transactionCount = 0;
  let capital = 0;
  let revenue = 0;
  let procCardAmount = 0;
  const largest = []; // top-N min-heap-ish via sorted insertion

  for await (const row of parseCsvObjects(stream)) {
    const amountRaw = row["Amount"];
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount)) continue;

    transactionCount++;
    totalAmount += amount;

    const unit = (row["Organisational Unit"] || "Unknown").trim();
    const division = (row["Service Division Label"] || "Unknown").trim();
    const supplier = (row["Beneficiary Name"] || "Unknown").trim();
    const cr = (row["Capital Or Revenue"] || "").trim().toUpperCase();
    const pcard = (row["Procurement Card"] || "").trim().toLowerCase() === "yes";

    const u = byUnit.get(unit) || { amount: 0, divisions: new Map() };
    u.amount += amount;
    u.divisions.set(division, (u.divisions.get(division) || 0) + amount);
    byUnit.set(unit, u);

    const s = bySupplier.get(supplier) || { amount: 0, count: 0 };
    s.amount += amount;
    s.count += 1;
    bySupplier.set(supplier, s);

    if (cr === "C") capital += amount;
    else if (cr === "R") revenue += amount;

    if (pcard) procCardAmount += amount;

    if (largest.length < LARGEST_TXNS || amount > largest[largest.length - 1].amount) {
      largest.push({
        date: parseUkDate(row["Payment Date"]),
        amount,
        beneficiary: supplier,
        purpose: (row["Purpose"] || "").trim(),
        unit,
      });
      largest.sort((a, b) => b.amount - a.amount);
      if (largest.length > LARGEST_TXNS) largest.length = LARGEST_TXNS;
    }
  }

  // Flatten unit map for output, sorted by amount desc. Divisions sorted desc inside each unit.
  const byOrganisationalUnit = [...byUnit.entries()]
    .map(([name, { amount, divisions }]) => ({
      name,
      amount: round2(amount),
      share: totalAmount ? amount / totalAmount : 0,
      divisions: [...divisions.entries()]
        .map(([dname, damount]) => ({ name: dname, amount: round2(damount) }))
        .sort((a, b) => b.amount - a.amount),
    }))
    .sort((a, b) => b.amount - a.amount);

  const topSuppliers = [...bySupplier.entries()]
    .map(([name, { amount, count }]) => ({ name, amount: round2(amount), count }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, TOP_SUPPLIERS);

  return {
    month,
    monthLabel: formatMonthLabel(month),
    totalAmount: round2(totalAmount),
    transactionCount,
    averageTransaction: transactionCount ? round2(totalAmount / transactionCount) : 0,
    byOrganisationalUnit,
    topSuppliers,
    capitalVsRevenue: { capital: round2(capital), revenue: round2(revenue) },
    procurementCardAmount: round2(procCardAmount),
    procurementCardShare: totalAmount ? procCardAmount / totalAmount : 0,
    largestTransactions: largest.map((t) => ({ ...t, amount: round2(t.amount) })),
    source: `https://datamillnorth.org/dataset/council-spending-${DATASET_ID}`,
    updated: new Date().toISOString(),
  };
}

function parseUkDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}

function formatMonthLabel(month) {
  const [y, m] = month.split("-");
  const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${names[Number(m) - 1]} ${y}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Route handlers ------------------------------------------------------------

export async function handleSummary(env, month) {
  const target = month || (await env.CACHE.get("spending:latest"));
  if (!target) return null;
  return env.CACHE.get(`spending:summary:${target}`, { type: "json" });
}

export async function handleTrend(env) {
  return env.CACHE.get("spending:trend", { type: "json" });
}

export async function handleAvailableMonths(env) {
  const trend = await env.CACHE.get("spending:trend", { type: "json" });
  if (!trend) return null;
  return { months: trend.months.map((m) => m.month).sort().reverse() };
}
