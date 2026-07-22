import { readFileSync } from "node:fs";

export interface MemoryUsage {
  memTotalMB: number;
  memUsedMB: number;
}

function parseMeminfo(raw: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (match) values.set(match[1], Number(match[2]));
  }
  return values;
}

export function collectMemoryUsage(): MemoryUsage {
  const values = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));

  const totalKB = values.get("MemTotal");
  if (totalKB === undefined) throw new Error("MemTotal missing from /proc/meminfo");

  const availableKB = values.get("MemAvailable");
  let usedKB: number;
  if (availableKB !== undefined) {
    usedKB = totalKB - availableKB;
  } else {
    const freeKB = values.get("MemFree") ?? 0;
    const buffersKB = values.get("Buffers") ?? 0;
    const cachedKB = values.get("Cached") ?? 0;
    usedKB = totalKB - freeKB - buffersKB - cachedKB;
  }

  return {
    memTotalMB: totalKB / 1024,
    memUsedMB: usedKB / 1024,
  };
}
