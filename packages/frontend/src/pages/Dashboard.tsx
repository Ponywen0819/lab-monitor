import { useNavigate } from "react-router-dom";
import type { DiskPartition, GpuInfo, HostSnapshot, HostStatus } from "@labmon/shared";
import { useHosts } from "../ws/WsProvider";

const STATUS_LABEL: Record<HostStatus, string> = {
  online: "Online",
  disconnected: "Disconnected",
  offline: "Offline",
  notified: "Notified",
};

// green=online, yellow=offline (mid-severity, notification pending),
// red=notified (owner already alerted), gray=disconnected (transient grace period).
const STATUS_CLASS: Record<HostStatus, string> = {
  online: "status-online",
  offline: "status-offline",
  notified: "status-notified",
  disconnected: "status-disconnected",
};

function aggregateDiskUsagePct(disks: DiskPartition[] | null): number | null {
  if (!disks || disks.length === 0) return null;
  const totalBytes = disks.reduce((sum, d) => sum + d.totalBytes, 0);
  const usedBytes = disks.reduce((sum, d) => sum + d.usedBytes, 0);
  if (totalBytes === 0) return null;
  return (usedBytes / totalBytes) * 100;
}

function formatPct(pct: number | null): string {
  return pct === null ? "—" : `${pct.toFixed(0)}%`;
}

function formatMB(mb: number | null): string {
  if (mb === null) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function pctBarClass(pct: number | null): string {
  if (pct === null) return "bar-fill";
  if (pct >= 90) return "bar-fill bar-danger";
  if (pct >= 70) return "bar-fill bar-warn";
  return "bar-fill bar-ok";
}

function MetricBar({ label, pct, detail }: { label: string; pct: number | null; detail: string }) {
  return (
    <div className="metric-row">
      <div className="metric-row-header">
        <span>{label}</span>
        <span>{detail}</span>
      </div>
      <div className="bar-track">
        <div className={pctBarClass(pct)} style={{ width: `${pct ?? 0}%` }} />
      </div>
    </div>
  );
}

function GpuSummary({ gpus }: { gpus: GpuInfo[] }) {
  return (
    <div className="gpu-summary">
      {gpus.map((gpu, i) => (
        <div key={`${gpu.name}-${i}`} className="metric-row">
          <div className="metric-row-header">
            <span>{gpu.name}</span>
            <span>
              {gpu.utilizationPct === null ? "—" : `${gpu.utilizationPct.toFixed(0)}%`}
              {gpu.tempC !== null ? ` · ${gpu.tempC.toFixed(0)}°C` : ""}
            </span>
          </div>
          <div className="bar-track">
            <div className={pctBarClass(gpu.utilizationPct)} style={{ width: `${gpu.utilizationPct ?? 0}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function HostCard({ host }: { host: HostSnapshot }) {
  const navigate = useNavigate();
  const metrics = host.latestMetrics;

  return (
    <button className="host-card" onClick={() => navigate(`/hosts/${encodeURIComponent(host.id)}`)}>
      <div className="host-card-header">
        <span className={`status-dot ${STATUS_CLASS[host.status]}`} aria-hidden="true" />
        <span className="host-name">{host.name}</span>
        <span className="host-type">{host.type}</span>
      </div>
      <div className="host-status-label">{STATUS_LABEL[host.status]}</div>

      {host.type === "agent" && metrics && (
        <div className="host-metrics">
          <MetricBar label="CPU" pct={metrics.cpuUsagePct} detail={formatPct(metrics.cpuUsagePct)} />
          <MetricBar
            label="Memory"
            pct={
              metrics.memTotalMB && metrics.memUsedMB !== null
                ? (metrics.memUsedMB / metrics.memTotalMB) * 100
                : null
            }
            detail={`${formatMB(metrics.memUsedMB)} / ${formatMB(metrics.memTotalMB)}`}
          />
          <MetricBar
            label="Disk"
            pct={aggregateDiskUsagePct(metrics.disks)}
            detail={formatPct(aggregateDiskUsagePct(metrics.disks))}
          />
          {metrics.gpus && metrics.gpus.length > 0 && <GpuSummary gpus={metrics.gpus} />}
        </div>
      )}
    </button>
  );
}

export function Dashboard() {
  const { hosts, connected } = useHosts();
  const sortedHosts = [...hosts.values()].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <div className="page-header">
        <h2>Hosts</h2>
        <span className={connected ? "ws-status ws-connected" : "ws-status ws-disconnected"}>
          {connected ? "live" : "reconnecting…"}
        </span>
      </div>

      {sortedHosts.length === 0 ? (
        <p className="empty-state">No hosts reported yet.</p>
      ) : (
        <div className="host-grid">
          {sortedHosts.map((host) => (
            <HostCard key={host.id} host={host} />
          ))}
        </div>
      )}
    </div>
  );
}
