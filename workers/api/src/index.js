// Leeds Data API Worker
//
// Pure read-only KV reader. All data aggregation happens in
// scripts/refresh.mjs, run nightly by the GitHub Actions workflow at
// .github/workflows/refresh-data.yml. The Worker just serves what's in KV.
//
// Routes (all under /api/* once mapped to leedsdata.co.uk):
//   GET /api/health                         → liveness + last-refresh time
//   GET /api/spending/summary               → latest month summary
//   GET /api/spending/summary/<yyyy-mm>     → historical month summary
//   GET /api/spending/trend                 → rolling 24-month totals
//   GET /api/spending/months                → list of months with summaries
//
// Bindings (wrangler.toml):
//   CACHE — Workers KV namespace where the refresh script writes summaries.

import { handleSummary, handleTrend, handleAvailableMonths } from "./spending.js";

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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";

    if (path === "/health") return handleHealth(env);

    if (path === "/spending/summary") {
      const data = await handleSummary(env, null);
      return data ? json(data) : json({ error: "No spending data yet" }, { status: 503 });
    }

    const summaryMatch = path.match(/^\/spending\/summary\/([0-9]{4}-[0-9]{2})$/);
    if (summaryMatch) {
      const data = await handleSummary(env, summaryMatch[1]);
      return data ? json(data) : json({ error: "Month not available" }, { status: 404 });
    }

    if (path === "/spending/trend") {
      const data = await handleTrend(env);
      return data ? json(data) : json({ error: "No trend data yet" }, { status: 503 });
    }

    if (path === "/spending/months") {
      const data = await handleAvailableMonths(env);
      return data ? json(data) : json({ error: "No data yet" }, { status: 503 });
    }

    return json({ error: "Not found" }, { status: 404 });
  },
};
