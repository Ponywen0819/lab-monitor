import type { HostMetrics } from "./metrics.js";
import type { HostSnapshot, HostStatus } from "./host.js";
import type { InstallProgressEvent } from "./install.js";

/** Agent -> Collector: pushed every collection cycle, doubles as a heartbeat. */
export interface AgentReportMessage {
  type: "agent_report";
  hostId: string;
  timestamp: number;
  metrics: HostMetrics;
}

/** Frontend -> Collector: opt in to the dashboard push channel. */
export interface DashboardSubscribeMessage {
  type: "dashboard_subscribe";
}

/** Collector -> Frontend: a host's metrics or status changed. */
export interface HostUpdateMessage {
  type: "host_update";
  host: HostSnapshot;
}

/** Collector -> Frontend: status-only transition (used heavily by NAS hosts). */
export interface HostStatusMessage {
  type: "host_status";
  hostId: string;
  status: HostStatus;
  timestamp: number;
}

/** Collector -> Frontend: progress push for an in-flight remote install. */
export interface InstallProgressMessage {
  type: "install_progress";
  event: InstallProgressEvent;
}

/** Collector -> Frontend: a host was deleted and should be dropped from the UI. */
export interface HostRemovedMessage {
  type: "host_removed";
  hostId: string;
}

export type AgentToCollectorMessage = AgentReportMessage;
export type FrontendToCollectorMessage = DashboardSubscribeMessage;
export type CollectorToFrontendMessage =
  | HostUpdateMessage
  | HostStatusMessage
  | InstallProgressMessage
  | HostRemovedMessage;

export type WsMessage =
  | AgentToCollectorMessage
  | FrontendToCollectorMessage
  | CollectorToFrontendMessage;
