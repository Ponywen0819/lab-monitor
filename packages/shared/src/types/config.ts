export interface SystemConfig {
  notifyEmail: string | null;
}

export interface StatusEvent {
  hostId: string;
  status: "online" | "offline" | "notified";
  timestamp: number;
}
