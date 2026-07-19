// Air quality page: annual means against UK legal limits and WHO 2021 health
// guidelines, the daily NO₂ rhythm, the seasonal cycle, and days over the
// short-term PM10 limit. Chart.js is global.
//
// Data is the air:summary blob built in workers/api/src/air.js from DEFRA
// UK-AIR hourly files for Leeds Centre. Annual means arrive pre-filtered:
// a year below 75% data capture has mean === null and simply leaves a gap.
// Provisional (not yet ratified) years are drawn as open points and named
// in the caption.

import { getAirSummary } from "../api.js";
import { applyChartTheme, tokens, series, wash, axes } from "./theme.js";

const fmt1 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Tiny inline plugin: horizontal reference lines with a small right-aligned
// label. Configured per chart via options.plugins.referenceLines.lines =
// [{ value, label, color, dash, labelBelow }]. Colours are passed in from
// theme tokens — never hardcoded here.
const referenceLines = {
  id: "referenceLines",
  afterDatasetsDraw(chart, _args, opts) {
    const lines = opts?.lines || [];
    if (!lines.length) return;
    const { ctx, chartArea } = chart;
    const yScale = chart.scales.y;
    ctx.save();
    ctx.font = '10px "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif';
    for (const line of lines) {
      const y = yScale.getPixelForValue(line.value);
      if (y < chartArea.top - 1 || y > chartArea.bottom + 1) continue;
      ctx.strokeStyle = line.color;
      ctx.setLineDash(line.dash || [5, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      if (line.label) {
        ctx.setLineDash([]);
        ctx.fillStyle = line.color;
        ctx.textAlign = "right";
        ctx.textBaseline = line.labelBelow ? "top" : "bottom";
        ctx.fillText(line.label, chartArea.right, y + (line.labelBelow ? 3 : -3));
      }
    }
    ctx.restore();
  },
};

applyChartTheme();
bootstrap();

async function bootstrap() {
  try {
    const s = await getAirSummary();
    renderStats(s);
    renderHero(s);
    renderRhythm(s);
    renderSeasonal(s);
    renderDays(s);
  } catch (err) {
    console.error(err);
    document.getElementById("summary-line").textContent =
      "Sorry — the air quality data couldn't be loaded right now. Please try again later.";
  }
}

// Years with a usable (≥75% capture) annual mean for a pollutant.
const validYears = (s, key) => s.years.filter((y) => y[key].mean !== null);

function renderStats(s) {
  const no2 = validYears(s, "no2");
  const pm25 = validYears(s, "pm25");
  const latest = no2.at(-1);
  const first = no2[0];
  const latestPm25 = pm25.at(-1);

  document.getElementById("no2-year").textContent = latest ? String(latest.year) : "latest";
  document.getElementById("stat-no2").textContent = latest
    ? `${fmt1.format(latest.no2.mean)} µg/m³`
    : "—";

  document.getElementById("stat-pm25").textContent = latestPm25
    ? `${fmt1.format(latestPm25.pm25.mean / s.limits.pm25.who)}×`
    : "—";

  let changePct = null;
  if (latest && first && first.year < latest.year) {
    changePct = Math.round((latest.no2.mean / first.no2.mean - 1) * 100);
    document.getElementById("change-window").textContent = `since ${first.year}`;
    document.getElementById("stat-change").textContent = `${changePct > 0 ? "+" : ""}${changePct}%`;
  }

  // Last year any UK annual-mean legal limit was breached at this station.
  const breaches = s.years.filter(
    (y) =>
      (y.no2.mean !== null && y.no2.mean > s.limits.no2.uk) ||
      (y.pm25.mean !== null && y.pm25.mean > s.limits.pm25.uk) ||
      (y.pm10.mean !== null && y.pm10.mean > s.limits.pm10.uk)
  );
  const lastBreach = breaches.at(-1);
  document.getElementById("stat-legal").textContent = lastBreach
    ? `Since ${lastBreach.year + 1}`
    : `Every year since ${s.coverage.from}`;

  const overWho = latest && latest.no2.mean > s.limits.no2.who;
  document.getElementById("summary-line").innerHTML =
    `The air over central Leeds averaged <strong>${fmt1.format(latest?.no2.mean ?? 0)} µg/m³</strong> of ` +
    `nitrogen dioxide in ${latest?.year} — <strong>${Math.abs(changePct ?? 0)}% ${changePct <= 0 ? "less" : "more"}</strong> than in ${first?.year}, ` +
    `and comfortably inside the UK legal limit of ${s.limits.no2.uk}. But legal isn't the same as healthy: ` +
    `both nitrogen dioxide and fine particles ${overWho ? "still sit well above" : "are near"} the World Health ` +
    `Organization's guidelines for clean air.`;

  const updated = s.updated
    ? new Date(s.updated).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "—";
  document.getElementById("source-updated").textContent = updated;
  document.getElementById("source-coverage").textContent = s.coverage.latestReading
    ? new Date(`${s.coverage.latestReading}T00:00:00Z`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";
}

function renderHero(s) {
  const t = tokens();
  const [c1, c2, c3] = series(3);
  const years = s.years.map((y) => y.year);
  const at = (key) => s.years.map((y) => y[key].mean);
  const provisional = s.years.filter((y) => y.provisional && y.no2.mean !== null).map((y) => y.year);
  if (provisional.length) {
    document.getElementById("hero-caption").textContent +=
      ` Figures for ${provisional.join(", ")} are provisional (open points) and may be revised by DEFRA.`;
  }

  // Open points for provisional years — colour is never the only signal.
  const pointFill = (colour) =>
    s.years.map((y) => (y.provisional ? t.surface : colour));

  const lineSet = (label, key, colour) => ({
    label,
    data: at(key),
    borderColor: colour,
    pointBackgroundColor: pointFill(colour),
    pointBorderColor: colour,
    tension: 0.3,
    spanGaps: true,
  });

  new Chart(document.getElementById("hero-chart"), {
    type: "line",
    plugins: [referenceLines],
    data: {
      labels: years,
      datasets: [
        lineSet("Nitrogen dioxide (NO₂)", "no2", c1),
        lineSet("Fine particles (PM2.5)", "pm25", c2),
        lineSet("Coarse particles (PM10)", "pm10", c3),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        referenceLines: {
          lines: [
            { value: s.limits.no2.uk, label: `UK legal limit — NO₂ & PM10 (${s.limits.no2.uk})`, color: t.inkMuted, dash: [5, 4] },
            { value: s.limits.pm25.uk, label: `UK limit — PM2.5 (${s.limits.pm25.uk})`, color: c2, dash: [5, 4] },
            { value: s.limits.pm10.who, label: `WHO — PM10 (${s.limits.pm10.who})`, color: c3, dash: [2, 3] },
            { value: s.limits.no2.who, label: `WHO — NO₂ (${s.limits.no2.who})`, color: c1, dash: [2, 3] },
            { value: s.limits.pm25.who, label: `WHO — PM2.5 (${s.limits.pm25.who})`, color: c2, dash: [2, 3], labelBelow: true },
          ],
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              const y = s.years[items[0].dataIndex];
              return `${y.year}${y.provisional ? " (provisional)" : ""}`;
            },
            label: (c) => `${c.dataset.label}: ${fmt1.format(c.parsed.y)} µg/m³`,
          },
        },
      },
      scales: {
        x: axes.x(),
        y: axes.y({
          suggestedMax: s.limits.no2.uk + 5,
          title: { display: true, text: "µg/m³, annual average" },
        }),
      },
    },
  });
}

function renderRhythm(s) {
  const [c1] = series(1);
  const hours = s.rhythm.no2ByHour;
  const windowLabel = describeWindow(s.rhythm.years);
  if (windowLabel) {
    document.getElementById("rhythm-caption").textContent =
      document.getElementById("rhythm-caption").textContent.replace("recent years", windowLabel);
  }
  new Chart(document.getElementById("rhythm-chart"), {
    type: "line",
    data: {
      // hour-ending 1–24 → the hour that STARTS at h-1:00.
      labels: hours.map((h) => `${String(h.hour - 1).padStart(2, "0")}:00`),
      datasets: [
        {
          data: hours.map((h) => h.mean),
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
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const h = hours[items[0].dataIndex].hour;
              return `${String(h - 1).padStart(2, "0")}:00–${String(h).padStart(2, "0")}:00 GMT`;
            },
            label: (c) => `NO₂: ${fmt1.format(c.parsed.y)} µg/m³ on average`,
          },
        },
      },
      scales: {
        x: axes.x({ ticks: { maxTicksLimit: 9 } }),
        y: axes.y({ title: { display: true, text: "µg/m³" } }),
      },
    },
  });
}

function renderSeasonal(s) {
  const [c1, c2, c3, c4] = series(4);
  const months = s.seasonal.monthly;
  const windowLabel = describeWindow(s.seasonal.years);
  if (windowLabel) {
    const cap = document.getElementById("seasonal-caption");
    cap.textContent = cap.textContent.replace(
      "by month of the year.",
      `by month of the year, averaged over ${windowLabel}.`
    );
  }
  const set = (label, key, colour) => ({
    label,
    data: months.map((m) => m[key]),
    borderColor: colour,
    pointBackgroundColor: colour,
    tension: 0.3,
    spanGaps: true,
  });
  new Chart(document.getElementById("seasonal-chart"), {
    type: "line",
    data: {
      labels: months.map((m) => MONTH_NAMES[m.month - 1]),
      datasets: [
        set("NO₂", "no2", c1),
        set("PM2.5", "pm25", c2),
        set("PM10", "pm10", c3),
        set("Ozone (O₃)", "o3", c4),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${fmt1.format(c.parsed.y)} µg/m³`,
          },
        },
      },
      scales: {
        x: axes.x(),
        y: axes.y({ title: { display: true, text: "µg/m³, monthly average" } }),
      },
    },
  });
}

function renderDays(s) {
  const t = tokens();
  const [c1] = series(1);
  // Years where PM10 ran well enough for the day-count to be comparable.
  const ys = s.years.filter((y) => y.exceedances.pm10Days !== null);
  new Chart(document.getElementById("days-chart"), {
    type: "bar",
    plugins: [referenceLines],
    data: {
      labels: ys.map((y) => y.year),
      datasets: [{ data: ys.map((y) => y.exceedances.pm10Days), backgroundColor: c1 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        referenceLines: {
          lines: [
            {
              value: s.limits.pm10Daily.allowedDays,
              label: `Allowed: up to ${s.limits.pm10Daily.allowedDays} days a year`,
              color: t.inkMuted,
              dash: [5, 4],
            },
          ],
        },
        tooltip: {
          callbacks: {
            title: (items) => String(ys[items[0].dataIndex].year),
            label: (c) =>
              `${c.parsed.y} day${c.parsed.y === 1 ? "" : "s"} averaging over ${s.limits.pm10Daily.limit} µg/m³ PM10`,
          },
        },
      },
      scales: {
        x: axes.x(),
        y: axes.y({
          suggestedMax: s.limits.pm10Daily.allowedDays + 5,
          title: { display: true, text: "Days per year" },
        }),
      },
    },
  });
}

// [2023, 2024, 2025] → "2023–2025"; [2024] → "2024"; [] → null.
function describeWindow(years) {
  if (!years || !years.length) return null;
  return years.length === 1 ? String(years[0]) : `${years[0]}–${years[years.length - 1]}`;
}
