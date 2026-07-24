# Data sources

Most data on this site comes from **[Datamillnorth.org](https://datamillnorth.org)**, Leeds City Council's open-data portal. It runs **DataPress** (not CKAN — the legacy CKAN endpoints are deprecated). Three topics have no usable Datamillnorth dataset and use national sources instead: **air quality** (DEFRA UK-AIR), **recycling & waste** (DEFRA statistics) and **planning** (MHCLG statistics + the PlanIt map layer) — see their entries below.

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

### City centre footfall

- **Dataset**: [Leeds city centre footfall data](https://datamillnorth.org/dataset/leeds-city-centre-footfall-data-2rlld) (id `2rlld`)
- **Resources**: ~575 CSVs (+ 2 PDFs, 1 xlsx we ignore). 8 cameras counting people hourly. **The files overlap massively** (per-camera history dumps, weekly feeds, monthly feeds, "revised" re-issues) — the `timeframe` metadata is garbage.
- **Coverage**: 2008 onwards.
- **Why we use it**: "how busy is the city?" — the long footfall trend, the pandemic crash and recovery, and the busiest times/days/streets.
- **The gotchas** (this is the fiddliest dataset — ingestion *is* the job; all handled in `footfall.js`):
  - **Three schema eras**: 2008–2014 = one file *per camera* (`Date` DD/MM/YYYY, `Hour`, `LocationName`, `Count`); ~2015 = `TotalCount`/`FactoredTotalCount`, `Date` YYYY-MM-DD; 2020+ = `ReportCount`/`FactoredReportCount`, `Date` DD-Mon-YY. `Hour` is `0` or `00:00`. We read the count from `Count` ?? `TotalCount` ?? `ReportCount` (non-factored, the only one present in every era).
  - **Heavy overlap** → key every row by `(date, hour, camera)` and keep the **max** on collision. The council warned older counts were under-reported and later revised upward, so max prefers the corrected figures.
  - **Camera renames**: 8 physical cameras, renamed over time. `RENAME` folds the four documented old→new pairs (e.g. "Briggate at McDonalds" → "Briggate at Swan Street") so a camera is one series and isn't double-counted during a transition.
  - Varying live-camera count → trend the **mean daily footfall per camera**, not raw totals (same normalisation as the counters).
  - Malformed/analysis CSVs (e.g. "Christmas analysis 2017-2019") parse to nothing and are harmless.
- **Memory note**: the refresh holds a dedupe map of ~1M+ `(date,hour,camera)` slots — fine in GitHub Actions, would never fit the Worker.
- **KV layout**: `footfall:summary` (monthly + yearly mean-daily series, by-hour, by-weekday, busiest locations), `footfall:hash` (fingerprint).
- **Worker route**: `GET /api/footfall/summary`
- **Chart**: [pages/footfall.html](../pages/footfall.html), [assets/js/charts/footfall.js](../assets/js/charts/footfall.js). Long-run trend, by-hour rhythm, by-weekday, busiest-streets bar.

### Council tax

- **Dataset**: [Council tax charges](https://datamillnorth.org/dataset/council-tax-charges-24zz5) (id `24zz5`)
- **Resources**: one "Major Council Tax Precepts 1993-20XX" CSV (re-issued with a new end year annually) + per-year "charges by band"/parish files we ignore. We pick the precepts file with the biggest end year in its title.
- **Coverage**: every financial year since 1993/94.
- **Update cadence**: annual (each spring, when the new year's charges are set).
- **Why we use it**: everyone pays it — 33 years of band A–H charges split by precepting authority (council / police / fire).
- **Quirks** (handled in `counciltax.js`):
  - The financial year is forward-filled — only the first row of each year's block carries it, and that row isn't always the council's (2021/22 starts with the fire authority).
  - Year-label typos: `1993/64`, `1996/67`, `1999/20`. Trust the 4-digit start year, derive the end.
  - Authority names drift across eras (`POLICE` → `West Yorkshire Police Authority` → `Police & Crime Commissioner West Yorks`) — classify by keyword.
  - The **Adult Social Care precept** appears as its own row in some years from 2016/17 and is folded into the council's line in others — keep it separate in the data, fold it into the council share when charting.
  - Amounts are `£1,234.56` strings in cp1252.
- **KV layout**: `counciltax:summary`, `counciltax:hash`.
- **Worker route**: `GET /api/counciltax/summary`
- **Chart**: [pages/council-tax.html](../pages/council-tax.html), [assets/js/charts/council-tax.js](../assets/js/charts/council-tax.js). Band D stack by authority since 1993, annual % rise, latest charges by band.

### Council housing (three datasets, one page)

- **Datasets**:
  - [Council house bids](https://datamillnorth.org/dataset/council-house-bids-20jjj) (id `20jjj`) — every advertised let + expressions of interest. Annual files 2014–2018, quarterly from Apr 2019. Two "guidance" lookup CSVs are excluded by title.
  - [Number of council houses](https://datamillnorth.org/dataset/number-of-council-houses-2o1gn) (id `2o1gn`) — stock by ward, one cumulative CSV re-published yearly (biggest year in the title wins).
  - [Tenanted housing stock](https://datamillnorth.org/dataset/tenanted-housing-stock-ep6qr) (id `ep6qr`) — quarterly per-property snapshots (~51k rows); we use the latest by the date in the title.
- **Update cadence**: bids quarterly; stock annual; tenanted quarterly.
- **Why we use them**: "how hard is it to get a council house?" — bids per home (demand) vs a shrinking stock (supply), plus what the stock actually is.
- **Quirks** (handled in `housing.js`):
  - **Two ward eras in bids**: 2014–2019 files carry 2-letter codes for the PRE-2018 wards; later files spell out post-2018 ward names (with drift: `Crossgates` vs `Cross Gates`). The two ward maps aren't 1:1, so ward stats use named rows only; the citywide trend uses everything.
  - Bid dates come as `25/02/2026` and `30-JUN-2014`. Blank padding rows are skipped.
  - Ward/bedroom breakdowns are computed from the latest **complete** calendar year (`monthsCovered === 12`) so seasonal quarters don't skew them; 2019 (Apr–Dec) and the in-progress year are partial.
  - The stock CSV is **two year-blocks side by side** (2006/07–2017/18, then a repeated Ward column and 2018/19 on) — parsed positionally. Its ward list is the pre-2018 one even in recent columns, so only the `Grand Total` row is trusted; never join it to bids wards.
  - Property type codes (`1BMSF`, `2BH`, typo `2BMFS`) → bedrooms by leading digit, 4+ folded.
- **KV layout**: `housing:summary`, `housing:hash` (one fingerprint across all three datasets).
- **Worker route**: `GET /api/housing/summary`
- **Chart**: [pages/housing.html](../pages/housing.html), [assets/js/charts/housing.js](../assets/js/charts/housing.js). Bids-per-home trend, homes advertised, stock trend, by-ward and by-bedrooms competition, stock-mix donut.

### School places (four datasets, one page)

- **Datasets**:
  - [Primary Preferences](https://datamillnorth.org/dataset/primary-preferences-24l45) (id `24l45`) — applications by preference rank per school, 2021+.
  - [Primary school allocations](https://datamillnorth.org/dataset/primary-school-allocations-e6qpz) (id `e6qpz`) — PAN + places allocated, usable ~2021+.
  - [Secondary School Preferences](https://datamillnorth.org/dataset/secondary-school-preferences-e619w) (id `e619w`) — 2019+.
  - [Secondary school allocations](https://datamillnorth.org/dataset/secondary-school-allocations-23ym1) (id `23ym1`) — usable ~2019+.
- **Update cadence**: annual (offer day each spring, for September entry).
- **Why we use them**: "who gets the school they want?" — first-choice demand by phase, the most competitive schools, and the falling-rolls gap at primaries.
- **The big caveat**: PAN and places-allocated are only published for **community and voluntary-controlled schools** — academies stopped reporting after 2019, and only ~5 secondaries still report (nearly all Leeds secondaries are academies). So competition/fill charts are council-run primaries only; preference counts cover every school. The page says this in plain English.
- **Quirks** (handled in `schools.js`):
  - 0–2 junk title lines before the real header — the header row is detected by content, never by position. Files whose schema isn't recognised (the pre-2019 era, e.g. `schoolprimarydistances.csv`) are skipped file-by-file with a log line.
  - Header drift: `DfE Number` vs `Dfee`, `School Code` vs `SchoolCode`, `Applications as 1st preference` vs `1st Preferences`, trailing spaces everywhere.
  - Secondary allocations publish `Total Allocated / Places Available` as one cell (`270/270`) in some years, a plain number in others. PAN ≠ places available in bulge years — we use the cell's second number as "available" when present.
  - The primary preferences dataset's "Historical information" resource is excluded by title.
  - Entry year comes from the resource title (`September 2026 entry`), not the file.
  - Datamillnorth rate-limits (429) under the ~30 small files this topic pulls, even with the API token. Fetches are **cached per file** in KV (`schools:files`, keyed by resource hash), so a run only downloads files it has no cached result for — including `null` results for the unparseable pre-2019 era. Before this, one 429 withheld the fingerprint, the next run re-fetched all ~30 files, hit the limit again and withheld again: the "retry next run" never healed and the secondary competition table sat two years stale. Bump `SCHOOLS_VERSION` to invalidate the cache after a parser change.
- **KV layout**: `schools:summary`, `schools:hash` (one fingerprint across all four datasets), `schools:files` (per-file parsed-row cache, versioned).
- **Worker route**: `GET /api/schools/summary`
- **Chart**: [pages/schools.html](../pages/schools.html), [assets/js/charts/schools.js](../assets/js/charts/schools.js). Demand trend by phase, most-competitive council-run primaries, places offered vs filled, spare-places share.

### Air quality (DEFRA UK-AIR — not Datamillnorth)

- **Dataset**: [Leeds Centre monitoring station](https://uk-air.defra.gov.uk/data/flat_files?site_id=LEED) (`site_id=LEED`, AURN urban background, DEFRA UK-AIR)
- **Resources**: one CSV per year, direct URL `https://uk-air.defra.gov.uk/datastore/data_files/site_data/LEED_<YEAR>.csv?v=1` (~1.4 MB, ~8,760 hourly rows). No API key, no auth. 2007 onwards used (files exist back to at least 2006; v1 scope starts 2007). Current-year file updates daily, ~2 days behind.
- **Update cadence**: nightly refresh; ratified years never change, so the fingerprint is per-year ETag/Last-Modified from HEAD requests.
- **Why we use it**: the only long-run, hourly, quality-assured air pollution record for central Leeds — NO₂, PM2.5, PM10, O₃ (plus CO/SO₂/NOₓ we don't chart).
- **Schema**: ~4 preamble lines, then a header starting `Date,time`, then a near-blank spacer line. Each pollutant is a value/status/unit column triplet. Dates `DD-MM-YYYY`, times hour-ending `01:00`–`24:00` GMT.
- **Quirks**:
  - Column names contain HTML (`PM<sub>2.5</sub> …`) in most years but not 2008 — strip tags and match by name; the column set drifts (2008 has 12 pollutant channels incl. volatile/non-volatile PM, 2024 has 8).
  - Blank value = monitor down; every mean carries a data-capture %. Annual means below 75% capture are withheld (nulled) per DEFRA convention — e.g. 2013 PM and pre-2009 PM2.5.
  - Status `R` = ratified, `P`/`P*` = provisional (the newest year or two); provisional years are flagged in the summary and drawn as open points.
  - Small negative hourly PM values occur in TEOM-FDMS-era files (2009–2016) and are kept in means, as DEFRA does.
- **KV layout**: `air:summary`, `air:hash`.
- **Worker route**: `GET /api/air/summary`
- **Chart**: [pages/air-quality.html](../pages/air-quality.html), [assets/js/charts/air-quality.js](../assets/js/charts/air-quality.js). Annual means vs UK/WHO limits, NO₂ by hour, seasonal cycle, PM10 days over 50 µg/m³.

### Recycling & waste (two DEFRA sources, one page)

The first topic with **no Datamillnorth data** (checked July 2026) — both
sources are DEFRA, free, Crown copyright / OGL, fetched server-side by the
nightly refresh.

- **Datasets**:
  - [Local authority collected waste management annual results](https://www.gov.uk/government/statistics/local-authority-collected-waste-management-annual-results)
    — one ODS (~2 MB), re-published each March. Sheet `Table_3` "Selected
    Waste Indicators": one row per authority per year, 2010-11 → latest
    (recycling %, landfill %, residual kg/household, kg/person). `Table_3b`:
    England household recycling rate back to 2000-01.
  - [Fly-tipping statistics for England](https://www.gov.uk/government/statistics/fly-tipping-statistics-for-england)
    — two per-authority CSVs on S3 (incidents + actions), 2012-13 → latest.
- **URL discovery (required — links change every release)**:
  - ODS: GOV.UK content API
    (`https://www.gov.uk/api/content/government/statistics/local-authority-collected-waste-management-annual-results`)
    → `details.attachments[]` → title starting "Local authority collected
    waste generation annual results" → `url`.
  - Fly-tipping: the content API returns no attachments for the ENV24 page,
    so scrape the data.gov.uk dataset page
    (`https://www.data.gov.uk/dataset/1388104c-3599-4cd2-abb5-ca8ddeeb4c9c/fly-tipping_in_england_`)
    for `Local+authority+flytipping+(incidents|actions)+…\.csv`; the
    `statistics_YYYY` path segment moves each year.
- **Update cadence**: both annual (waste in March, fly-tipping in winter);
  refreshed nightly anyway, hash-skipped on the files' ETag/content-length.
- **Why we use them**: "do we recycle enough, and who's dumping on Leeds?" —
  Leeds vs England recycling rate, the landfill→incineration shift after the
  RERF opened (~2016), and fly-tipping scale/location/enforcement.
- **Quirks** (handled in `waste.js`):
  - The ODS is parsed with a hand-rolled zip reader (central directory +
    `zlib.inflateRawSync`, no dependency; handles STORED and DEFLATE
    entries). `node:zlib` is imported lazily so the Worker stays deployable.
  - ODS cell runs are collapsed with `table:number-columns-repeated` (one
    row ends with a 16,000-cell blank run) — repeats must be expanded or
    every column misaligns; rows are capped at 40 columns.
  - ODS values are strings: `34.7%`, numbers padded with `<text:s/>`, `-` /
    `..` for missing. Year labels drift between `2019-20` and `2019/20`.
  - The fly-tipping CSVs can carry stray NUL bytes and a BOM (they defeat
    grep but parse fine once stripped at the byte level); the real header is
    on line 2 after a title line, detected by content; one header cell is a
    quoted multi-line value ("Chemical Drums, Oil, Fuel Incidents"); `:` is
    a null marker; the `£` in cost headers arrives cp1252-mangled some years.
  - **Leeds is matched by ONS code `E08000035` only** — it's "Leeds City
    Council MBC" in the ODS and "Leeds" in the fly-tipping files.
  - Fly-tipping incident counts partly reflect **reporting practice** (DEFRA's
    own caveat — the 2012-13 → 2013-14 jump from ~3,000 to ~10,500 is largely
    a recording change); the page says so.
- **KV layout**: `waste:summary`, `waste:hash` (ETag/content-length
  fingerprint across all three files; nothing is written if any fetch fails,
  so the hash is withheld and the next run retries).
- **Worker route**: `GET /api/waste/summary`
- **Chart**: [pages/recycling.html](../pages/recycling.html),
  [assets/js/charts/recycling.js](../assets/js/charts/recycling.js). Leeds vs
  England recycling rate, landfill trend, fly-tipping trend, incidents by
  land type, actions vs incidents.

### Planning applications

- **Datasets** (no usable Datamillnorth data — checked July 2026, `exkkr` is
  a lone guidance file):
  - [MHCLG live tables on planning application statistics](https://www.gov.uk/government/statistical-data-sets/live-tables-on-planning-application-statistics)
    — PS1 full dataset (~12 MB: received/decided/withdrawn per LPA per
    quarter) + PS2 full dataset (~58 MB: decisions by outcome, size and
    speed). The unrounded open-data tables, not the rounded ODS live tables.
  - [PlanIt](https://www.planit.org.uk/) ([API](https://www.planit.org.uk/api/))
    — application-level map layer only, last 12 months of Leeds applications.
- **URL discovery (required — media URLs change every publication)**: GOV.UK
  content API (`https://www.gov.uk/api/content/government/statistical-data-sets/live-tables-on-planning-application-statistics`)
  → `details.attachments[]` → titles anchored on
  `District planning application statistics (PS1) - full dataset` (and PS2).
  Anchoring matters: the same page carries County-level `CPS1`/`CPS2` files
  whose titles contain "PS1"/"PS2". Because the URLs change per publication
  and GOV.UK assets are immutable, the URL pair doubles as the refresh
  fingerprint — no download needed to detect "unchanged".
- **Update cadence**: quarterly (roughly Mar/Jun/Sep/Dec releases); PlanIt
  scrapes the council portal daily-ish.
- **Why we use them**: "does planning ever say no?" — decade-scale approval
  rates, the majors-vs-minors refusal gap, decision speed, and a what's-near-
  you map that Datamillnorth cannot provide.
- **Quirks** (handled in `planning.js`):
  - Preamble rows before the header vary by file (PS1 has 3, PS2 has 2 in
    the March 2026 edition) — the header row is detected by content
    (`Region, LPANM, LPACD, Quarter`), and every measure is looked up by
    NAME, never position (~330 semicolon-named columns in PS2, drifting).
  - Missing values are `..` → null; some editions carry stray NUL/BOM bytes
    that defeat grep but parse fine once stripped.
  - **Leeds = LPACD `E08000035`.** PS2 history reaches 1988 Q4, PS1 1996 Q2.
  - "% decided in time" sums the excluding-PA and PA-only in-time measures
    over their combined decision counts.
  - PlanIt is rate-limited (429 + Retry-After, honoured with backoff), caps
    responses at 5,000 results / 1,000 kB, and asks for polite paging — the
    refresh pages month-by-month at `pg_sz=300` with 1.5 s pauses and hard
    caps (60 requests / 15,000 records). Records are deduped by `name`,
    descriptions trimmed, coordinates bounded to Leeds.
  - **The per-IP budget is small (observed July 2026: ~15–20 requests before
    a 429 with a 12–20-minute Retry-After, then 403s for repeat offenders),
    and GitHub Actions' shared egress IPs are often already drained or
    blocked outright (403s / connection failures).** So the map layer is
    **incremental**: the canonical last-12-months entry set lives in
    `planning:appsrc` (keyed by application name); each night fetches the
    two recent monthly windows plus one older "backfill cursor" window
    (`planning:planitcursor`, cycling 2→11) — ~9 requests, capped at 12.
    Fetched entries merge over the stored set, anything past 12 months ages
    out, and the public payload is rebuilt. Full 12-month coverage
    assembles over ~10 nights from nothing and self-heals on the same
    rotation; partial fetches merge safely; Retry-Afters longer than 180 s
    abort the PlanIt fetch for the night (the job has a 15-minute Actions
    timeout). Don't try to bulk-sweep PlanIt from anywhere — that's how the
    IP gets blocked.
  - PlanIt is a volunteer-run third-party scraper: it powers the map/table
    only, its failure keeps the last-good `planning:apps` blob, and the page
    says so. Attribution (name + link) is required courtesy.
- **KV layout**: `planning:summary` (MHCLG stats), `planning:apps` (PlanIt
  map payload — never overwritten with an empty result), `planning:hash`
  (PS1+PS2 URL fingerprint; withheld if either fetch fails so the next run
  retries).
- **Worker routes**: `GET /api/planning/summary`, `GET /api/planning/apps`
- **Chart**: [pages/planning.html](../pages/planning.html),
  [assets/js/charts/planning.js](../assets/js/charts/planning.js). Decided vs
  granted per quarter (1988→now), rolling-year approval rate by scheme size,
  applications received (1996→now), PlanIt map + recent large applications.

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
