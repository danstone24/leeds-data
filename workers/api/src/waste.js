// Recycling & waste aggregator + Worker handler.
//
// The site's second non-Datamillnorth topic: two DEFRA sources, both free,
// Crown copyright / OGL, fetched server-side by the nightly refresh.
//
//   1. Local authority collected waste (annual ODS, re-published each March):
//      sheet Table_3 "Selected Waste Indicators" carries one row per authority
//      per year 2010-11 → latest — recycling %, landfill %, residual
//      kg/household. Table_3b carries the England household recycling rate
//      back to 2000-01 for the comparison line.
//   2. Fly-tipping statistics (two per-authority CSVs, incidents + actions,
//      2012-13 → latest).
//
// Quirks handled here:
//   - The ODS is a zip; content.xml is extracted with a hand-rolled central-
//     directory reader (no dependency). node:zlib is imported lazily inside
//     the extractor so this module stays loadable in the Worker, which only
//     ever calls the KV-reading handler.
//   - ODS cell runs are collapsed with table:number-columns-repeated (one row
//     ends with a 16,000-cell run of blanks) — the parser expands repeats or
//     every column would misalign, and caps each row at MAX_COLS.
//   - ODS values are strings: "34.7%", "615.4" wrapped in <text:s/> padding,
//     "-" / ".." for missing. Strip %, treat "-"/ ".."/":" as null.
//   - Year labels drift between "2019-20" and "2019/20" — normalised to "-".
//   - The fly-tipping CSVs can carry stray NUL bytes and a BOM (they defeat
//     grep but parse fine once stripped); their real header is on line 2
//     after a title line, so it's detected by content, never by position.
//   - Leeds is matched by ONS code E08000035 ONLY — it's "Leeds City Council
//     MBC" in the ODS but "Leeds" in the fly-tipping files.
//
// KV keys:
//   waste:summary → recycling/landfill/residual series + fly-tipping series
//   waste:hash    → fingerprint (content-length/ETag) across all three files

import { parseCsvStream } from "./csv.js";

export const LEEDS_ONS = "E08000035";

const clean = (s) => String(s ?? "").trim();

// "34.7%" → 34.7 · " 615.4 " → 615.4 · "1,234" → 1234 · "-" / ".." / ":" → null
const num = (s) => {
  const t = clean(s).replace(/%$/, "").replace(/,/g, "");
  if (!t || t === "-" || t === ".." || t === ":") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

// "2019/20" → "2019-20"
const normYear = (s) => clean(s).replace("/", "-");
const YEAR_RE = /^\d{4}-\d{2}$/;

function findHeaderRow(records, requiredPatterns, scan = 6) {
  for (let i = 0; i < Math.min(records.length, scan); i++) {
    const cells = records[i].map((c) => clean(c).toLowerCase());
    if (requiredPatterns.every((re) => cells.some((c) => re.test(c)))) return i;
  }
  return -1;
}

function columnIndex(header, re) {
  return header.findIndex((c) => re.test(clean(c).toLowerCase()));
}

// ODS extraction (refresh-script path only — needs node:zlib) ---------------

// An ODS file is a zip. Walk the end-of-central-directory record to find
// content.xml, then inflate it. Entries may be STORED (method 0) or DEFLATE
// (method 8) — both are handled. zlib is imported lazily so the Worker never
// evaluates a Node builtin at startup.
export async function extractOdsContentXml(buffer) {
  const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const u16 = (o) => buf[o] | (buf[o + 1] << 8);
  const u32 = (o) => (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;

  // End-of-central-directory signature PK\x05\x06, scanned back past any
  // trailing zip comment (max 64 KB).
  let eocd = -1;
  const stop = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip: end-of-central-directory record missing");

  const entryCount = u16(eocd + 10);
  let off = u32(eocd + 16);
  const dec = new TextDecoder();
  for (let n = 0; n < entryCount; n++) {
    if (u32(off) !== 0x02014b50) throw new Error("Corrupt zip central directory");
    const method = u16(off + 10);
    const compSize = u32(off + 20);
    const nameLen = u16(off + 28);
    const extraLen = u16(off + 30);
    const commentLen = u16(off + 32);
    const localOff = u32(off + 42);
    const name = dec.decode(buf.subarray(off + 46, off + 46 + nameLen));
    if (name === "content.xml") {
      // Local header's name/extra lengths can differ from the central copy.
      if (u32(localOff) !== 0x04034b50) throw new Error("Corrupt zip local header");
      const dataStart = localOff + 30 + u16(localOff + 26) + u16(localOff + 28);
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return dec.decode(data);
      if (method === 8) {
        const { inflateRawSync } = await import("node:zlib");
        return dec.decode(inflateRawSync(data));
      }
      throw new Error(`content.xml uses unsupported zip method ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("content.xml not found in ODS");
}

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// Join the cell's <text:p> paragraphs and strip nested markup (<text:s/>
// padding, spans), then decode entities.
function cellText(inner) {
  const ps = [];
  const re = /<text:p[^>]*>([\s\S]*?)<\/text:p>/g;
  let m;
  while ((m = re.exec(inner))) ps.push(m[1]);
  return decodeEntities(ps.join(" ").replace(/<[^>]*>/g, "")).trim();
}

// Real data never lives past ~column 30 in these sheets; blank runs of
// 16k repeated cells are truncated here instead of expanded.
const MAX_COLS = 40;

// Extract one named sheet from ODS content.xml as string[][], expanding
// table:number-columns-repeated so columns align. Returns null if missing.
export function parseOdsTable(xml, name) {
  const at = xml.indexOf(`table:name="${name}"`);
  if (at < 0) return null;
  const start = xml.lastIndexOf("<table:table", at);
  const end = xml.indexOf("</table:table>", at);
  if (start < 0 || end < 0) return null;
  const chunk = xml.slice(start, end);

  const rows = [];
  const rowRe = /<table:table-row\b[^>]*\/>|<table:table-row\b[^>]*>[\s\S]*?<\/table:table-row>/g;
  const cellRe = /<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g;
  let rm;
  while ((rm = rowRe.exec(chunk))) {
    const cells = [];
    let cm;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rm[0])) && cells.length < MAX_COLS) {
      const rep = /table:number-columns-repeated="(\d+)"/.exec(cm[1]);
      const n = Math.min(rep ? Number(rep[1]) : 1, MAX_COLS - cells.length);
      const text = cm[2] ? cellText(cm[2]) : "";
      for (let i = 0; i < n; i++) cells.push(text);
    }
    rows.push(cells);
  }
  return rows;
}

// Waste indicators (Table_3 + Table_3b) -------------------------------------

// xml: ODS content.xml. Returns:
//   leeds:   [{ year, recycling, landfill, residualKg, perPersonKg }]  2010-11 →
//   england: [{ year, rate }]                                          2000-01 →
export function parseWasteOds(xml) {
  const t3 = parseOdsTable(xml, "Table_3");
  if (!t3) throw new Error("Table_3 not found in waste ODS");
  const h = findHeaderRow(t3, [/^year$/, /ons code/, /landfill/], 8);
  if (h < 0) throw new Error("Table_3 header row not recognised");
  const header = t3[h];
  const yearCol = columnIndex(header, /^year$/);
  const onsCol = columnIndex(header, /ons code/);
  const residCol = columnIndex(header, /residual household waste/);
  const recycCol = columnIndex(header, /reuse, recycling or composting/);
  const landfCol = columnIndex(header, /landfill/);
  const perPersonCol = columnIndex(header, /per person/);
  if (residCol < 0 || recycCol < 0 || landfCol < 0) {
    throw new Error("Table_3 indicator columns not recognised");
  }

  const leeds = t3
    .slice(h + 1)
    .filter((r) => clean(r[onsCol]) === LEEDS_ONS)
    .map((r) => ({
      year: normYear(r[yearCol]),
      recycling: num(r[recycCol]),
      landfill: num(r[landfCol]),
      residualKg: num(r[residCol]),
      perPersonKg: perPersonCol >= 0 ? num(r[perPersonCol]) : null,
    }))
    .filter((r) => YEAR_RE.test(r.year))
    .sort((a, b) => a.year.localeCompare(b.year));

  // Table_3b is wide: a years header row, then indicator rows. We want
  // "Household waste recycling rate" against the nearest years row above it.
  const england = [];
  const t3b = parseOdsTable(xml, "Table_3b");
  if (t3b) {
    const rateIdx = t3b.findIndex((r) => /^household waste recycling rate/i.test(clean(r[0])));
    let yearsRow = null;
    for (let i = rateIdx - 1; i >= 0; i--) {
      if (YEAR_RE.test(normYear(t3b[i][1]))) {
        yearsRow = t3b[i];
        break;
      }
    }
    if (rateIdx >= 0 && yearsRow) {
      for (let c = 1; c < yearsRow.length; c++) {
        const year = normYear(yearsRow[c]);
        const rate = num(t3b[rateIdx][c]);
        if (YEAR_RE.test(year) && rate !== null) england.push({ year, rate });
      }
    }
  }

  return { leeds, england };
}

// Fly-tipping CSVs -----------------------------------------------------------

// Strip stray NUL bytes and a UTF-8 BOM at the byte level, then reuse the
// shared streaming CSV parser (which also handles the quoted multi-line
// "Chemical Drums, Oil, Fuel" header cell).
export async function csvRecordsFromBytes(bytes) {
  let buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  if (buf.includes(0)) buf = buf.filter((b) => b !== 0);
  const records = [];
  for await (const rec of parseCsvStream(new Response(buf).body)) records.push(rec);
  return records;
}

// Land-type columns, in the file's own order. Anchored so the land-type
// "Other (unidentified) Incidents" doesn't also match the waste-type column
// "Primary Waste Type Measures Other (unidentified) Incidents".
const LAND_TYPES = [
  [/^highway incidents$/, "Highway"],
  [/^footpath \/ bridleway incidents$/, "Footpath or bridleway"],
  [/^back alleyway incidents$/, "Back alleyway"],
  [/^railway incidents$/, "Railway"],
  [/^council land incidents$/, "Council land"],
  [/^agricultural incidents$/, "Agricultural land"],
  [/^private \/ residential incidents$/, "Private or residential"],
  [/^commercial \/ industrial incidents$/, "Commercial or industrial"],
  [/^watercourse \/ bank incidents$/, "Watercourse or bank"],
  [/^other \(unidentified\) incidents$/, "Other or unidentified"],
];

// records: string[][]. Returns Map year → { total, byLandType: [{type, count}] }
export function parseFlyTippingIncidents(records) {
  const h = findHeaderRow(records, [/^year$/, /ons code/, /^total incidents$/]);
  if (h < 0) throw new Error("Fly-tipping incidents header not recognised");
  const header = records[h];
  const yearCol = columnIndex(header, /^year$/);
  const onsCol = columnIndex(header, /ons code/);
  const totalCol = columnIndex(header, /^total incidents$/);
  const landCols = LAND_TYPES.map(([re, label]) => [columnIndex(header, re), label]).filter(
    ([i]) => i >= 0
  );

  const byYear = new Map();
  for (const row of records.slice(h + 1)) {
    if (clean(row[onsCol]) !== LEEDS_ONS) continue;
    const year = normYear(row[yearCol]);
    if (!YEAR_RE.test(year)) continue;
    const total = num(row[totalCol]);
    if (total === null) continue;
    byYear.set(year, {
      total,
      byLandType: landCols
        .map(([i, type]) => ({ type, count: num(row[i]) ?? 0 }))
        .sort((a, b) => b.count - a.count),
    });
  }
  return byYear;
}

// records: string[][]. Returns Map year → { total, investigationCostGbp }
export function parseFlyTippingActions(records) {
  const h = findHeaderRow(records, [/^year$/, /ons code/, /^total actions$/]);
  if (h < 0) throw new Error("Fly-tipping actions header not recognised");
  const header = records[h];
  const yearCol = columnIndex(header, /^year$/);
  const onsCol = columnIndex(header, /ons code/);
  const totalCol = columnIndex(header, /^total actions$/);
  // The £ in "Investigation Action Costs (£)" arrives cp1252-mangled some
  // years, so the pattern avoids the currency symbol entirely.
  const costCol = columnIndex(header, /^investigation action costs/);

  const byYear = new Map();
  for (const row of records.slice(h + 1)) {
    if (clean(row[onsCol]) !== LEEDS_ONS) continue;
    const year = normYear(row[yearCol]);
    if (!YEAR_RE.test(year)) continue;
    const total = num(row[totalCol]);
    if (total === null) continue;
    byYear.set(year, {
      total,
      investigationCostGbp: costCol >= 0 ? num(row[costCol]) : null,
    });
  }
  return byYear;
}

// Final summary ---------------------------------------------------------------

const WASTE_SOURCE =
  "https://www.gov.uk/government/statistics/local-authority-collected-waste-management-annual-results";
const FLYTIP_SOURCE = "https://www.gov.uk/government/statistics/fly-tipping-statistics-for-england";

// odsBuffer / incidentsCsv / actionsCsv are raw bytes (Buffer or Uint8Array).
// meta may carry the resolved file URLs for provenance.
export async function buildWaste({ odsBuffer, incidentsCsv, actionsCsv, meta = {} }) {
  const xml = await extractOdsContentXml(odsBuffer);
  const { leeds, england } = parseWasteOds(xml);
  if (!leeds.length) throw new Error("No Leeds rows found in waste ODS");

  const incidents = parseFlyTippingIncidents(await csvRecordsFromBytes(incidentsCsv));
  const actions = parseFlyTippingActions(await csvRecordsFromBytes(actionsCsv));

  const years = [...new Set([...incidents.keys(), ...actions.keys()])].sort();
  const yearly = years.map((year) => ({
    year,
    incidents: incidents.get(year)?.total ?? null,
    actions: actions.get(year)?.total ?? null,
    investigationCostGbp: actions.get(year)?.investigationCostGbp ?? null,
  }));

  const incidentYears = years.filter((y) => incidents.has(y));
  const latestYear = incidentYears[incidentYears.length - 1] ?? null;

  return {
    recycling: {
      leeds,
      england,
      source: WASTE_SOURCE,
      fileUrl: meta.odsUrl || null,
    },
    flyTipping: {
      yearly,
      latest: latestYear
        ? {
            year: latestYear,
            incidents: incidents.get(latestYear).total,
            byLandType: incidents.get(latestYear).byLandType,
          }
        : null,
      source: FLYTIP_SOURCE,
    },
    updated: new Date().toISOString(),
  };
}

// Worker route handler (KV read only) --------------------------------------

export async function handleWasteSummary(env) {
  return env.CACHE.get("waste:summary", { type: "json" });
}
