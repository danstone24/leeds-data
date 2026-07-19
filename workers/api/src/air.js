// Air quality aggregator + Worker handler.
//
// Source: DEFRA UK-AIR hourly monitoring data for the Leeds Centre station
// (site_id=LEED, urban background) — the site's first NON-Datamillnorth
// source. One CSV per year, ~8,760 hourly rows:
//   https://uk-air.defra.gov.uk/datastore/data_files/site_data/LEED_<YEAR>.csv
//
// Quirks handled here:
//   - ~4 preamble lines before the real header (which starts "Date,time"),
//     then one near-blank spacer line before the data.
//   - Column names contain HTML ("PM<sub>2.5</sub> particulate matter…") and
//     the schema drifts across years (2008 has extra volatile/non-volatile PM
//     channels; no HTML tags at all), so columns are matched BY NAME after
//     stripping tags — never by position.
//   - Each pollutant is a value/status/unit triplet; blanks mean the monitor
//     was down and are skipped, so every mean carries a data-capture %.
//     DEFRA convention: an annual mean below ~75% capture is not meaningful,
//     so those means are nulled here (capture is kept so pages can annotate).
//   - Dates are DD-MM-YYYY, times hour-ending 01:00–24:00 GMT. Rows are
//     bucketed by their own date, not the file they arrived in.
//   - Status R = ratified, P/P* = provisional (the most recent year or two).
//     Years containing any provisional readings are flagged.
//
// KV keys:
//   air:summary → annual means + capture, hourly rhythm, seasonal means,
//                 exceedance counts, limits table
//   air:hash    → fingerprint across all year files (ETag/Last-Modified)

import { parseCsvStream } from "./csv.js";

// Canonical pollutant keys, matched against tag-stripped, lowercased headers.
// Exact matches so "Non-volatile PM10 …" / "Volatile PM10 …" don't collide
// with the headline PM channels.
const POLLUTANTS = {
  no2: /^nitrogen dioxide$/,
  pm25: /^pm2\.5 particulate matter \(hourly measured\)$/,
  pm10: /^pm10 particulate matter \(hourly measured\)$/,
  o3: /^ozone$/,
};
const KEYS = Object.keys(POLLUTANTS);

// Annual-mean limits (µg/m³) and short-term allowances. UK: Air Quality
// Standards Regulations 2010 / Environment Act 2021 PM2.5 target for England.
// WHO: 2021 Global Air Quality Guidelines.
export const LIMITS = {
  no2: { uk: 40, who: 10 },
  pm25: { uk: 20, who: 5, ukTarget2040: 10 },
  pm10: { uk: 40, who: 15 },
  no2Hourly: { limit: 200, allowedHours: 18 },
  pm10Daily: { limit: 50, allowedDays: 35 },
};

// Below this share of valid hours an annual mean is withheld (DEFRA convention).
export const CAPTURE_THRESHOLD = 0.75;

// Hourly/seasonal averages pool this many recent well-captured years so the
// rhythm reflects today's traffic, not 2008's.
const WINDOW_YEARS = 3;

const stripTags = (s) => String(s ?? "").replace(/<[^>]*>/g, "").trim();
const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const hoursInYear = (y) => (isLeap(y) ? 8784 : 8760);

function newYearAcc(year) {
  const per = () => ({
    sum: 0,
    count: 0,
    monthly: Array.from({ length: 12 }, () => ({ sum: 0, count: 0 })),
    hourly: Array.from({ length: 24 }, () => ({ sum: 0, count: 0 })),
  });
  return {
    year,
    provisional: false,
    pollutants: Object.fromEntries(KEYS.map((k) => [k, per()])),
    pm10Daily: new Map(), // "MM-DD" → { sum, count }
    no2HoursOver200: 0,
    latestDate: null, // "YYYY-MM-DD"
  };
}

// Locate each pollutant's value column in a tag-stripped header row.
function mapColumns(header) {
  const cols = {};
  for (let i = 0; i < header.length; i++) {
    const name = stripTags(header[i]).toLowerCase();
    for (const key of KEYS) {
      if (cols[key] === undefined && POLLUTANTS[key].test(name)) cols[key] = i;
    }
  }
  return cols;
}

// Feed one year-file's records into the by-year accumulator map. Rows are
// bucketed by their own date so a stray boundary row can't pollute a year.
function accumulateRecords(records, byYear) {
  const headerIdx = records.findIndex(
    (r) => /^date$/i.test(stripTags(r[0])) && /^time$/i.test(stripTags(r[1]))
  );
  if (headerIdx < 0) return false;
  const cols = mapColumns(records[headerIdx]);
  if (Object.keys(cols).length === 0) return false;

  for (const row of records.slice(headerIdx + 1)) {
    const m = String(row[0] || "").trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!m) continue; // spacer line / junk
    const [, dd, mm, yyyy] = m;
    const month = Number(mm);
    const year = Number(yyyy);
    const hour = Number(String(row[1] || "").slice(0, 2)); // hour-ending 1–24
    if (!month || month > 12 || !hour || hour > 24) continue;

    let acc = byYear.get(year);
    if (!acc) {
      acc = newYearAcc(year);
      byYear.set(year, acc);
    }
    const iso = `${yyyy}-${mm}-${dd}`;
    if (!acc.latestDate || iso > acc.latestDate) acc.latestDate = iso;

    for (const key of KEYS) {
      const col = cols[key];
      if (col === undefined) continue;
      const raw = String(row[col] ?? "").trim();
      if (raw === "") continue; // monitor down
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const status = String(row[col + 1] || "").trim().toUpperCase();
      if (status.startsWith("P")) acc.provisional = true;

      const p = acc.pollutants[key];
      p.sum += value;
      p.count++;
      p.monthly[month - 1].sum += value;
      p.monthly[month - 1].count++;
      p.hourly[hour - 1].sum += value;
      p.hourly[hour - 1].count++;

      if (key === "no2" && value > LIMITS.no2Hourly.limit) acc.no2HoursOver200++;
      if (key === "pm10") {
        const dayKey = `${mm}-${dd}`;
        let d = acc.pm10Daily.get(dayKey);
        if (!d) {
          d = { sum: 0, count: 0 };
          acc.pm10Daily.set(dayKey, d);
        }
        d.sum += value;
        d.count++;
      }
    }
  }
  return true;
}

const meanOf = (b) => (b.count ? b.sum / b.count : null);

function finaliseYear(acc) {
  const total = hoursInYear(acc.year);
  const out = { year: acc.year, provisional: acc.provisional };
  for (const key of KEYS) {
    const p = acc.pollutants[key];
    const capture = round3(p.count / total);
    out[key] = {
      mean: capture >= CAPTURE_THRESHOLD ? round1(p.sum / p.count) : null,
      capture,
    };
  }
  // PM10 daily-mean exceedances: only days with ≥75% of hours count as valid
  // days, and the year's count is only comparable when capture was decent.
  let pm10Days = 0;
  for (const d of acc.pm10Daily.values()) {
    if (d.count >= 18 && d.sum / d.count > LIMITS.pm10Daily.limit) pm10Days++;
  }
  out.exceedances = {
    no2Hours: out.no2.capture >= CAPTURE_THRESHOLD ? acc.no2HoursOver200 : null,
    pm10Days: out.pm10.capture >= CAPTURE_THRESHOLD ? pm10Days : null,
  };
  return out;
}

// yearFiles: [{ year, text }] — already-fetched CSV text per year.
// Returns the air:summary object.
export async function buildAirQuality(yearFiles) {
  const byYear = new Map();
  for (const f of yearFiles) {
    const records = [];
    for await (const rec of parseCsvStream(new Response(f.text).body)) records.push(rec);
    const ok = accumulateRecords(records, byYear);
    if (!ok) throw new Error(`LEED_${f.year}: no recognisable header row`);
  }

  const accs = [...byYear.values()].sort((a, b) => a.year - b.year);
  const years = accs.map(finaliseYear);

  // Rhythm + seasonal: pool the most recent WINDOW_YEARS years whose NO₂
  // capture clears the threshold (partial current year excluded so a
  // January–July file can't skew the seasonal shape).
  const windowAccs = accs
    .filter((a) => a.pollutants.no2.count / hoursInYear(a.year) >= CAPTURE_THRESHOLD)
    .slice(-WINDOW_YEARS);
  const windowYears = windowAccs.map((a) => a.year);

  const pooled = (key, dim, i) => {
    let sum = 0;
    let count = 0;
    for (const a of windowAccs) {
      sum += a.pollutants[key][dim][i].sum;
      count += a.pollutants[key][dim][i].count;
    }
    return count ? round1(sum / count) : null;
  };

  const rhythm = {
    years: windowYears,
    // hour = hour-ending (1 → midnight–1am … 24 → 11pm–midnight), GMT.
    no2ByHour: Array.from({ length: 24 }, (_, i) => ({
      hour: i + 1,
      mean: pooled("no2", "hourly", i),
    })),
  };

  const seasonal = {
    years: windowYears,
    monthly: Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      no2: pooled("no2", "monthly", i),
      pm25: pooled("pm25", "monthly", i),
      pm10: pooled("pm10", "monthly", i),
      o3: pooled("o3", "monthly", i),
    })),
  };

  const latestAcc = accs[accs.length - 1] || null;
  return {
    station: { name: "Leeds Centre", siteId: "LEED", type: "Urban background" },
    unit: "µg/m³",
    captureThreshold: CAPTURE_THRESHOLD,
    limits: LIMITS,
    years,
    rhythm,
    seasonal,
    coverage: {
      from: accs.length ? accs[0].year : null,
      to: latestAcc ? latestAcc.year : null,
      latestReading: latestAcc ? latestAcc.latestDate : null,
    },
    source: "https://uk-air.defra.gov.uk/data/flat_files?site_id=LEED",
    updated: new Date().toISOString(),
  };
}

// Worker route handler (KV read only) --------------------------------------

export async function handleAirSummary(env) {
  return env.CACHE.get("air:summary", { type: "json" });
}
