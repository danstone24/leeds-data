// Leeds Data API Worker
//
// Read-only KV server. Aggregation runs in GitHub Actions (see
// .github/workflows/refresh-data.yml). The Worker exposes /api/* under
// leedsdata.co.uk.
//
// Routes:
//   GET /api/health
//   GET /api/spending/periods
//   GET /api/spending/summary
//   GET /api/spending/summary/<period-id>
//        period-id = yyyy-mm | fy:YYYY | cy:YYYY | ytd:YYYY
//   GET /api/spending/trend
//   GET /api/spending/months
//   GET /api/spending/transactions/<yyyy-mm>?unit=…&division=…&purpose=…
//   GET /api/potholes/summary
//   GET /api/potholes/points
//   GET /api/collisions/summary
//   GET /api/counts/<cycle|traffic>/summary
//   GET /api/footfall/summary

import {
  handleSummary,
  handleTrend,
  handlePeriods,
  handleTransactions,
} from "./spending.js";
import { handlePotholesSummary, handlePotholesPoints } from "./potholes.js";
import { handleCollisionsSummary } from "./collisions.js";
import { handleCountsSummary } from "./counts.js";
import { handleFootfallSummary } from "./footfall.js";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      ...CORS_HEADERS,
      ...(init.headers || {}),
    },
  });
}

async function handleHealth(env) {
  const lastRefresh = await env.CACHE?.get("meta:last-refresh");
  const latestSpending = await env.CACHE?.get("spending:latest");
  return json({
    ok: true,
    service: "leeds-data-api",
    updated: lastRefresh || new Date(0).toISOString(),
    spending: { latestMonth: latestSpending || null },
  });
}

const PERIOD_ID_RE = /^(\d{4}-\d{2}|fy:\d{4}|cy:\d{4}|ytd:\d{4})$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";

    if (path === "/health") return handleHealth(env);

    if (path === "/spending/periods") {
      const data = await handlePeriods(env);
      return data ? json(data) : json({ error: "No period data yet" }, { status: 503 });
    }

    if (path === "/spending/summary") {
      const data = await handleSummary(env, null);
      return data ? json(data) : json({ error: "No spending data yet" }, { status: 503 });
    }

    const summaryMatch = path.match(/^\/spending\/summary\/(.+)$/);
    if (summaryMatch) {
      const periodId = decodeURIComponent(summaryMatch[1]);
      if (!PERIOD_ID_RE.test(periodId)) {
        return json({ error: "Invalid period id" }, { status: 400 });
      }
      const data = await handleSummary(env, periodId);
      return data ? json(data) : json({ error: "Period not available" }, { status: 404 });
    }

    if (path === "/spending/trend") {
      const data = await env.CACHE.get("spending:trend", { type: "json" });
      return data ? json(data) : json({ error: "No trend data yet" }, { status: 503 });
    }

    // Legacy endpoint — list of months, kept so older frontend builds still work.
    if (path === "/spending/months") {
      const cat = await handlePeriods(env);
      if (!cat) return json({ error: "No data yet" }, { status: 503 });
      return json({ months: cat.months.map((m) => m.id) });
    }

    if (path === "/potholes/summary") {
      const data = await handlePotholesSummary(env);
      return data ? json(data) : json({ error: "No pothole data yet" }, { status: 503 });
    }

    if (path === "/potholes/points") {
      const data = await handlePotholesPoints(env);
      // Map points are heavier and change at most quarterly — cache hard.
      return data
        ? json({ points: data }, { headers: { "cache-control": "public, max-age=3600" } })
        : json({ error: "No pothole map data yet" }, { status: 503 });
    }

    if (path === "/collisions/summary") {
      const data = await handleCollisionsSummary(env);
      return data ? json(data) : json({ error: "No collision data yet" }, { status: 503 });
    }

    const countsMatch = path.match(/^\/counts\/(cycle|traffic)\/summary$/);
    if (countsMatch) {
      const data = await handleCountsSummary(env, countsMatch[1]);
      return data ? json(data) : json({ error: "No count data yet" }, { status: 503 });
    }

    if (path === "/footfall/summary") {
      const data = await handleFootfallSummary(env);
      return data ? json(data) : json({ error: "No footfall data yet" }, { status: 503 });
    }

    const txnMatch = path.match(/^\/spending\/transactions\/(\d{4}-\d{2})$/);
    if (txnMatch) {
      const month = txnMatch[1];
      const unit = url.searchParams.get("unit");
      const division = url.searchParams.get("division");
      const purpose = url.searchParams.get("purpose");
      if (!unit || !division || !purpose) {
        return json({ error: "Required query params: unit, division, purpose" }, { status: 400 });
      }
      const data = await handleTransactions(env, month, unit, division, purpose);
      return data ? json(data) : json({ error: "Transactions not available for this month" }, { status: 404 });
    }

    return json({ error: "Not found" }, { status: 404 });
  },
};
