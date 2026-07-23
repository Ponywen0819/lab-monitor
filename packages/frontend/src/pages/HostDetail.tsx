import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DiskPartition, MetricSnapshot } from "@labmon/shared";
import { fetchHostMetrics } from "../api/client";
import { useHosts } from "../ws/WsProvider";

interface ChartPoint {
  timestamp: number;
  cpuUsagePct: number | null;
  memUsedMB: number | null;
  memTotalMB: number | null;
  diskUsedPct: number | null;
  gpuTempC: number | null;
  gpuUtilPct: number | null;
  gpuMemUsedPct: number | null;
}

function aggregateDiskUsagePct(disks: DiskPartition[] | null): number | null {
  if (!disks || disks.length === 0) return null;
  const totalBytes = disks.reduce((sum, d) => sum + d.totalBytes, 0);
  const usedBytes = disks.reduce((sum, d) => sum + d.usedBytes, 0);
  if (totalBytes === 0) return null;
  return (usedBytes / totalBytes) * 100;
}

// Only the first reported GPU is charted -- multi-GPU trend comparison is out
// of scope for this pass, per-partition disk detail has the same tradeoff.
function toChartPoints(snapshots: MetricSnapshot[]): ChartPoint[] {
  return [...snapshots]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((s) => {
      const gpu = s.metrics.gpus?.[0] ?? null;
      const gpuMemUsedPct =
        gpu && gpu.memTotalMB && gpu.memUsedMB !== null ? (gpu.memUsedMB / gpu.memTotalMB) * 100 : null;
      return {
        timestamp: s.timestamp,
        cpuUsagePct: s.metrics.cpuUsagePct,
        memUsedMB: s.metrics.memUsedMB,
        memTotalMB: s.metrics.memTotalMB,
        diskUsedPct: aggregateDiskUsagePct(s.metrics.disks),
        gpuTempC: gpu?.tempC ?? null,
        gpuUtilPct: gpu?.utilizationPct ?? null,
        gpuMemUsedPct,
      };
    });
}

function hasAny(points: ChartPoint[], ...keys: (keyof ChartPoint)[]): boolean {
  return points.some((p) => keys.some((k) => p[k] !== null));
}

// Total MB isn't drawn as its own line anymore, but it still defines the
// chart's ceiling (rounded up to a whole MB) so the axis reads as installed
// capacity rather than just auto-scaling to whatever's been used so far.
function memYMax(points: ChartPoint[]): number | "dataMax" {
  const totals = points.map((p) => p.memTotalMB).filter((v): v is number => v !== null);
  return totals.length > 0 ? Math.ceil(Math.max(...totals)) : "dataMax";
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function TimeSeriesChart({
  data,
  lines,
  yUnit,
  yDomain,
  yAllowDecimals,
  valueFormatter,
}: {
  data: ChartPoint[];
  lines: { key: keyof ChartPoint; label: string; color: string }[];
  yUnit?: string;
  yDomain?: [number | string, number | string];
  yAllowDecimals?: boolean;
  valueFormatter?: (value: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="timestamp"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickFormatter={formatTime}
          minTickGap={40}
        />
        <YAxis unit={yUnit} domain={yDomain} allowDecimals={yAllowDecimals} />
        <Tooltip
          labelFormatter={(t) => new Date(t as number).toLocaleString()}
          formatter={
            valueFormatter
              ? (value: unknown) => (typeof value === "number" ? valueFormatter(value) : String(value))
              : undefined
          }
        />
        <Legend />
        {lines.map((line) => (
          <Line
            key={String(line.key)}
            type="monotone"
            dataKey={line.key}
            name={line.label}
            stroke={line.color}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function HostDetail() {
  const { id } = useParams<{ id: string }>();
  const { hosts } = useHosts();
  const host = id ? hosts.get(id) : undefined;

  const [snapshots, setSnapshots] = useState<MetricSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id || host?.type === "nas") return;
    let cancelled = false;
    setSnapshots(null);
    setError(null);
    fetchHostMetrics(id)
      .then((data) => {
        if (!cancelled) setSnapshots(data);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
    // host?.type (not the whole host object) avoids re-fetching on every WS metrics push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, host?.type]);

  if (!id) return <p>No host id in URL.</p>;

  return (
    <div>
      <p>
        <Link to="/">&larr; back to dashboard</Link>
      </p>
      <h2>{host?.name ?? id}</h2>

      {!host && <p className="empty-state">Loading host…</p>}

      {host?.type === "nas" && <p className="empty-state">No metrics available for NAS hosts.</p>}

      {host?.type === "agent" && (
        <>
          {error && <p className="error-text">Failed to load metrics: {error}</p>}
          {!error && !snapshots && <p className="empty-state">Loading metrics…</p>}
          {!error && snapshots && snapshots.length === 0 && (
            <p className="empty-state">No metrics recorded in the last 24h.</p>
          )}
          {!error && snapshots && snapshots.length > 0 && (
            <ChartSet data={toChartPoints(snapshots)} />
          )}
        </>
      )}
    </div>
  );
}

function ChartSet({ data }: { data: ChartPoint[] }) {
  const showCpu = hasAny(data, "cpuUsagePct");
  const showMem = hasAny(data, "memUsedMB", "memTotalMB");
  const showDisk = hasAny(data, "diskUsedPct");
  const showGpu = hasAny(data, "gpuTempC", "gpuUtilPct", "gpuMemUsedPct");

  return (
    <div className="chart-grid">
      {showCpu && (
        <section className="chart-card">
          <h3>CPU usage (%)</h3>
          <TimeSeriesChart
            data={data}
            lines={[{ key: "cpuUsagePct", label: "CPU %", color: "#2563eb" }]}
            yDomain={[0, 100]}
            valueFormatter={(v) => v.toFixed(2)}
          />
        </section>
      )}

      {showMem && (
        <section className="chart-card">
          <h3>Memory used (MB)</h3>
          <TimeSeriesChart
            data={data}
            lines={[{ key: "memUsedMB", label: "Used MB", color: "#7c3aed" }]}
            yDomain={[0, memYMax(data)]}
            yAllowDecimals={false}
          />
        </section>
      )}

      {showDisk && (
        <section className="chart-card">
          <h3>Disk usage (%, aggregate across partitions)</h3>
          <TimeSeriesChart
            data={data}
            lines={[{ key: "diskUsedPct", label: "Disk %", color: "#d97706" }]}
            yDomain={[0, 100]}
            valueFormatter={(v) => v.toFixed(2)}
          />
        </section>
      )}

      {showGpu && (
        <section className="chart-card">
          <h3>GPU (first device)</h3>
          <TimeSeriesChart
            data={data}
            lines={[
              { key: "gpuUtilPct", label: "Util %", color: "#059669" },
              { key: "gpuTempC", label: "Temp °C", color: "#dc2626" },
              { key: "gpuMemUsedPct", label: "Mem %", color: "#7c3aed" },
            ]}
          />
        </section>
      )}

      {!showCpu && !showMem && !showDisk && !showGpu && (
        <p className="empty-state">No metric values present in the last 24h.</p>
      )}
    </div>
  );
}
