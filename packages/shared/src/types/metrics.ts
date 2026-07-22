export interface DiskPartition {
  mount: string;
  totalBytes: number;
  usedBytes: number;
}

export interface GpuInfo {
  name: string;
  tempC: number | null;
  utilizationPct: number | null;
  memUsedMB: number | null;
  memTotalMB: number | null;
}

/** Which top-level metric group failed to collect, and why. See blueprint 2.5. */
export type MetricField = "cpu" | "mem" | "disk" | "gpu";

export interface HostMetrics {
  cpuUsagePct: number | null;
  memUsedMB: number | null;
  memTotalMB: number | null;
  disks: DiskPartition[] | null;
  gpus: GpuInfo[] | null;
  errors: Partial<Record<MetricField, string>>;
}

export interface MetricSnapshot {
  hostId: string;
  timestamp: number;
  metrics: HostMetrics;
}
