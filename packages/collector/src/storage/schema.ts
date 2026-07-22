export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS host (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('agent', 'nas'))
);

CREATE TABLE IF NOT EXISTS metric_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id TEXT NOT NULL REFERENCES host(id),
  timestamp INTEGER NOT NULL,
  cpu_usage REAL,
  mem_usage REAL,
  mem_total REAL,
  disk_info TEXT,
  gpu_info TEXT
);
CREATE INDEX IF NOT EXISTS idx_metric_snapshot_host_timestamp ON metric_snapshot(host_id, timestamp);

-- Never pruned by the retention sweep: this is the permanent offline-history
-- record the blueprint calls for, unlike metric_snapshot which is high-volume
-- telemetry that only needs a rolling window.
CREATE TABLE IF NOT EXISTS status_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id TEXT NOT NULL REFERENCES host(id),
  status TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_event_host_timestamp ON status_event(host_id, timestamp);

CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
