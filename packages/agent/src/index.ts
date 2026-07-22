import { AGENT_REPORT_INTERVAL_MS } from "@labmon/shared";
import type { AgentReportMessage, HostMetrics, MetricField } from "@labmon/shared";
import { loadConfig } from "./config.js";
import { WsClient } from "./ws-client.js";
import { collectCpuUsage } from "./collectors/cpu.js";
import { collectMemoryUsage } from "./collectors/memory.js";
import { collectDiskUsage } from "./collectors/disk.js";
import { collectGpuInfo } from "./collectors/gpu.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

console.log(`[agent] starting, hostId=${config.hostId}, collector=${config.collectorWsUrl}`);

const wsClient = new WsClient(config.collectorWsUrl);
wsClient.start();

function collectMetrics(): HostMetrics {
  const errors: Partial<Record<MetricField, string>> = {};

  let cpuUsagePct: number | null = null;
  try {
    cpuUsagePct = collectCpuUsage();
  } catch (err) {
    errors.cpu = (err as Error).message;
  }

  let memUsedMB: number | null = null;
  let memTotalMB: number | null = null;
  try {
    const mem = collectMemoryUsage();
    memUsedMB = mem.memUsedMB;
    memTotalMB = mem.memTotalMB;
  } catch (err) {
    errors.mem = (err as Error).message;
  }

  let disks: HostMetrics["disks"] = null;
  try {
    disks = collectDiskUsage();
  } catch (err) {
    errors.disk = (err as Error).message;
  }

  let gpus: HostMetrics["gpus"] = null;
  try {
    gpus = collectGpuInfo();
  } catch (err) {
    errors.gpu = (err as Error).message;
  }

  return { cpuUsagePct, memUsedMB, memTotalMB, disks, gpus, errors };
}

function runCycle(): void {
  try {
    const metrics = collectMetrics();
    const message: AgentReportMessage = {
      type: "agent_report",
      hostId: config.hostId,
      timestamp: Date.now(),
      metrics,
    };
    wsClient.send(message);
    console.log(`[agent] cycle: ${JSON.stringify(metrics)}`);
  } catch (err) {
    // Belt-and-suspenders: individual collectors already catch their own
    // errors, this guards against anything unexpected (e.g. JSON.stringify
    // throwing) so one bad cycle never kills the process -- systemd
    // Restart=always is the crash-recovery layer, not this loop.
    console.error(`[agent] unexpected error in collection cycle: ${(err as Error).stack ?? err}`);
  }
}

runCycle();
setInterval(runCycle, AGENT_REPORT_INTERVAL_MS);
