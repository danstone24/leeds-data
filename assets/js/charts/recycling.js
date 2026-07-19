// Recycling & waste page: Leeds recycling rate vs the England average,
// the landfill-to-incineration shift, and fly-tipping scale, location and
// enforcement. Chart.js is global.
//
// Data is authority-level DEFRA statistics (not Datamillnorth) — see
// workers/api/src/waste.js for the aggregation and its caveats. Fly-tipping
// incident counts partly reflect reporting practice; the page copy says so.

import { getWasteSummary } from "../api.js";
import { applyChartTheme, series, wash, axes } from "./theme.js";

const fmtNumber = new Intl.NumberFormat("en-GB");

applyChartTheme();
bootstrap();

async function bootstrap() {
  try {
    const s = await getWasteSummary();
    renderStats(s);
    renderHero(s.recycling);
    renderLandfill(s.recycling);
    renderFlyTrend(s.flyTipping);
    renderLandType(s.flyTipping);
    renderEnforcement(s.flyTipping);
  } catch (err) {
    console.error(err);
    document.getElementById("summary-line").textContent =
      "Sorry — the recycling and waste data couldn't be loaded right now. Please try again later.";
  }
}

const pct = (v) => `${v.toFixed(1)}%`;

function renderStats(s) {
  const leeds = s.recycling.leeds;
  const latest = leeds.at(-1);
  const previous = leeds.at(-2);
  const england = s.recycling.england.find((e) => e.year === latest.year);

  const dir =
    previous && latest.recycling !== previous.recycling
      ? latest.recycling > previous.recycling
        ? " (up on last year)"
        : " (down on last year)"
      : "";
  document.getElementById("stat-recycling-label").textContent =
    `Leeds recycling rate ${latest.year}${dir}`;
  document.getElementById("stat-recycling").textContent = pct(latest.recycling);

  if (england) {
    document.getElementById("stat-england-label").textContent = `England average ${england.year}`;
    document.getElementById("stat-england").textContent = pct(england.rate);
  }

  const fly = s.flyTipping.latest;
  const flyYearly = s.flyTipping.yearly.filter((y) => y.incidents !== null);
  const flyPrev = flyYearly.at(-2);
  let flyDir = "";
  if (fly && flyPrev && flyPrev.incidents) {
    const change = Math.round((fly.incidents / flyPrev.incidents - 1) * 100);
    flyDir = change ? ` (${change > 0 ? "up" : "down"} ${Math.abs(change)}% on last year)` : "";
  }
  if (fly) {
    document.getElementById("stat-flytip-label").textContent =
      `Fly-tipping incidents ${fly.year}${flyDir}`;
    document.getElementById("stat-flytip").textContent = fmtNumber.format(fly.incidents);
  }

  document.getElementById("stat-residual-label").textContent =
    `Residual waste per household ${latest.year}`;
  document.getElementById("stat-residual").textContent =
    `${fmtNumber.format(Math.round(latest.residualKg))} kg`;

  const gap = england ? (england.rate - latest.recycling).toFixed(1) : null;
  document.getElementById("summary-line").innerHTML =
    `Leeds sent <strong>${pct(latest.recycling)}</strong> of household waste for reuse, recycling or ` +
    `composting in ${latest.year}` +
    (gap ? ` — <strong>${gap} points below</strong> the England average of ${pct(england.rate)}` : "") +
    `. Landfill has all but ended since the city's incinerator opened, and the council recorded ` +
    `<strong>${fly ? fmtNumber.format(fly.incidents) : "—"}</strong> fly-tipping incidents${flyDir}.`;

  const updated = s.updated
    ? new Date(s.updated).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "—";
  document.getElementById("source-updated").textContent = updated;
}

// Fig 1 — Leeds vs England recycling rate, aligned to the Leeds era (2010-11 →).
function renderHero(recycling) {
  const leeds = recycling.leeds;
  const firstYear = leeds[0].year;
  const england = recycling.england.filter((e) => e.year >= firstYear);
  const years = [...new Set([...leeds.map((y) => y.year), ...england.map((y) => y.year)])].sort();
  const leedsAt = (year) => leeds.find((y) => y.year === year)?.recycling ?? null;
  const englandAt = (year) => england.find((y) => y.year === year)?.rate ?? null;
  const [c1, c2] = series(2);
  new Chart(document.getElementById("hero-chart"), {
    type: "line",
    data: {
      labels: years,
      datasets: [
        {
          label: "Leeds",
          data: years.map(leedsAt),
          borderColor: c1,
          pointBackgroundColor: c1,
          tension: 0.3,
          spanGaps: true,
        },
        {
          label: "England average",
          data: years.map(englandAt),
          borderColor: c2,
          pointBackgroundColor: c2,
          tension: 0.3,
          spanGaps: true,
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
            label: (c) => `${c.dataset.label}: ${pct(c.parsed.y)} recycled`,
          },
        },
      },
      scales: {
        x: axes.x(),
        y: axes.y({ max: 60, ticks: { callback: (v) => `${v}%` } }),
      },
    },
  });
}

// Fig 2 — landfill share of municipal waste, single series.
function renderLandfill(recycling) {
  const ys = recycling.leeds.filter((y) => y.landfill !== null);
  const [c1] = series(1);
  new Chart(document.getElementById("landfill-chart"), {
    type: "line",
    data: {
      labels: ys.map((y) => y.year),
      datasets: [
        {
          data: ys.map((y) => y.landfill),
          borderColor: c1,
          pointBackgroundColor: c1,
          backgroundColor: wash(c1),
          fill: true,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${pct(c.parsed.y)} of municipal waste sent to landfill`,
          },
        },
      },
      scales: {
        x: axes.x(),
        y: axes.y({ ticks: { callback: (v) => `${v}%` } }),
      },
    },
  });
}

// Fig 3 — fly-tipping incidents per year, single series.
function renderFlyTrend(flyTipping) {
  const ys = flyTipping.yearly.filter((y) => y.incidents !== null);
  new Chart(document.getElementById("flytrend-chart"), {
    type: "bar",
    data: {
      labels: ys.map((y) => y.year),
      datasets: [{ data: ys.map((y) => y.incidents), backgroundColor: series(1)[0] }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${fmtNumber.format(c.parsed.y)} incidents recorded`,
          },
        },
      },
      scales: { x: axes.x(), y: axes.y() },
    },
  });
}

// Fig 4 — latest-year incidents by land type, single-series horizontal bar.
function renderLandType(flyTipping) {
  const latest = flyTipping.latest;
  if (!latest) return;
  document.getElementById("landtype-caption").textContent =
    `Incidents in ${latest.year} by the type of land they were found on. Most fly-tipping in ` +
    `Leeds lands on highways and council land — the places the council itself must clear.`;
  const total = latest.byLandType.reduce((s, t) => s + t.count, 0);
  new Chart(document.getElementById("landtype-chart"), {
    type: "bar",
    data: {
      labels: latest.byLandType.map((t) => t.type),
      datasets: [
        { data: latest.byLandType.map((t) => t.count), backgroundColor: series(1)[0], maxBarThickness: 16 },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${fmtNumber.format(c.parsed.x)} incidents`,
            afterLabel: (c) =>
              total ? `${Math.round((c.parsed.x / total) * 100)}% of the year's total` : "",
          },
        },
      },
      scales: {
        x: axes.y({ position: "top" }),
        y: axes.x({ ticks: { autoSkip: false, font: { size: 11 } } }),
      },
    },
  });
}

// Fig 5 — enforcement actions vs incidents over time.
function renderEnforcement(flyTipping) {
  const ys = flyTipping.yearly.filter((y) => y.incidents !== null || y.actions !== null);
  const [c1, c2] = series(2);
  new Chart(document.getElementById("enforcement-chart"), {
    type: "line",
    data: {
      labels: ys.map((y) => y.year),
      datasets: [
        {
          label: "Incidents recorded",
          data: ys.map((y) => y.incidents),
          borderColor: c1,
          pointBackgroundColor: c1,
          tension: 0.3,
          spanGaps: true,
        },
        {
          label: "Enforcement actions",
          data: ys.map((y) => y.actions),
          borderColor: c2,
          pointBackgroundColor: c2,
          backgroundColor: wash(c2),
          fill: true,
          tension: 0.3,
          spanGaps: true,
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
            label: (c) =>
              c.parsed.y === null ? null : `${c.dataset.label}: ${fmtNumber.format(c.parsed.y)}`,
          },
        },
      },
      scales: { x: axes.x(), y: axes.y() },
    },
  });
}
