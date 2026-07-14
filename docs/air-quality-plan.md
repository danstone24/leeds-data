# Air quality — build plan (not yet built)

Planning notes for an "Is the air we breathe getting cleaner?" page. **Not built
yet** — this records what we can pull and how, so a future session can execute it
directly. Decision on record: frame figures against **both UK legal limits and
WHO guidelines**.

---

## Source

**DEFRA UK-AIR** — the national air-quality monitoring network. This is the site's
**first non-Datamillnorth source**, so CLAUDE.md's "all data from Datamillnorth"
wording will need a caveat when we build. The architecture still holds: the
nightly refresh (GitHub Actions, Node) fetches directly, aggregates, and writes to
KV; the frontend still only reads our Worker. No API key, no CORS concern
(server-side fetch).

- **Station**: Leeds Centre, `site_id=LEED` (urban background site).
  Landing page: `https://uk-air.defra.gov.uk/data/flat_files?site_id=LEED`
- **Files**: one CSV per year, direct URLs:
  `https://uk-air.defra.gov.uk/datastore/data_files/site_data/LEED_<YEAR>.csv?v=1`
- **Coverage**: 2007 → present (currently to 2026). ~8,760 hourly rows/year, ~1.35 MB each.
- **Other Leeds sites**: `LEED` is Leeds Centre only. There may be other Leeds
  stations (e.g. a kerbside/roadside site) — check the UK-AIR site list if we ever
  want multi-site. **v1 = Leeds Centre only** (clean, official urban-background station).

## Pollutants available

Present across the whole period (parse **by column name, not position** — the
schema drifts: 2008 has 12 pollutant columns incl. volatile/non-volatile PM
variants, 2024 has 8):

| Pollutant | Column header (contains HTML) | Unit | Health relevance |
|---|---|---|---|
| **Nitrogen dioxide (NO₂)** | `Nitrogen dioxide` | µg/m³ | **Headline** — traffic pollutant; ties to the getting-around + collisions pages |
| **PM2.5** | `PM<sub>2.5</sub> particulate matter (Hourly measured)` | µg/m³ | Fine particulates — strongest health link |
| **PM10** | `PM<sub>10</sub> particulate matter (Hourly measured)` | µg/m³ | Coarse particulates |
| Ozone (O₃) | `Ozone` | µg/m³ | Secondary; summer-peaking |
| Carbon monoxide | `Carbon monoxide` | mg/m³ | Low now; long decline |
| Sulphur dioxide | `Sulphur dioxide` | µg/m³ | Low now |
| Nitric oxide / NOₓ as NO₂ | `Nitric oxide` / `Nitrogen oxides as nitrogen dioxide` | µg/m³ | Supporting |

**Primary focus**: NO₂, PM2.5, PM10. Ozone/CO/SO₂ as secondary context.

## Health limits to frame against

Both are annual-mean unless noted. Plot as reference lines on the trend charts.

| Pollutant | UK legal limit (annual mean) | WHO 2021 guideline (annual mean) | Short-term limits (for "days over" KPI) |
|---|---|---|---|
| NO₂ | **40 µg/m³** | **10 µg/m³** | Hourly 200 µg/m³, ≤18 exceedances/yr |
| PM2.5 | **20 µg/m³** (England obj.; 10 µg/m³ target by 2040) | **5 µg/m³** | 24-hr WHO 15 µg/m³ |
| PM10 | **40 µg/m³** | **15 µg/m³** | 24-hr 50 µg/m³, ≤35 exceedances/yr (WHO 24-hr 45) |
| O₃ | 8-hr 100 µg/m³ (target) | Peak-season 60 µg/m³ | 8-hr 100 µg/m³ |
| CO | 8-hr 10 mg/m³ | 24-hr 4 mg/m³ | — |
| SO₂ | 24-hr 125 µg/m³, hourly 350 | 24-hr 40 µg/m³ | — |

*Verify these against current DEFRA/WHO tables at build time — limits get revised
(e.g. the England PM2.5 targets under the Environment Act).*

## KPIs / charts we can produce

**Headline stat tiles**
- Latest full-year annual-mean **NO₂** (µg/m³) + within/over UK limit.
- Latest annual-mean **PM2.5** + vs WHO guideline.
- **% change in NO₂** since ~2010 (the long-run improvement — likely a big fall).
- **Legal compliance**: currently within all UK legal limits? / years since last breach.

**Charts**
1. **Hero — annual mean NO₂ / PM2.5 / PM10 over 2007→now**, each with its UK legal
   limit and WHO guideline as reference lines. Answers "getting cleaner? legal? healthy?"
   in one view. (Likely story: NO₂ well down and now under the UK limit, but still
   far above the WHO guideline; PM2.5 under UK, over WHO.)
2. **The daily rhythm** — NO₂ by hour of day, averaged. Expect rush-hour peaks →
   ties directly to the traffic page.
3. **The seasonal pattern** — monthly means: NO₂/PM higher in winter, O₃ higher in
   summer. Good "why does it vary" context.
4. **Days over the limit** — count of days/hours exceeding the short-term limits per
   year (e.g. PM10 days > 50 µg/m³ vs the 35/yr allowance).

## Data processing

- **Fetch** `LEED_<year>.csv` for each year 2007→current (idempotent hash like the others).
- **Header quirk**: skip the ~5 preamble lines; locate the real header row (starts
  `Date,time`). One blank line follows the header before data.
- **Column names contain HTML** (`<sub>…</sub>`) — strip tags, then match to canonical
  pollutant keys by name.
- **Triplets**: each pollutant is `value, status, unit` — parse by the header index of
  each pollutant's value column.
- **Dates**: `DD-MM-YYYY`, time `HH:00` (GMT, hour-ending).
- **Missing values**: blank when a monitor is down → skip that reading.
- **Status**: `R` = ratified, `P`/`P*` = provisional (the current/most-recent year is
  provisional). Include provisional but consider flagging the latest year.
- **Data-capture caveat**: an annual mean is only meaningful with enough valid hours
  (DEFRA convention ≈ ≥75% capture). **Compute and store data-capture %; flag/annotate
  low-capture years** rather than drawing a misleading point.
- **Aggregate**: per year → mean per pollutant + capture %; per month → mean; per hour →
  mean; exceedance counts for short-term limits.

## Wiring (mirror the existing datasets)

- `workers/api/src/air.js` — aggregator (`buildAirQuality`) + `handleAirSummary`.
  Parse-by-name to survive schema drift; strip HTML in headers.
- `refresh.mjs` — `refreshAirQuality()` as a new isolated dataset; fetches DEFRA
  year-URLs directly (add a tiny fetch since it's not a Datamillnorth resource).
  KV keys `air:summary`, `air:hash`.
- `index.js` — route `GET /api/air/summary`; `api.js` — `getAirSummary()`.
- `pages/air-quality.html` + `assets/js/charts/air-quality.js` — hero limits chart,
  daily rhythm, seasonal, days-over. Reference-line plugin or extra datasets for limits.
- Homepage "Air quality" card → Live. Update `docs/data-sources.md` (note the DEFRA
  source) and the CLAUDE.md "all data from Datamillnorth" wording.

## Open scoping questions for build time

- Single site (Leeds Centre) confirmed for v1; multi-site (add a roadside station) later?
- Which pollutants get their own chart vs. bundled (NO₂/PM2.5/PM10 primary).
- Ratified-only vs include the provisional latest year (lean: include, flag it).
- Data-capture threshold for showing an annual point (lean: ≥75%, annotate below).
