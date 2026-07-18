// "Getting around" page: cycling vs motor traffic. Pulls both counter datasets,
// builds a modal-shift index, per-mode annual trends, cycling seasonality and a
// recorder map. Chart.js and Leaflet are page globals.

import { getCountsSummary } from "../api.js";
import { applyChartTheme, tokens, series, axes } from "./theme.js";

// A year needs at least this many months of data before we trust its annual
// average — cycling is strongly seasonal, so a couple of winter months would
// understate it badly.
const MIN_MONTHS = 6;
// Both networks only have continuous monthly data from 2022 onward — earlier
// years are gappy (nothing 2012–2019) and 2020–21 are pandemic-distorted, which
// would make any baseline misleading. Keep the comparison to the clean window.
const MIN_YEAR = 2022;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHS_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const fmtNumber = new Intl.NumberFormat("en-GB");
const fmtSignedPct = (n) => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n * 100))}%`;

// Cycling wears green (slot 2), traffic blue (slot 1) — a validated adjacent
// pair, held consistently across every chart and the map on this page.
const modeColours = () => {
  const [blue, green] = series(2);
  return { cycle: green, traffic: blue };
};

applyChartTheme();
bootstrap();

async function bootstrap() {
  try {
    const [cycle, traffic] = await Promise.all([
      getCountsSummary("cycle"),
      getCountsSummary("traffic"),
    ]);
    renderIndex(cycle, traffic);
    renderAnnual("cycle-chart", cycle, modeColours().cycle, "bikes");
    renderAnnual("traffic-chart", traffic, modeColours().traffic, "vehicles");
    renderSeason(cycle);
    renderStats(cycle, traffic);
    renderMap(cycle, traffic);
  } catch (err) {
    console.error(err);
    document.getElementById("summary-line").textContent =
      "Sorry — the cycling and traffic data couldn't be loaded right now. Please try again later.";
  }
}

const usableYears = (s) => (s.yearly || []).filter((y) => y.monthsCovered >= MIN_MONTHS && y.year >= MIN_YEAR);

// The baseline is the earliest year that both modes cover well.
function commonBaseline(cycle, traffic) {
  const cYears = new Map(usableYears(cycle).map((y) => [y.year, y]));
  const tYears = new Map(usableYears(traffic).map((y) => [y.year, y]));
  const shared = [...cYears.keys()].filter((y) => tYears.has(y)).sort((a, b) => a - b);
  return shared.length ? shared[0] : null;
}

function indexSeries(s, baselineYear) {
  const years = usableYears(s);
  const base = years.find((y) => y.year === baselineYear);
  if (!base || !base.meanDailyFlow) return [];
  return years
    .filter((y) => y.year >= baselineYear)
    .map((y) => ({ year: y.year, index: (y.meanDailyFlow / base.meanDailyFlow) * 100 }));
}

function renderIndex(cycle, traffic) {
  const t = tokens();
  const mode = modeColours();
  const baseYear = commonBaseline(cycle, traffic);
  if (!baseYear) {
    document.querySelector('[aria-label="Cycling and traffic index over time"]').closest(".figure").style.display = "none";
    return;
  }
  document.getElementById("baseline-year").textContent = baseYear;

  const c = indexSeries(cycle, baseYear);
  const tr = indexSeries(traffic, baseYear);
  const years = [...new Set([...c, ...tr].map((d) => d.year))].sort((a, b) => a - b);
  const at = (series_, yr) => { const f = series_.find((d) => d.year === yr); return f ? Math.round(f.index) : null; };

  new Chart(document.getElementById("index-chart"), {
    type: "line",
    data: {
      labels: years,
      datasets: [
        { label: "Cycling", data: years.map((y) => at(c, y)), borderColor: mode.cycle, pointBackgroundColor: mode.cycle, tension: 0.3, spanGaps: true },
        { label: "Car traffic", data: years.map((y) => at(tr, y)), borderColor: mode.traffic, pointBackgroundColor: mode.traffic, tension: 0.3, spanGaps: true },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y} (baseline ${baseYear} = 100)` } },
      },
      scales: {
        x: axes.x(),
        y: axes.y({
          beginAtZero: false,
          // the =100 baseline reads a step darker than the ordinary grid
          grid: { color: (ctx) => (ctx.tick.value === 100 ? t.axis : t.grid), drawTicks: false },
          title: { display: true, text: `Index (${baseYear} = 100)`, color: t.inkMuted },
        }),
      },
    },
  });
}

function renderAnnual(canvasId, s, colour, noun) {
  const years = (s.yearly || []).filter((y) => y.monthsCovered >= MIN_MONTHS && y.year >= MIN_YEAR);
  new Chart(document.getElementById(canvasId), {
    type: "bar",
    data: {
      labels: years.map((y) => y.year),
      datasets: [{
        data: years.map((y) => y.meanDailyFlow),
        backgroundColor: colour,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${fmtNumber.format(c.parsed.y)} ${noun} per counter/day`,
            afterLabel: (c) => `${years[c.dataIndex].monthsCovered} months of data`,
          },
        },
      },
      scales: { x: axes.x(), y: axes.y() },
    },
  });
}

// Average daily cycling by calendar month, across every year in the data.
function seasonAverages(s) {
  const buckets = Array.from({ length: 12 }, () => ({ flow: 0, n: 0 }));
  for (const m of s.monthly || []) {
    if (Number(m.month.slice(0, 4)) < MIN_YEAR) continue;
    const mi = Number(m.month.slice(5, 7)) - 1;
    if (mi >= 0 && mi < 12) { buckets[mi].flow += m.meanDailyFlow; buckets[mi].n += 1; }
  }
  return buckets.map((b) => (b.n ? Math.round(b.flow / b.n) : 0));
}

function renderSeason(cycle) {
  const avg = seasonAverages(cycle);
  new Chart(document.getElementById("season-chart"), {
    type: "bar",
    data: {
      labels: MONTHS,
      datasets: [{ data: avg, backgroundColor: modeColours().cycle }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${fmtNumber.format(c.parsed.y)} bikes per counter/day` } },
      },
      scales: { x: axes.x(), y: axes.y() },
    },
  });
}

function renderStats(cycle, traffic) {
  const baseYear = commonBaseline(cycle, traffic);
  const changeOf = (s) => {
    const series_ = indexSeries(s, baseYear);
    if (series_.length < 2) return null;
    return series_[series_.length - 1].index / 100 - 1;
  };

  if (baseYear) {
    document.getElementById("since-1").textContent = `since ${baseYear}`;
    document.getElementById("since-2").textContent = `since ${baseYear}`;
    const cChange = changeOf(cycle);
    const tChange = changeOf(traffic);
    document.getElementById("stat-cycle-change").textContent = cChange === null ? "—" : fmtSignedPct(cChange);
    document.getElementById("stat-traffic-change").textContent = tChange === null ? "—" : fmtSignedPct(tChange);

    const latestYear = indexSeries(cycle, baseYear).slice(-1)[0]?.year;
    const phrase = (label, ch) =>
      ch === null ? `${label} data is still too sparse to trend` :
      `${label} is <strong>${fmtSignedPct(ch).replace("−", "down ").replace("+", "up ")}</strong>`;
    document.getElementById("summary-line").innerHTML =
      `Comparing ${latestYear || "recent years"} with ${baseYear}, ${phrase("cycling", cChange)} ` +
      `while ${phrase("car traffic", tChange)} — measured as the average daily count per counter across Leeds.`;
  } else {
    document.getElementById("summary-line").textContent =
      "There isn't yet enough overlapping data to compare cycling and traffic trends — check back after the next refresh.";
  }

  // Busiest cycling month.
  const avg = seasonAverages(cycle);
  const peak = avg.indexOf(Math.max(...avg));
  document.getElementById("stat-peak-month").textContent = avg.some((v) => v > 0) ? MONTHS_LONG[peak] : "—";

  document.getElementById("stat-recorders").textContent =
    fmtNumber.format((cycle.sites?.length || 0) + (traffic.sites?.length || 0));

  const updated = cycle.updated || traffic.updated;
  document.getElementById("source-updated").textContent = updated
    ? new Date(updated).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "—";
}

function renderMap(cycle, traffic) {
  const t = tokens();
  const mode = modeColours();
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const map = L.map("map", { scrollWheelZoom: false }).setView([53.8, -1.55], 11);
  L.tileLayer(
    dark
      ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' }
  ).addTo(map);

  const all = [];
  const add = (sites, colour, kind) => {
    for (const s of sites || []) {
      if (s.lat === null || s.lng === null) continue;
      const marker = L.circleMarker([s.lat, s.lng], { radius: 6, weight: 2, color: t.paper, fillColor: colour, fillOpacity: 0.95 });
      marker.bindPopup(`<strong>${kind} counter</strong>${s.name ? `<br>${s.name}` : ""}`);
      marker.addTo(map);
      all.push([s.lat, s.lng]);
    }
  };
  add(cycle.sites, mode.cycle, "Cycle");
  add(traffic.sites, mode.traffic, "Traffic");
  if (all.length) map.fitBounds(all, { padding: [30, 30] });
}
