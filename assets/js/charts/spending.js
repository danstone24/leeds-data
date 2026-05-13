// Spending page chart logic.
// Drill levels:
//   L1 By department  →  L2 Divisions  →  L3 Purposes  →  L4 Transactions table
// L4 is only available when a single month is selected.

import {
  getSpendingPeriods,
  getSpendingSummary,
  getSpendingTrend,
  getSpendingTransactions,
} from "../api.js";

const fmtCurrency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const fmtCurrencyM = (n) => {
  const millions = n / 1_000_000;
  if (Math.abs(millions) >= 10) return `£${millions.toFixed(0)}m`;
  if (Math.abs(millions) >= 1) return `£${millions.toFixed(1)}m`;
  return `£${(n / 1000).toFixed(0)}k`;
};
const fmtNumber = new Intl.NumberFormat("en-GB");
const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;

const palette = () => {
  const css = getComputedStyle(document.documentElement);
  return [1, 2, 3, 4, 5, 6].map((i) => css.getPropertyValue(`--chart-${i}`).trim());
};
const textColor = () => getComputedStyle(document.documentElement).getPropertyValue("--color-text").trim();
const mutedColor = () => getComputedStyle(document.documentElement).getPropertyValue("--color-text-muted").trim();
const gridColor = () => getComputedStyle(document.documentElement).getPropertyValue("--color-border").trim();

// Module state -------------------------------------------------------------

let deptChart = null;
let suppliersChart = null;
let trendChart = null;
let currentSummary = null;
let periodCatalogue = null; // full /api/spending/periods response, used to expand year-period → months for L4

// Bootstrap ----------------------------------------------------------------

bootstrap();

async function bootstrap() {
  try {
    const [catalogue, trend] = await Promise.all([
      getSpendingPeriods(),
      getSpendingTrend(),
    ]);
    periodCatalogue = catalogue;
    populatePeriodPicker(catalogue);
    renderTrend(trend.months);
    const initialId =
      catalogue.periods[0]?.id || catalogue.months[0]?.id;
    if (initialId) await loadPeriod(initialId);
  } catch (err) {
    console.error(err);
    showError(err);
  }
}

// Custom period picker — category tabs + chips for the items in the selected category.

const TAB_DEFS = [
  { kind: "ytd",   label: "Year to date" },
  { kind: "fy",    label: "Tax year" },
  { kind: "cy",    label: "Calendar year" },
  { kind: "month", label: "Month" },
];

function populatePeriodPicker(cat) {
  const tabsEl = document.getElementById("period-tabs");
  const chipsEl = document.getElementById("period-chips");
  tabsEl.innerHTML = "";
  chipsEl.innerHTML = "";

  const itemsByKind = {
    ytd: cat.periods.filter((p) => p.kind === "ytd").map((p) => ({ id: p.id, label: stripTaxYearMonths(p.label) })),
    fy:  cat.periods.filter((p) => p.kind === "fy").map((p) => ({ id: p.id, label: shortTaxYearLabel(p) })),
    cy:  cat.periods.filter((p) => p.kind === "cy").map((p) => ({ id: p.id, label: p.label.replace(/^Calendar year /, "") })),
    month: cat.months.map((m) => ({ id: m.id, label: m.label })),
  };

  // Tabs (only show non-empty kinds)
  const visibleKinds = TAB_DEFS.filter((d) => itemsByKind[d.kind].length);
  for (const def of visibleKinds) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "period-tab";
    btn.textContent = def.label;
    btn.dataset.kind = def.kind;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.addEventListener("click", () => selectKind(def.kind, /* loadFirst */ true));
    tabsEl.appendChild(btn);
  }

  // Initial state: pick whichever kind contains the first available period.
  const initialKind = visibleKinds[0]?.kind || "month";
  selectKind(initialKind, /* loadFirst */ false);
  const initialId = itemsByKind[initialKind][0]?.id;
  if (initialId) {
    markSelectedChip(initialId);
  }

  function selectKind(kind, loadFirst) {
    for (const t of tabsEl.querySelectorAll(".period-tab")) {
      t.setAttribute("aria-selected", t.dataset.kind === kind ? "true" : "false");
    }
    renderChips(kind);
    if (loadFirst) {
      const first = itemsByKind[kind][0];
      if (first) {
        markSelectedChip(first.id);
        loadPeriod(first.id);
      }
    }
  }

  function renderChips(kind) {
    chipsEl.innerHTML = "";
    chipsEl.classList.toggle("scrollable", kind === "month");
    for (const item of itemsByKind[kind]) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "period-chip";
      chip.textContent = item.label;
      chip.dataset.periodId = item.id;
      chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", () => {
        markSelectedChip(item.id);
        loadPeriod(item.id);
      });
      chipsEl.appendChild(chip);
    }
  }

  function markSelectedChip(periodId) {
    for (const c of chipsEl.querySelectorAll(".period-chip")) {
      c.setAttribute("aria-pressed", c.dataset.periodId === periodId ? "true" : "false");
    }
    const sel = chipsEl.querySelector('.period-chip[aria-pressed="true"]');
    sel?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "instant" });
  }
}

// "Year to date — 2026" → "2026"
function stripTaxYearMonths(label) {
  return label.replace(/^Year to date — /, "");
}
// Period entry from /api/spending/periods → short chip label, e.g. "2025–26"
function shortTaxYearLabel(p) {
  // p.id is like "fy:2025"; we want "2025–26"
  const m = p.id.match(/^fy:(\d{4})$/);
  if (!m) return p.label;
  const start = m[1];
  const end = String(Number(start) + 1).slice(2);
  return `${start}–${end}`;
}

async function loadPeriod(periodId) {
  closeTransactions();
  const summary = await getSpendingSummary(periodId);
  currentSummary = summary;
  renderHero(summary);
  renderStats(summary);
  renderDepartments(summary);
  renderSuppliers(summary);
  renderCapRev(summary);
  renderLargest(summary);
  renderSource(summary);
}

// Rendering ----------------------------------------------------------------

function renderHero(s) {
  const topUnit = s.byOrganisationalUnit[0];
  const topShare = topUnit ? fmtPct(topUnit.share) : "—";
  const periodWord = s.periodKind === "month" ? "spent" : "spent across this period";
  document.getElementById("summary-line").textContent =
    `In ${s.label}, Leeds City Council ${periodWord} ${fmtCurrency.format(s.totalAmount)} ` +
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
  closeTransactions();
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
  closeTransactions();
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
  closeTransactions();
  document.getElementById("dept-chart-title").textContent = `${unit.name} › ${division.name}`;
  const purposeCount = (division.purposes || []).length;
  document.getElementById("dept-chart-caption").textContent =
    purposeCount
      ? `${fmtCurrency.format(division.amount)} across ${purposeCount} purpose${purposeCount === 1 ? "" : "s"}. Click a slice to see individual transactions.`
      : `${fmtCurrency.format(division.amount)}. No purpose breakdown available.`;
  setBack(`Back to ${unit.name}`, () => showDivisionDrilldown(s, unit));
  if (!purposeCount) {
    deptChart?.destroy();
    return;
  }
  renderDonut(
    { labels: division.purposes.map((p) => p.name), values: division.purposes.map((p) => p.amount) },
    (i) => showTransactions(s, unit, division, division.purposes[i]),
  );
}

async function showTransactions(s, unit, division, purpose) {
  const title = `${unit.name} › ${division.name} › ${purpose.name}`;

  // "Other purposes (N)" is a roll-up — there's no single transaction list for it.
  if (/^Other purposes \(/.test(purpose.name)) {
    openTransactionsPanel({
      title,
      caption: "This bucket aggregates the long tail of small purposes — there's no single transaction list for it.",
      rows: [],
    });
    return;
  }

  // Decide which months to query. For monthly views: just that month.
  // For year/YTD views: every month in the period (look up from the catalogue).
  let months = [s.periodId];
  let multiMonth = false;
  if (s.periodKind !== "month") {
    const entry = periodCatalogue?.periods.find((p) => p.id === s.periodId);
    if (entry?.months?.length) {
      months = entry.months;
      multiMonth = true;
    }
  }

  openTransactionsPanel({
    title,
    caption: multiMonth
      ? `Loading transactions across ${months.length} months…`
      : "Loading transactions…",
    rows: [],
  });

  try {
    const results = await Promise.all(
      months.map((m) =>
        getSpendingTransactions(m, unit.name, division.name, purpose.name).catch(() => ({ transactions: [] })),
      ),
    );
    let all = [];
    for (const r of results) {
      for (const t of r.transactions || []) all.push(t);
    }
    // Sort by absolute amount descending so the largest payments come first.
    all.sort((a, b) => Math.abs(b.a) - Math.abs(a.a));
    const DISPLAY_LIMIT = 200;
    const truncated = all.length > DISPLAY_LIMIT;
    if (truncated) all = all.slice(0, DISPLAY_LIMIT);

    let caption;
    if (!all.length) {
      caption = "No matching transactions in the source CSV.";
    } else if (multiMonth) {
      const cap = 100; // per-month cap inside each KV blob
      caption = `${all.length} transactions${truncated ? ` (showing top ${DISPLAY_LIMIT} of more)` : ""}, ${fmtCurrency.format(purpose.amount)} total across ${months.length} months. Each month contributes up to ${cap} of its largest transactions.`;
    } else {
      const cap = s.transactionsCapPerLeaf || 100;
      caption = `${all.length} transactions${all.length >= cap ? ` (top ${cap} by amount; tail truncated)` : ""}, ${fmtCurrency.format(purpose.amount)} total.`;
    }

    openTransactionsPanel({ title, caption, rows: all });
  } catch (err) {
    console.error(err);
    openTransactionsPanel({ title, caption: `Failed to load transactions: ${err.message}`, rows: [] });
  }
}

function openTransactionsPanel({ title, caption, rows }) {
  const panel = document.getElementById("txn-panel");
  document.getElementById("txn-title").textContent = title;
  document.getElementById("txn-caption").textContent = caption;
  const tbody = document.querySelector("#txn-table tbody");
  tbody.innerHTML = "";
  for (const t of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${t.d ? formatDate(t.d) : "—"}</td>
      <td>${escapeHtml(t.s)}</td>
      <td class="num">${fmtCurrency.format(t.a)}</td>
    `;
    tbody.appendChild(tr);
  }
  panel.hidden = false;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  document.getElementById("txn-close").onclick = closeTransactions;
}

function closeTransactions() {
  const panel = document.getElementById("txn-panel");
  if (panel) panel.hidden = true;
}

function renderSuppliers(s) {
  const labels = s.topSuppliers.map((sup) => sup.name);
  const data = s.topSuppliers.map((sup) => sup.amount);

  suppliersChart?.destroy();
  suppliersChart = new Chart(document.getElementById("suppliers-chart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{ data, backgroundColor: palette()[0], borderRadius: 4 }],
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
        x: { ticks: { color: mutedColor(), callback: (v) => fmtCurrencyM(v) }, grid: { color: gridColor() } },
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
        y: { ticks: { color: mutedColor(), callback: (v) => fmtCurrencyM(v) }, grid: { color: gridColor() } },
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

// Helpers ------------------------------------------------------------------

function cycle(arr, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[i % arr.length]);
  return out;
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
