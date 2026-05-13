// Thin client for the DataPress API used by Datamillnorth.org.
// Docs: https://datapress.com/docs/api

const BASE = "https://datamillnorth.org/api/v3";

function authHeaders(env) {
  const headers = { accept: "application/json" };
  if (env.DATAMILLNORTH_TOKEN) {
    headers.authorization = `Bearer ${env.DATAMILLNORTH_TOKEN}`;
  }
  return headers;
}

export async function getDataset(env, id) {
  const res = await fetch(`${BASE}/dataset/${id}`, { headers: authHeaders(env) });
  if (!res.ok) throw new Error(`Datamillnorth ${res.status} fetching dataset ${id}`);
  return res.json();
}

// List CSV resources from a dataset, newest-first by timeframe.to.
// Each entry: { id, title, url, size, timeframeTo (YYYY-MM or null), hash }
export function listCsvResources(dataset) {
  const out = [];
  for (const [id, r] of Object.entries(dataset.resources || {})) {
    if ((r.format || "").toLowerCase() !== "csv") continue;
    out.push({
      id,
      title: r.title || "",
      url: r.url,
      size: r.size || 0,
      timeframeTo: r.timeframe?.to || null,
      hash: r.hash || null,
    });
  }
  out.sort((a, b) => (b.timeframeTo || "").localeCompare(a.timeframeTo || ""));
  return out;
}

// Stream a CSV download. Returns a ReadableStream of Uint8Array chunks.
export async function streamCsv(env, url) {
  const res = await fetch(url, {
    headers: { ...authHeaders(env), accept: "text/csv" },
  });
  if (!res.ok || !res.body) throw new Error(`CSV fetch ${res.status} ${url}`);
  return res.body;
}
