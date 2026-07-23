import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { DiskPartition, GpuInfo, Host, HostMetrics, MetricSnapshot, StatusEvent } from "@labmon/shared";
import { SCHEMA_SQL } from "./schema.js";

interface MetricSnapshotRow {
  host_id: string;
  timestamp: number;
  cpu_usage: number | null;
  mem_usage: number | null;
  mem_total: number | null;
  disk_info: string | null;
  gpu_info: string | null;
}

function rowToMetricSnapshot(row: MetricSnapshotRow): MetricSnapshot {
  return {
    hostId: row.host_id,
    timestamp: row.timestamp,
    metrics: {
      cpuUsagePct: row.cpu_usage,
      memUsedMB: row.mem_usage,
      memTotalMB: row.mem_total,
      disks: row.disk_info ? (JSON.parse(row.disk_info) as DiskPartition[]) : null,
      gpus: row.gpu_info ? (JSON.parse(row.gpu_info) as GpuInfo[]) : null,
      // The metric_snapshot schema has no column for per-field collection
      // errors (see blueprint schema) -- they are reported live over WS but
      // not persisted, so replayed history always reports a clean read here.
      errors: {},
    },
  };
}

export class Storage {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
  }

  upsertHost(host: Host): void {
    this.db
      .prepare(
        `INSERT INTO host (id, name, type) VALUES (@id, @name, @type)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type`
      )
      .run(host);
  }

  getHost(id: string): Host | undefined {
    return this.db.prepare(`SELECT id, name, type FROM host WHERE id = ?`).get(id) as Host | undefined;
  }

  listHosts(): Host[] {
    return this.db.prepare(`SELECT id, name, type FROM host`).all() as Host[];
  }

  // No ON DELETE CASCADE on the schema's REFERENCES host(id), so metric_snapshot
  // and status_event rows are cleared explicitly; wrapped in a transaction so a
  // crash mid-delete can't leave orphaned metric/status rows behind.
  deleteHost(id: string): void {
    const runDelete = this.db.transaction((hostId: string) => {
      this.db.prepare(`DELETE FROM metric_snapshot WHERE host_id = ?`).run(hostId);
      this.db.prepare(`DELETE FROM status_event WHERE host_id = ?`).run(hostId);
      this.db.prepare(`DELETE FROM host WHERE id = ?`).run(hostId);
    });
    runDelete(id);
  }

  insertMetricSnapshot(snapshot: MetricSnapshot): void {
    const m: HostMetrics = snapshot.metrics;
    this.db
      .prepare(
        `INSERT INTO metric_snapshot (host_id, timestamp, cpu_usage, mem_usage, mem_total, disk_info, gpu_info)
         VALUES (@hostId, @timestamp, @cpuUsage, @memUsage, @memTotal, @diskInfo, @gpuInfo)`
      )
      .run({
        hostId: snapshot.hostId,
        timestamp: snapshot.timestamp,
        cpuUsage: m.cpuUsagePct,
        memUsage: m.memUsedMB,
        memTotal: m.memTotalMB,
        diskInfo: m.disks ? JSON.stringify(m.disks) : null,
        gpuInfo: m.gpus ? JSON.stringify(m.gpus) : null,
      });
  }

  getRecentMetrics(hostId: string, sinceTimestamp: number): MetricSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT host_id, timestamp, cpu_usage, mem_usage, mem_total, disk_info, gpu_info
         FROM metric_snapshot WHERE host_id = ? AND timestamp >= ? ORDER BY timestamp ASC`
      )
      .all(hostId, sinceTimestamp) as MetricSnapshotRow[];
    return rows.map(rowToMetricSnapshot);
  }

  getLatestMetricSnapshot(hostId: string): MetricSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT host_id, timestamp, cpu_usage, mem_usage, mem_total, disk_info, gpu_info
         FROM metric_snapshot WHERE host_id = ? ORDER BY timestamp DESC LIMIT 1`
      )
      .get(hostId) as MetricSnapshotRow | undefined;
    return row ? rowToMetricSnapshot(row) : null;
  }

  insertStatusEvent(event: StatusEvent): void {
    this.db
      .prepare(`INSERT INTO status_event (host_id, status, timestamp) VALUES (@hostId, @status, @timestamp)`)
      .run(event);
  }

  getSystemConfig(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM system_config WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSystemConfig(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO system_config (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run({ key, value });
  }

  // status_event is intentionally never pruned here (permanent offline
  // history per the blueprint) -- only metric_snapshot is high-volume enough
  // to need a rolling retention window.
  deleteMetricsOlderThan(timestamp: number): void {
    this.db.prepare(`DELETE FROM metric_snapshot WHERE timestamp < ?`).run(timestamp);
  }

  close(): void {
    this.db.close();
  }
}

export function createStorage(dbPath: string): Storage {
  return new Storage(dbPath);
}
