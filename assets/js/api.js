// Thin wrapper around our Worker at /api/*.
// Frontend code should NEVER call Datamillnorth directly — always go through here
// so caching, CORS, and rate limits stay in one place.

export async function getJson(path) {
  const res = await fetch(path.startsWith("http") ? path : path, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
  return res.json();
}

export function pingApi() {
  return getJson("/api/health");
}

export function getSpendingSummary(month) {
  return getJson(month ? `/api/spending/summary/${month}` : "/api/spending/summary");
}

export function getSpendingTrend() {
  return getJson("/api/spending/trend");
}

export function getSpendingMonths() {
  return getJson("/api/spending/months");
}
