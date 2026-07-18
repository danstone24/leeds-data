// Council housing aggregator + Worker handler.
//
// Three datasets tell one story — how hard it is to get a council house:
//   20jjj  Council house bids     (every advertised let + bids received)
//   2o1gn  Number of council houses (stock by ward, 2006/07 → now)
//   ep6qr  Tenanted housing stock (per-property snapshot: type, ward)
//
// Quirks handled here:
//   - Bids files span two eras. 2014–2019 files carry 2-letter codes for the
//     PRE-2018 wards; later files spell out the post-2018 ward names (with
//     drift: "Crossgates & Whinmoor" vs "Cross Gates & Whinmoor"). The two
//     ward maps aren't 1:1, so ward-level stats only use named-ward rows;
//     the citywide trend uses everything.
//   - The stock-by-ward CSV is two year-blocks side by side (2006/07–2017/18,
//     then a repeated Ward column and 2018/19 on), so it's parsed by cell
//     position, not header objects. Its ward list is the pre-2018 one even in
//     recent columns — we only trust its Grand Total row, never join it to
//     bids wards.
//   - Bid dates appear as "25/02/2026" and "30-JUN-2014".
//   - 2026 (and 2019) are partial years; yearly entries carry monthsCovered
//     so the frontend can exclude incomplete years where it matters.
//
// KV keys:
//   housing:summary → bids trend + ward/bedroom breakdowns + stock + mix
//   housing:hash    → fingerprint across all three datasets' resources

const MONTHS3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// "25/02/2026", "30-JUN-2014" or "26-Jan-15" → { year, month }. Null if
// unparseable (the 2015/16 files use two-digit years).
export function parseBidDate(s) {
  const t = String(s || "").trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return { year: Number(m[3]), month: Number(m[2]) };
  m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/);
  if (m) {
    const mo = MONTHS3[m[2].toLowerCase()];
    const y = Number(m[3]);
    return mo ? { year: y < 100 ? y + 2000 : y, month: mo } : null;
  }
  return null;
}

const normWard = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

// "1BMSF" → "1 bed" … "4BH" → "4+ bed". Null if the code doesn't lead with a digit.
function bedroomsFromType(code) {
  const m = String(code || "").trim().match(/^(\d)/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 4 ? "4+ bed" : `${n} bed`;
}

// Bids ---------------------------------------------------------------------

// acc: Map year → { eois: number[], months: Set, byWard: Map, byBeds: Map }
// fallback: { year, months } from the file's title — some files (2019 Q3 on)
// have no date column at all, so the title period is all we have.
export function accumulateBidRow(acc, row, fallback = null) {
  const when = parseBidDate(row["Commencement Date"] ?? row["Commencement_Date"]);
  const eoi = Number(row["Number of Expressions of Interest"]);
  if (!Number.isFinite(eoi)) return;
  if (!when && !fallback) return;
  const year = when ? when.year : fallback.year;

  let y = acc.get(year);
  if (!y) {
    y = { eois: [], months: new Set(), byWard: new Map(), byBeds: new Map() };
    acc.set(year, y);
  }
  y.eois.push(eoi);
  if (when) y.months.add(when.month);
  else for (const m of fallback.months) y.months.add(m);

  // Ward-level only for the named-ward era — 2-letter codes are pre-2018
  // wards that don't map onto today's, so they stay citywide-only.
  const wardRaw = String(row["Ward Code"] || "").trim();
  if (wardRaw.length > 3) {
    const key = normWard(wardRaw);
    let w = y.byWard.get(key);
    if (!w) { w = { name: wardRaw, eois: [] }; y.byWard.set(key, w); }
    w.eois.push(eoi);
    // Prefer the longer spelling ("Cross Gates" beats "Crossgates").
    if (wardRaw.length > w.name.length) w.name = wardRaw;
  }

  const beds = bedroomsFromType(row["Prop Type Code"] ?? row["Property_Type_Code"]);
  if (beds) {
    if (!y.byBeds.has(beds)) y.byBeds.set(beds, []);
    y.byBeds.get(beds).push(eoi);
  }
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const round1 = (n) => Math.round(n * 10) / 10;

// Stock by ward (positional parse) ------------------------------------------

// records: raw string[][] from parseCsvStream. Returns yearly citywide totals
// from the Grand Total row: [{ fy: "2006/07", startYear: 2006, total }]
export function parseStockRecords(records) {
  if (!records.length) return [];
  const header = records[0];
  const yearCols = [];
  for (let i = 0; i < header.length; i++) {
    const m = String(header[i] || "").trim().match(/^(\d{4})\/(\d{2})$/);
    if (m) yearCols.push({ col: i, fy: m[0], startYear: Number(m[1]) });
  }
  const totalRow = records.find((r) => /grand total/i.test(String(r[0] || "")) || /grand total/i.test(String(r[14] || "")));
  if (!totalRow) return [];
  // The second block repeats the ward-name column; find totals by year column.
  const grandTotalRows = records.filter((r) => r.some((c) => /grand total/i.test(String(c || ""))));
  const out = [];
  for (const { col, fy, startYear } of yearCols) {
    for (const r of grandTotalRows) {
      const v = Number(String(r[col] || "").replace(/,/g, ""));
      if (Number.isFinite(v) && v > 0) {
        out.push({ fy, startYear, total: v });
        break;
      }
    }
  }
  return out.sort((a, b) => a.startYear - b.startYear);
}

// Tenanted stock snapshot ----------------------------------------------------

// acc: { total, byForm: Map, needs: Map }
export function accumulateTenantedRow(acc, row) {
  const type = String(row["Property Type"] || "").trim();
  if (!row["Asset Reference"]) return;
  acc.total++;
  let form = "Unknown";
  if (/high rise/i.test(type)) form = "High-rise flat";
  else if (/flat/i.test(type)) form = "Flat";
  else if (/house/i.test(type)) form = "House";
  else if (/bungalow/i.test(type)) form = "Bungalow";
  else if (/maisonette/i.test(type)) form = "Maisonette";
  else if (/bedsit/i.test(type)) form = "Bedsit";
  acc.byForm.set(form, (acc.byForm.get(form) || 0) + 1);
  const needs = /sheltered|extra care/i.test(type) ? "sheltered" : "general";
  acc.needs.set(needs, (acc.needs.get(needs) || 0) + 1);
}

export function newTenantedAcc() {
  return { total: 0, byForm: new Map(), needs: new Map() };
}

// Final summary ---------------------------------------------------------------

export function finaliseHousing(bidsAcc, stockYearly, tenAcc, meta = {}) {
  const yearly = [...bidsAcc.entries()]
    .map(([year, y]) => ({
      year,
      lets: y.eois.length,
      totalEoi: y.eois.reduce((s, v) => s + v, 0),
      meanEoi: round1(mean(y.eois)),
      medianEoi: median(y.eois),
      monthsCovered: y.months.size,
    }))
    .sort((a, b) => a.year - b.year);

  // Ward and bedroom breakdowns come from the most recent COMPLETE year so
  // seasonal quarters don't skew them.
  const fullYears = yearly.filter((y) => y.monthsCovered === 12);
  const breakdownYear = fullYears.length ? fullYears[fullYears.length - 1].year : null;
  let byWard = [];
  let byBedrooms = [];
  if (breakdownYear !== null) {
    const y = bidsAcc.get(breakdownYear);
    byWard = [...y.byWard.values()]
      .map((w) => ({ ward: w.name, lets: w.eois.length, meanEoi: round1(mean(w.eois)) }))
      .sort((a, b) => b.meanEoi - a.meanEoi);
    byBedrooms = [...y.byBeds.entries()]
      .map(([beds, eois]) => ({ beds, lets: eois.length, meanEoi: round1(mean(eois)) }))
      .sort((a, b) => a.beds.localeCompare(b.beds));
  }

  const stockLatest = stockYearly[stockYearly.length - 1] || null;
  const stockFirst = stockYearly[0] || null;

  return {
    bids: {
      yearly,
      breakdownYear,
      byWard,
      byBedrooms,
      source: "https://datamillnorth.org/dataset/council-house-bids-20jjj",
    },
    stock: {
      yearly: stockYearly,
      latest: stockLatest,
      first: stockFirst,
      change:
        stockLatest && stockFirst && stockFirst.total
          ? stockLatest.total / stockFirst.total - 1
          : null,
      source: "https://datamillnorth.org/dataset/number-of-council-houses-2o1gn",
    },
    mix: {
      total: tenAcc.total,
      byForm: [...tenAcc.byForm.entries()]
        .map(([form, count]) => ({ form, count }))
        .sort((a, b) => b.count - a.count),
      shelteredShare: tenAcc.total ? (tenAcc.needs.get("sheltered") || 0) / tenAcc.total : 0,
      snapshotDate: meta.snapshotDate || null,
      source: "https://datamillnorth.org/dataset/tenanted-housing-stock-ep6qr",
    },
    updated: new Date().toISOString(),
  };
}

// Worker route handler (KV read only) --------------------------------------

export async function handleHousingSummary(env) {
  return env.CACHE.get("housing:summary", { type: "json" });
}
