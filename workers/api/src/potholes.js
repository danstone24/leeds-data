// Historic potholes aggregator + Worker handlers.
//
// Dataset: e7ylx ("Historic potholes data"). One row per recorded carriageway
// pothole: Reference, Road, Ward, Defect, Recorded, Completed, Cost, Easting,
// Northing. The council republishes the whole record set (one CSV per year,
// refreshed quarterly), so we merge every CSV and dedupe by Reference.
//
// Like spending, the heavy parsing runs in scripts/refresh.mjs (Node); the
// Worker only reads precomputed blobs from KV.
//
// KV key layout:
//   potholes:summary  → headline stats, monthly trend, ward table, fix-time buckets
//   potholes:points   → compact [lat, lng, code] array for the map
//   potholes:hash     → fingerprint of the source resources (idempotent refresh)
//
// points code: >=0 fixed and took that many days · -1 still open · -2 fixed,
// duration unknown (missing recorded date).

const DATASET_ID = "e7ylx";
const SOURCE = `https://datamillnorth.org/dataset/historic-potholes-data-${DATASET_ID}`;
// Meaningful volume starts here; a handful of stray 2023/early-2024 records sit
// before it and would stretch the trend axis with empty months.
const TREND_START = "2024-11";
const TOP_WARDS = 15;

function normaliseField(s) {
  if (!s) return "";
  return s.trim().replace(/\s+/g, " ");
}

// dd/mm/yyyy → "yyyy-mm-dd" (or null). Kept as a string so downstream diffing
// is timezone-free.
function parseUkDate(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function percentile(nums, p) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

// Merge one raw CSV row into a Map keyed by Reference. When a pothole appears in
// more than one yearly file, prefer the copy that carries a Completed date (the
// later file has the up-to-date repair status).
export function mergePotholeRow(map, row) {
  const ref = (row["Reference"] || "").trim();
  if (!ref) return;
  const existing = map.get(ref);
  if (!existing) {
    map.set(ref, row);
  } else if (!(existing["Completed"] || "").trim() && (row["Completed"] || "").trim()) {
    map.set(ref, row);
  }
}

// OSGB36 National Grid (Easting/Northing) → WGS84 [lat, lon].
// Inverse Transverse Mercator to OSGB36 lat/lon on the Airy 1830 ellipsoid,
// then a 7-parameter Helmert transform onto WGS84. Matches Ordnance Survey's
// published worked example to 6 dp — accurate to a few metres, fine for pins.
export function osgbToWgs84(E, N) {
  const a = 6377563.396, b = 6356256.909; // Airy 1830
  const F0 = 0.9996012717;
  const lat0 = (49 * Math.PI) / 180, lon0 = (-2 * Math.PI) / 180;
  const N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b), n2 = n * n, n3 = n * n * n;

  let lat = lat0, M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const Ma = (1 + n + 1.25 * n2 + 1.25 * n3) * (lat - lat0);
    const Mb = (3 * n + 3 * n2 + 2.625 * n3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
    const Mc = (1.875 * n2 + 1.875 * n3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
    const Md = (35 / 24) * n3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
    M = b * F0 * (Ma - Mb + Mc - Md);
  } while (Math.abs(N - N0 - M) >= 0.00001);

  const sinLat = Math.sin(lat), tanLat = Math.tan(lat), cosLat = Math.cos(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;
  const tan2 = tanLat * tanLat, tan4 = tan2 * tan2, tan6 = tan4 * tan2;
  const secLat = 1 / cosLat;
  const VII = tanLat / (2 * rho * nu);
  const VIII = (tanLat / (24 * rho * nu ** 3)) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const IX = (tanLat / (720 * rho * nu ** 5)) * (61 + 90 * tan2 + 45 * tan4);
  const X = secLat / nu;
  const XI = (secLat / (6 * nu ** 3)) * (nu / rho + 2 * tan2);
  const XII = (secLat / (120 * nu ** 5)) * (5 + 28 * tan2 + 24 * tan4);
  const XIIA = (secLat / (5040 * nu ** 7)) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);
  const dE = E - E0;
  const latAiry = lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6;
  const lonAiry = lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7;

  // Helmert OSGB36 → WGS84 via geocentric cartesian coordinates.
  const sinP = Math.sin(latAiry), cosP = Math.cos(latAiry);
  const sinL = Math.sin(lonAiry), cosL = Math.cos(lonAiry);
  const v = a / Math.sqrt(1 - e2 * sinP * sinP);
  const x = v * cosP * cosL;
  const y = v * cosP * sinL;
  const z = (1 - e2) * v * sinP;
  const tx = 446.448, ty = -125.157, tz = 542.06;
  const s = -20.4894e-6;
  const rx = (0.1502 / 3600) * (Math.PI / 180);
  const ry = (0.247 / 3600) * (Math.PI / 180);
  const rz = (0.8421 / 3600) * (Math.PI / 180);
  const x2 = tx + (1 + s) * x - rz * y + ry * z;
  const y2 = ty + rz * x + (1 + s) * y - rx * z;
  const z2 = tz - ry * x + rx * y + (1 + s) * z;

  const aW = 6378137, bW = 6356752.3142; // WGS84
  const e2W = 1 - (bW * bW) / (aW * aW);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let latW = Math.atan2(z2, p * (1 - e2W));
  let prev;
  do {
    prev = latW;
    const vW = aW / Math.sqrt(1 - e2W * Math.sin(latW) ** 2);
    latW = Math.atan2(z2 + e2W * vW * Math.sin(latW), p);
  } while (Math.abs(latW - prev) > 1e-12);
  const lonW = Math.atan2(y2, x2);
  return [(latW * 180) / Math.PI, (lonW * 180) / Math.PI];
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// Build the summary + map points from the deduped set of pothole rows.
export function buildPotholes(rows) {
  let fixed = 0;
  let open = 0;
  let totalCost = 0;
  const fixDays = [];                 // repair durations, completed rows only
  const recordedByMonth = new Map();  // yyyy-mm → count
  const completedByMonth = new Map(); // yyyy-mm → count
  const wardAgg = new Map();          // ward → { count, open, fixDays: [] }
  const points = [];
  let missingCoords = 0;

  for (const row of rows) {
    const ward = normaliseField(row["Ward"]) || "Unknown ward";
    const recorded = parseUkDate(row["Recorded"]);
    const completed = parseUkDate(row["Completed"]);
    const cost = Number(row["Cost"]);
    if (Number.isFinite(cost)) totalCost += cost;

    let code; // for the map point + ward fix-time stats
    if (completed) {
      fixed += 1;
      const d = recorded ? daysBetween(recorded, completed) : null;
      if (d !== null && d >= 0) {
        fixDays.push(d);
        code = d;
      } else {
        code = -2; // fixed, but we can't measure how long
      }
    } else {
      open += 1;
      code = -1;
    }

    if (recorded && recorded >= `${TREND_START}-01`) {
      const rm = recorded.slice(0, 7);
      recordedByMonth.set(rm, (recordedByMonth.get(rm) || 0) + 1);
    }
    if (completed && completed >= `${TREND_START}-01`) {
      const cm = completed.slice(0, 7);
      completedByMonth.set(cm, (completedByMonth.get(cm) || 0) + 1);
    }

    let w = wardAgg.get(ward);
    if (!w) { w = { count: 0, open: 0, fixDays: [] }; wardAgg.set(ward, w); }
    w.count += 1;
    if (!completed) w.open += 1;
    if (typeof code === "number" && code >= 0) w.fixDays.push(code);

    const E = Number(row["Easting"]);
    const N = Number(row["Northing"]);
    if (Number.isFinite(E) && Number.isFinite(N) && E > 0 && N > 0) {
      const [lat, lon] = osgbToWgs84(E, N);
      points.push([round(lat, 5), round(lon, 5), code]);
    } else {
      missingCoords += 1;
    }
  }

  // Monthly trend — union of recorded/completed months, sorted.
  const months = [...new Set([...recordedByMonth.keys(), ...completedByMonth.keys()])].sort();
  const trend = months.map((m) => ({
    month: m,
    recorded: recordedByMonth.get(m) || 0,
    fixed: completedByMonth.get(m) || 0,
  }));

  // Ward table — sorted by count, with each ward's own median repair time.
  const wards = [...wardAgg.entries()]
    .map(([name, w]) => ({
      name,
      count: w.count,
      open: w.open,
      medianFixDays: median(w.fixDays),
    }))
    .sort((a, b) => b.count - a.count);

  // Fix-time buckets — how quickly fixed potholes were repaired.
  const buckets = [
    { label: "Within a week", count: fixDays.filter((d) => d <= 7).length },
    { label: "1–4 weeks", count: fixDays.filter((d) => d > 7 && d <= 30).length },
    { label: "1–3 months", count: fixDays.filter((d) => d > 30 && d <= 90).length },
    { label: "Over 3 months", count: fixDays.filter((d) => d > 90).length },
  ];

  const total = rows.length;
  const summary = {
    totalRecorded: total,
    fixedCount: fixed,
    openCount: open,
    fixedShare: total ? fixed / total : 0,
    medianFixDays: median(fixDays),
    meanFixDays: fixDays.length ? Math.round((fixDays.reduce((s, d) => s + d, 0) / fixDays.length) * 10) / 10 : 0,
    p90FixDays: percentile(fixDays, 0.9),
    totalCost: Math.round(totalCost * 100) / 100,
    avgCost: total ? Math.round((totalCost / total) * 100) / 100 : 0,
    coverage: { from: months[0] || null, to: months[months.length - 1] || null },
    trend,
    wards: wards.slice(0, TOP_WARDS),
    wardCount: wards.length,
    fixTimeBuckets: buckets,
    mapPointCount: points.length,
    missingCoords,
    source: SOURCE,
    updated: new Date().toISOString(),
  };

  return { summary, points };
}

// Worker route handlers (KV reads only) ------------------------------------

export async function handlePotholesSummary(env) {
  return env.CACHE.get("potholes:summary", { type: "json" });
}

export async function handlePotholesPoints(env) {
  return env.CACHE.get("potholes:points", { type: "json" });
}
