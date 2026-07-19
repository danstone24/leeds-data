# Planning applications — build plan (not yet built)

Planning notes for a "What's being built in Leeds, and what gets approved?"
page. **Not built yet** — everything below was verified with live requests on
2026-07-18. All sources free; fetched server-side by the nightly refresh.

**There is no usable Datamillnorth dataset** (checked July 2026 — `exkkr` has
one guidance file and nothing else). This page combines **two** external
sources with different jobs:

| Source | Job | Trust level |
|---|---|---|
| MHCLG PS1/PS2 quarterly open data | Volumes, approval rate, speed — the statistics | Official statistics — source of truth |
| PlanIt API | Application-level detail + map ("what, where") | Third-party volunteer scraper — display layer only |

Design so the page still works if PlanIt disappears: every *number* comes from
MHCLG; PlanIt only powers the map/list figure.

---

## Source 1 — MHCLG planning application statistics (PS1/PS2)

Quarterly returns from every district planning authority, published as
open-data CSVs alongside the live tables.

- **Landing page**: https://www.gov.uk/government/statistical-data-sets/live-tables-on-planning-application-statistics
- **Files** (March 2026 edition, verified):
  - PS1 full dataset (~12 MB): applications received/decided/withdrawn per
    LPA per quarter.
  - PS2 full dataset (~58 MB): decisions by outcome, development type, and
    speed per LPA per quarter.
  - "Last 4 quarters" variants (~340 KB / ~880 KB) — same schema, small.
- **URL discovery (required — media URLs change every quarter)**: GOV.UK
  content API, verified working:
  `https://www.gov.uk/api/content/government/statistical-data-sets/live-tables-on-planning-application-statistics`
  → `details.attachments[]` → match titles
  `District planning application statistics (PS1) - full dataset` and
  `…(PS2) - full dataset` (also `… - last 4 quarters` variants).
- **Schema (both)**: 3 preamble rows (title, "England, <period>", a note),
  then header row 4: `Region, LPANM, LPACD, Quarter, <measures…>`; data from
  row 5. Quarter format `2025 Q2`. **Leeds = `LPACD E08000035`**, `LPANM
  "Leeds"`.
  - PS1 measures: applications at start of quarter, received, decided,
    withdrawn, at end, delegated, …
  - PS2 measures (~200 columns): `Total decisions; grand total (all)`,
    `Total granted; …`, `Total refused; …`, decisions **in time**, split by
    major/minor/other and by development type (dwellings, offices, retail…),
    and performance-agreement (PA) splits.
- **Leeds check**: 2025 Q2 — PS1: 943 received, 1,017 decided, 46 withdrawn;
  PS2: 1,017 decisions, 881 granted, 136 refused (87% approval).
- **Quirks** (all verified):
  - Files defeat `grep` (stray bytes/BOM) — strip ` `/BOM after decode; our
    CSV parser then reads them fine.
  - Missing values are `..` — treat as null, don't `Number()` blindly.
  - District-level figures in the *statistical release* are rounded; these
    open-data tables are the unrounded ones — use them, not the ODS tables.
  - Parse header by name, not position — column sets have drifted across
    years and the measure names are long and semicolon-delimited.
- **Strategy**: fetch the **full** PS1+PS2 each refresh (70 MB total is fine
  in Actions; hash-skip makes it rare), backfilling the whole quarterly
  series in one pass. History extends back years — take whatever's in the
  file rather than assuming a start date.
- Cadence: quarterly (usually ~June/Sep/Dec/Mar releases).

## Source 2 — PlanIt API (application-level layer)

Free, donation-supported aggregator (planit.org.uk) scraping 420+ council
portals daily-ish, including Leeds' own `publicaccess.leeds.gov.uk` (which has
no API of its own — that's why we don't scrape it directly).

- **API spec**: https://www.planit.org.uk/api/ · data dictionary:
  https://www.planit.org.uk/dictionary/
- **Query** (verified live, Leeds current data, scraped the previous day):
  `https://www.planit.org.uk/api/applics/json?auth=Leeds&limit=…&pg_sz=…&page=…`
  plus `start_date`/`end_date` filters. JSON and GeoJSON available.
- **Fields**: `name` (e.g. `Leeds/26/04033/TR`), `description`, `address`,
  `location` (GeoJSON point — 91% of records geocoded), `app_type`
  (Full/Outline/Amendment/Conditions/Heritage/Trees/Advertising/Telecoms/Other),
  `app_size` (Small/Medium/Large), `app_state`
  (Undecided/Permitted/Conditions/Rejected/Withdrawn/Referred/Unresolved/Other),
  `start_date`, `decided_date`, `link` back to PlanIt, plus `other_fields`
  with the council's own portal URLs.
- **Limits** (from the API page): rate-limited with **429 + Retry-After** on
  excess (reuse the `streamCsvWithRetry` backoff pattern); hard caps of 5,000
  results and 1,000 kB per request; default `pg_sz` 300; asked to page
  politely rather than bulk-grab.
- **Scope decision**: fetch the **last 12 months** of Leeds applications only
  (a few thousand records ≈ 10–20 paged requests) — enough for the map and a
  "recent major applications" list. Do NOT try to pull the 20-year history;
  the trend numbers come from MHCLG.
- **Attribution**: credit PlanIt by name with a link in the source block
  (their data is compiled from council portals; the service is free and
  donation-supported).
- **Fragility caveat for the page**: volunteer-run single-maintainer service.
  If a refresh fails, keep serving the last good `planning:apps` KV blob; the
  page's stats figures don't depend on it.

## What was rejected

- **planning.data.gov.uk** — no national planning-applications dataset yet
  (recheck yearly; it would replace PlanIt if it ships).
- **Open Data Communities** (opendatacommunities.org) — platform migrated;
  old CSV endpoints redirect to HTML. Superseded by the GOV.UK CSVs.
- **Scraping publicaccess.leeds.gov.uk directly** — no API, fragile,
  duplicates PlanIt.
- **PlanAPI / PlanWire / api.planning.org.uk** — commercial/credit-based.
- Datamillnorth's S106 agreements (`2gp9w`), planning enforcement breaches
  (`2j7kl`) and housing land supply (`2zx5p`) are live and could make a
  future "planning & housebuilding part 2" — out of scope here.

## KPIs / charts

**Stat tiles**
- Decisions last quarter (PS2) + approval rate %.
- Applications received last quarter (PS1).
- Median speed proxy: % decided in time (PS2 "in time" measures).
- Major developments decided in the last year.

**Charts**
1. **Hero — decided vs granted per quarter** (PS2, stacked or two lines,
   full history): volumes and the approval share in one view. Likely story:
   high approval rate (~85–90%) — "planning rarely says no".
2. **Approval rate: majors vs minors vs others** (PS2 splits) — majors get
   refused far more often.
3. **What's applied for** — applications received trend (PS1), optionally by
   development type (PS2 dev-type columns).
4. **Map — applications near you** (PlanIt GeoJSON, last 12 months, Leaflet +
   markercluster like potholes; popup: description, type, state, council
   link). Colour by app_state (status colours: decided-granted vs refused vs
   undecided — respect the reserved status palette).
5. Optional list: recent **Large** applications (PlanIt `app_size=Large`),
   the "what's actually being built" table.

## Wiring (mirror the existing datasets)

- `workers/api/src/planning.js` — PS1/PS2 aggregator (`buildPlanning`) +
  PlanIt normaliser + handlers. KV: `planning:summary` (MHCLG stats),
  `planning:apps` (PlanIt map payload — keep last-good on failure),
  `planning:hash`.
- `refresh.mjs` — `refreshPlanning()`: content-API discovery → PS1/PS2 fetch
  (hash-skip); PlanIt paged fetch with backoff; withhold hash on partial
  fetch (housing/schools pattern).
- `index.js` routes `GET /api/planning/summary` + `GET /api/planning/apps`;
  `api.js` helpers.
- `pages/planning.html` + `assets/js/charts/planning.js` (Leaflet loaded like
  potholes.html).
- Homepage card → Live; nav "Planning"; about.html methodology note
  (including the PlanIt attribution + "statistics are MHCLG official
  statistics" distinction); data-sources.md; CLAUDE.md status + non-DMN
  sources wording.

## Open questions for build time

- PS2 column picking: which development-type splits earn a chart vs tooltip.
- Map window: 12 months (lean) or 24?
- Whether to show PlanIt's `app_state` for undecided applications on the map
  only, or also a small "currently open applications" stat (PlanIt-derived
  numbers would then need a "not official statistics" caption).
