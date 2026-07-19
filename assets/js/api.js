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

export function getPotholesSummary() {
  return getJson("/api/potholes/summary");
}

export function getPotholesPoints() {
  return getJson("/api/potholes/points");
}

export function getCollisionsSummary() {
  return getJson("/api/collisions/summary");
}

export function getCountsSummary(kind) {
  return getJson(`/api/counts/${kind}/summary`);
}

export function getFootfallSummary() {
  return getJson("/api/footfall/summary");
}

export function getCouncilTaxSummary() {
  return getJson("/api/counciltax/summary");
}

export function getHousingSummary() {
  return getJson("/api/housing/summary");
}

export function getSchoolsSummary() {
  return getJson("/api/schools/summary");
}

export function getWasteSummary() {
  return getJson("/api/waste/summary");
}

export function getAirSummary() {
  return getJson("/api/air/summary");
}

export function getPlanningSummary() {
  return getJson("/api/planning/summary");
}

export function getPlanningApps() {
  return getJson("/api/planning/apps");
}
