# Data sources

All data on this site comes from **[Datamillnorth.org](https://datamillnorth.org)**, Leeds City Council's open-data portal. It runs **DataPress** (not CKAN — the legacy CKAN endpoints are deprecated).

## The DataPress API

Base URL: `https://datamillnorth.org/api/v3/`

Endpoints we use:

| Endpoint | What it does |
|---|---|
| `GET /api/v3/datasets/export.json` | List every dataset on the portal |
| `GET /api/v3/dataset/<id>` | Full metadata + resources keyed by id |

URLs on the site look like `https://datamillnorth.org/dataset/<slug>-<id>`. The trailing short code (e.g. `2gpp0` in `council-spending-2gpp0`) IS the API id — strip the slug.

**Resources** within a dataset come back as a dict keyed by numeric id. Each resource has:
- `title`, `format` (csv, pdf, xlsx, …), `size`, `hash` (md5)
- `url` — direct download link, CORS-open, supports HTTP Range requests
- `timeframe: { from, to }` (may be null)

**Auth**: requests carry `Authorization: Bearer ${DATAMILLNORTH_TOKEN}` (Worker secret). Lifts rate limits.

**Docs**: official DataPress API docs at https://datapress.com/docs/api.

## How to discover a dataset

1. Browse [datamillnorth.org/dataset](https://datamillnorth.org/dataset).
2. Note the URL — the short code at the end is the API id.
3. Hit `https://datamillnorth.org/api/v3/dataset/<id>` to see the resources.
4. Add an entry to the Worker (see [../workers/api/README.md](../workers/api/README.md)).

## Datasets currently wired up

### Council spending

- **Dataset**: [Council spending](https://datamillnorth.org/dataset/council-spending-2gpp0) (id `2gpp0`)
- **Resources**: 184 monthly CSVs (~6MB each) + matching PDFs. Two CSVs per month — one for >£500 spend and one for purchasing-card spend.
- **Coverage**: ~2010 onwards. Most recent: previous month, published ~28th of the month after.
- **Update cadence**: monthly (we cron-refresh nightly to pick up new months on the day they appear).
- **Why we use it**: this is THE dataset for showing where council money goes. ~14k rows/month, organised by department, supplier, and purpose.
- **Schema** (CSV columns):
  - `Organisation Code` (URI, always Leeds — ignore)
  - `Organisation Label` (always "Leeds City Council" — ignore)
  - `Effective Date` — month-end date, DD/MM/YYYY
  - `Organisational Unit` — top-level department (e.g. *Children & Families*)
  - `Service Division Label` — sub-department (e.g. *Social Care*)
  - `Category Internal Name` — accounting category (note: trailing `?` on some values, strip it)
  - `Purpose` — purpose-code label
  - `Detailed Expenditure Code` — numeric code
  - `Payment Date` — DD/MM/YYYY
  - `Transaction Number` — txn id
  - `Irrecoverable VAT Amount` — £
  - `Amount` — £ (main number)
  - `Capital Or Revenue` — `C` or `R`
  - `Beneficiary Name` — supplier (free text, inconsistent — `LTD` / `Ltd` / `Limited` variants)
  - `Procurement Card` — `Yes` / `No`
- **Quirks**:
  - Some `Category Internal Name` values have a trailing `?` (e.g. `Supplies & Services?`) — strip in the parser.
  - Beneficiary names are free text and not normalised. Same supplier can appear with multiple spellings. V1 doesn't try to dedupe — just shows raw values. Later we may add a manual alias map.
  - Two CSV resources per month — historically one was >£500-only and one was full transactions. As of recent months they look duplicate-ish; we use the larger one.
  - Some months have negative amounts (refunds/corrections) — include them, they're real spend.
- **Worker routes**:
  - `GET /api/spending/summary` → latest month
  - `GET /api/spending/summary/<yyyy-mm>` → historical month
  - `GET /api/spending/trend` → rolling 24-month totals
- **Chart**: [pages/spending.html](../pages/spending.html), [assets/js/charts/spending.js](../assets/js/charts/spending.js)

### Potholes & road repairs

- **Dataset**: [Historic potholes data](https://datamillnorth.org/dataset/historic-potholes-data-e7ylx) (id `e7ylx`)
- **Resources**: one CSV per year (currently a 2025 file and a rolling "to date" file), ~2–5 MB each. The council republishes the whole record set, so files overlap heavily.
- **Coverage**: recorded potholes from ~Nov 2024 onwards (a few stray earlier rows exist). ~34k records so far.
- **Update cadence**: refreshed automatically on the 1st day of each quarter. We pick up changes nightly via the resource fingerprint.
- **Why we use it**: directly answers the flagship "potholes" question — how many, how fast they're fixed, where the hotspots are, and what it costs. First dataset with a map.
- **Schema** (CSV columns): `Reference` (txn id), `Road`, `Ward`, `Defect`, `Recorded` (DD/MM/YYYY), `Completed` (DD/MM/YYYY, blank if still open), `Cost` (£), `Easting`, `Northing` (OSGB36 grid).
- **Quirks**:
  - Same pothole appears across yearly files — dedupe by `Reference`, preferring the copy that has a `Completed` date.
  - `Defect` has two labels for the same thing (`Pothole Carriageway` / `Pothole Cwy`); all rows are carriageway potholes so we don't split on it.
  - `Easting`/`Northing` are OSGB36 National Grid, not lat/long. We convert in `potholes.js` (`osgbToWgs84`) via inverse Transverse Mercator + a Helmert datum shift — matches the OS worked example to 6 dp. ~500 rows have no coords and don't plot, but still count in the stats.
  - `Cost` is the council's own recorded repair cost (unit-cost based; ~29 distinct values).
  - "Time to fix" = `Completed` − `Recorded`; open potholes are excluded from that figure.
- **KV layout**: `potholes:summary` (stats/trend/wards/buckets), `potholes:points` (`[lat, lon, code]` map array; code ≥0 = fixed in N days, -1 = open, -2 = fixed but duration unknown), `potholes:hash` (source fingerprint).
- **Worker routes**:
  - `GET /api/potholes/summary`
  - `GET /api/potholes/points`
- **Chart**: [pages/potholes.html](../pages/potholes.html), [assets/js/charts/potholes.js](../assets/js/charts/potholes.js). Uses Leaflet + markercluster for the map (CARTO basemap, light/dark aware).

### Road safety & collisions

- **Dataset**: [Road traffic collisions](https://datamillnorth.org/dataset/road-traffic-collisions-2o11d) (id `2o11d`)
- **Resources**: one CSV per year, 2009 onwards (~130–450 KB each), plus a `Guidance` CSV that decodes the Stats19 numeric codes. One row per **injured casualty** (a crash with several casualties spans several rows).
- **Coverage**: 2009–latest full year. ~36k casualties total.
- **Update cadence**: roughly annual. We pick up changes nightly via the resource fingerprint.
- **Why we use it**: the "are roads getting safer?" question. Long, clean KSI (killed or seriously injured) trend backing the city's Vision Zero goal.
- **Schema**: changed around 2017. Common fields (names vary): `Reference Number`, `Number of vehicles`, `Date`/`Accident Date`, `Time`, road class/surface/lighting/weather, `Casualty Class`, `Casualty Severity`, `Sex`/`Age of Casualty`, vehicle type(s).
- **Quirks** (this one's messy — handled in `collisions.js`):
  - **Two file formats**: pre-2017 files spell values out (`Slight`, `Pedestrian`) and carry `Easting`/`Northing`; 2017+ files use Stats19 numeric codes (`1`/`2`/`3`), drop coordinates and **pad the file with blank trailing rows**. Drop rows with no `Reference Number`.
  - **Inconsistent labels even within the "old" format**: casualty class appears as `Driver`, `Driver or rider`, `Driver/Rider` (2015 only) and numeric codes; 2014 is already numeric. The `CLASS`/`SEVERITY` maps in `collisions.js` cover every observed variant — audit raw values before trusting a new year.
  - `Casualty Severity`: 1 = Fatal, 2 = Serious, 3 = Slight. **KSI** = fatal + serious.
  - `Casualty Class`: 1 = Driver/rider, 2 = Passenger, 3 = Pedestrian.
  - **No map**: coordinates only exist in the pre-2017 files, so a consistent map isn't possible. The page is trend-only.
- **KV layout**: `collisions:summary` (yearly trend, severity/class splits, by-hour, totals), `collisions:hash` (fingerprint).
- **Worker route**: `GET /api/collisions/summary`
- **Chart**: [pages/collisions.html](../pages/collisions.html), [assets/js/charts/collisions.js](../assets/js/charts/collisions.js). Chart.js only — casualties-by-severity, KSI trend, casualty class, and by-hour-of-day.

### Cycle & traffic counters (twins)

Two datasets with an **identical schema**, so they share one aggregator (`counts.js`) and one page. Presented together as a "modal shift" story.

- **Datasets**:
  - [Leeds annual cycle growth](https://datamillnorth.org/dataset/leeds-annual-cycle-growth-e1dmk) (id `e1dmk`) — ~28 cycle counters.
  - [Leeds annual traffic growth](https://datamillnorth.org/dataset/leeds-annual-traffic-growth-e6q0n) (id `e6q0n`) — ~29 vehicle counters.
- **Resources**: one CSV per month of **hourly, per-lane** counts (~2–4 MB each), plus small recorder-location docs. Some giant historical annual dumps (8–30 MB) exist and are deliberately skipped (see size cap below).
- **Schema**: `Sdate` (DD/MM/YYYY HH:MM), `Cosit` (recorder id), `Period`, `LaneNumber`, `LaneDescription`, `LaneDirection`, `DirectionDescription`, `Volume` (count), `Flag Text` (`Checked` / `Estimate,Checked`).
- **Why we use them**: "is investment in cycling paying off / do you still need a car?" — cycling vs motor-traffic trend.
- **The key gotcha — comparability**: the set of *working* recorders changes a lot month to month (e.g. traffic had only ~10 of 29 reporting in May 2024; cycle dropped 13 West-Yorkshire recorders in June 2024). **Raw totals are meaningless for a trend.** We normalise to **mean daily flow per recorder** = total volume ÷ number of (recorder, day) pairs that reported. It still assumes the live recorders are representative — the page says so.
- **Other quirks** (handled in `counts.js`):
  - File titles/timeframes are unreliable (many say only a year) — we bucket every row by its in-row `Sdate` instead.
  - `Cosit` is zero-padded in some files (`000000100643`) and bare in others (`90810`) — normalise by stripping leading zeros to join with locations and count recorders once.
  - Location docs differ: cycle gives `Latitude`/`Longitude`; traffic gives OSGB grid `X`/`Y` which we convert via `osgbToWgs84` (imported from `potholes.js`). The cycle sites doc has a title row before the header — `fetchCsvRows` in refresh.mjs skips preamble.
  - Refresh only ingests data files **50 KB–6 MB** (`COUNTS_MIN/MAX_BYTES`): below = tiny location docs, above = the old giant dumps we skip. Malformed/old-schema rows are safely no-ops (bad `Sdate`/`Volume` → skipped).
  - Cycling is **strongly seasonal** (summer ≫ winter), so annual averages from years with few months are biased — the frontend needs ≥6 months before trusting a year for the index, and fades/flags partial years.
- **KV layout**: `counts:<cycle|traffic>:summary` (monthly + yearly mean-daily-flow series + recorder sites), `counts:<cycle|traffic>:hash` (fingerprint).
- **Worker route**: `GET /api/counts/<cycle|traffic>/summary`
- **Chart**: [pages/getting-around.html](../pages/getting-around.html), [assets/js/charts/getting-around.js](../assets/js/charts/getting-around.js). Modal-shift index (both indexed to a common baseline year), per-mode annual trends, cycling seasonality, and a Leaflet map of recorder locations.

## Template for new entries

### <topic name>

- **Dataset**: [<title>](https://datamillnorth.org/dataset/<slug>-<id>) (id `<id>`)
- **Resources**: <count + format>
- **Update cadence**: <e.g. monthly>
- **Why we use it**: <one sentence>
- **Quirks**: <gotchas>
- **Worker routes**: `/api/...`
- **Chart**: <link>

## Licence

Datamillnorth data is published under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). We must attribute the source. Every chart on the site links back to the source dataset.
