// Road traffic collisions aggregator + Worker handler.
//
// Dataset: 2o11d ("Road traffic collisions"). One CSV per year, 2009 onwards,
// one row per injured casualty (from police Stats19 forms). The schema changed
// around 2017: older files spell values out ("Slight", "Pedestrian") and carry
// grid references; newer files use numeric Stats19 codes, drop the coordinates
// and pad the file with blank trailing rows. We normalise both and drop the
// padding.
//
// No map: coordinates only exist in the pre-2017 files, so a consistent map
// across all years isn't possible. The story here is the trend anyway.
//
// KV key layout:
//   collisions:summary → yearly trend, severity/class splits, by-hour, totals
//   collisions:hash    → fingerprint of the source resources (idempotent refresh)

const DATASET_ID = "2o11d";
const SOURCE = `https://datamillnorth.org/dataset/road-traffic-collisions-${DATASET_ID}`;

// Stats19 codes AND the older spelled-out labels → canonical values.
const SEVERITY = {
  "1": "fatal", fatal: "fatal",
  "2": "serious", serious: "serious",
  "3": "slight", slight: "slight",
};
// The class label is spelled several ways across years — "Driver", "Driver or
// rider", "Driver/Rider" (2015 only) — so cover every observed variant.
const CLASS = {
  "1": "driver", "driver": "driver", "driver or rider": "driver", "driver/rider": "driver",
  "2": "passenger", "passenger": "passenger", "vehicle or pillion passenger": "passenger",
  "3": "pedestrian", "pedestrian": "pedestrian",
};

function pick(row, ...names) {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function canonSeverity(row) {
  return SEVERITY[pick(row, "Casualty Severity").toLowerCase()] || null;
}
function canonClass(row) {
  return CLASS[pick(row, "Casualty Class").toLowerCase()] || null;
}

// Time comes as "2345", "0630", "08:00" or the odd "8:00" — pull the hour.
function parseHour(row) {
  const t = pick(row, "Time", "Time (24hr)");
  if (!t) return null;
  const digits = t.replace(/[^\d]/g, "");
  if (!digits) return null;
  let hour;
  if (t.includes(":")) hour = Number(t.split(":")[0]);
  else if (digits.length <= 2) hour = Number(digits);
  else hour = Number(digits.slice(0, digits.length - 2)); // strip trailing minutes
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

// A padding row has no reference number — the newer files pad to a fixed length
// with all-empty rows.
export function isRealCollisionRow(row) {
  return pick(row, "Reference Number").length > 0;
}

// Build the summary. `records` is an array of { year, row } — the caller tags
// each parsed row with the year of the file it came from.
export function buildCollisions(records) {
  const yearMap = new Map(); // year → tallies
  const hours = Array.from({ length: 24 }, () => ({ count: 0, ksi: 0 }));
  let totalCasualties = 0;
  let totalKsi = 0;

  const blank = () => ({
    casualties: 0, fatal: 0, serious: 0, slight: 0,
    pedestrian: 0, passenger: 0, driver: 0,
    accidents: new Set(),
  });

  for (const { year, row } of records) {
    const sev = canonSeverity(row);
    const cls = canonClass(row);
    let y = yearMap.get(year);
    if (!y) { y = blank(); yearMap.set(year, y); }

    y.casualties += 1;
    totalCasualties += 1;
    if (sev) y[sev] += 1;
    if (cls) y[cls] += 1;
    const ref = pick(row, "Reference Number");
    if (ref) y.accidents.add(ref);

    const isKsi = sev === "fatal" || sev === "serious";
    if (isKsi) totalKsi += 1;

    const h = parseHour(row);
    if (h !== null) {
      hours[h].count += 1;
      if (isKsi) hours[h].ksi += 1;
    }
  }

  const yearly = [...yearMap.entries()]
    .map(([year, y]) => ({
      year: Number(year),
      casualties: y.casualties,
      fatal: y.fatal,
      serious: y.serious,
      slight: y.slight,
      ksi: y.fatal + y.serious,
      pedestrian: y.pedestrian,
      passenger: y.passenger,
      driver: y.driver,
      accidents: y.accidents.size,
    }))
    .sort((a, b) => a.year - b.year);

  const byHour = hours.map((h, hour) => ({ hour, count: h.count, ksi: h.ksi }));

  const first = yearly[0];
  const latest = yearly[yearly.length - 1];
  const changeSinceStart =
    first && latest && first.casualties
      ? (latest.casualties - first.casualties) / first.casualties
      : 0;

  const summary = {
    coverage: { from: first?.year ?? null, to: latest?.year ?? null },
    latest: latest || null,
    totalCasualties,
    totalKsi,
    changeSinceStart,
    yearly,
    byHour,
    source: SOURCE,
    updated: new Date().toISOString(),
  };

  return { summary };
}

// Worker route handler (KV read only) --------------------------------------

export async function handleCollisionsSummary(env) {
  return env.CACHE.get("collisions:summary", { type: "json" });
}
