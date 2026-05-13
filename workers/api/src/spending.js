// Council spending aggregator.
//
// Datamillnorth dataset: council-spending (id 2gpp0). Monthly CSVs of every
// council transaction. The heavy aggregation happens OUTSIDE the Worker —
// in scripts/refresh.mjs, run by GitHub Actions — because Workers Free
// caps CPU at 10ms per invocation and parsing a 6MB CSV blows that budget.
//
// The Worker just reads precomputed summary blobs from KV via the handlers
// below. The exported `buildMonthlySummary` function is shared with the
// refresh script so both sides agree on the schema.

import { parseCsvObjects } from "./csv.js";

const DATASET_ID = "2gpp0";
const TOP_SUPPLIERS = 20;
const LARGEST_TXNS = 10;

// Pure aggregation — takes a CSV byte stream, returns a summary object.
// No KV, no fetch — safe to run anywhere.
export async function buildMonthlySummary(month, resource, stream) {
  const byUnit = new Map();
  const bySupplier = new Map();
  let totalAmount = 0;
  let transactionCount = 0;
  let capital = 0;
  let revenue = 0;
  let procCardAmount = 0;
  const largest = [];

  for await (const row of parseCsvObjects(stream)) {
    const amount = Number(row["Amount"]);
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

// Route handlers (Worker side, KV reads only) -------------------------------

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
