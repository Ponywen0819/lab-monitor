export type HostType = "agent" | "nas";

/**
 * Mirrors the offline-detection state machine (blueprint 1.4/3.3).
 * "disconnected" is the <30s grace period and is never persisted as a
 * status_event row — it only exists transiently in the collector's memory.
 */
export type HostStatus = "online" | "disconnected" | "offline" | "notified";

export interface Host {
  id: string;
  name: string;
  type: HostType;
}

export interface HostSnapshot extends Host {
  status: HostStatus;
  lastSeenAt: number | null;
  offlineSinceAt: number | null;
  latestMetrics: import("./metrics.js").HostMetrics | null;
}
