# Leeds Data — Project Context for Claude

**This file is the source of truth for any Claude instance working on this project.** Read it first before doing anything. Update it when architecture, stack, or conventions change.

---

## Project goal

A public website that visualises open data about Leeds — mostly **Leeds City Council**'s own datasets via [Datamillnorth.org](https://datamillnorth.org), plus official national statistics (DEFRA, MHCLG) for the three topics the council doesn't publish (air quality, recycling & waste, planning). The site exists so anyone — residents, journalists, councillors — can see at a glance how the council is performing on things like potholes, spending, traffic, planning, recycling, etc.

**Audience**: general public. No assumed technical knowledge. Every chart should answer a "why should I care" question, not just dump numbers.

**Owner**: Dan Stone. Domain: **leedsdata.co.uk**.

---

## Architecture

```
┌─────────────────────────────┐         ┌──────────────────────────┐
│  Browser (visitor)          │         │  Datamillnorth.org       │
│  loads leedsdata.co.uk      │         │  (DataPress portal)      │
└────────────┬────────────────┘         └────────────▲─────────────┘
             │                                       │
             │  HTML/CSS/JS                          │  download CSVs
             │  (Cloudflare Pages)                   │  (daily)
             ▼                                       │
┌─────────────────────────────┐         ┌────────────┴─────────────┐
│  Cloudflare Pages           │         │  GitHub Actions          │
│  (static site, this repo)   │         │  scripts/refresh.mjs     │
└────────────┬────────────────┘         │  (aggregates monthly     │
             │                          │   CSVs in Node)          │
             │  /api/* fetch            └────────────┬─────────────┘
             ▼                                       │ writes JSON via
┌─────────────────────────────┐  reads  ┌────────────▼─────────────┐
│  Cloudflare Worker          │ ──────▶ │  Workers KV (CACHE)      │
│  (pure KV reader)           │         │  precomputed summaries    │
└─────────────────────────────┘         └──────────────────────────┘
```

- **Frontend**: plain HTML/CSS/JS hosted on **Cloudflare Pages**.
- **Worker** (`workers/api/`): KV reader serving `/api/*`. No fetches to Datamillnorth — that would exceed Workers Free's 10ms CPU limit when parsing 6MB CSVs.
- **Data refresh**: a **GitHub Actions** workflow (`.github/workflows/refresh-data.yml`) runs `scripts/refresh.mjs` nightly. The script downloads any changed CSVs, aggregates them in Node, and writes summary JSON blobs to KV via Cloudflare's REST API.
- **Cache**: **Workers KV** (`CACHE`) is the single source of truth for served data. Idempotent: skipping unchanged months via hash check.
- **Hosting**: GitHub repo → auto-deploys to Cloudflare on push to `main`. Pages via Cloudflare's native Pages integration; Worker via Workers Builds.

**Why this stack**: zero-cost on the free tier, global CDN, no servers to manage, every change auditable in git, and the heavy CSV-parsing work happens on GitHub's 6-hour Actions budget instead of fighting Workers' 10ms-per-invocation CPU cap.

---

## Repo layout

```
/
├── claude.md             ← you are here
├── README.md             ← public-facing project description
├── index.html            ← homepage
├── assets/
│   ├── css/
│   │   └── style.css     ← single global stylesheet (design tokens live here)
│   ├── fonts/            ← self-hosted Newsreader + IBM Plex Sans (OFL)
│   ├── js/
│   │   ├── main.js       ← page bootstrap
│   │   ├── api.js        ← fetch helpers, talks to /api/*
│   │   └── charts/       ← theme.js (shared chart theme) + one file per page
│   └── img/
├── scripts/
│   └── dev.mjs           ← local dev server; proxies /api/* to production
├── pages/                ← topic pages (potholes.html, spending.html, …)
├── workers/
│   └── api/              ← Worker (KV reader) + refresh script
│       ├── src/
│       │   ├── index.js          ← routes
│       │   ├── spending.js       ← aggregator + handlers (shared with refresh script)
│       │   ├── datamillnorth.js  ← DataPress client
│       │   └── csv.js            ← streaming CSV parser
│       ├── scripts/
│       │   └── refresh.mjs       ← Node script, run by GitHub Actions
│       ├── wrangler.toml
│       ├── package.json
│       └── README.md
├── docs/
│   ├── data-sources.md   ← which Datamillnorth datasets we use and why
│   └── deployment.md     ← step-by-step deploy notes
└── .github/
    └── workflows/
        └── refresh-data.yml      ← nightly aggregation + KV write
```

---

## Conventions

**Code style**
- Plain ES modules. No bundler. Import via `<script type="module">`.
- 2-space indentation. Semicolons. Double quotes in JS, double quotes in HTML.
- Filenames `kebab-case.js`. Functions `camelCase`. Constants `UPPER_SNAKE`.

**Files**
- One concern per file. A chart file exports one `render(elementId, data)` function.
- HTML pages stay flat: load CSS in `<head>`, JS as `<script type="module" defer>` at end of `<body>`.
- No inline styles or inline scripts.

**Data**
- Frontend NEVER calls Datamillnorth directly. Always go via our Worker at `/api/*` so we control caching, CORS, and rate limits.
- Worker responses are JSON, shape: `{ data: [...], updated: "ISO-8601", source: "url" }`.
- Always show "last updated" and "source" on any chart so visitors trust the data.

**Visuals — the broadsheet design system (July 2026 overhaul)**
- The look is **data-journalism broadsheet**: warm paper ground, ink hairline
  rules (no card boxes or shadows), serif display headlines (**Newsreader**),
  sans UI/figures (**IBM Plex Sans**). Fonts are self-hosted in `assets/fonts/`
  (latin-subset variable woff2, OFL — see the LICENSE.md there). No CDN fonts.
- Charts are auto-numbered figures: `<figure class="figure">` with a
  `<figcaption>` rail (`.figure-no` renders "Fig. N" via CSS counter, then the
  h2 + caption) and a `.figure-body`. On ≥960px the caption sits in a left
  margin column beside the chart.
- **Chart.js** for bar/line/donut. **Leaflet** for maps. D3 only if a viz genuinely can't be done with the above.
- All chart styling flows through `assets/js/charts/theme.js` — call
  `applyChartTheme()` once per page and use its `tokens()/series()/ordinal()/wash()/axes` helpers.
  Never hardcode colours in chart configs — every colour is a CSS variable in `style.css`.
- The categorical palette (`--series-1..8`) and ordinal ramps (`--ord-red-*`,
  `--ord-blue-*`) are **validated** (CVD separation, lightness band, contrast)
  against both paper surfaces. If you change any of them, re-run the dataviz
  palette validator before shipping. Rules that must hold: assign categorical
  hues in fixed order and never cycle past 8 (fold the tail into a neutral
  "Everything else"); ordered buckets (severity, durations) use an ordinal
  one-hue ramp; status colours (`--status-*`) are reserved for meaning, never
  used as "series 4"; single-series charts get no legend; charts don't animate.
- All charts must be readable on mobile (320px+) and respect `prefers-reduced-motion`.

**Accessibility**
- Every chart has a text summary nearby ("Potholes reported rose 18% in 2025 vs 2024…").
- Colour is never the only signal. Use patterns/labels too.
- All interactive elements keyboard-navigable.

**Commits**
- Conventional-ish: `feat: add spending donut chart`, `fix: pothole API cache key`, `docs: …`.
- One logical change per commit. Don't bundle a feature and a refactor.

---

## Data sources

**Primary source** is Datamillnorth; three topics use external sources instead (no usable Datamillnorth data, checked July 2026): **air quality** (DEFRA UK-AIR per-year CSVs), **recycling & waste** (DEFRA LA-waste ODS + fly-tipping CSVs) and **planning** (MHCLG PS1/PS2 CSVs + the PlanIt API map layer). All external fetches happen server-side in the nightly refresh; the frontend still only reads our Worker. Common gotchas: GOV.UK/DEFRA media URLs change every publication (re-discover via the GOV.UK content API or a page scrape on each run), and several files carry stray NUL/BOM bytes that defeat grep but parse fine once stripped.

Datamillnorth runs **DataPress** (not CKAN — the CKAN-compatible facade is deprecated). API base: `https://datamillnorth.org/api/v3/`.

Useful endpoints:
- `GET /api/v3/datasets/export.json` — list all datasets
- `GET /api/v3/dataset/<id>` — full dataset metadata + all resources keyed by id (e.g. `2gpp0` for Council Spending)
- Resources have a direct `url` field pointing to the CSV/PDF download. CSVs are CORS-open with range request support.

**Auth**: a Datamillnorth API key is stored as the Worker secret `DATAMILLNORTH_TOKEN` and sent on every request to lift rate limits.

Dataset URLs look like `/dataset/<slug>-<id>` — the trailing short code IS the API id.

See [docs/data-sources.md](docs/data-sources.md) for the curated list of datasets we use and any quirks.

---

## Deployment

**Frontend (Pages)**: push to `main` → Cloudflare Pages auto-builds and deploys. No build command needed (static site).

**Workers**: push to `main` → **Workers Builds** (Cloudflare's git-connected build system, same model as Pages) runs `npx wrangler deploy` from `workers/api/`. Configured once in the Cloudflare dashboard against the connected GitHub repo — no workflow file in this repo, nothing to maintain.

**Domain**: `leedsdata.co.uk` points to Cloudflare Pages. DNS managed in Cloudflare.

**Secrets**: nothing secret in the repo. Worker secrets (if any) set via `wrangler secret put` or the Cloudflare dashboard.

---

## How a Claude instance should work on this project

1. **Read this file fully** before touching code.
2. If you're adding a new dataset/chart: update `docs/data-sources.md`, add the Worker route, add the chart file, link from the relevant page.
3. If you're changing architecture or conventions: **update this file in the same commit**.
4. Don't introduce a framework, bundler, or new dependency without first proposing it to Dan and explaining the tradeoff. Plain HTML/JS is a deliberate choice.
5. Don't call Datamillnorth from the browser. Always proxy via the Worker.
6. Test mobile width (DevTools 375px) before declaring a chart done.
7. Run the local dev server (`node scripts/dev.mjs`, then http://localhost:8787) to sanity-check before pushing — it serves the static site **and proxies `/api/*` to production**, so charts render with real data locally.

---

## Current status

**Last updated**: 2026-07-19

- [x] Stack chosen, repo scaffolded
- [x] GitHub repo created at https://github.com/danstone24/leeds-data
- [x] Cloudflare Pages connected to repo and live at leedsdata.co.uk
- [x] Worker deployed and routed at leedsdata.co.uk/api/*
- [x] First dataset (Council spending, id `2gpp0`) aggregator + frontend page built
- [x] Pipeline restructured: aggregation moved to GitHub Actions (Worker Free CPU limit was blocking in-Worker refresh)
- [x] GitHub secrets added + Refresh-data workflow runs successfully nightly
- [x] Spending page live at leedsdata.co.uk/pages/spending.html with cleaned-up data (cp1252 decoder, label normalisation, SD→Unit inference recovering ~93% of blank Org Units)
- [x] Time-range filters (YTD, tax years, calendar years, months) via grouped period picker; aggregator combines monthly summaries server-side
- [x] L4 drill: clicking a Purpose opens a transactions table for monthly views (top 100 per leaf, capped)
- [x] Second dataset (Potholes, id `e7ylx`) — live at pages/potholes.html: stats, Leaflet map of every pothole (OSGB→WGS84 conversion in `potholes.js`), reported-vs-repaired trend, by-ward ranking, repair-time buckets. Refresh script now runs multiple datasets (spending + potholes), each isolated.
- [x] Third dataset (Road traffic collisions, id `2o11d`) — live at pages/collisions.html: casualties-by-severity, KSI (Vision Zero) trend, casualty class, by-hour-of-day. Handles two file formats + inconsistent labels (see `collisions.js`). Trend-only (coords only in pre-2017 files). No map.
- [x] Fourth + fifth datasets (Cycle `e1dmk` + Traffic `e6q0n` growth twins) — live at pages/getting-around.html: combined "do you still need a car?" modal-shift page. Shared aggregator `counts.js` (identical schema). Normalises to **mean daily flow per recorder** because working-recorder counts vary month to month; buckets rows by in-row `Sdate` (titles unreliable); handles zero-padded Cosit and two location-doc formats. Charts: modal-shift index, per-mode annual trends, cycling seasonality, recorder map.
- [x] Sixth dataset (City centre footfall, id `2rlld`) — live at pages/footfall.html: long-run footfall trend (pandemic crash + recovery), by-hour rhythm, by-weekday, busiest streets. The fiddly one: ~575 overlapping CSVs across 3 schema eras, deduped by (date,hour,camera) keeping max (prefers council's revised-up figures), camera renames folded, mean-daily-per-camera normalisation. See `footfall.js`.
- [x] About / methodology page — live at /about.html: why the site exists, where data comes from, how numbers are handled (two principles), a plain-English methodology note per dataset, how it's built, contact.
- [x] Full UI overhaul (July 2026): broadsheet design system — self-hosted Newsreader + IBM Plex Sans, paper/ink tokens with hairline rules, double-rule masthead + topic section-nav, numbered figures with a marginalia caption rail, validated chart palette applied through `assets/js/charts/theme.js` (fixed-order categorical slots, ordinal ramps for severity/duration, status red for KSI, donut tail folded past 7 hues), themed Leaflet popups/clusters, dark mode re-derived (not flipped), charts non-animated. Verified light+dark, desktop+375px, zero console errors, donut drill exercised.

- [x] Seventh dataset (Council tax, id `24zz5`) — live at pages/council-tax.html: band D stack by precepting authority 1993→now, annual % rise, latest charges by band. Precepts CSV has forward-filled year blocks, year-label typos, era-drifting authority names, and an on/off Adult Social Care precept row (kept in data, folded into the council share on the page). See `counciltax.js`.
- [x] Eighth topic (Council housing — three datasets: bids `20jjj`, stock by ward `2o1gn`, tenanted stock `ep6qr`) — live at pages/housing.html: bids-per-home trend, homes advertised, shrinking-stock trend, by-ward + by-bedrooms competition, stock-mix donut. Bids span two ward eras (pre-2018 2-letter codes vs named post-2018 wards — NOT 1:1, so ward stats use the named era only); the stock CSV is two side-by-side year blocks parsed positionally and only its Grand Total row is trusted. See `housing.js`.
- [x] Ninth topic (School places — four datasets: prefs `24l45`/`e619w`, allocations `e6qpz`/`23ym1`) — live at pages/schools.html: first-choice demand by phase, most-competitive council-run primaries, places offered vs filled, spare-places share. Header rows are detected by content (junk preamble lines, era-drifting column names); PAN/allocated only exist for community/VC schools (academies stopped reporting after 2019), so those charts are council-run primaries only and the page says so. See `schools.js`.

- [x] Tenth topic (Air quality — DEFRA UK-AIR, first non-Datamillnorth source, Leeds Centre `site_id=LEED`) — live at pages/air-quality.html: annual NO₂/PM2.5/PM10 means vs UK legal limits + WHO 2021 guidelines (inline reference-line plugin), NO₂ by hour, seasonal cycle, PM10 days-over-50 vs the 35-day allowance. One CSV per year fetched directly (plain fetch, HEAD-header fingerprint); columns matched by name after stripping `<sub>` HTML (schema drifts, 2008 has no tags); blank = monitor down, so annual means below 75% capture are withheld and provisional (P/P*) years flagged. See `air.js`.
- [x] Eleventh topic (Recycling & waste — two DEFRA sources, no Datamillnorth: LA collected waste ODS + fly-tipping incidents/actions CSVs) — live at pages/recycling.html: Leeds vs England recycling rate, landfill collapse after the RERF opened (~2016), fly-tipping trend, incidents by land type, enforcement actions vs incidents. Hand-rolled ODS extraction in `waste.js` (zip central-directory reader + `inflateRawSync`; `node:zlib` imported lazily so the Worker stays deployable) — `table:number-columns-repeated` MUST be expanded or columns misalign; ODS values are strings ("34.7%", "-" as null); fly-tipping CSVs can carry NUL/BOM bytes and a line-2 header; Leeds matched by ONS code `E08000035` never by name. Both source URLs re-discovered every run (GOV.UK content API for the ODS; data.gov.uk page scrape for the CSVs — the content API has no attachments for that page).
- [x] Twelfth topic (Planning — MHCLG PS1/PS2 open-data CSVs + PlanIt map layer, no Datamillnorth) — live at pages/planning.html: decided-vs-granted per quarter back to 1988 ("planning rarely says no" — ~81–87% approved), rolling-year approval by scheme size (majors refused most), applications received since 1996, PlanIt map of the last 12 months + recent large applications. PS1/PS2 discovered via the GOV.UK content API (titles anchored on "District" — County CPS files also match loosely; media URLs change per release and double as the hash), header found by content (preamble depth varies), columns matched by name, `..` = null, stray NUL/BOM stripped, Leeds = LPACD E08000035. PlanIt (volunteer-run) powers the map ONLY and is fetched **incrementally**: the canonical 12-month entry set lives in KV `planning:appsrc`, nightly runs fetch just the recent windows (~6 requests) and merge, because PlanIt's per-IP budget (~15–20 requests) can't fit a full sweep and GitHub Actions' shared IPs are often drained/blocked anyway (the bootstrap had to run from a residential IP). Retry-After > 180 s aborts for the night; last-good `planning:apps` kept on failure; page degrades gracefully. See `planning.js` + data-sources.md.

All twelve topics + the About page are now built — every homepage card is Live. The last three are the site's first non-Datamillnorth sources (build plans that produced them: [docs/air-quality-plan.md](docs/air-quality-plan.md), [docs/recycling-waste-plan.md](docs/recycling-waste-plan.md), [docs/planning-plan.md](docs/planning-plan.md)); the "mostly Datamillnorth" wording on the homepage, about page, README and this file reflects that.

**Note for air/waste/planning**: aggregators were verified locally against real downloads (known-good spot figures all passed exactly), but the live pages only get data after a production refresh populates `air:*`/`waste:*`/`planning:*` in KV — eyeball the live figures after the first refresh.

**Note for cycle/traffic**: the trend numbers only become real after a production refresh populates `counts:*` in KV. Sanity-check the actual modal-shift figures before promoting any specific % claim — the aggregator is verified but the live trend hasn't been eyeballed yet.
