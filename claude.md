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
│  loads leedsdata.co.uk      │         │  (CKAN open-data portal) │
└────────────┬────────────────┘         └────────────▲─────────────┘
             │                                       │
             │  HTML/CSS/JS (Cloudflare Pages)       │  cached fetch
             │                                       │  (daily/hourly cron)
             ▼                                       │
┌─────────────────────────────┐         ┌────────────┴─────────────┐
│  Cloudflare Pages           │ ──API─▶ │  Cloudflare Workers      │
│  (static site, this repo)   │         │  + Workers KV (cache)    │
└─────────────────────────────┘         └──────────────────────────┘
```

- **Frontend**: plain HTML/CSS/JS (no build step, no framework) hosted on **Cloudflare Pages**.
- **Backend**: **Cloudflare Workers** that fetch + cache Datamillnorth data, exposed at `/api/*` on the same domain.
- **Cache**: **Workers KV** keyed by dataset, refreshed via **Cron Triggers**.
- **Hosting**: GitHub repo → auto-deploys to Cloudflare on push to `main`.

**Why this stack**: zero-cost on the free tier, global CDN, no servers to manage, and every change is auditable in git. Both Pages and Workers deploy from the same repo.

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
│   └── api/              ← one Worker, routes /api/*
│       ├── src/
│       │   └── index.js
│       ├── wrangler.toml
│       └── README.md
├── docs/
│   ├── data-sources.md   ← which Datamillnorth datasets we use and why
│   └── deployment.md     ← step-by-step deploy notes
└── .github/
    └── workflows/        ← (optional) CI for Workers if not using Workers Builds
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

Datamillnorth runs **CKAN**, so it has a standard API. Base: `https://datamillnorth.org/api/3/action/`.

Useful endpoints:
- `package_search?q=potholes` — find datasets
- `package_show?id=<dataset-id>` — dataset metadata + resource list
- `datastore_search?resource_id=<resource-id>&limit=1000` — actual rows (only works for datasets in CKAN's datastore; many are CSV downloads instead)

See [docs/data-sources.md](docs/data-sources.md) for the curated list of datasets we use and any quirks (e.g. column rename in 2023, missing months).

---

## Deployment

**Frontend (Pages)**: push to `main` → Cloudflare Pages auto-builds and deploys. No build command needed (static site).

**Workers**: same model via **Workers Builds**, OR a GitHub Action that runs `wrangler deploy`. See [docs/deployment.md](docs/deployment.md).

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

**Last updated**: 2026-05-13

- [x] Stack chosen, repo scaffolded
- [x] GitHub repo created at https://github.com/danstone24/leeds-data
- [ ] Cloudflare Pages connected to repo and live at leedsdata.co.uk
- [ ] First Worker deployed at /api/health
- [ ] First dataset wired up end-to-end
- [ ] About / methodology page

Next: connect the GitHub repo to Cloudflare Pages and get the placeholder site live on the domain.
