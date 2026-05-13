// Thin wrapper around our Worker at /api/*.
// Frontend code should NEVER call Datamillnorth directly — always go through here
// so caching, CORS, and rate limits stay in one place.

export async function getJson(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
  return res.json();
}

export function pingApi() {
  return getJson("/api/health");
}

export function getSpendingPeriods() {
  return getJson("/api/spending/periods");
}

export function getSpendingSummary(periodId) {
  return getJson(periodId ? `/api/spending/summary/${encodeURIComponent(periodId)}` : "/api/spending/summary");
}

export function getSpendingTrend() {
  return getJson("/api/spending/trend");
}

export function getSpendingTransactions(month, unit, division, purpose) {
  const qs = new URLSearchParams({ unit, division, purpose });
  return getJson(`/api/spending/transactions/${month}?${qs}`);
}
