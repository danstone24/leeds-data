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
const TOP_PURPOSES_PER_DIVISION = 12; // long-tail purposes get bundled as "Other purposes"

// Normalise a free-text field. The council's CSVs publish the same logical
// value under several spellings within the same file (e.g. "Adults & Health"
// vs "Adults and Health", trailing spaces, trailing '?' on category names),
// so we have to canonicalise before aggregating or we get fragmented buckets.
function normaliseField(s) {
  if (!s) return "";
  return s
    .trim()
    .replace(/\s+/g, " ")          // collapse runs of whitespace
    .replace(/\s+and\s+/gi, " & ") // "Adults and Health" → "Adults & Health"
    .replace(/\?+$/, "");          // strip trailing '?' (e.g. "Supplies & Services?")
}

// Pure aggregation — takes a CSV byte stream, returns a summary object.
// No KV, no fetch — safe to run anywhere.
export async function buildMonthlySummary(month, resource, stream) {
  // Pass 1: stream-decode into memory with normalisation applied. ~27k rows
  // per month, modest memory footprint. We need two passes because the
  // Org-Unit→Service-Division mapping is built from the rows where both are
  // populated, then applied to the rows where Org Unit is missing.
  const records = [];
  for await (const row of parseCsvObjects(stream)) {
    const amount = Number(row["Amount"]);
    if (!Number.isFinite(amount)) continue;
    records.push({
      amount,
      unit: normaliseField(row["Organisational Unit"]),
      division: normaliseField(row["Service Division Label"]),
      supplier: normaliseField(row["Beneficiary Name"]) || "Unknown supplier",
      purpose: normaliseField(row["Purpose"]),
      cr: (row["Capital Or Revenue"] || "").trim().toUpperCase(),
      pcard: (row["Procurement Card"] || "").trim().toLowerCase() === "yes",
      date: parseUkDate(row["Payment Date"]),
    });
  }

  // Build a Service-Division → most-common-Org-Unit lookup from rows where
  // both are populated. ~80% of Leeds rows omit Org Unit but include Service
  // Division, so this recovers most of the missing hierarchy.
  const counts = new Map();
  for (const r of records) {
    if (!r.unit || !r.division) continue;
    const m = counts.get(r.division) || new Map();
    m.set(r.unit, (m.get(r.unit) || 0) + 1);
    counts.set(r.division, m);
  }
  const sdToUnit = new Map();
  for (const [div, units] of counts) {
    let top = null;
    let topC = 0;
    for (const [u, c] of units) if (c > topC) { top = u; topC = c; }
    sdToUnit.set(div, top);
  }

  // Pass 2: aggregate, resolving missing Org Unit via the lookup.
  const byUnit = new Map();
  const bySupplier = new Map();
  let totalAmount = 0;
  let transactionCount = 0;
  let capital = 0;
  let revenue = 0;
  let procCardAmount = 0;
  let unitResolvedCount = 0;
  let unitUnresolvedCount = 0;
  const largest = [];

  for (const r of records) {
    transactionCount++;
    totalAmount += r.amount;

    let unit = r.unit;
    if (!unit) {
      const resolved = r.division ? sdToUnit.get(r.division) : null;
      if (resolved) {
        unit = resolved;
        unitResolvedCount++;
      } else {
        unit = "Other / unspecified";
        unitUnresolvedCount++;
      }
    }
    const division = r.division || "Unspecified";

    const u = byUnit.get(unit) || { amount: 0, divisions: new Map() };
    u.amount += r.amount;
    const div = u.divisions.get(division) || { amount: 0, purposes: new Map() };
    div.amount += r.amount;
    const purpose = r.purpose || "Unspecified purpose";
    div.purposes.set(purpose, (div.purposes.get(purpose) || 0) + r.amount);
    u.divisions.set(division, div);
    byUnit.set(unit, u);

    const s = bySupplier.get(r.supplier) || { amount: 0, count: 0 };
    s.amount += r.amount;
    s.count += 1;
    bySupplier.set(r.supplier, s);

    if (r.cr === "C") capital += r.amount;
    else if (r.cr === "R") revenue += r.amount;
    if (r.pcard) procCardAmount += r.amount;

    if (largest.length < LARGEST_TXNS || r.amount > largest[largest.length - 1].amount) {
      largest.push({
        date: r.date,
        amount: r.amount,
        beneficiary: r.supplier,
        purpose: r.purpose,
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
        .map(([dname, { amount: damount, purposes }]) => {
          const sortedPurposes = [...purposes.entries()]
            .map(([pname, pamount]) => ({ name: pname, amount: pamount }))
            .sort((a, b) => b.amount - a.amount);
          const top = sortedPurposes.slice(0, TOP_PURPOSES_PER_DIVISION);
          const tail = sortedPurposes.slice(TOP_PURPOSES_PER_DIVISION);
          if (tail.length) {
            const otherAmount = tail.reduce((s, p) => s + p.amount, 0);
            top.push({ name: `Other purposes (${tail.length})`, amount: otherAmount });
          }
          return {
            name: dname,
            amount: round2(damount),
            purposes: top.map((p) => ({ name: p.name, amount: round2(p.amount) })),
          };
        })
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
    dataQuality: {
      // How many transactions had their Org Unit inferred from Service Division
      // (because the source data left it blank) vs left as "Other / unspecified".
      unitResolvedCount,
      unitUnresolvedCount,
    },
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
