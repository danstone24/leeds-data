// Council tax page: the band D bill since 1993 split by authority, the annual
// rise, and what each band pays now. Chart.js is loaded as a global.

import { getCouncilTaxSummary } from "../api.js";
import { applyChartTheme, tokens, series, axes } from "./theme.js";

const fmtMoney = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});
const fmtMoneyExact = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const fmtPct = (n) => `${n > 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(1)}%`;

applyChartTheme();
bootstrap();

async function bootstrap() {
  try {
    const s = await getCouncilTaxSummary();
    renderStats(s);
    renderStack(s.years);
    renderRise(s.years);
    renderBands(s.latest);
  } catch (err) {
    console.error(err);
    document.getElementById("summary-line").textContent =
      "Sorry — the council tax data couldn't be loaded right now. Please try again later.";
  }
}

// The adult social care precept is only published as its own line in some
// years, so everywhere on this page it is folded into the council's share.
const councilShare = (y) => y.bandD.council + y.bandD.socialCare;

function renderStats(s) {
  const { latest, first } = s;
  document.getElementById("latest-year").textContent = `in ${latest.year}`;
  document.getElementById("first-year").textContent = first.year;
  document.getElementById("stat-bandd").textContent = fmtMoneyExact.format(latest.bandD.total);
  document.getElementById("stat-yoy").textContent = fmtPct(s.changeYoY);
  document.getElementById("stat-since").textContent = `×${(1 + s.changeSinceStart).toFixed(1)}`;
  document.getElementById("stat-share").textContent =
    `${Math.round((councilShare(latest) / latest.bandD.total) * 100)}%`;

  document.getElementById("summary-line").innerHTML =
    `A band D household in Leeds pays <strong>${fmtMoneyExact.format(latest.bandD.total)}</strong> in ${latest.year} — ` +
    `up <strong>${fmtPct(s.changeYoY).replace("+", "")}</strong> on last year and nearly four times the ${first.year} bill. ` +
    `About <strong>${Math.round((councilShare(latest) / latest.bandD.total) * 100)}p in every pound</strong> goes to the council; ` +
    `the rest funds West Yorkshire's police and fire services.`;

  document.getElementById("bands-year").textContent = `in ${latest.year}`;
  const updated = s.updated
    ? new Date(s.updated).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "—";
  document.getElementById("source-updated").textContent = updated;
}

function renderStack(years) {
  const t = tokens();
  const slots = series(3);
  new Chart(document.getElementById("stack-chart"), {
    type: "bar",
    data: {
      labels: years.map((y) => y.year),
      datasets: [
        { label: "Leeds City Council", data: years.map(councilShare), backgroundColor: slots[0], stack: "b" },
        { label: "Police", data: years.map((y) => y.bandD.police), backgroundColor: slots[1], stack: "b" },
        { label: "Fire", data: years.map((y) => y.bandD.fire), backgroundColor: slots[2], stack: "b" },
      ].map((d) => ({
        ...d,
        borderColor: t.surface,
        borderWidth: { top: 2 },
        borderSkipped: false,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${fmtMoneyExact.format(c.parsed.y)}`,
            footer: (items) =>
              `Total: ${fmtMoneyExact.format(years[items[0].dataIndex].bandD.total)}`,
          },
        },
      },
      scales: {
        x: axes.x({ stacked: true, ticks: { maxTicksLimit: 12 } }),
        y: axes.y({ stacked: true, ticks: { callback: (v) => fmtMoney.format(v) } }),
      },
    },
  });
}

function renderRise(years) {
  const rises = years.slice(1).map((y, i) => ({
    year: y.year,
    pct: years[i].bandD.total ? (y.bandD.total / years[i].bandD.total - 1) * 100 : 0,
  }));
  new Chart(document.getElementById("rise-chart"), {
    type: "bar",
    data: {
      labels: rises.map((r) => r.year),
      datasets: [{ data: rises.map((r) => r.pct), backgroundColor: series(1)[0] }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (c) => `${c.parsed.y.toFixed(1)}% rise on the year before` },
        },
      },
      scales: {
        x: axes.x({ ticks: { maxTicksLimit: 12 } }),
        y: axes.y({ ticks: { callback: (v) => `${v}%` } }),
      },
    },
  });
}

// Bands A–H are one ordered measure — a single-series bar, one colour.
function renderBands(latest) {
  const bands = Object.entries(latest.bands); // A → H, insertion order
  new Chart(document.getElementById("bands-chart"), {
    type: "bar",
    data: {
      labels: bands.map(([b]) => `Band ${b}`),
      datasets: [{ data: bands.map(([, v]) => v), backgroundColor: series(1)[0] }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (c) => `${fmtMoneyExact.format(c.parsed.y)} a year` },
        },
      },
      scales: {
        x: axes.x(),
        y: axes.y({ ticks: { callback: (v) => fmtMoney.format(v) } }),
      },
    },
  });
}
