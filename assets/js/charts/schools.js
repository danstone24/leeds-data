// School places page: first-choice demand by phase, the most competitive
// council-run primaries, and the growing spare-places gap. Chart.js is global.
//
// Per-school and fill charts are PRIMARY-ONLY by design: admission numbers
// are only published for community/voluntary-controlled schools, and nearly
// every Leeds secondary is an academy now (5 reporting schools — too few to
// chart honestly).

import { getSchoolsSummary } from "../api.js";
import { applyChartTheme, tokens, series, wash, axes } from "./theme.js";

const fmtNumber = new Intl.NumberFormat("en-GB");

applyChartTheme();
bootstrap();

async function bootstrap() {
  try {
    const s = await getSchoolsSummary();
    renderStats(s);
    renderDemand(s);
    renderCompetition(s.primary);
    renderFill(s.primary);
    renderSpare(s.primary);
  } catch (err) {
    console.error(err);
    document.getElementById("summary-line").textContent =
      "Sorry — the school places data couldn't be loaded right now. Please try again later.";
  }
}

const demandYears = (phase) => phase.yearly.filter((y) => y.firstPrefs !== undefined);
const allocYears = (phase) => phase.yearly.filter((y) => y.allocated !== undefined);

function renderStats(s) {
  const prim = demandYears(s.primary).at(-1);
  const sec = demandYears(s.secondary).at(-1);
  document.getElementById("prim-year").textContent = `for ${prim.year}`;
  document.getElementById("sec-year").textContent = `for ${sec.year}`;
  document.getElementById("stat-primary").textContent = fmtNumber.format(prim.firstPrefs);
  document.getElementById("stat-secondary").textContent = fmtNumber.format(sec.firstPrefs);

  const top = [...s.primary.competition, ...s.secondary.competition].sort(
    (a, b) => b.ratio - a.ratio
  )[0];
  document.getElementById("stat-competitive").textContent = top
    ? `${top.ratio}× oversubscribed`
    : "—";

  const latestAlloc = allocYears(s.primary).at(-1);
  document.getElementById("stat-spare").textContent = latestAlloc
    ? `${Math.round((latestAlloc.underSubscribed / latestAlloc.allocSchools) * 100)}%`
    : "—";

  const primFirst = demandYears(s.primary)[0];
  const dir = prim.firstPrefs < primFirst.firstPrefs ? "fallen" : "risen";
  document.getElementById("summary-line").innerHTML =
    `Families made <strong>${fmtNumber.format(prim.firstPrefs)}</strong> first-choice applications for primary ` +
    `places and <strong>${fmtNumber.format(sec.firstPrefs)}</strong> for secondary places for September ${prim.year}. ` +
    `Primary demand has ${dir} since ${primFirst.year} as the birth rate falls — while at council-run primaries, ` +
    `<strong>${latestAlloc ? Math.round((latestAlloc.underSubscribed / latestAlloc.allocSchools) * 100) : "—"}%</strong> ` +
    `of schools no longer fill their reception class.`;

  const updated = s.updated
    ? new Date(s.updated).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "—";
  document.getElementById("source-updated").textContent = updated;
}

function renderDemand(s) {
  const prim = demandYears(s.primary);
  const sec = demandYears(s.secondary);
  const years = [...new Set([...prim, ...sec].map((y) => y.year))].sort();
  const at = (ys, year) => ys.find((y) => y.year === year)?.firstPrefs ?? null;
  const [c1, c2] = series(2);
  new Chart(document.getElementById("demand-chart"), {
    type: "line",
    data: {
      labels: years,
      datasets: [
        {
          label: "Primary (reception)",
          data: years.map((y) => at(prim, y)),
          borderColor: c1,
          pointBackgroundColor: c1,
          tension: 0.3,
          spanGaps: true,
        },
        {
          label: "Secondary (year 7)",
          data: years.map((y) => at(sec, y)),
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
            title: (items) => `September ${items[0].label} entry`,
            label: (c) => `${c.dataset.label}: ${fmtNumber.format(c.parsed.y)} first choices`,
          },
        },
      },
      scales: { x: axes.x(), y: axes.y() },
    },
  });
}

function renderCompetition(primary) {
  const top = primary.competition.slice(0, 12);
  document.getElementById("competition-caption").textContent =
    `First-choice applications for every reception place at council-run primaries, September ` +
    `${primary.competitionYear} entry. Academies, free schools and most faith schools set their ` +
    `own admissions and don't publish these numbers, so they can't be ranked here.`;
  new Chart(document.getElementById("competition-chart"), {
    type: "bar",
    data: {
      labels: top.map((c) => shortName(c.name)),
      datasets: [{ data: top.map((c) => c.ratio), backgroundColor: series(1)[0], maxBarThickness: 16 }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => top[items[0].dataIndex].name,
            label: (c) => `${c.parsed.x} first choices per place`,
            afterLabel: (c) => {
              const t = top[c.dataIndex];
              return `${fmtNumber.format(t.first)} first choices for ${t.available} places`;
            },
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

function renderFill(primary) {
  const ys = allocYears(primary);
  const [c1, c2] = series(2);
  new Chart(document.getElementById("fill-chart"), {
    type: "line",
    data: {
      labels: ys.map((y) => y.year),
      datasets: [
        {
          label: "Places offered",
          data: ys.map((y) => y.available),
          borderColor: c1,
          pointBackgroundColor: c1,
          tension: 0.3,
        },
        {
          label: "Places filled",
          data: ys.map((y) => y.allocated),
          borderColor: c2,
          pointBackgroundColor: c2,
          backgroundColor: wash(c2),
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
        tooltip: {
          callbacks: {
            title: (items) => `September ${items[0].label} entry`,
            label: (c) => `${c.dataset.label}: ${fmtNumber.format(c.parsed.y)}`,
            footer: (items) => {
              const y = ys[items[0].dataIndex];
              return `${fmtNumber.format(y.available - y.allocated)} places unfilled across ${y.allocSchools} schools`;
            },
          },
        },
      },
      scales: { x: axes.x(), y: axes.y() },
    },
  });
}

function renderSpare(primary) {
  const ys = allocYears(primary);
  new Chart(document.getElementById("spare-chart"), {
    type: "bar",
    data: {
      labels: ys.map((y) => y.year),
      datasets: [
        {
          data: ys.map((y) => Math.round((y.underSubscribed / y.allocSchools) * 100)),
          backgroundColor: series(1)[0],
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
            title: (items) => `September ${items[0].label} entry`,
            label: (c) => `${c.parsed.y}% of council-run primaries had spare places`,
            afterLabel: (c) => {
              const y = ys[c.dataIndex];
              return `${y.underSubscribed} of ${y.allocSchools} schools`;
            },
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

// Long official names ("… Church of England Voluntary Controlled Primary
// School") crowd a bar axis — trim the boilerplate, keep the identity.
function shortName(name) {
  return name
    .replace(/\s*Church of England\s*/i, " CE ")
    .replace(/\s*Voluntary (Controlled|Aided)\s*/i, " ")
    .replace(/\s*Primary School\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
