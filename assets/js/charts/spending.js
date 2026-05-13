// Spending page — fetches the precomputed summary blobs from /api/spending/*
// and renders the four chart sections and the largest-transactions table.

import { getJson } from "../api.js";

const fmtCurrency = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});
const fmtCurrencyM = (n) => {
  const millions = n / 1_000_000;
  if (Math.abs(millions) >= 10) return `£${millions.toFixed(0)}m`;
  if (Math.abs(millions) >= 1) return `£${millions.toFixed(1)}m`;
  const k = n / 1000;
  return `£${k.toFixed(0)}k`;
};
const fmtNumber = new Intl.NumberFormat("en-GB");
const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;

const palette = () => {
  const css = getComputedStyle(document.documentElement);
  return [
    css.getPropertyValue("--chart-1").trim(),
    css.getPropertyValue("--chart-2").trim(),
    css.getPropertyValue("--chart-3").trim(),
    css.getPropertyValue("--chart-4").trim(),
    css.getPropertyValue("--chart-5").trim(),
    css.getPropertyValue("--chart-6").trim(),
  ];
};
const textColor = () => getComputedStyle(document.documentElement).getPropertyValue("--color-text").trim();
const mutedColor = () => getComputedStyle(document.documentElement).getPropertyValue("--color-text-muted").trim();
const gridColor = () => getComputedStyle(document.documentElement).getPropertyValue("--color-border").trim();

// State -----------------------------------------------------------------

let deptChart = null;
let suppliersChart = null;
let trendChart = null;
let currentSummary = null;

// Bootstrap -------------------------------------------------------------

bootstrap();

async function bootstrap() {
  try {
    const [months, trend] = await Promise.all([
      getJson("/api/spending/months"),
      getJson("/api/spending/trend"),
    ]);
    populateMonthPicker(months.months);
    renderTrend(trend.months);
    await loadMonth(months.months[0]);
  } catch (err) {
    console.error(err);
    showError(err);
  }
}

function populateMonthPicker(months) {
  const select = document.getElementById("month-select");
  select.innerHTML = "";
  for (const m of months) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = formatMonthLabel(m);
    select.appendChild(opt);
  }
  select.addEventListener("change", () => loadMonth(select.value));
}

async function loadMonth(month) {
  const summary = await getJson(`/api/spending/summary/${month}`);
  currentSummary = summary;
  renderHero(summary);
  renderStats(summary);
  renderDepartments(summary);
  renderSuppliers(summary);
  renderCapRev(summary);
  renderLargest(summary);
  renderSource(summary);
}

// Rendering --------------------------------------------------------------

function renderHero(s) {
  const topUnit = s.byOrganisationalUnit[0];
  const topShare = topUnit ? fmtPct(topUnit.share) : "—";
  document.getElementById("summary-line").textContent =
    `In ${s.monthLabel}, Leeds City Council spent ${fmtCurrency.format(s.totalAmount)} ` +
    `across ${fmtNumber.format(s.transactionCount)} transactions. ` +
    `${topUnit?.name ?? "—"} was the biggest department, accounting for ${topShare} of all spend.`;
}

function renderStats(s) {
  document.getElementById("stat-total").textContent = fmtCurrencyM(s.totalAmount);
  document.getElementById("stat-txns").textContent = fmtNumber.format(s.transactionCount);
  document.getElementById("stat-avg").textContent = fmtCurrency.format(s.averageTransaction);
  document.getElementById("stat-pcard").textContent = fmtPct(s.procurementCardShare);
}

function renderDepartments(s) {
  showDeptOverview(s);
}

// Render a donut at any level (departments / divisions / purposes).
function renderDonut({ labels, values }, onClick) {
  deptChart?.destroy();
  deptChart = new Chart(document.getElementById("dept-chart"), {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: cycle(palette(), labels.length),
        borderColor: getComputedStyle(document.documentElement).getPropertyValue("--color-bg-elevated").trim(),
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "55%",
      plugins: {
        legend: { position: "right", labels: { color: textColor() } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtCurrency.format(ctx.parsed)}` } },
      },
      onClick: onClick ? (_evt, els) => { if (els.length) onClick(els[0].index); } : undefined,
    },
  });
}

function setBack(label, handler) {
  const btn = document.getElementById("dept-back");
  if (!handler) {
    btn.hidden = true;
    btn.onclick = null;
  } else {
    btn.hidden = false;
    btn.textContent = `← ${label}`;
    btn.onclick = handler;
  }
}

function showDeptOverview(s) {
  document.getElementById("dept-chart-title").textContent = "By department";
  document.getElementById("dept-chart-caption").textContent =
    "Click a slice to see the divisions inside that department.";
  setBack(null);
  renderDonut(
    { labels: s.byOrganisationalUnit.map((u) => u.name), values: s.byOrganisationalUnit.map((u) => u.amount) },
    (i) => showDivisionDrilldown(s, s.byOrganisationalUnit[i]),
  );
}

function showDivisionDrilldown(s, unit) {
  document.getElementById("dept-chart-title").textContent = unit.name;
  document.getElementById("dept-chart-caption").textContent =
    `${fmtCurrency.format(unit.amount)} across ${unit.divisions.length} divisions. Click a slice to see what the money was spent on.`;
  setBack("Back to all departments", () => showDeptOverview(s));
  renderDonut(
    { labels: unit.divisions.map((d) => d.name), values: unit.divisions.map((d) => d.amount) },
    (i) => showPurposeDrilldown(s, unit, unit.divisions[i]),
  );
}

function showPurposeDrilldown(s, unit, division) {
  document.getElementById("dept-chart-title").textContent = `${unit.name} › ${division.name}`;
  const purposeCount = (division.purposes || []).length;
  document.getElementById("dept-chart-caption").textContent =
    purposeCount
      ? `${fmtCurrency.format(division.amount)} across ${purposeCount} purpose${purposeCount === 1 ? "" : "s"}.`
      : `${fmtCurrency.format(division.amount)}. No purpose breakdown available.`;
  setBack(`Back to ${unit.name}`, () => showDivisionDrilldown(s, unit));
  if (!purposeCount) {
    deptChart?.destroy();
    return;
  }
  renderDonut({
    labels: division.purposes.map((p) => p.name),
    values: division.purposes.map((p) => p.amount),
  });
}

function renderSuppliers(s) {
  const labels = s.topSuppliers.map((sup) => sup.name);
  const data = s.topSuppliers.map((sup) => sup.amount);

  suppliersChart?.destroy();
  suppliersChart = new Chart(document.getElementById("suppliers-chart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: palette()[0],
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${fmtCurrency.format(ctx.parsed.x)} (${s.topSuppliers[ctx.dataIndex].count} payments)`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: mutedColor(), callback: (v) => fmtCurrencyM(v) },
          grid: { color: gridColor() },
        },
        y: { ticks: { color: textColor() }, grid: { display: false } },
      },
    },
  });
}

function renderTrend(months) {
  const labels = months.map((m) => formatMonthLabelShort(m.month));
  const data = months.map((m) => m.total);

  trendChart?.destroy();
  trendChart = new Chart(document.getElementById("trend-chart"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        data,
        borderColor: palette()[0],
        backgroundColor: palette()[0] + "22",
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => fmtCurrency.format(ctx.parsed.y) } },
      },
      scales: {
        x: { ticks: { color: mutedColor() }, grid: { display: false } },
        y: {
          ticks: { color: mutedColor(), callback: (v) => fmtCurrencyM(v) },
          grid: { color: gridColor() },
        },
      },
    },
  });
}

function renderCapRev(s) {
  const { capital, revenue } = s.capitalVsRevenue;
  const total = capital + revenue;
  const capPct = total ? capital / total : 0;
  const revPct = total ? revenue / total : 0;
  document.getElementById("cap-rev").innerHTML = `
    <div class="cap-rev-bar" aria-hidden="true">
      <span style="width: ${(revPct * 100).toFixed(1)}%; background: var(--chart-1);"></span>
      <span style="width: ${(capPct * 100).toFixed(1)}%; background: var(--chart-2);"></span>
    </div>
    <div class="cap-rev-legend">
      <div><span class="dot" style="background: var(--chart-1)"></span> Revenue <strong>${fmtCurrency.format(revenue)}</strong> <span class="muted">(${fmtPct(revPct)})</span></div>
      <div><span class="dot" style="background: var(--chart-2)"></span> Capital <strong>${fmtCurrency.format(capital)}</strong> <span class="muted">(${fmtPct(capPct)})</span></div>
    </div>
  `;
}

function renderLargest(s) {
  const tbody = document.querySelector("#largest-table tbody");
  tbody.innerHTML = "";
  for (const t of s.largestTransactions) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${t.date ? formatDate(t.date) : "—"}</td>
      <td>${escapeHtml(t.unit)}</td>
      <td>${escapeHtml(t.beneficiary)}</td>
      <td>${escapeHtml(t.purpose)}</td>
      <td class="num">${fmtCurrency.format(t.amount)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderSource(s) {
  document.getElementById("source-link").href = s.source;
  document.getElementById("source-updated").textContent = new Date(s.updated).toLocaleString("en-GB");
}

// Helpers ---------------------------------------------------------------

function cycle(arr, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[i % arr.length]);
  return out;
}

function formatMonthLabel(m) {
  const [y, mo] = m.split("-");
  const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${names[Number(mo) - 1]} ${y}`;
}

function formatMonthLabelShort(m) {
  const [y, mo] = m.split("-");
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${names[Number(mo) - 1]} ${y.slice(2)}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showError(err) {
  const line = document.getElementById("summary-line");
  line.innerHTML = `Couldn't load the spending data. The API may not have been deployed yet, or a refresh hasn't run. <br/><small>${escapeHtml(err.message)}</small>`;
}
