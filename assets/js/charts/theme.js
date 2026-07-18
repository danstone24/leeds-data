// Shared chart theme — the single place Chart.js meets the design system.
// Every colour is read from CSS custom properties in style.css, so the
// palette stays validated (see docs) and light/dark swap automatically.
//
// Usage in a chart module:
//   import { applyChartTheme, tokens, series, ordinal, axes } from "./theme.js";
//   applyChartTheme();
//   const t = tokens();

const css = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function tokens() {
  return {
    surface: css("--chart-surface"),
    grid: css("--chart-grid"),
    axis: css("--chart-axis"),
    ink: css("--ink"),
    inkSecondary: css("--ink-secondary"),
    inkMuted: css("--ink-muted"),
    accent: css("--accent"),
    paper: css("--paper"),
    paperTint: css("--paper-tint"),
    rule: css("--rule"),
    statusCritical: css("--status-critical"),
    statusGood: css("--status-good"),
    seriesOther: css("--series-other"),
  };
}

// Categorical slots — fixed order, assigned in sequence, never cycled.
// Ask for n and you get the first n slots; past 8, callers must fold to
// "Other" (seriesOther) rather than invent colours.
export function series(n = 8) {
  const out = [];
  for (let i = 1; i <= Math.min(n, 8); i++) out.push(css(`--series-${i}`));
  return out;
}

// Ordered buckets (severity, duration bands): one hue, stepped lightness.
export function ordinal(hue, n) {
  const max = hue === "red" ? 3 : 6;
  const steps = [];
  for (let i = 1; i <= max; i++) steps.push(css(`--ord-${hue}-${i}`));
  if (n >= max) return steps;
  // Spread n picks across the ramp so the ends stay anchored.
  const picked = [];
  for (let i = 0; i < n; i++) {
    picked.push(steps[Math.round((i * (max - 1)) / Math.max(n - 1, 1))]);
  }
  return picked;
}

// Series hue at ~10% opacity — the only legal area fill.
export function wash(hex, alpha = 0.1) {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Global Chart.js defaults: Plex for all chart text, hairline solid grid,
// paper-toned tooltips, point-style legends. Call once per page before
// constructing charts.
export function applyChartTheme() {
  const t = tokens();
  const C = window.Chart;
  if (!C) return;

  C.defaults.font.family =
    '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif';
  C.defaults.font.size = 12;
  C.defaults.color = t.inkMuted;

  // Print doesn't animate, and neither do we — data appears settled, like a
  // typeset figure (also moot under prefers-reduced-motion).
  C.defaults.animation = false;

  // Marks
  C.defaults.elements.line.borderWidth = 2;
  C.defaults.elements.line.borderJoinStyle = "round";
  C.defaults.elements.line.borderCapStyle = "round";
  C.defaults.elements.point.radius = 4; // ≥8px marker
  C.defaults.elements.point.hoverRadius = 5;
  C.defaults.elements.point.borderWidth = 2; // surface ring
  C.defaults.elements.point.borderColor = t.surface;
  C.defaults.elements.point.hitRadius = 12; // generous hover target
  C.defaults.elements.bar.borderRadius = 3; // rounded data-end
  C.defaults.elements.bar.borderSkipped = "start"; // square at the baseline
  C.defaults.datasets.bar.maxBarThickness = 24;

  // Legend — present for ≥2 series (single-series charts pass display:false)
  C.defaults.plugins.legend.position = "top";
  C.defaults.plugins.legend.align = "start";
  C.defaults.plugins.legend.labels.usePointStyle = true;
  C.defaults.plugins.legend.labels.pointStyle = "circle";
  C.defaults.plugins.legend.labels.boxWidth = 7;
  C.defaults.plugins.legend.labels.boxHeight = 7;
  C.defaults.plugins.legend.labels.color = t.inkSecondary;
  C.defaults.plugins.legend.labels.padding = 16;

  // Tooltip — a printed annotation, not a glassy overlay
  const tt = C.defaults.plugins.tooltip;
  tt.backgroundColor = t.paper;
  tt.titleColor = t.ink;
  tt.bodyColor = t.inkSecondary;
  tt.footerColor = t.inkMuted;
  tt.borderColor = t.axis;
  tt.borderWidth = 1;
  tt.cornerRadius = 2;
  tt.padding = 10;
  tt.titleFont = { weight: 600 };
  tt.boxWidth = 7;
  tt.boxHeight = 7;
  tt.usePointStyle = true;
  tt.caretSize = 5;

  // Colours are read once at construction — a mid-session scheme flip would
  // strand every chart half-themed, so re-render the page instead.
  if (!window.__ldSchemeWatch) {
    window.__ldSchemeWatch = true;
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => location.reload());
  }
}

// Scale factories — hairline solid grid, no vertical gridlines, muted ticks.
// Overrides deep-merge one level down (ticks/grid/border), so passing a custom
// tick callback doesn't silently drop the shared defaults.
function mergeScale(base, overrides) {
  const out = { ...base, ...overrides };
  for (const key of ["ticks", "grid", "border", "title"]) {
    if (base[key] && overrides[key]) out[key] = { ...base[key], ...overrides[key] };
  }
  return out;
}

export const axes = {
  x(overrides = {}) {
    const t = tokens();
    return mergeScale(
      {
        grid: { display: false },
        border: { color: t.axis, width: 1 },
        ticks: { color: t.inkMuted, maxRotation: 0, autoSkip: true },
      },
      overrides,
    );
  },
  y(overrides = {}) {
    const t = tokens();
    return mergeScale(
      {
        beginAtZero: true,
        grid: { color: t.grid, drawTicks: false },
        border: { display: false },
        ticks: { color: t.inkMuted, padding: 8, maxTicksLimit: 6 },
      },
      overrides,
    );
  },
};
