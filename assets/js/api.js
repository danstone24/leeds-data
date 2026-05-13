// Thin wrapper around our Worker at /api/*.
// Frontend code should NEVER call Datamillnorth directly — always go through here
// so caching, CORS, and rate limits stay in one place.

const API_BASE = "/api";

async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`API ${path} returned ${res.status}`);
  }
  return res.json();
}

export function pingApi() {
  return getJson("/health");
}

export function getDataset(name) {
  return getJson(`/dataset/${encodeURIComponent(name)}`);
}
