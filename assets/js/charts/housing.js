// Council housing page: bids-per-home trend, homes advertised, the shrinking
// stock, ward and bedroom competition, and the stock mix. Chart.js is global.

import { getHousingSummary } from "../api.js";
import { applyChartTheme, tokens, series, wash, axes } from "./theme.js";

const fmtNumber = new Intl.NumberFormat("en-GB");

applyChartTheme();
bootstrap();

async function bootstrap() {
  try {
    const s = await getHousingSummary();
    renderStats(s);
    renderBidsTrend(s.bids.yearly);
    renderLets(s.bids.yearly);
    renderStock(s.stock.yearly);
    renderWards(s.bids.byWard, s.bids.breakdownYear);
    renderBeds(s.bids.byBedrooms, s.bids.breakdownYear);
    renderMix(s.mix);
  } catch (err) {
    console.error(err);
    document.getElementById("summary-line").textContent =
      "Sorry — the council housing data couldn't be loaded right now. Please try again later.";
  }
}

function renderStats(s) {
  const year = s.bids.breakdownYear;
  const latest = s.bids.yearly.find((y) => y.year === year);
  const first = s.bids.yearly[0];

  document.getElementById("breakdown-year").textContent = `in ${year}`;
  document.getElementById("breakdown-year-2").textContent = `in ${year}`;
  document.getElementById("stat-bids").textContent = Math.round(latest.meanEoi);
  document.getElementById("stat-lets").textContent = fmtNumber.format(latest.lets);
  document.getElementById("stock-year").textContent = s.stock.latest ? `in ${s.stock.latest.fy}` : "now";
  document.getElementById("stat-stock").textContent = fmtNumber.format(s.stock.latest.total);
  document.getElementById("stock-first-year").textContent = s.stock.first.fy;
  document.getElementById("stat-stock-change").textContent =
    `−${Math.abs(Math.round(s.stock.change * 100))}%`;

  document.getElementById("summary-line").innerHTML =
    `On average, <strong>${Math.round(latest.meanEoi)} households</strong> bid on every council home advertised ` +
    `in Leeds in ${year} — up from <strong>${Math.round(first.meanEoi)}</strong> in ${first.year}. ` +
    `Only <strong>${fmtNumber.format(latest.lets)}</strong> homes came up all year, from a stock that has shrunk ` +
    `by <strong>${fmtNumber.format(s.stock.first.total - s.stock.latest.total)}</strong> since ${s.stock.first.fy}.`;

  const updated = s.updated
    ? new Date(s.updated).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "—";
  document.getElementById("source-updated").textContent = updated;
}

// Years with less than half coverage would show as misleading dips — drop
// them from the trend and say so in the caption.
function trendYears(yearly) {
  return yearly.filter((y) => y.monthsCovered >= 6);
}

function renderBidsTrend(yearly) {
  const ys = trendYears(yearly);
  const partial = ys.filter((y) => y.monthsCovered < 12).map((y) => y.year);
  if (partial.length) {
    document.getElementById("bids-trend-caption").textContent +=
      ` ${partial.join(" and ")} cover${partial.length === 1 ? "s" : ""} part of the year only.`;
  }
  const c = series(1)[0];
  new Chart(document.getElementById("bids-trend-chart"), {
    type: "line",
    data: {
      labels: ys.map((y) => y.year),
      datasets: [
        {
          label: "Mean bids per home",
          data: ys.map((y) => y.meanEoi),
          borderColor: c,
          pointBackgroundColor: c,
          backgroundColor: wash(c),
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
            label: (ctx) => `${ctx.parsed.y} bids per home on average`,
            afterLabel: (ctx) => {
              const y = ys[ctx.dataIndex];
              return `Median ${y.medianEoi} · ${fmtNumber.format(y.lets)} homes advertised`;
            },
          },
        },
      },
      scales: { x: axes.x(), y: axes.y() },
    },
  });
}

// Counting is coverage-biased, so this one shows complete years only.
function renderLets(yearly) {
  const full = yearly.filter((y) => y.monthsCovered === 12);
  new Chart(document.getElementById("lets-chart"), {
    type: "bar",
    data: {
      labels: full.map((y) => y.year),
      datasets: [{ data: full.map((y) => y.lets), backgroundColor: series(1)[0] }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${fmtNumber.format(c.parsed.y)} homes advertised` } },
      },
      scales: { x: axes.x(), y: axes.y() },
    },
  });
}

function renderStock(yearly) {
  const c = series(1)[0];
  new Chart(document.getElementById("stock-chart"), {
    type: "line",
    data: {
      labels: yearly.map((y) => y.fy),
      datasets: [
        {
          label: "Council homes",
          data: yearly.map((y) => y.total),
          borderColor: c,
          pointBackgroundColor: c,
          backgroundColor: wash(c),
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
        tooltip: { callbacks: { label: (ctx) => `${fmtNumber.format(ctx.parsed.y)} council homes` } },
      },
      scales: {
        x: axes.x({ ticks: { maxTicksLimit: 10 } }),
        // Not zero-based: the story is the 7,500-home slide, which a zero
        // axis would flatten into invisibility.
        y: axes.y({ beginAtZero: false }),
      },
    },
  });
}

function renderWards(byWard, year) {
  document.getElementById("ward-caption").textContent =
    `Average bids per advertised home by ward in ${year}. Inner-city wards see the longest ` +
    `queues; the outer suburbs the shortest — but nowhere in Leeds is a council home easy to get.`;
  new Chart(document.getElementById("ward-chart"), {
    type: "bar",
    data: {
      labels: byWard.map((w) => w.ward),
      datasets: [{ data: byWard.map((w) => w.meanEoi), backgroundColor: series(1)[0], maxBarThickness: 16 }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${c.parsed.x} bids per home on average`,
            afterLabel: (c) => `${fmtNumber.format(byWard[c.dataIndex].lets)} homes advertised`,
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

function renderBeds(byBedrooms, year) {
  document.getElementById("beds-caption").textContent =
    `Average bids by property size in ${year}. Three-bed family homes rarely come up — ` +
    `when they do, the queue is the longest of all.`;
  new Chart(document.getElementById("beds-chart"), {
    type: "bar",
    data: {
      labels: byBedrooms.map((b) => b.beds),
      datasets: [{ data: byBedrooms.map((b) => b.meanEoi), backgroundColor: series(1)[0] }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${c.parsed.y} bids per home on average`,
            afterLabel: (c) => `${fmtNumber.format(byBedrooms[c.dataIndex].lets)} advertised`,
          },
        },
      },
      scales: { x: axes.x(), y: axes.y() },
    },
  });
}

// Donut of the stock mix — top forms get categorical slots in fixed order,
// the tail folds into a neutral "Everything else".
function renderMix(mix) {
  const t = tokens();
  const MAX_SLICES = 5;
  const named = mix.byForm.slice(0, MAX_SLICES);
  const tail = mix.byForm.slice(MAX_SLICES);
  const labels = named.map((f) => f.form);
  const data = named.map((f) => f.count);
  if (tail.length) {
    labels.push("Everything else");
    data.push(tail.reduce((s, f) => s + f.count, 0));
  }
  const colours = [...series(named.length), t.seriesOther];

  document.getElementById("mix-caption").textContent =
    `The ${fmtNumber.format(mix.total)} tenanted council homes by property type` +
    (mix.snapshotDate ? ` (snapshot ${new Date(mix.snapshotDate).toLocaleDateString("en-GB", { month: "long", year: "numeric" })})` : "") +
    `. ${Math.round(mix.shelteredShare * 100)}% of the stock is sheltered or extra-care housing for older residents.`;

  new Chart(document.getElementById("mix-chart"), {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: colours, borderColor: t.surface, borderWidth: 2 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "62%",
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) =>
              `${c.label}: ${fmtNumber.format(c.parsed)} homes (${Math.round((c.parsed / mix.total) * 100)}%)`,
          },
        },
      },
    },
  });
}
