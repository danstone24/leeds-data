// Cycle & traffic counter aggregator + Worker handlers.
//
// Two datasets share this code because they have an identical schema:
//   Cycle   growth: e1dmk  (28 cycle counters around Leeds)
//   Traffic growth: e6q0n  (29 vehicle counters around Leeds)
// Each file is one month of hourly, per-lane counts:
//   Sdate, Cosit, Period, LaneNumber, LaneDescription, LaneDirection,
//   DirectionDescription, Volume, Flag Text
//
// The hard part is comparability. The set of working recorders changes a lot
// month to month (e.g. traffic had only 10 of ~29 reporting in May 2024), so
// raw totals can't be trended. We normalise to **mean daily flow per recorder**
// = total volume ÷ number of (recorder, day) pairs that reported. That controls
// for both how many recorders were live and partial-month coverage. It still
// assumes the live recorders are broadly representative — see the page caveat.
//
// KV key layout (per dataset, keyed by kind = "cycle" | "traffic"):
//   counts:<kind>:summary → monthly + yearly mean-daily-flow series, sites
//   counts:<kind>:hash    → fingerprint of the source resources

import { osgbToWgs84 } from "./potholes.js";

const META = {
  cycle: { datasetId: "e1dmk", unit: "cycles", source: "https://datamillnorth.org/dataset/leeds-annual-cycle-growth-e1dmk" },
  traffic: { datasetId: "e6q0n", unit: "vehicles", source: "https://datamillnorth.org/dataset/leeds-annual-traffic-growth-e6q0n" },
};

// Cosit appears zero-padded in some files ("000000100643") and bare in others
// ("90810") — strip leading zeros so the same recorder counts once.
export function normaliseCosit(s) {
  const t = String(s || "").trim().replace(/^0+/, "");
  return t || "0";
}

// "01/08/2024 00:00" → { month: "2024-08", day: "2024-08-01" }. Returns null if
// unparseable.
function parseSdate(s) {
  const m = String(s || "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return { month: `${m[3]}-${m[2]}`, day: `${m[3]}-${m[2]}-${m[1]}` };
}

// Fold one CSV row into the accumulator. `acc` is a Map: month → { volume,
// recorderDays: Set<"cosit|day">, recorders: Set<cosit> }.
export function accumulateCountRow(acc, row) {
  const when = parseSdate(row["Sdate"]);
  if (!when) return;
  const volume = Number(row["Volume"]);
  if (!Number.isFinite(volume)) return;
  const cosit = normaliseCosit(row["Cosit"]);

  let m = acc.get(when.month);
  if (!m) { m = { volume: 0, recorderDays: new Set(), recorders: new Set() }; acc.set(when.month, m); }
  m.volume += volume;
  m.recorderDays.add(`${cosit}|${when.day}`);
  m.recorders.add(cosit);
}

// Parse a recorder-location CSV into [{ id, name, lat, lng }]. The two datasets
// publish locations differently: cycle gives Latitude/Longitude, traffic gives
// OSGB grid X/Y that we convert. Returns a Map keyed by normalised id.
export function parseSites(kind, rows) {
  const sites = new Map();
  for (const row of rows) {
    const id = normaliseCosit(row["Site ID"] ?? row["Site Id"] ?? row["SiteID"]);
    if (!id || id === "0") continue;
    const name = (row["Description"] || row["Site Name"] || "").trim();
    let lat = null, lng = null;
    if (row["Latitude"] && row["Longitude"]) {
      lat = Number(row["Latitude"]);
      lng = Number(row["Longitude"]);
    } else if (row["X"] && row["Y"]) {
      const e = Number(row["X"]), n = Number(row["Y"]);
      if (Number.isFinite(e) && Number.isFinite(n) && e > 0 && n > 0) {
        [lat, lng] = osgbToWgs84(e, n);
      }
    }
    sites.set(id, {
      id,
      name,
      lat: Number.isFinite(lat) ? Math.round(lat * 1e5) / 1e5 : null,
      lng: Number.isFinite(lng) ? Math.round(lng * 1e5) / 1e5 : null,
    });
  }
  return sites;
}

function round(n) { return Math.round(n); }

// Turn the accumulator into the stored summary.
export function finaliseCounts(kind, acc, sitesMap) {
  const meta = META[kind];
  const monthly = [...acc.entries()]
    .map(([month, m]) => ({
      month,
      volume: m.volume,
      recorders: m.recorders.size,
      recorderDays: m.recorderDays.size,
      meanDailyFlow: m.recorderDays.size ? round(m.volume / m.recorderDays.size) : 0,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Yearly: mean daily flow = total volume / total recorder-days across the year.
  const yearMap = new Map();
  for (const mo of monthly) {
    const y = mo.month.slice(0, 4);
    let yr = yearMap.get(y);
    if (!yr) { yr = { volume: 0, recorderDays: 0, months: 0, recorders: new Set() }; yearMap.set(y, yr); }
    yr.volume += mo.volume;
    yr.recorderDays += mo.recorderDays;
    yr.months += 1;
  }
  const yearly = [...yearMap.entries()]
    .map(([year, y]) => ({
      year: Number(year),
      volume: y.volume,
      recorderDays: y.recorderDays,
      monthsCovered: y.months,
      meanDailyFlow: y.recorderDays ? round(y.volume / y.recorderDays) : 0,
    }))
    .sort((a, b) => a.year - b.year);

  // Only recorders that actually produced data, joined to their location.
  const seen = new Set(monthly.flatMap(() => []));
  for (const m of acc.values()) for (const r of m.recorders) seen.add(r);
  const sites = [...seen]
    .map((id) => sitesMap.get(id) || { id, name: "", lat: null, lng: null })
    .filter((s) => s.lat !== null && s.lng !== null)
    .sort((a, b) => a.id.localeCompare(b.id));

  const latest = yearly[yearly.length - 1] || null;
  const first = yearly[0] || null;

  return {
    kind,
    unit: meta.unit,
    monthly,
    yearly,
    sites,
    coverage: { from: monthly[0]?.month || null, to: monthly[monthly.length - 1]?.month || null },
    latest,
    first,
    activeRecorders: seen.size,
    source: meta.source,
    updated: new Date().toISOString(),
  };
}

// Worker route handler (KV read only) --------------------------------------

export async function handleCountsSummary(env, kind) {
  if (kind !== "cycle" && kind !== "traffic") return null;
  return env.CACHE.get(`counts:${kind}:summary`, { type: "json" });
}
