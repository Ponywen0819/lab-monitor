import { afterEach, describe, expect, it, vi } from "vitest";

function statLine(fields: number[]): string {
  return `cpu  ${fields.join(" ")}\nintr 12345 0\n`;
}

async function freshCpuModule() {
  vi.resetModules();
  const readFileSyncMock = vi.fn<(...args: unknown[]) => string>();
  vi.doMock("node:fs", () => ({ readFileSync: readFileSyncMock }));
  const mod = await import("./cpu.js");
  return { collectCpuUsage: mod.collectCpuUsage, readFileSyncMock };
}

describe("collectCpuUsage", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
  });

  it("throws on the first call, having no baseline sample yet", async () => {
    const { collectCpuUsage, readFileSyncMock } = await freshCpuModule();
    readFileSyncMock.mockReturnValue(statLine([100, 0, 100, 800, 0, 0, 0, 0]));

    expect(() => collectCpuUsage()).toThrow(
      "no prior sample yet, one cycle needed to establish a baseline",
    );
    expect(readFileSyncMock).toHaveBeenCalledWith("/proc/stat", "utf8");
  });

  it("computes usage percent from the delta between two successive samples", async () => {
    const { collectCpuUsage, readFileSyncMock } = await freshCpuModule();

    readFileSyncMock.mockReturnValueOnce(statLine([100, 0, 100, 800, 0, 0, 0, 0]));
    expect(() => collectCpuUsage()).toThrow();

    readFileSyncMock.mockReturnValueOnce(statLine([200, 0, 200, 1600, 0, 0, 0, 0]));
    const usage = collectCpuUsage();

    expect(usage).toBeCloseTo(20, 10);
  });

  it("throws when the total delta is zero", async () => {
    const { collectCpuUsage, readFileSyncMock } = await freshCpuModule();
    const line = statLine([100, 0, 100, 800, 0, 0, 0, 0]);

    readFileSyncMock.mockReturnValueOnce(line);
    expect(() => collectCpuUsage()).toThrow();

    readFileSyncMock.mockReturnValueOnce(line);
    expect(() => collectCpuUsage()).toThrow("non-positive /proc/stat total delta");
  });

  it("throws when the total delta is negative (counters went backwards)", async () => {
    const { collectCpuUsage, readFileSyncMock } = await freshCpuModule();

    readFileSyncMock.mockReturnValueOnce(statLine([1000, 0, 0, 9000, 0, 0, 0, 0]));
    expect(() => collectCpuUsage()).toThrow();

    readFileSyncMock.mockReturnValueOnce(statLine([500, 0, 0, 4000, 0, 0, 0, 0]));
    expect(() => collectCpuUsage()).toThrow("non-positive /proc/stat total delta");
  });

  it("clamps usage to 100 when the raw formula would exceed it", async () => {
    const { collectCpuUsage, readFileSyncMock } = await freshCpuModule();

    readFileSyncMock.mockReturnValueOnce(statLine([0, 0, 0, 10000, 0, 0, 0, 0]));
    expect(() => collectCpuUsage()).toThrow();

    readFileSyncMock.mockReturnValueOnce(statLine([20000, 0, 0, 0, 0, 0, 0, 0]));
    const usage = collectCpuUsage();

    expect(usage).toBe(100);
  });

  it("clamps usage to 0 when the raw formula would go negative", async () => {
    const { collectCpuUsage, readFileSyncMock } = await freshCpuModule();

    readFileSyncMock.mockReturnValueOnce(statLine([500, 0, 0, 0, 0, 0, 0, 0]));
    expect(() => collectCpuUsage()).toThrow();

    readFileSyncMock.mockReturnValueOnce(statLine([100, 0, 0, 1000, 0, 0, 0, 0]));
    const usage = collectCpuUsage();

    expect(usage).toBe(0);
  });
});
