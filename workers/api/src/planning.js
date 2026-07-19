// Planning applications aggregator + Worker handlers.
//
// Two sources with different jobs (see docs/planning-plan.md):
//   - MHCLG PS1/PS2 quarterly open-data CSVs — every NUMBER on the page.
//     PS1 = applications received/decided/withdrawn per LPA per quarter;
//     PS2 = decisions by outcome, size (major/minor/other) and speed.
//     Discovered via the GOV.UK content API (media URLs change every
//     publication); Leeds = LPACD E08000035.
//   - PlanIt API (planit.org.uk) — the map layer only. Volunteer-run
//     third-party aggregator of council portals; display layer, never stats.
//
// PS1/PS2 quirks handled here:
//   - A variable number of preamble rows before the real header (PS1 has 3,
//     PS2 has 2 in the March 2026 edition) — the header row is detected by
//     content (Region, LPANM, LPACD, Quarter), never by position.
//   - Columns are looked up by NAME, not position — the measure sets have
//     drifted across years and the names are long and semicolon-delimited.
//   - Missing values are ".." — treated as null, never Number()'d blindly.
//   - Some editions carry stray NUL/BOM bytes that defeat grep — stripped
//     before parsing; the CSV parser then reads them fine.
//
// KV keys:
//   planning:summary → MHCLG per-quarter series + latest-quarter tiles
//   planning:apps    → PlanIt map payload (kept last-good on refresh failure)
//   planning:hash    → fingerprint of the two MHCLG files

import { parseCsvStream } from "./csv.js";

export const LEEDS_LPACD = "E08000035";
export const MHCLG_LANDING =
  "https://www.gov.uk/government/statistical-data-sets/live-tables-on-planning-application-statistics";
export const PLANIT_SOURCE = "https://www.planit.org.uk/";

const clean = (s) => String(s ?? "").trim();

// ".." is MHCLG's explicit null. Empty cells too.
const num = (s) => {
  const t = clean(s);
  if (!t || t === "..") return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

// Strip the stray bytes (NULs, BOM) that some editions carry.
const stripStray = (text) => text.replace(/[\u0000\ufeff]/g, "");

// "2025 Q2" → 20252 for sorting; null if it doesn't look like a quarter.
function quarterKey(q) {
  const m = clean(q).match(/^(\d{4})\s*Q([1-4])$/i);
  return m ? Number(m[1]) * 10 + Number(m[2]) : null;
}

function columnIndex(header, re) {
  return header.findIndex((c) => re.test(clean(c).toLowerCase()));
}

// Parse one PS file's text down to Leeds rows: Map<quarterKey, {quarter, cells, header}>.
// `cols` maps output field names to header-matching regexes.
async function extractLeeds(csvText, cols) {
  const stream = new Response(stripStray(csvText)).body;
  let header = null;
  let idx = null;
  const out = new Map();
  for await (const record of parseCsvStream(stream)) {
    if (!header) {
      const four = record.slice(0, 4).map((c) => clean(c).toLowerCase());
      if (four[0] === "region" && four[1] === "lpanm" && four[2] === "lpacd" && four[3] === "quarter") {
        header = record;
        idx = {};
        for (const [field, re] of Object.entries(cols)) {
          idx[field] = columnIndex(header, re);
          if (idx[field] < 0) throw new Error(`Planning: column not found for "${field}"`);
        }
      }
      continue;
    }
    if (clean(record[2]) !== LEEDS_LPACD) continue;
    const key = quarterKey(record[3]);
    if (key === null) continue;
    const row = { quarter: clean(record[3]) };
    for (const field of Object.keys(idx)) row[field] = num(record[idx[field]]);
    out.set(key, row);
  }
  if (!header) throw new Error("Planning: header row not found (Region, LPANM, LPACD, Quarter)");
  return out;
}

// Column name → regex, matched against lowercased trimmed header cells.
const PS1_COLS = {
  received: /^applications received$/,
  decided: /^applications decided$/,
  withdrawn: /^applications withdrawn$/,
};

const PS2_COLS = {
  decisions: /^total decisions; grand total \(all\)$/,
  granted: /^total granted; grand total \(all\)$/,
  refused: /^total refused; grand total \(all\)$/,
  decExclPa: /^total decisions; grand total \(excluding pas\)$/,
  inTimeExclPa: /^total decisions in time; grand total \(excluding pas\)$/,
  decPa: /^total decisions; grand total \(pas only\)$/,
  inTimePa: /^total decisions in time; grand total \(pas only\)$/,
  majorDecisions: /^total decisions; major total \(all\)$/,
  majorGranted: /^total granted; major total \(all\)$/,
  majorRefused: /^total refused; major total \(all\)$/,
  minorDecisions: /^total decisions; minor total \(all\)$/,
  minorGranted: /^total granted; minor total \(all\)$/,
  minorRefused: /^total refused; minor total \(all\)$/,
  otherDecisions: /^total decisions; \(other\) total \(all\)$/,
  otherGranted: /^total granted; \(other\) total \(all\)$/,
  otherRefused: /^total refused; \(other\) total \(all\)$/,
};

const round3 = (n) => Math.round(n * 1000) / 1000;

function split(dec, granted, refused) {
  if (dec === null && granted === null && refused === null) return null;
  return { decisions: dec, granted, refused };
}

// "% decided in time" is only defined where the in-time measures exist
// (they don't in the earliest years). PAs (performance agreements) have
// their own deadline, so both halves are summed.
function inTimeShare(row) {
  const dec = (row.decExclPa ?? 0) + (row.decPa ?? 0);
  if (row.inTimeExclPa === null && row.inTimePa === null) return null;
  if (!dec) return null;
  return round3(((row.inTimeExclPa ?? 0) + (row.inTimePa ?? 0)) / dec);
}

// Merge the two Leeds series into one quarterly array + latest-quarter tiles.
// ps1Csv/ps2Csv are the full downloaded file texts; sources are the discovered
// media URLs so the page can link to the exact files served.
export async function buildPlanning({ ps1Csv, ps2Csv, sources = {} }) {
  const ps1 = await extractLeeds(ps1Csv, PS1_COLS);
  const ps2 = await extractLeeds(ps2Csv, PS2_COLS);

  const keys = [...new Set([...ps1.keys(), ...ps2.keys()])].sort((a, b) => a - b);
  const quarters = keys.map((key) => {
    const a = ps1.get(key) || null;
    const b = ps2.get(key) || null;
    return {
      quarter: (a || b).quarter,
      received: a ? a.received : null,
      decided: a ? a.decided : null,
      withdrawn: a ? a.withdrawn : null,
      decisions: b ? b.decisions : null,
      granted: b ? b.granted : null,
      refused: b ? b.refused : null,
      inTimeShare: b ? inTimeShare(b) : null,
      major: b ? split(b.majorDecisions, b.majorGranted, b.majorRefused) : null,
      minor: b ? split(b.minorDecisions, b.minorGranted, b.minorRefused) : null,
      other: b ? split(b.otherDecisions, b.otherGranted, b.otherRefused) : null,
    };
  });

  const withDecisions = quarters.filter((q) => q.decisions !== null && q.decisions > 0);
  const withReceived = quarters.filter((q) => q.received !== null);
  const latest = withDecisions[withDecisions.length - 1] || null;
  const latestReceived = withReceived[withReceived.length - 1] || null;
  const last4 = withDecisions.slice(-4);

  return {
    quarters,
    tiles: latest
      ? {
          quarter: latest.quarter,
          decisions: latest.decisions,
          granted: latest.granted,
          approvalShare:
            latest.granted !== null && latest.decisions ? round3(latest.granted / latest.decisions) : null,
          receivedQuarter: latestReceived ? latestReceived.quarter : null,
          received: latestReceived ? latestReceived.received : null,
          inTimeShare: latest.inTimeShare,
          majorsLastYear: last4.reduce((s, q) => s + (q.major?.decisions ?? 0), 0),
          majorsFromQuarter: last4.length ? last4[0].quarter : null,
        }
      : null,
    coverage: quarters.length
      ? { from: quarters[0].quarter, to: quarters[quarters.length - 1].quarter }
      : null,
    sources: {
      landing: MHCLG_LANDING,
      ps1: sources.ps1 || MHCLG_LANDING,
      ps2: sources.ps2 || MHCLG_LANDING,
    },
    updated: new Date().toISOString(),
  };
}

// PlanIt normaliser -----------------------------------------------------------
//
// Raw paged JSON records → compact map payload. Each geocoded application
// becomes a fixed-order tuple to keep the KV blob and the transfer small:
//   [lat, lon, state, type, size, description, startDate, decidedDate, url]
// `url` is the council's own portal page when PlanIt carries it, else the
// PlanIt page. Large applications additionally go into a small `large` list
// (objects, newest first) for the "what's actually being built" table.

const DESC_MAX = 180;
const LARGE_MAX = 25;

// Loose Leeds-district bounding box — PlanIt occasionally mis-geocodes; a
// point in Cornwall would wreck fitBounds.
const IN_LEEDS = (lat, lon) => lat > 53.6 && lat < 54.0 && lon > -1.9 && lon < -1.2;

const round5 = (n) => Math.round(n * 100000) / 100000;

function trimDescription(s) {
  const t = clean(s).replace(/\s+/g, " ");
  return t.length > DESC_MAX ? `${t.slice(0, DESC_MAX - 1).trimEnd()}…` : t;
}

// One raw PlanIt record → canonical entry (or null when it has no name).
// Entries are what the refresh script persists between runs (keyed by name in
// planning:appsrc) so nightly fetches can be small and merged incrementally —
// PlanIt's per-IP rate budget is nowhere near a full 12-month sweep.
export function planitEntry(r) {
  const name = clean(r?.name);
  if (!name) return null;
  const entry = {
    name,
    description: trimDescription(r.description),
    address: clean(r.address),
    state: clean(r.app_state) || "Other",
    type: clean(r.app_type) || "Other",
    size: clean(r.app_size) || null,
    start: clean(r.start_date) || null,
    decided: clean(r.decided_date) || null,
    url: clean(r.url) || clean(r.link) || null,
  };
  const coords = r.location?.type === "Point" ? r.location.coordinates : null;
  if (coords) {
    const [lon, lat] = coords.map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon) && IN_LEEDS(lat, lon)) {
      entry.lat = round5(lat);
      entry.lon = round5(lon);
    }
  }
  return entry;
}

// Canonical entries → the public map payload served at /api/planning/apps.
export function buildPlanitApps(entries, meta = {}) {
  const apps = [];
  const large = [];

  for (const entry of entries || []) {
    if (entry.size === "Large") large.push(entry);
    if (entry.lat === undefined) continue;
    apps.push([
      entry.lat,
      entry.lon,
      entry.state,
      entry.type,
      entry.size,
      entry.description,
      entry.start,
      entry.decided,
      entry.url,
    ]);
  }

  large.sort((a, b) => String(b.start || "").localeCompare(String(a.start || "")));

  return {
    count: (entries || []).length,
    geocoded: apps.length,
    apps,
    large: large.slice(0, LARGE_MAX).map(({ lat, lon, ...rest }) => rest),
    window: meta.window || null,
    source: PLANIT_SOURCE,
    updated: new Date().toISOString(),
  };
}

export function normalisePlanitApps(records, meta = {}) {
  const byName = new Map();
  for (const r of records || []) {
    const entry = planitEntry(r);
    if (entry && !byName.has(entry.name)) byName.set(entry.name, entry);
  }
  return buildPlanitApps([...byName.values()], meta);
}

// Worker route handlers (KV read only) ---------------------------------------

export async function handlePlanningSummary(env) {
  return env.CACHE.get("planning:summary", { type: "json" });
}

export async function handlePlanningApps(env) {
  return env.CACHE.get("planning:apps", { type: "json" });
}
