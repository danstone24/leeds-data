// Council spending aggregator + Worker handlers.
//
// The heavy work runs in scripts/refresh.mjs (GitHub Actions, Node), not in
// the Worker — Workers Free's 10ms CPU cap can't parse a 6MB CSV. The Worker
// only reads precomputed blobs from KV. See workers/api/README.md.
//
// KV key layout:
//   spending:summary:<period-id>     → summary blob
//   spending:transactions:<yyyy-mm>  → nested transactions { unit: { division: { purpose: [{d, a, s}] }}}
//   spending:periods                 → JSON catalogue of every period available
//   spending:trend                   → rolling monthly totals
//   spending:hash:<month>            → md5 of source CSV (idempotent refresh)
//   spending:latest                  → latest yyyy-mm
//   meta:last-refresh                → ISO timestamp

import { parseCsvObjects } from "./csv.js";

const DATASET_ID = "2gpp0";
const TOP_SUPPLIERS = 20;
const LARGEST_TXNS = 10;
const TOP_PURPOSES_PER_DIVISION = 12;
const TXNS_PER_LEAF = 100;

function normaliseField(s) {
  if (!s) return "";
  return s
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s+and\s+/gi, " & ")
    .replace(/\?+$/, "");
}

// Build a summary AND a nested transactions tree for a single month.
export async function buildMonthlySummary(month, resource, stream) {
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

  // Build Service Division → most-common Org Unit lookup, then apply.
  const sdCounts = new Map();
  for (const r of records) {
    if (!r.unit || !r.division) continue;
    const m = sdCounts.get(r.division) || new Map();
    m.set(r.unit, (m.get(r.unit) || 0) + 1);
    sdCounts.set(r.division, m);
  }
  const sdToUnit = new Map();
  for (const [div, units] of sdCounts) {
    let top = null;
    let topC = 0;
    for (const [u, c] of units) if (c > topC) { top = u; topC = c; }
    sdToUnit.set(div, top);
  }

  // Nested aggregation — Maps all the way down. Avoids any string-key
  // separator pitfalls.
  const byUnit = new Map();              // unit → { amount, divisions: Map<division, { amount, purposes: Map<purpose, amount> }> }
  const txnTree = new Map();             // unit → Map<division, Map<purpose, transaction[]>>
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
    const purpose = r.purpose || "Unspecified purpose";

    // Amount aggregation by unit/division/purpose
    let u = byUnit.get(unit);
    if (!u) { u = { amount: 0, divisions: new Map() }; byUnit.set(unit, u); }
    u.amount += r.amount;
    let d = u.divisions.get(division);
    if (!d) { d = { amount: 0, purposes: new Map() }; u.divisions.set(division, d); }
    d.amount += r.amount;
    d.purposes.set(purpose, (d.purposes.get(purpose) || 0) + r.amount);

    // Supplier
    let s = bySupplier.get(r.supplier);
    if (!s) { s = { amount: 0, count: 0 }; bySupplier.set(r.supplier, s); }
    s.amount += r.amount;
    s.count += 1;

    if (r.cr === "C") capital += r.amount;
    else if (r.cr === "R") revenue += r.amount;
    if (r.pcard) procCardAmount += r.amount;

    if (largest.length < LARGEST_TXNS || r.amount > largest[largest.length - 1].amount) {
      largest.push({
        date: r.date,
        amount: r.amount,
        beneficiary: r.supplier,
        purpose,
        unit,
      });
      largest.sort((a, b) => b.amount - a.amount);
      if (largest.length > LARGEST_TXNS) largest.length = LARGEST_TXNS;
    }

    // Transaction tree (for L4 drill)
    let tU = txnTree.get(unit);
    if (!tU) { tU = new Map(); txnTree.set(unit, tU); }
    let tD = tU.get(division);
    if (!tD) { tD = new Map(); tU.set(division, tD); }
    let tP = tD.get(purpose);
    if (!tP) { tP = []; tD.set(purpose, tP); }
    tP.push({ d: r.date, a: r.amount, s: r.supplier });
  }

  // Flatten unit map for summary output.
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
            top.push({
              name: `Other purposes (${tail.length})`,
              amount: tail.reduce((sum, p) => sum + p.amount, 0),
            });
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

  // Flatten transactions tree to a plain nested object, capping per leaf.
  const transactions = {};
  for (const [unit, divMap] of txnTree) {
    transactions[unit] = {};
    for (const [division, purposeMap] of divMap) {
      transactions[unit][division] = {};
      for (const [purpose, txns] of purposeMap) {
        txns.sort((a, b) => Math.abs(b.a) - Math.abs(a.a));
        transactions[unit][division][purpose] = txns
          .slice(0, TXNS_PER_LEAF)
          .map((t) => ({ d: t.d, a: round2(t.a), s: t.s }));
      }
    }
  }

  const summary = {
    periodId: month,
    periodKind: "month",
    label: formatMonthLabel(month),
    totalAmount: round2(totalAmount),
    transactionCount,
    averageTransaction: transactionCount ? round2(totalAmount / transactionCount) : 0,
    byOrganisationalUnit,
    topSuppliers,
    capitalVsRevenue: { capital: round2(capital), revenue: round2(revenue) },
    procurementCardAmount: round2(procCardAmount),
    procurementCardShare: totalAmount ? procCardAmount / totalAmount : 0,
    largestTransactions: largest.map((t) => ({ ...t, amount: round2(t.amount) })),
    dataQuality: { unitResolvedCount, unitUnresolvedCount },
    transactionsCapPerLeaf: TXNS_PER_LEAF,
    source: `https://datamillnorth.org/dataset/council-spending-${DATASET_ID}`,
    updated: new Date().toISOString(),
    // Back-compat aliases for the existing frontend until it's redeployed.
    month,
    monthLabel: formatMonthLabel(month),
  };

  return { summary, transactions };
}

// Merge several monthly summary blobs into a single period summary. L4
// transactions are NOT produced for period views — they would balloon to
// tens of thousands of rows. Document accordingly on the page.
export function combineSummaries(summaries, periodId, periodKind, label) {
  let totalAmount = 0;
  let transactionCount = 0;
  let capital = 0;
  let revenue = 0;
  let procCardAmount = 0;
  let unitResolvedCount = 0;
  let unitUnresolvedCount = 0;
  const byUnit = new Map();
  const bySupplier = new Map();
  const allLargest = [];

  for (const s of summaries) {
    totalAmount += s.totalAmount || 0;
    transactionCount += s.transactionCount || 0;
    capital += s.capitalVsRevenue?.capital || 0;
    revenue += s.capitalVsRevenue?.revenue || 0;
    procCardAmount += s.procurementCardAmount || 0;
    unitResolvedCount += s.dataQuality?.unitResolvedCount || 0;
    unitUnresolvedCount += s.dataQuality?.unitUnresolvedCount || 0;

    for (const u of s.byOrganisationalUnit || []) {
      let exU = byUnit.get(u.name);
      if (!exU) { exU = { amount: 0, divisions: new Map() }; byUnit.set(u.name, exU); }
      exU.amount += u.amount;
      for (const d of u.divisions || []) {
        let exD = exU.divisions.get(d.name);
        if (!exD) { exD = { amount: 0, purposes: new Map() }; exU.divisions.set(d.name, exD); }
        exD.amount += d.amount;
        for (const p of d.purposes || []) {
          exD.purposes.set(p.name, (exD.purposes.get(p.name) || 0) + p.amount);
        }
      }
    }

    for (const sup of s.topSuppliers || []) {
      let ex = bySupplier.get(sup.name);
      if (!ex) { ex = { amount: 0, count: 0 }; bySupplier.set(sup.name, ex); }
      ex.amount += sup.amount;
      ex.count += sup.count;
    }
    for (const t of s.largestTransactions || []) allLargest.push(t);
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
            top.push({
              name: `Other purposes (${tail.length})`,
              amount: tail.reduce((sum, p) => sum + p.amount, 0),
            });
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

  const largestTransactions = allLargest
    .sort((a, b) => b.amount - a.amount)
    .slice(0, LARGEST_TXNS)
    .map((t) => ({ ...t, amount: round2(t.amount) }));

  return {
    periodId,
    periodKind,
    label,
    totalAmount: round2(totalAmount),
    transactionCount,
    averageTransaction: transactionCount ? round2(totalAmount / transactionCount) : 0,
    byOrganisationalUnit,
    topSuppliers,
    capitalVsRevenue: { capital: round2(capital), revenue: round2(revenue) },
    procurementCardAmount: round2(procCardAmount),
    procurementCardShare: totalAmount ? procCardAmount / totalAmount : 0,
    largestTransactions,
    dataQuality: { unitResolvedCount, unitUnresolvedCount },
    transactionsCapPerLeaf: null,
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

// Worker route handlers (KV reads only) ------------------------------------

export async function handleSummary(env, periodId) {
  const target = periodId || (await env.CACHE.get("spending:latest"));
  if (!target) return null;
  return env.CACHE.get(`spending:summary:${target}`, { type: "json" });
}

export async function handleTrend(env) {
  return env.CACHE.get("spending:trend", { type: "json" });
}

export async function handlePeriods(env) {
  return env.CACHE.get("spending:periods", { type: "json" });
}

export async function handleTransactions(env, month, unit, division, purpose) {
  // L4 is only available for monthly periods.
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const blob = await env.CACHE.get(`spending:transactions:${month}`, { type: "json" });
  if (!blob) return null;
  const leaf = blob?.[unit]?.[division]?.[purpose];
  return { transactions: leaf || [], unit, division, purpose, month };
}
