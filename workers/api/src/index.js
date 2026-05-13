// Leeds Data API Worker
//
// Routes (all under /api/* once mapped to the Pages domain):
//   GET /api/health                 → liveness + last-cache-refresh
//   GET /api/dataset/<name>         → cached Datamillnorth data, normalised
//
// Datamillnorth (CKAN) base: https://datamillnorth.org/api/3/action/
//
// New datasets: add an entry to DATASETS below. The Worker handles fetch + cache.
// Heavy normalisation (e.g. column renames) should live in a per-dataset module
// once we have more than a couple — for now, inline transforms are fine.

const CKAN_BASE = "https://datamillnorth.org/api/3/action";

// Registry of datasets the site exposes. Keep keys URL-safe.
// `resourceId` is the CKAN datastore resource id (find via package_show).
const DATASETS = {
  // example: "potholes": { resourceId: "abc-123", label: "Pothole reports", ttlSeconds: 3600 },
};

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
      "cache-control": "public, max-age=60",
      ...CORS_HEADERS,
      ...(init.headers || {}),
    },
  });
}

async function handleHealth(env) {
  const lastRefresh = await env.CACHE?.get("meta:last-refresh");
  return json({
    ok: true,
    service: "leeds-data-api",
    updated: lastRefresh || new Date(0).toISOString(),
  });
}

async function handleDataset(env, name) {
  const config = DATASETS[name];
  if (!config) {
    return json({ error: `Unknown dataset: ${name}` }, { status: 404 });
  }

  const cacheKey = `dataset:${name}`;
  const cached = await env.CACHE?.get(cacheKey, { type: "json" });
  if (cached) return json(cached);

  const fresh = await fetchDataset(config);
  if (env.CACHE) {
    await env.CACHE.put(cacheKey, JSON.stringify(fresh), {
      expirationTtl: config.ttlSeconds ?? 3600,
    });
  }
  return json(fresh);
}

async function fetchDataset(config) {
  const url =
    `${CKAN_BASE}/datastore_search?` +
    new URLSearchParams({ resource_id: config.resourceId, limit: "10000" });
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`CKAN ${res.status}`);
  const body = await res.json();
  if (!body.success) throw new Error("CKAN reported failure");

  return {
    data: body.result.records,
    updated: new Date().toISOString(),
    source: url,
  };
}

async function refreshAll(env) {
  for (const [name, config] of Object.entries(DATASETS)) {
    try {
      const fresh = await fetchDataset(config);
      await env.CACHE.put(`dataset:${name}`, JSON.stringify(fresh), {
        expirationTtl: (config.ttlSeconds ?? 3600) * 2,
      });
    } catch (err) {
      console.error(`refresh ${name} failed`, err);
    }
  }
  await env.CACHE.put("meta:last-refresh", new Date().toISOString());
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "");

    if (path === "/health" || path === "/health/") {
      return handleHealth(env);
    }

    const datasetMatch = path.match(/^\/dataset\/([^/]+)\/?$/);
    if (datasetMatch) {
      return handleDataset(env, datasetMatch[1]);
    }

    return json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshAll(env));
  },
};
