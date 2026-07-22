import { execFileSync } from "node:child_process";
import type { GpuInfo } from "@labmon/shared";

const QUERY_FIELDS = "name,temperature.gpu,utilization.gpu,memory.used,memory.total";

function parseNumeric(field: string): number | null {
  const trimmed = field.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "[not supported]") return null;
  const value = Number(trimmed);
  return Number.isNaN(value) ? null : value;
}

export function collectGpuInfo(): GpuInfo[] {
  const output = execFileSync(
    "nvidia-smi",
    [`--query-gpu=${QUERY_FIELDS}`, "--format=csv,noheader,nounits"],
    { encoding: "utf8", timeout: 5_000 },
  );

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, tempC, utilizationPct, memUsedMB, memTotalMB] = line.split(",");
      return {
        name: name.trim(),
        tempC: parseNumeric(tempC),
        utilizationPct: parseNumeric(utilizationPct),
        memUsedMB: parseNumeric(memUsedMB),
        memTotalMB: parseNumeric(memTotalMB),
      };
    });
}
