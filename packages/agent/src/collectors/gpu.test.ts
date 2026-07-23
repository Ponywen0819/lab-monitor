import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { collectGpuInfo } from "./gpu.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

describe("collectGpuInfo", () => {
  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("parses a single GPU line into a GpuInfo", () => {
    vi.mocked(execFileSync).mockReturnValue(
      "NVIDIA GeForce RTX 3090, 45, 12, 1024, 24576\n",
    );

    const result = collectGpuInfo();

    expect(result).toEqual([
      { name: "NVIDIA GeForce RTX 3090", tempC: 45, utilizationPct: 12, memUsedMB: 1024, memTotalMB: 24576 },
    ]);
    expect(execFileSync).toHaveBeenCalledWith(
      "nvidia-smi",
      [
        "--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total",
        "--format=csv,noheader,nounits",
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
  });

  it("parses multiple GPU lines into a GpuInfo array", () => {
    vi.mocked(execFileSync).mockReturnValue(
      ["NVIDIA A100, 60, 80, 40000, 81920", "NVIDIA A100, 55, 30, 10000, 81920", ""].join("\n"),
    );

    const result = collectGpuInfo();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: "NVIDIA A100",
      tempC: 60,
      utilizationPct: 80,
      memUsedMB: 40000,
      memTotalMB: 81920,
    });
    expect(result[1]).toEqual({
      name: "NVIDIA A100",
      tempC: 55,
      utilizationPct: 30,
      memUsedMB: 10000,
      memTotalMB: 81920,
    });
  });

  it("parses [Not Supported] fields as null", () => {
    vi.mocked(execFileSync).mockReturnValue("NVIDIA Old GPU, [Not Supported], 5, 100, 4096\n");

    const result = collectGpuInfo();

    expect(result).toEqual([
      { name: "NVIDIA Old GPU", tempC: null, utilizationPct: 5, memUsedMB: 100, memTotalMB: 4096 },
    ]);
  });

  it("propagates the error when nvidia-smi is not found", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("spawnSync nvidia-smi ENOENT: Executable not found in $PATH");
    });

    expect(() => collectGpuInfo()).toThrow("Executable not found in $PATH");
  });
});
