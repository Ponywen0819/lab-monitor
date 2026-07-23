import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { collectMemoryUsage } from "./memory.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

describe("collectMemoryUsage", () => {
  afterEach(() => {
    vi.mocked(readFileSync).mockReset();
  });

  it("uses MemTotal - MemAvailable when MemAvailable is present", () => {
    vi.mocked(readFileSync).mockReturnValue(
      [
        "MemTotal:       16345678 kB",
        "MemFree:         1234567 kB",
        "MemAvailable:    8000000 kB",
        "Buffers:          200000 kB",
        "Cached:          3000000 kB",
        "SwapTotal:       2000000 kB",
        "SwapFree:        2000000 kB",
        "",
      ].join("\n"),
    );

    const result = collectMemoryUsage();

    expect(result.memTotalMB).toBeCloseTo(16345678 / 1024, 10);
    expect(result.memUsedMB).toBeCloseTo((16345678 - 8000000) / 1024, 10);
    expect(readFileSync).toHaveBeenCalledWith("/proc/meminfo", "utf8");
  });

  it("falls back to MemTotal - MemFree - Buffers - Cached when MemAvailable is absent", () => {
    vi.mocked(readFileSync).mockReturnValue(
      [
        "MemTotal:       16345678 kB",
        "MemFree:         1234567 kB",
        "Buffers:          200000 kB",
        "Cached:          3000000 kB",
        "",
      ].join("\n"),
    );

    const result = collectMemoryUsage();
    const expectedUsedKB = 16345678 - 1234567 - 200000 - 3000000;

    expect(result.memTotalMB).toBeCloseTo(16345678 / 1024, 10);
    expect(result.memUsedMB).toBeCloseTo(expectedUsedKB / 1024, 10);
  });

  it("treats missing MemFree/Buffers/Cached as zero in the fallback formula", () => {
    vi.mocked(readFileSync).mockReturnValue(["MemTotal:       1000000 kB", ""].join("\n"));

    const result = collectMemoryUsage();

    expect(result.memTotalMB).toBeCloseTo(1000000 / 1024, 10);
    expect(result.memUsedMB).toBeCloseTo(1000000 / 1024, 10);
  });

  it("throws a clear error when MemTotal is missing", () => {
    vi.mocked(readFileSync).mockReturnValue(["MemFree:  100 kB", ""].join("\n"));

    expect(() => collectMemoryUsage()).toThrow("MemTotal missing from /proc/meminfo");
  });
});
