import { readFileSync } from "node:fs";

interface CpuTimes {
  idle: number;
  total: number;
}

function readCpuTimes(): CpuTimes {
  const line = readFileSync("/proc/stat", "utf8").split("\n")[0];
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = fields;
  const idleTotal = idle + (iowait ?? 0);
  const total = user + nice + system + idleTotal + irq + softirq + (steal ?? 0);
  return { idle: idleTotal, total };
}

// Sampled once per collection cycle and diffed against the previous cycle's
// snapshot (rather than sleeping ~1s inline) so collectCpuUsage never blocks
// the collection loop. First call after process start has no prior sample,
// so it returns null for that one cycle only.
let previous: CpuTimes | null = null;

export function collectCpuUsage(): number {
  const current = readCpuTimes();

  if (previous === null) {
    previous = current;
    throw new Error("no prior sample yet, one cycle needed to establish a baseline");
  }

  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;
  previous = current;

  if (totalDelta <= 0) {
    throw new Error("non-positive /proc/stat total delta");
  }

  const usagePct = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.max(0, Math.min(100, usagePct));
}
