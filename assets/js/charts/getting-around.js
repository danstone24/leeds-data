// "Getting around" page: cycling vs motor traffic. Pulls both counter datasets,
// builds a modal-shift index, per-mode annual trends, cycling seasonality and a
// recorder map. Chart.js and Leaflet are page globals.

import { getCountsSummary } from "../api.js";

// A year needs at least this many months of data before we trust its annual
// average — cycling is strongly seasonal, so a couple of winter months would
// understate it badly.
const MIN_MONTHS = 6;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHS_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const fmtNumber = new Intl.NumberFormat("en-GB");
const fmtSignedPct = (n) => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n * 100))}%`;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const palette = () => ({
  cycle: css("--color-accent"),
  traffic: css("--chart-3"),
  text: css("--color-text"),
  muted: css("--color-text-muted"),
  grid: css("--color-border"),
});
const fade = (hex, a) => {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

bootstrap();

async function bootstrap() {
  try {
    const [cycle, traffic] = await Promise.all([
      getCountsSummary("cycle"),
      getCountsSummary("traffic"),
    ]);
    renderIndex(cycle, traffic);
    renderAnnual("cycle-chart", cycle, palette().cycle, "bikes");
    renderAnnual("traffic-chart", traffic, palette().traffic, "vehicles");
    renderSeason(cycle);
    renderStats(cycle, traffic);
    renderMap(cycle, traffic);
  } catch (err) {
    console.error(err);
    document.getElementById("summary-line").textContent =
      "Sorry — the cycling and traffic data couldn't be loaded right now. Please try again later.";
  }
}

const usableYears = (s) => (s.yearly || []).filter((y) => y.monthsCovered >= MIN_MONTHS);

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
  const p = palette();
  const baseYear = commonBaseline(cycle, traffic);
  if (!baseYear) {
    document.querySelector('[aria-label="Cycling and traffic index over time"]').closest(".chart-section").style.display = "none";
    return;
  }
  document.getElementById("baseline-year").textContent = baseYear;

  const c = indexSeries(cycle, baseYear);
  const t = indexSeries(traffic, baseYear);
  const years = [...new Set([...c, ...t].map((d) => d.year))].sort((a, b) => a - b);
  const at = (series, yr) => { const f = series.find((d) => d.year === yr); return f ? Math.round(f.index) : null; };

  new Chart(document.getElementById("index-chart"), {
    type: "line",
    data: {
      labels: years,
      datasets: [
        { label: "Cycling", data: years.map((y) => at(c, y)), borderColor: p.cycle, backgroundColor: p.cycle, tension: 0.3, pointRadius: 3, spanGaps: true },
        { label: "Car traffic", data: years.map((y) => at(t, y)), borderColor: p.traffic, backgroundColor: p.traffic, tension: 0.3, pointRadius: 3, spanGaps: true },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: p.text, usePointStyle: true, boxWidth: 8 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y} (baseline ${baseYear} = 100)` } },
      },
      scales: {
        x: { ticks: { color: p.muted }, grid: { display: false } },
        y: {
          ticks: { color: p.muted, callback: (v) => v },
          grid: { color: (ctx) => (ctx.tick.value === 100 ? p.muted : p.grid) },
          title: { display: true, text: `Index (${baseYear} = 100)`, color: p.muted },
        },
      },
    },
  });
}

function renderAnnual(canvasId, s, colour, noun) {
  const p = palette();
  const years = (s.yearly || []).filter((y) => y.monthsCovered >= 3);
  new Chart(document.getElementById(canvasId), {
    type: "bar",
    data: {
      labels: years.map((y) => y.year),
      datasets: [{
        label: `Average ${noun} per counter per day`,
        data: years.map((y) => y.meanDailyFlow),
        backgroundColor: years.map((y) => (y.monthsCovered >= MIN_MONTHS ? colour : fade(colour, 0.4))),
        borderRadius: 4,
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
            afterLabel: (c) => {
              const y = years[c.dataIndex];
              return y.monthsCovered < MIN_MONTHS ? `⚠ only ${y.monthsCovered} month(s) of data` : `${y.monthsCovered} months of data`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: p.muted }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: p.muted }, grid: { color: p.grid } },
      },
    },
  });
}

// Average daily cycling by calendar month, across every year in the data.
function seasonAverages(s) {
  const buckets = Array.from({ length: 12 }, () => ({ flow: 0, n: 0 }));
  for (const m of s.monthly || []) {
    const mi = Number(m.month.slice(5, 7)) - 1;
    if (mi >= 0 && mi < 12) { buckets[mi].flow += m.meanDailyFlow; buckets[mi].n += 1; }
  }
  return buckets.map((b) => (b.n ? Math.round(b.flow / b.n) : 0));
}

function renderSeason(cycle) {
  const p = palette();
  const avg = seasonAverages(cycle);
  new Chart(document.getElementById("season-chart"), {
    type: "bar",
    data: {
      labels: MONTHS,
      datasets: [{ label: "Average bikes per counter per day", data: avg, backgroundColor: p.cycle, borderRadius: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${fmtNumber.format(c.parsed.y)} bikes per counter/day` } },
      },
      scales: {
        x: { ticks: { color: p.muted }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: p.muted }, grid: { color: p.grid } },
      },
    },
  });
}

function renderStats(cycle, traffic) {
  const p = palette();
  const baseYear = commonBaseline(cycle, traffic);
  const changeOf = (s) => {
    const series = indexSeries(s, baseYear);
    if (series.length < 2) return null;
    return series[series.length - 1].index / 100 - 1;
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
  const p = palette();
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
      const marker = L.circleMarker([s.lat, s.lng], { radius: 6, weight: 1, color: "#fff", fillColor: colour, fillOpacity: 0.9 });
      marker.bindPopup(`<strong>${kind} counter</strong>${s.name ? `<br>${s.name}` : ""}`);
      marker.addTo(map);
      all.push([s.lat, s.lng]);
    }
  };
  add(cycle.sites, p.cycle, "Cycle");
  add(traffic.sites, p.traffic, "Traffic");
  if (all.length) map.fitBounds(all, { padding: [30, 30] });
}
