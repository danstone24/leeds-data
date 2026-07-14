// Potholes page: headline stats, a Leaflet map of every recorded pothole,
// a reported-vs-repaired trend, a by-ward ranking and a repair-time breakdown.
// Chart.js and Leaflet (+ markercluster) are loaded as globals in the page.

import { getPotholesSummary, getPotholesPoints } from "../api.js";

const fmtNumber = new Intl.NumberFormat("en-GB");
const fmtPct = (n) => `${Math.round(n * 100)}%`;
const fmtMoneyShort = (n) => {
  if (n >= 1_000_000) return `£${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
  if (n >= 1000) return `£${Math.round(n / 1000)}k`;
  return `£${Math.round(n)}`;
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const monthLong = (ym) => { const [y, m] = ym.split("-"); return `${MONTHS[+m - 1]} ${y}`; };
const monthShort = (ym) => { const [y, m] = ym.split("-"); return `${MONTHS[+m - 1].slice(0, 3)} ${y.slice(2)}`; };

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const palette = () => ({
  accent: css("--color-accent"),
  warn: css("--color-warn"),
  blue: css("--chart-3"),
  text: css("--color-text"),
  muted: css("--color-text-muted"),
  grid: css("--color-border"),
});

bootstrap();

async function bootstrap() {
  try {
    const summary = await getPotholesSummary();
    renderStats(summary);
    renderTrend(summary.trend);
    renderWards(summary.wards);
    renderBuckets(summary);
    // The map payload is heavier — load it after the page is usable.
    getPotholesPoints()
      .then((res) => renderMap(res.points))
      .catch((err) => {
        console.error(err);
        document.getElementById("map-caption").textContent =
          "The map couldn't be loaded, but the figures below are unaffected.";
      });
  } catch (err) {
    console.error(err);
    document.getElementById("summary-line").textContent =
      "Sorry — the pothole data couldn't be loaded right now. Please try again later.";
  }
}

// Headline ------------------------------------------------------------------

function renderStats(s) {
  document.getElementById("stat-total").textContent = fmtNumber.format(s.totalRecorded);
  document.getElementById("stat-fixed").textContent = fmtPct(s.fixedShare);
  document.getElementById("stat-median").textContent =
    `${s.medianFixDays} ${s.medianFixDays === 1 ? "day" : "days"}`;
  document.getElementById("stat-cost").textContent = fmtMoneyShort(s.totalCost);

  const since = s.coverage.from ? monthLong(s.coverage.from) : "records began";
  document.getElementById("summary-line").innerHTML =
    `Leeds has recorded <strong>${fmtNumber.format(s.totalRecorded)}</strong> potholes since ${since}. ` +
    `<strong>${fmtPct(s.fixedShare)}</strong> have been repaired, typically within ` +
    `<strong>${s.medianFixDays} days</strong> — though the slowest tenth took over ${s.p90FixDays}. ` +
    `Repairs have cost <strong>${fmtMoneyShort(s.totalCost)}</strong> so far.`;

  const updated = s.updated ? new Date(s.updated).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "—";
  document.getElementById("source-updated").textContent = updated;
}

// Map -----------------------------------------------------------------------

function renderMap(points) {
  const p = palette();
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const map = L.map("map", { scrollWheelZoom: false }).setView([53.8, -1.55], 11);

  const tiles = dark
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  L.tileLayer(tiles, {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  const cluster = L.markerClusterGroup({
    chunkedLoading: true,
    disableClusteringAtZoom: 16,
    maxClusterRadius: 50,
  });

  const markers = points.map(([lat, lon, code]) => {
    const open = code === -1;
    const marker = L.circleMarker([lat, lon], {
      radius: 4,
      weight: 0,
      fillColor: open ? p.warn : p.accent,
      fillOpacity: 0.75,
    });
    marker.bindPopup(
      open
        ? "Awaiting repair"
        : code >= 0
        ? `Repaired — ${code} ${code === 1 ? "day" : "days"} after being recorded`
        : "Repaired",
    );
    return marker;
  });
  cluster.addLayers(markers);
  map.addLayer(cluster);

  const bounds = cluster.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.05));
}

// Trend ---------------------------------------------------------------------

function renderTrend(trend) {
  const p = palette();
  new Chart(document.getElementById("trend-chart"), {
    type: "line",
    data: {
      labels: trend.map((t) => monthShort(t.month)),
      datasets: [
        { label: "Reported", data: trend.map((t) => t.recorded), borderColor: p.blue, backgroundColor: p.blue, tension: 0.3, pointRadius: 2 },
        { label: "Repaired", data: trend.map((t) => t.fixed), borderColor: p.accent, backgroundColor: p.accent, tension: 0.3, pointRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: p.text, usePointStyle: true, boxWidth: 8 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtNumber.format(c.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: p.muted, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: p.muted }, grid: { color: p.grid } },
      },
    },
  });
}

// Wards ---------------------------------------------------------------------

function renderWards(wards) {
  const p = palette();
  new Chart(document.getElementById("ward-chart"), {
    type: "bar",
    data: {
      labels: wards.map((w) => w.name),
      datasets: [{ label: "Potholes recorded", data: wards.map((w) => w.count), backgroundColor: p.accent, borderRadius: 4 }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${fmtNumber.format(c.parsed.x)} recorded`,
            afterLabel: (c) => {
              const w = wards[c.dataIndex];
              return `Median fix: ${w.medianFixDays} days · ${fmtNumber.format(w.open)} still open`;
            },
          },
        },
      },
      scales: {
        x: { beginAtZero: true, ticks: { color: p.muted }, grid: { color: p.grid } },
        y: { ticks: { color: p.text, autoSkip: false }, grid: { display: false } },
      },
    },
  });
}

// Repair-time buckets -------------------------------------------------------

function renderBuckets(s) {
  const p = palette();
  const buckets = s.fixTimeBuckets;
  const total = buckets.reduce((sum, b) => sum + b.count, 0) || 1;
  new Chart(document.getElementById("bucket-chart"), {
    type: "bar",
    data: {
      labels: buckets.map((b) => b.label),
      datasets: [{ label: "Potholes", data: buckets.map((b) => b.count), backgroundColor: p.accent, borderRadius: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${fmtNumber.format(c.parsed.y)} potholes (${fmtPct(c.parsed.y / total)})`,
          },
        },
      },
      scales: {
        x: { ticks: { color: p.text }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: p.muted }, grid: { color: p.grid } },
      },
    },
  });
}
