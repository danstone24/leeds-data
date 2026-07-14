// Footfall page: the long trend (with the pandemic crash and recovery), the
// daily rhythm by hour, the weekly pattern, and the busiest locations.
// Chart.js is a page global.

import { getFootfallSummary } from "../api.js";

const fmtNumber = new Intl.NumberFormat("en-GB");
const fmtSignedPct = (n) => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n * 100))}%`;
const fmtPct = (n) => `${Math.round(n * 100)}%`;

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monthShort = (ym) => { const [y, m] = ym.split("-"); return `${MONTHS[+m - 1]} ${y.slice(2)}`; };
const WEEK_ORDER = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const palette = () => ({
  accent: css("--color-accent"),
  amber: css("--chart-2"),
  blue: css("--chart-3"),
  text: css("--color-text"),
  muted: css("--color-text-muted"),
  grid: css("--color-border"),
});

bootstrap();

async function bootstrap() {
  try {
    const s = await getFootfallSummary();
    renderStats(s);
    renderTrend(s.monthly);
    renderHour(s.byHour);
    renderWeekday(s.byWeekday);
    renderLocations(s.locations);
  } catch (err) {
    console.error(err);
    document.getElementById("summary-line").textContent =
      "Sorry — the footfall data couldn't be loaded right now. Please try again later.";
  }
}

function renderStats(s) {
  const latest = s.latest;
  document.getElementById("latest-year").textContent = latest ? `(${latest.year})` : "";
  document.getElementById("stat-latest").textContent = latest ? fmtNumber.format(latest.meanDaily) : "—";

  // Recovery vs the last pre-pandemic year present in the data.
  const preYear = [2019, 2018, 2017].find((y) => s.yearly.some((r) => r.year === y));
  const pre = s.yearly.find((r) => r.year === preYear);
  if (pre && latest && pre.meanDaily) {
    document.getElementById("recovery-label").textContent = `Vs ${pre.year} (pre-pandemic)`;
    document.getElementById("stat-recovery").textContent = fmtSignedPct(latest.meanDaily / pre.meanDaily - 1);
  } else {
    document.getElementById("stat-recovery").textContent = "—";
  }

  const busiestDay = [...s.byWeekday].sort((a, b) => b.avgPerCamera - a.avgPerCamera)[0];
  document.getElementById("stat-day").textContent = busiestDay ? busiestDay.day : "—";
  document.getElementById("stat-spot").textContent = s.locations[0]?.name || "—";

  const from = s.coverage.from ? s.coverage.from.slice(0, 4) : "records began";
  let line = `Leeds' city-centre cameras have counted footfall since ${from}. `;
  if (pre && latest && pre.meanDaily) {
    const rec = latest.meanDaily / pre.meanDaily - 1;
    line += rec < -0.02
      ? `In ${latest.year} it was still <strong>${fmtSignedPct(rec).replace("−", "down ")}</strong> on its ${pre.year} level — the city centre hasn't fully returned to how busy it was before the pandemic.`
      : `By ${latest.year} it was <strong>${fmtSignedPct(rec).replace("+", "up ").replace("−", "down ")}</strong> versus ${pre.year} — broadly back to its pre-pandemic level.`;
  } else {
    line += `The busiest spot is <strong>${s.locations[0]?.name || "the main shopping streets"}</strong>.`;
  }
  document.getElementById("summary-line").innerHTML = line;

  document.getElementById("source-updated").textContent = s.updated
    ? new Date(s.updated).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "—";
}

function renderTrend(monthly) {
  const p = palette();
  new Chart(document.getElementById("trend-chart"), {
    type: "line",
    data: {
      labels: monthly.map((m) => m.month),
      datasets: [{
        label: "People per camera per day",
        data: monthly.map((m) => m.meanDaily),
        borderColor: p.accent,
        backgroundColor: `${p.accent}22`,
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => monthShort(items[0].label),
            label: (c) => `${fmtNumber.format(c.parsed.y)} per camera/day`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: p.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 10,
            callback(v) { const lbl = this.getLabelForValue(v); return lbl.endsWith("-01") ? lbl.slice(0, 4) : ""; },
          },
          grid: { display: false },
        },
        y: { beginAtZero: true, ticks: { color: p.muted }, grid: { color: p.grid } },
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
      datasets: [{ label: "People per camera", data: byHour.map((h) => h.avgPerCamera), backgroundColor: p.accent, borderRadius: 3 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${fmtNumber.format(c.parsed.y)} people per camera, typical day` } },
      },
      scales: {
        x: { ticks: { color: p.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: p.muted }, grid: { color: p.grid } },
      },
    },
  });
}

function renderWeekday(byWeekday) {
  const p = palette();
  const byName = new Map(byWeekday.map((w) => [w.day, w.avgPerCamera]));
  new Chart(document.getElementById("weekday-chart"), {
    type: "bar",
    data: {
      labels: WEEK_ORDER,
      datasets: [{
        label: "People per camera per day",
        data: WEEK_ORDER.map((d) => byName.get(d) || 0),
        backgroundColor: WEEK_ORDER.map((d) => (d === "Saturday" || d === "Sunday" ? p.amber : p.accent)),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${fmtNumber.format(c.parsed.y)} per camera/day` } },
      },
      scales: {
        x: { ticks: { color: p.text }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: p.muted }, grid: { color: p.grid } },
      },
    },
  });
}

function renderLocations(locations) {
  const p = palette();
  const top = locations.slice(0, 10);
  new Chart(document.getElementById("loc-chart"), {
    type: "bar",
    data: {
      labels: top.map((l) => l.name),
      datasets: [{ label: "Share of footfall", data: top.map((l) => l.share * 100), backgroundColor: p.accent, borderRadius: 4 }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.parsed.x.toFixed(1)}% of recent footfall` } },
      },
      scales: {
        x: { beginAtZero: true, ticks: { color: p.muted, callback: (v) => `${v}%` }, grid: { color: p.grid } },
        y: { ticks: { color: p.text, autoSkip: false }, grid: { display: false } },
      },
    },
  });
}
