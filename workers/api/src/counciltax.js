// Council tax aggregator + Worker handler.
//
// Source: "Council tax charges" dataset (24zz5). We read the single
// "Major Council Tax Precepts 1993-20XX.csv" file — one row per precepting
// authority per financial year, bands A–H, plus a Total row per year.
//
// Quirks handled here:
//   - The financial year is only present on the first row of each year's
//     block (forward-filled), and the first row isn't always the council's
//     (2021/22 starts with the fire authority).
//   - Year labels contain typos ("1993/64", "1996/67", "1999/20") — we trust
//     the 4-digit start year and derive the end year ourselves.
//   - Authority names drift across eras ("POLICE" → "West Yorkshire Police
//     Authority" → "Police & Crime Commissioner West Yorks"), so rows are
//     classified by keyword.
//   - From 2016/17 the Adult Social Care precept sometimes appears as its own
//     row and is sometimes folded into the council's line. We keep it separate
//     when published; charts stack it on top of the council share.
//   - Amounts are "£1,234.56" strings in cp1252 (the shared CSV parser already
//     decodes that).
//
// KV keys:
//   counciltax:summary → yearly band-D components + per-band totals
//   counciltax:hash    → fingerprint of the source resource

const BANDS = ["A", "B", "C", "D", "E", "F", "G", "H"];

function parseMoney(s) {
  const n = Number(String(s || "").replace(/[£\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// "1993/64" → 1993 (the start year is reliable, the suffix isn't).
function parseStartYear(s) {
  const m = String(s || "").trim().match(/^(\d{4})\s*\//);
  return m ? Number(m[1]) : null;
}

function yearLabel(startYear) {
  return `${startYear}/${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function classifyAuthority(name) {
  const n = String(name || "").toLowerCase();
  if (!n.trim()) return null;
  if (n.includes("adult social care")) return "socialCare";
  if (n.includes("leeds")) return "council";
  if (n.includes("police")) return "police";
  if (n.includes("fire")) return "fire";
  return null;
}

// rows: objects from parseCsvObjects over the precepts CSV.
export function buildCouncilTax(rows, resource) {
  const byYear = new Map(); // startYear → { components: {…}, totalBands: {…} }
  let currentYear = null;

  for (const row of rows) {
    const yearCell = String(row["Financial Year"] || "").trim();
    const isTotal =
      /^total$/i.test(yearCell) || /^total$/i.test(String(row["Precepting Authority"] || "").trim());
    const startYear = parseStartYear(yearCell);
    if (startYear !== null) currentYear = startYear;
    if (currentYear === null) continue;

    let y = byYear.get(currentYear);
    if (!y) {
      y = { components: {}, totalBands: null };
      byYear.set(currentYear, y);
    }

    const bands = {};
    let any = false;
    for (const b of BANDS) {
      const v = parseMoney(row[`Band ${b}`]);
      bands[b] = v;
      if (v !== null) any = true;
    }
    if (!any) continue;

    if (isTotal) {
      y.totalBands = bands;
      continue;
    }
    const kind = classifyAuthority(row["Precepting Authority"]);
    if (kind) y.components[kind] = bands;
  }

  const years = [...byYear.entries()]
    .filter(([, y]) => y.totalBands || y.components.council)
    .map(([startYear, y]) => {
      const comp = (kind) => y.components[kind]?.D ?? 0;
      // Fall back to summed components for the odd year missing a Total row.
      const totalBands =
        y.totalBands ||
        Object.fromEntries(
          BANDS.map((b) => [
            b,
            Object.values(y.components).reduce((sum, c) => sum + (c[b] || 0), 0),
          ])
        );
      return {
        year: yearLabel(startYear),
        startYear,
        bandD: {
          council: comp("council"),
          socialCare: comp("socialCare"),
          police: comp("police"),
          fire: comp("fire"),
          total: totalBands.D ?? 0,
        },
        bands: totalBands,
      };
    })
    .sort((a, b) => a.startYear - b.startYear);

  const latest = years[years.length - 1] || null;
  const previous = years[years.length - 2] || null;
  const first = years[0] || null;

  return {
    years,
    latest,
    first,
    changeSinceStart:
      latest && first && first.bandD.total ? latest.bandD.total / first.bandD.total - 1 : null,
    changeYoY:
      latest && previous && previous.bandD.total
        ? latest.bandD.total / previous.bandD.total - 1
        : null,
    source: "https://datamillnorth.org/dataset/council-tax-charges-24zz5",
    resourceTitle: resource?.title || null,
    updated: new Date().toISOString(),
  };
}

// Worker route handler (KV read only) --------------------------------------

export async function handleCouncilTaxSummary(env) {
  return env.CACHE.get("counciltax:summary", { type: "json" });
}
