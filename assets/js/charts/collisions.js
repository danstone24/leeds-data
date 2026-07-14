// Road safety page: casualties by severity, the KSI trend, who gets hurt, and
// when crashes happen. Chart.js is loaded as a global in the page.

import { getCollisionsSummary } from "../api.js";

const fmtNumber = new Intl.NumberFormat("en-GB");
const fmtSignedPct = (n) => `${n > 0 ? "+" : "−"}${Math.abs(Math.round(n * 100))}%`;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const palette = () => ({
  accent: css("--color-accent"),
  amber: css("--chart-2"),
  red: css("--chart-4"),
  blue: css("--chart-3"),
  violet: css("--chart-6"),
  text: css("--color-text"),
  muted: css("--color-text-muted"),
  grid: css("--color-border"),
});

const baseScales = (p) => ({
  x: { stacked: false, ticks: { color: p.muted, maxRotation: 0, autoSkip: true }, grid: { display: false } },
  y: { beginAtZero: true, ticks: { color: p.muted }, grid: { color: p.grid } },
});

bootstrap();

async function bootstrap() {
  try {
    const s = await getCollisionsSummary();
    renderStats(s);
    renderSeverity(s.yearly);
    renderKsi(s.yearly);
    renderClass(s.yearly);
    renderHour(s.byHour);
  } catch (err) {
    console.error(err);
    document.getElementById("summary-line").textContent =
      "Sorry — the road-safety data couldn't be loaded right now. Please try again later.";
  }
}

function renderStats(s) {
  const latest = s.latest;
  document.getElementById("latest-year").textContent = `in ${latest.year}`;
  document.getElementById("stat-casualties").textContent = fmtNumber.format(latest.casualties);
  document.getElementById("stat-ksi").textContent = fmtNumber.format(latest.ksi);
  document.getElementById("stat-deaths").textContent = fmtNumber.format(latest.fatal);
  document.getElementById("change-label").textContent = `Change since ${s.coverage.from}`;
  document.getElementById("stat-change").textContent = fmtSignedPct(s.changeSinceStart);

  // Find the pandemic-era KSI low to frame the "but serious cases are rising" point.
  const ksiLow = [...s.yearly].sort((a, b) => a.ksi - b.ksi)[0];
  const dir = s.changeSinceStart < 0 ? "down" : "up";
  document.getElementById("summary-line").innerHTML =
    `Leeds recorded <strong>${fmtNumber.format(latest.casualties)}</strong> road casualties in ${latest.year}, ` +
    `${dir} <strong>${fmtSignedPct(s.changeSinceStart).replace("−", "")}</strong> on ${s.coverage.from}. ` +
    `But the most serious cases have proved harder to shift — killed or seriously injured rose from a low of ` +
    `<strong>${fmtNumber.format(ksiLow.ksi)}</strong> in ${ksiLow.year} to <strong>${fmtNumber.format(latest.ksi)}</strong> last year.`;

  const updated = s.updated
    ? new Date(s.updated).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "—";
  document.getElementById("source-updated").textContent = updated;
}

function renderSeverity(yearly) {
  const p = palette();
  new Chart(document.getElementById("severity-chart"), {
    type: "bar",
    data: {
      labels: yearly.map((y) => y.year),
      datasets: [
        { label: "Slight", data: yearly.map((y) => y.slight), backgroundColor: p.accent, stack: "s" },
        { label: "Serious", data: yearly.map((y) => y.serious), backgroundColor: p.amber, stack: "s" },
        { label: "Fatal", data: yearly.map((y) => y.fatal), backgroundColor: p.red, stack: "s" },
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
        x: { stacked: true, ticks: { color: p.muted, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { color: p.muted }, grid: { color: p.grid } },
      },
    },
  });
}

function renderKsi(yearly) {
  const p = palette();
  new Chart(document.getElementById("ksi-chart"), {
    type: "line",
    data: {
      labels: yearly.map((y) => y.year),
      datasets: [
        {
          label: "Killed or seriously injured",
          data: yearly.map((y) => y.ksi),
          borderColor: p.red,
          backgroundColor: p.red,
          tension: 0.3,
          pointRadius: 3,
          fill: false,
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
            label: (c) => `${fmtNumber.format(c.parsed.y)} killed or seriously injured`,
            afterLabel: (c) => `of which ${fmtNumber.format(yearly[c.dataIndex].fatal)} fatal`,
          },
        },
      },
      scales: baseScales(p),
    },
  });
}

function renderClass(yearly) {
  const p = palette();
  new Chart(document.getElementById("class-chart"), {
    type: "bar",
    data: {
      labels: yearly.map((y) => y.year),
      datasets: [
        { label: "Drivers & riders", data: yearly.map((y) => y.driver), backgroundColor: p.blue, stack: "c" },
        { label: "Passengers", data: yearly.map((y) => y.passenger), backgroundColor: p.violet, stack: "c" },
        { label: "Pedestrians", data: yearly.map((y) => y.pedestrian), backgroundColor: p.amber, stack: "c" },
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
        x: { stacked: true, ticks: { color: p.muted, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { color: p.muted }, grid: { color: p.grid } },
      },
    },
  });
}

function renderHour(byHour) {
  const p = palette();
  const label = (h) => `${String(h).padStart(2, "0")}:00`;
  new Chart(document.getElementById("hour-chart"), {
    type: "bar",
    data: {
      labels: byHour.map((h) => label(h.hour)),
      datasets: [{ label: "Casualties", data: byHour.map((h) => h.count), backgroundColor: p.accent, borderRadius: 3 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `${items[0].label}–${label((byHour[items[0].dataIndex].hour + 1) % 24)}`,
            label: (c) => `${fmtNumber.format(c.parsed.y)} casualties`,
            afterLabel: (c) => `${fmtNumber.format(byHour[c.dataIndex].ksi)} killed or seriously injured`,
          },
        },
      },
      scales: {
        x: { ticks: { color: p.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: p.muted }, grid: { color: p.grid } },
      },
    },
  });
}
