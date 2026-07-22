import type { HostSnapshot, InstallRequest, MetricSnapshot, SystemConfig } from "@labmon/shared";

// Falls back to the collector's documented default port so `npm run dev`
// works out of the box without requiring a .env file.
const BASE_URL = import.meta.env.VITE_HTTP_BASE_URL ?? "http://localhost:8081";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function sendJson<T>(method: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const errMsg = detail && typeof detail === "object" && "error" in detail ? String(detail.error) : res.statusText;
    throw new Error(`${method} ${path} failed: ${res.status} ${errMsg}`);
  }
  return res.json() as Promise<T>;
}

export function fetchHosts(): Promise<HostSnapshot[]> {
  return getJson<HostSnapshot[]>("/api/hosts");
}

// Omitting sinceMs lets the collector apply its own default lookback
// (24h, see METRIC_RETENTION_MS) instead of duplicating that constant here.
export function fetchHostMetrics(hostId: string, sinceMs?: number): Promise<MetricSnapshot[]> {
  const query = sinceMs !== undefined ? `?sinceMs=${sinceMs}` : "";
  return getJson<MetricSnapshot[]>(`/api/hosts/${encodeURIComponent(hostId)}/metrics${query}`);
}

export function postInstall(request: InstallRequest): Promise<{ installId: string }> {
  return sendJson<{ installId: string }>("POST", "/api/install", request);
}

export function fetchConfig(): Promise<SystemConfig> {
  return getJson<SystemConfig>("/api/config");
}

export function updateConfig(notifyEmail: string): Promise<SystemConfig> {
  return sendJson<SystemConfig>("PUT", "/api/config", { notifyEmail });
}
