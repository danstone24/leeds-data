// Planning page: headline stats and three MHCLG charts (decided vs granted,
// approval rate by size, applications received), plus a PlanIt-powered map
// and large-applications table. Chart.js and Leaflet (+ markercluster) are
// loaded as globals in the page.
//
// Trust boundary, by design: every NUMBER comes from the MHCLG summary; the
// PlanIt payload only draws the map and the table, and the page degrades
// gracefully (charts intact, map figure shows a note) when it's missing.

import { getPlanningSummary, getPlanningApps } from "../api.js";
import { applyChartTheme, tokens, series, wash, axes } from "./theme.js";

const fmtNumber = new Intl.NumberFormat("en-GB");
const fmtPct = (n) => `${Math.round(n * 100)}%`;

applyChartTheme();
bootstrap();

async function bootstrap() {
  try {
    const summary = await getPlanningSummary();
    renderStats(summary);
    renderHero(summary.quarters);
    renderApproval(summary.quarters);
    renderReceived(summary.quarters);
  } catch (err) {
    console.error(err);
    document.getElementById("summary-line").textContent =
      "Sorry — the planning data couldn't be loaded right now. Please try again later.";
    return;
  }
  // The map layer is third-party and heavier — load it after the page is
  // usable, and shrug if it's unavailable.
  getPlanningApps()
    .then((apps) => {
      renderMap(apps);
      renderLarge(apps);
    })
    .catch((err) => {
      console.error(err);
      document.getElementById("map-caption").textContent =
        "The applications map is temporarily unavailable — the official statistics above are unaffected.";
    });
}

// Headline ------------------------------------------------------------------

function renderStats(s) {
  const t = s.tiles;
  if (!t) return;
  document.getElementById("tile-quarter").textContent = `in ${t.quarter}`;
  document.getElementById("tile-approved").textContent =
    t.approvalShare !== null ? `${fmtPct(t.approvalShare)} approved` : "approval n/a";
  document.getElementById("stat-decisions").textContent = fmtNumber.format(t.decisions);
  document.getElementById("tile-received-quarter").textContent =
    t.receivedQuarter ? `in ${t.receivedQuarter}` : "last quarter";
  document.getElementById("stat-received").textContent =
    t.received !== null ? fmtNumber.format(t.received) : "—";
  document.getElementById("stat-intime").textContent =
    t.inTimeShare !== null ? fmtPct(t.inTimeShare) : "—";
  document.getElementById("stat-majors").textContent = fmtNumber.format(t.majorsLastYear);

  document.getElementById("summary-line").innerHTML =
    `Leeds decided <strong>${fmtNumber.format(t.decisions)}</strong> planning applications in ` +
    `${t.quarter} and approved <strong>${t.approvalShare !== null ? fmtPct(t.approvalShare) : "most"}</strong> of them` +
    `${t.inTimeShare !== null ? `, with ${fmtPct(t.inTimeShare)} decided within the target time` : ""}. ` +
    `Over the last year <strong>${fmtNumber.format(t.majorsLastYear)}</strong> major schemes were decided. ` +
    `Refusal is the exception — and the big schemes face the toughest odds.`;

  const updated = s.updated
    ? new Date(s.updated).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "—";
  document.getElementById("source-updated").textContent = updated;
}

// Fig 1 — decided vs granted per quarter, full history ----------------------

function renderHero(quarters) {
  const qs = quarters.filter((q) => q.decisions !== null);
  const [c1, c2] = series(2);
  new Chart(document.getElementById("hero-chart"), {
    type: "line",
    data: {
      labels: qs.map((q) => q.quarter),
      datasets: [
        {
          label: "Decided",
          data: qs.map((q) => q.decisions),
          borderColor: c1,
          pointBackgroundColor: c1,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 12,
        },
        {
          label: "Granted",
          data: qs.map((q) => q.granted),
          borderColor: c2,
          pointBackgroundColor: c2,
          backgroundColor: wash(c2),
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 12,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${fmtNumber.format(c.parsed.y)}`,
            footer: (items) => {
              const q = qs[items[0].dataIndex];
              return q.granted !== null && q.decisions
                ? `${fmtPct(q.granted / q.decisions)} approved · ${fmtNumber.format(q.refused ?? 0)} refused`
                : "";
            },
          },
        },
      },
      scales: { x: axes.x(), y: axes.y() },
    },
  });
}

// Fig 2 — approval rate by size, rolling year -------------------------------
//
// Majors are only ~20 decisions a quarter, so a raw quarterly rate is noise.
// Each point is the share granted across that quarter and the three before
// it — a rolling year, sampled quarterly.

function rollingShare(qs, size) {
  return qs.map((_, i) => {
    if (i < 3) return null;
    const window = qs.slice(i - 3, i + 1).map((q) => q[size]);
    if (window.some((w) => !w || w.decisions === null || w.granted === null)) return null;
    const dec = window.reduce((s, w) => s + w.decisions, 0);
    const granted = window.reduce((s, w) => s + w.granted, 0);
    return dec ? (granted / dec) * 100 : null;
  });
}

function renderApproval(quarters) {
  const qs = quarters.filter((q) => q.major && q.minor && q.other);
  const [c1, c2, c3] = series(3);
  const mk = (label, size, colour) => ({
    label,
    data: rollingShare(qs, size),
    borderColor: colour,
    pointBackgroundColor: colour,
    tension: 0.3,
    pointRadius: 0,
    pointHitRadius: 12,
    spanGaps: true,
  });
  new Chart(document.getElementById("approval-chart"), {
    type: "line",
    data: {
      labels: qs.map((q) => q.quarter),
      datasets: [
        mk("Major schemes", "major", c1),
        mk("Minor schemes", "minor", c2),
        mk("Everything else", "other", c3),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => `Year to ${items[0].label}`,
            label: (c) => `${c.dataset.label}: ${Math.round(c.parsed.y)}% approved`,
          },
        },
      },
      scales: {
        x: axes.x(),
        y: axes.y({ max: 100, ticks: { callback: (v) => `${v}%` } }),
      },
    },
  });
}

// Fig 3 — applications received per quarter (single series, no legend) ------

function renderReceived(quarters) {
  const qs = quarters.filter((q) => q.received !== null);
  const c1 = series(1)[0];
  new Chart(document.getElementById("received-chart"), {
    type: "line",
    data: {
      labels: qs.map((q) => q.quarter),
      datasets: [
        {
          data: qs.map((q) => q.received),
          borderColor: c1,
          pointBackgroundColor: c1,
          backgroundColor: wash(c1),
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 12,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${fmtNumber.format(c.parsed.y)} applications received`,
            afterLabel: (c) => {
              const q = qs[c.dataIndex];
              return q.withdrawn !== null ? `${fmtNumber.format(q.withdrawn)} withdrawn` : "";
            },
          },
        },
      },
      scales: { x: axes.x(), y: axes.y() },
    },
  });
}

// Fig 4 — PlanIt map --------------------------------------------------------
//
// app_state → the reserved STATUS palette (a legitimate status use, per the
// design system): granted-ish green, refused red, everything else neutral.
// Tuple order: [lat, lon, state, type, size, description, start, decided, url]

const GRANTED_STATES = /^(permitted|conditions)$/i;
const REFUSED_STATES = /^rejected$/i;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function stateColour(state, t) {
  if (GRANTED_STATES.test(state)) return t.statusGood;
  if (REFUSED_STATES.test(state)) return t.statusCritical;
  return t.seriesOther;
}

function renderMap(payload) {
  const points = payload.apps || [];
  if (!points.length) {
    document.getElementById("map-caption").textContent =
      "The applications map is temporarily unavailable — the official statistics above are unaffected.";
    return;
  }
  const t = tokens();
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const map = L.map("map", { scrollWheelZoom: false }).setView([53.8, -1.55], 11);

  const tiles = dark
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  L.tileLayer(tiles, {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a> &middot; applications via <a href="https://www.planit.org.uk/">PlanIt</a>',
  }).addTo(map);

  const cluster = L.markerClusterGroup({
    chunkedLoading: true,
    disableClusteringAtZoom: 16,
    maxClusterRadius: 50,
  });

  const markers = points.map(([lat, lon, state, type, size, desc, start, decided, url]) => {
    const marker = L.circleMarker([lat, lon], {
      radius: 4,
      weight: 0,
      fillColor: stateColour(state, t),
      fillOpacity: GRANTED_STATES.test(state) || REFUSED_STATES.test(state) ? 0.85 : 0.6,
    });
    const when = decided ? `Decided ${fmtDate(decided)}` : start ? `Received ${fmtDate(start)}` : null;
    marker.bindPopup(
      `<strong>${esc(type)}${size ? ` · ${esc(size)}` : ""}</strong> — ${esc(state)}<br>` +
        `${esc(desc)}` +
        (when ? `<br>${esc(when)}` : "") +
        (url ? `<br><a href="${esc(url)}" rel="noopener" target="_blank">View the application</a>` : ""),
    );
    return marker;
  });
  cluster.addLayers(markers);
  map.addLayer(cluster);

  const bounds = cluster.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.05));

  document.getElementById("map-caption").textContent =
    `${fmtNumber.format(points.length)} planning applications from the last 12 months, mapped. ` +
    `Zoom in to split the clusters and click a dot for the details and a link to the council's ` +
    `planning portal. This layer comes from the volunteer-run PlanIt service, not official statistics.`;
}

// Fig 5 — recent large applications table -----------------------------------

function renderLarge(payload) {
  const rows = payload.large || [];
  if (!rows.length) return; // figure stays hidden
  const tbody = document.querySelector("#large-table tbody");
  for (const app of rows) {
    const tr = document.createElement("tr");

    const tdDesc = document.createElement("td");
    if (app.url) {
      const a = document.createElement("a");
      a.href = app.url;
      a.rel = "noopener";
      a.target = "_blank";
      a.textContent = app.description || app.name;
      tdDesc.appendChild(a);
    } else {
      tdDesc.textContent = app.description || app.name;
    }
    tr.appendChild(tdDesc);

    const tdState = document.createElement("td");
    tdState.textContent = app.state;
    tr.appendChild(tdState);

    const tdDate = document.createElement("td");
    tdDate.textContent = fmtDate(app.start) || "—";
    tr.appendChild(tdDate);

    tbody.appendChild(tr);
  }
  document.getElementById("large-figure").hidden = false;
}
