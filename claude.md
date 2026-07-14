# Leeds Data — Project Context for Claude

**This file is the source of truth for any Claude instance working on this project.** Read it first before doing anything. Update it when architecture, stack, or conventions change.

---

## Project goal

A public website that visualises open data published by **Leeds City Council** via [Datamillnorth.org](https://datamillnorth.org). The site exists so anyone — residents, journalists, councillors — can see at a glance how the council is performing on things like potholes, spending, traffic, planning, recycling, etc.

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
│   │   └── style.css     ← single global stylesheet
│   ├── js/
│   │   ├── main.js       ← page bootstrap
│   │   ├── api.js        ← fetch helpers, talks to /api/*
│   │   └── charts/       ← one file per chart type (chart-spending.js, …)
│   └── img/
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

**Visuals**
- **Chart.js** for bar/line/donut. **Leaflet** for maps. D3 only if a viz genuinely can't be done with the above.
- Colour palette defined in `assets/css/style.css` as CSS variables. Never hardcode colours in chart configs — pull from CSS.
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
7. Run a quick local server (`python3 -m http.server` from repo root) to sanity-check before pushing.

---

## Current status

**Last updated**: 2026-07-14

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
- [ ] About / methodology page

Next: About page (methodology + data-quality caveats).

**Note for cycle/traffic**: the trend numbers only become real after a production refresh populates `counts:*` in KV. Sanity-check the actual modal-shift figures before promoting any specific % claim — the aggregator is verified but the live trend hasn't been eyeballed yet.
