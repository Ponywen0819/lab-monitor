/** Shared timing constants for the offline-detection state machine (blueprint 1.4/3.3). */
export const DISCONNECTED_GRACE_MS = 30_000;
export const OFFLINE_TO_NOTIFIED_MS = 5 * 60_000;

export const NAS_PING_INTERVAL_MS = 30_000;
export const AGENT_REPORT_INTERVAL_MS = 10_000;

export const METRIC_RETENTION_MS = 24 * 60 * 60_000;
export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000;
