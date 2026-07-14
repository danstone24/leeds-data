// City-centre footfall aggregator + Worker handler.
//
// Dataset: 2rlld ("Leeds city centre footfall data"). 8 cameras counting people
// per hour. This is the messiest dataset on the site: ~575 CSVs that overlap
// heavily (per-camera history dumps, weekly feeds, monthly feeds, "revised"
// re-issues) across THREE schema eras:
//   2008–2014  one file per camera: Date(DD/MM/YYYY), Hour, LocationName, Count
//   ~2015      Date(YYYY-MM-DD), …, TotalCount, …, FactoredTotalCount
//   2020+      Date(DD-Mon-YY), …, ReportCount, FactoredReportCount, renamed cams
//
// Strategy (mirrors counts.js): ignore file titles, key every row by
// (date, hour, camera) and keep the MAX on collision — the council warned that
// older counts were under-reported and later revised upward, so max prefers the
// corrected figures. Because the number of live cameras varies, we trend the
// **mean daily footfall per camera** rather than raw totals.
//
// KV key layout:
//   footfall:summary → monthly + yearly trend, by-hour, by-weekday, busiest spots
//   footfall:hash    → fingerprint of the source resources

const DATASET_ID = "2rlld";
const SOURCE = `https://datamillnorth.org/dataset/leeds-city-centre-footfall-data-${DATASET_ID}`;
const RECENT_MONTHS = 12; // window for the "busiest locations" ranking

// The council renamed the cameras; fold old names into the current ones so a
// single camera is one series (and isn't double-counted during a transition).
const RENAME = {
  "albion street south": "Albion Street at Bond Street",
  "briggate at mcdonalds": "Briggate at Swan Street",
  "dortmund square": "Headrow at Broadgate",
  "headrow": "Headrow at Lands Lane",
};

const MONTH_ABBR = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function canonLocation(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return RENAME[t.toLowerCase()] || t;
}

// Handle the three date formats → "yyyy-mm-dd".
function parseFootDate(s) {
  const t = String(s || "").trim();
  let m;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/))) return `${m[3]}-${m[2]}-${m[1]}`;
  if ((m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/))) {
    const mm = MONTH_ABBR[m[2].toLowerCase()];
    if (!mm) return null;
    return `20${m[3]}-${mm}-${String(m[1]).padStart(2, "0")}`;
  }
  return null;
}

// "00:00" or "0" or "13:00" → 0..23
function parseHour(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  const h = Number(t.includes(":") ? t.split(":")[0] : t);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

function firstCount(row) {
  for (const key of ["Count", "TotalCount", "ReportCount"]) {
    const v = row[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// UTC weekday index (0 = Sunday) for a "yyyy-mm-dd" string.
function weekdayIndex(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Fold one CSV row into the dedupe map: key "date|hour|camera" → max count seen.
export function accumulateFootRow(map, row) {
  const date = parseFootDate(row["Date"]);
  if (!date) return;
  const hour = parseHour(row["Hour"]);
  if (hour === null) return;
  const loc = canonLocation(row["LocationName"]);
  if (!loc) return;
  const count = firstCount(row);
  if (count === null) return;

  const key = `${date}|${hour}|${loc}`;
  const prev = map.get(key);
  if (prev === undefined || count > prev) map.set(key, count);
}

function round(n) { return Math.round(n); }

// Turn the deduped slot map into the stored summary.
export function finaliseFootfall(map) {
  const monthly = new Map();       // month → { count, camDays:Set }
  const byHourSum = new Array(24).fill(0);
  const weekday = Array.from({ length: 7 }, () => ({ sum: 0, camDays: new Set() }));
  const locByMonth = new Map();    // "loc|month" → count
  const allCamDays = new Set();    // distinct loc|date overall

  for (const [key, count] of map) {
    const sep1 = key.indexOf("|");
    const sep2 = key.indexOf("|", sep1 + 1);
    const date = key.slice(0, sep1);
    const hour = Number(key.slice(sep1 + 1, sep2));
    const loc = key.slice(sep2 + 1);
    const month = date.slice(0, 7);
    const camDay = `${loc}|${date}`;

    let mo = monthly.get(month);
    if (!mo) { mo = { count: 0, camDays: new Set() }; monthly.set(month, mo); }
    mo.count += count;
    mo.camDays.add(camDay);

    byHourSum[hour] += count;

    const wi = weekdayIndex(date);
    weekday[wi].sum += count;
    weekday[wi].camDays.add(camDay);

    const lk = `${loc}|${month}`;
    locByMonth.set(lk, (locByMonth.get(lk) || 0) + count);

    allCamDays.add(camDay);
  }

  const monthlyArr = [...monthly.entries()]
    .map(([month, mo]) => ({
      month,
      count: mo.count,
      cameraDays: mo.camDays.size,
      meanDaily: mo.camDays.size ? round(mo.count / mo.camDays.size) : 0,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Yearly: mean daily = total count / total camera-days.
  const yearMap = new Map();
  for (const mo of monthlyArr) {
    const y = mo.month.slice(0, 4);
    let yr = yearMap.get(y);
    if (!yr) { yr = { count: 0, cameraDays: 0, months: 0 }; yearMap.set(y, yr); }
    yr.count += mo.count;
    yr.cameraDays += mo.cameraDays;
    yr.months += 1;
  }
  const yearly = [...yearMap.entries()]
    .map(([year, y]) => ({
      year: Number(year),
      meanDaily: y.cameraDays ? round(y.count / y.cameraDays) : 0,
      cameraDays: y.cameraDays,
      monthsCovered: y.months,
    }))
    .sort((a, b) => a.year - b.year);

  const totalCamDays = allCamDays.size || 1;
  const byHour = byHourSum.map((sum, hour) => ({ hour, avgPerCamera: round(sum / totalCamDays) }));
  const byWeekday = weekday.map((w, i) => ({
    day: WEEKDAYS[i],
    avgPerCamera: w.camDays.size ? round(w.sum / w.camDays.size) : 0,
  }));

  // Busiest locations over the most recent RECENT_MONTHS of data.
  const months = monthlyArr.map((m) => m.month);
  const recentSet = new Set(months.slice(-RECENT_MONTHS));
  const locRecent = new Map(); // loc → { count, camMonths }
  for (const [lk, count] of locByMonth) {
    const sep = lk.lastIndexOf("|");
    const loc = lk.slice(0, sep);
    const month = lk.slice(sep + 1);
    if (!recentSet.has(month)) continue;
    let l = locRecent.get(loc);
    if (!l) { l = { count: 0, months: 0 }; locRecent.set(loc, l); }
    l.count += count;
    l.months += 1;
  }
  const locations = [...locRecent.entries()]
    .map(([name, l]) => ({ name, share: 0, count: l.count }))
    .sort((a, b) => b.count - a.count);
  const locTotal = locations.reduce((s, l) => s + l.count, 0) || 1;
  for (const l of locations) l.share = l.count / locTotal;

  const cameras = new Set([...allCamDays].map((cd) => cd.slice(0, cd.indexOf("|")))).size;

  return {
    monthly: monthlyArr,
    yearly,
    byHour,
    byWeekday,
    locations,
    cameras,
    coverage: { from: monthlyArr[0]?.month || null, to: monthlyArr[monthlyArr.length - 1]?.month || null },
    latest: yearly[yearly.length - 1] || null,
    source: SOURCE,
    updated: new Date().toISOString(),
  };
}

// Worker route handler (KV read only) --------------------------------------

export async function handleFootfallSummary(env) {
  return env.CACHE.get("footfall:summary", { type: "json" });
}
