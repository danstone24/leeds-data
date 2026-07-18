// School places aggregator + Worker handler.
//
// Four datasets, two phases:
//   24l45 Primary preferences    e619w Secondary preferences
//   e6qpz Primary allocations    23ym1 Secondary allocations
//
// Preferences files list every school (including academies) with applications
// by preference rank — the demand side, and our only citywide measure.
// Allocations files carry Published Admission Number and places allocated,
// but ONLY for community and voluntary-controlled schools in recent years
// (academies stopped reporting after 2019), so anything built on
// PAN/allocated is explicitly "council-run schools only".
//
// Quirks handled here:
//   - Files open with 0–2 junk title lines before the real header, so we
//     detect the header row by content instead of position.
//   - Header names drift: "DfE Number" vs "Dfee", "School Code" vs
//     "SchoolCode", "1st Preferences" vs "Applications as 1st preference",
//     trailing spaces throughout.
//   - Secondary allocations publish "Total Allocated / Places Available" as
//     one cell ("300/285") in some years and a plain number in others.
//   - Trailing all-blank padding rows.
//
// KV keys:
//   schools:summary → per-phase demand trend, competition table, fill trend
//   schools:hash    → fingerprint across all four datasets' resources

const clean = (s) => String(s ?? "").trim();
const num = (s) => {
  const n = Number(clean(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

function findHeaderRow(records, requiredPatterns) {
  for (let i = 0; i < Math.min(records.length, 6); i++) {
    const cells = records[i].map((c) => clean(c).toLowerCase());
    if (requiredPatterns.every((re) => cells.some((c) => re.test(c)))) return i;
  }
  return -1;
}

function columnIndex(header, re) {
  return header.findIndex((c) => re.test(clean(c).toLowerCase()));
}

// records: string[][] from parseCsvStream. Returns [{ code, name, first, total }]
// or null if this doesn't look like a preferences file.
export function parsePrefsRecords(records) {
  const h = findHeaderRow(records, [/dfe|dfee/, /school name/, /1st/]);
  if (h < 0) return null;
  const header = records[h];
  const codeCol = columnIndex(header, /dfe|dfee/);
  const nameCol = columnIndex(header, /school name/);
  const firstCol = columnIndex(header, /1st/);
  const totalCol = columnIndex(header, /total/);
  const out = [];
  for (const row of records.slice(h + 1)) {
    const code = clean(row[codeCol]);
    const name = clean(row[nameCol]);
    if (!/^\d{3,4}$/.test(code) || !name || /total/i.test(name)) continue;
    const first = num(row[firstCol]);
    if (first === null) continue;
    out.push({ code, name, first, total: num(row[totalCol]) ?? first });
  }
  return out.length ? out : null;
}

// records: string[][]. Returns [{ code, name, type, pan, allocated, available }]
// or null if the file doesn't carry PAN/allocated columns (older eras).
export function parseAllocRecords(records) {
  const h = findHeaderRow(records, [/^school ?code$/, /published admission number/]);
  if (h < 0) return null;
  const header = records[h];
  const codeCol = columnIndex(header, /^school ?code$/);
  const nameCol = columnIndex(header, /^school$/);
  const typeCol = columnIndex(header, /^type$/);
  const panCol = columnIndex(header, /published admission number/);
  // Primary: "Places Allocated". Secondary: "Total Allocated / Places Available".
  const allocCol = columnIndex(header, /places allocated|total allocated/);
  if (nameCol < 0 || allocCol < 0) return null;

  const out = [];
  for (const row of records.slice(h + 1)) {
    const code = clean(row[codeCol]);
    const name = clean(row[nameCol]);
    if (!/^\d{3,4}$/.test(code) || !name || /total/i.test(name)) continue;
    const pan = num(row[panCol]);
    const allocCell = clean(row[allocCol]);
    let allocated = null;
    let available = pan;
    const combined = allocCell.match(/^(\d+)\s*\/\s*(\d+)/);
    if (combined) {
      allocated = Number(combined[1]);
      available = Number(combined[2]);
    } else {
      allocated = num(allocCell);
    }
    if (allocated === null || !available) continue;
    out.push({ code, name, type: clean(row[typeCol]), pan, allocated, available });
  }
  return out.length ? out : null;
}

// phase input: { prefsByYear: Map<year, prefRows>, allocByYear: Map<year, allocRows> }
function buildPhase(input) {
  const years = [...new Set([...input.prefsByYear.keys(), ...input.allocByYear.keys()])].sort();
  const yearly = years.map((year) => {
    const prefs = input.prefsByYear.get(year) || null;
    const alloc = input.allocByYear.get(year) || null;
    const entry = { year };
    if (prefs) {
      entry.firstPrefs = prefs.reduce((s, r) => s + r.first, 0);
      entry.totalPrefs = prefs.reduce((s, r) => s + r.total, 0);
      entry.schools = prefs.length;
    }
    if (alloc) {
      entry.allocSchools = alloc.length;
      entry.allocated = alloc.reduce((s, r) => s + r.allocated, 0);
      entry.available = alloc.reduce((s, r) => s + r.available, 0);
      entry.underSubscribed = alloc.filter((r) => r.allocated < r.available).length;
    }
    return entry;
  });

  // Competition table: latest year present in BOTH files, first prefs per
  // available place — council-run schools only (the rest have no PAN here).
  const joinYears = years
    .filter((y) => input.prefsByYear.has(y) && input.allocByYear.has(y))
    .sort();
  const joinYear = joinYears[joinYears.length - 1] ?? null;
  let competition = [];
  if (joinYear !== null) {
    const prefsByCode = new Map(input.prefsByYear.get(joinYear).map((r) => [r.code, r]));
    competition = input.allocByYear
      .get(joinYear)
      .filter((a) => prefsByCode.has(a.code) && a.available > 0)
      .map((a) => ({
        name: a.name,
        type: a.type,
        first: prefsByCode.get(a.code).first,
        available: a.available,
        ratio: Math.round((prefsByCode.get(a.code).first / a.available) * 10) / 10,
      }))
      .sort((a, b) => b.ratio - a.ratio);
  }

  const demandYears = yearly.filter((y) => y.firstPrefs !== undefined);
  return {
    yearly,
    latestYear: demandYears.length ? demandYears[demandYears.length - 1].year : null,
    competitionYear: joinYear,
    competition,
  };
}

export function buildSchools(primaryInput, secondaryInput) {
  return {
    primary: buildPhase(primaryInput),
    secondary: buildPhase(secondaryInput),
    sources: {
      primaryPreferences: "https://datamillnorth.org/dataset/primary-preferences-24l45",
      primaryAllocations: "https://datamillnorth.org/dataset/primary-school-allocations-e6qpz",
      secondaryPreferences: "https://datamillnorth.org/dataset/secondary-school-preferences-e619w",
      secondaryAllocations: "https://datamillnorth.org/dataset/secondary-school-allocations-23ym1",
    },
    updated: new Date().toISOString(),
  };
}

// Worker route handler (KV read only) --------------------------------------

export async function handleSchoolsSummary(env) {
  return env.CACHE.get("schools:summary", { type: "json" });
}
