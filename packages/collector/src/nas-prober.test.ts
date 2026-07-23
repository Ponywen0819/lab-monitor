import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { createNasProber, parseNasHostsConfig, type NasHostConfig } from "./nas-prober.js";
import { OfflineStateMachine } from "./state-machine.js";
import { Storage } from "./storage/db.js";

const spawnMock = vi.mocked(spawn);

type PingResult = "ok" | "fail" | "spawn-error";

function mockPingResults(results: Record<string, PingResult>): void {
  spawnMock.mockImplementation((_cmd, args) => {
    const ip = (args as string[])[(args as string[]).length - 1];
    const result = results[ip] ?? "ok";
    const proc = new EventEmitter();
    queueMicrotask(() => {
      if (result === "spawn-error") {
        proc.emit("error", new Error("spawn failed"));
      } else {
        proc.emit("close", result === "ok" ? 0 : 1);
      }
    });
    return proc as unknown as ReturnType<typeof spawn>;
  });
}

describe("parseNasHostsConfig", () => {
  it("returns an empty array for undefined", () => {
    expect(parseNasHostsConfig(undefined)).toEqual([]);
  });

  it("returns an empty array for an empty/whitespace string", () => {
    expect(parseNasHostsConfig("")).toEqual([]);
    expect(parseNasHostsConfig("   ")).toEqual([]);
  });

  it("parses a valid JSON array", () => {
    const raw = JSON.stringify([{ id: "nas-1", name: "Synology", ip: "10.0.0.5" }]);
    expect(parseNasHostsConfig(raw)).toEqual([{ id: "nas-1", name: "Synology", ip: "10.0.0.5" }]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseNasHostsConfig("{not json")).toThrow();
  });

  it("throws when the top level is not an array", () => {
    expect(() => parseNasHostsConfig(JSON.stringify({ id: "nas-1" }))).toThrow();
  });

  it("throws when an entry is not an object", () => {
    expect(() => parseNasHostsConfig(JSON.stringify(["nas-1"]))).toThrow();
  });

  it("throws when id is missing or wrong type", () => {
    expect(() => parseNasHostsConfig(JSON.stringify([{ name: "n", ip: "1.1.1.1" }]))).toThrow();
    expect(() => parseNasHostsConfig(JSON.stringify([{ id: 5, name: "n", ip: "1.1.1.1" }]))).toThrow();
  });

  it("throws when name is missing or wrong type", () => {
    expect(() => parseNasHostsConfig(JSON.stringify([{ id: "nas-1", ip: "1.1.1.1" }]))).toThrow();
    expect(() => parseNasHostsConfig(JSON.stringify([{ id: "nas-1", name: 5, ip: "1.1.1.1" }]))).toThrow();
  });

  it("throws when ip is missing or wrong type", () => {
    expect(() => parseNasHostsConfig(JSON.stringify([{ id: "nas-1", name: "n" }]))).toThrow();
    expect(() => parseNasHostsConfig(JSON.stringify([{ id: "nas-1", name: "n", ip: 5 }]))).toThrow();
  });
});

describe("createNasProber", () => {
  let dir: string;
  let storage: Storage;
  let stateMachine: OfflineStateMachine;
  const hosts: NasHostConfig[] = [
    { id: "nas-1", name: "NAS One", ip: "10.0.0.1" },
    { id: "nas-2", name: "NAS Two", ip: "10.0.0.2" },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    dir = mkdtempSync(join(tmpdir(), "labmon-nas-prober-"));
    storage = new Storage(join(dir, "test.db"));
    stateMachine = new OfflineStateMachine();
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("upserts all configured hosts into storage with type nas on start", async () => {
    mockPingResults({ "10.0.0.1": "ok", "10.0.0.2": "ok" });
    const prober = createNasProber({ hosts, stateMachine, storage, intervalMs: 30_000 });

    prober.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.getHost("nas-1")).toEqual({ id: "nas-1", name: "NAS One", type: "nas" });
    expect(storage.getHost("nas-2")).toEqual({ id: "nas-2", name: "NAS Two", type: "nas" });

    prober.stop();
  });

  it("signals the state machine up for a successful ping", async () => {
    mockPingResults({ "10.0.0.1": "ok", "10.0.0.2": "ok" });
    const prober = createNasProber({ hosts, stateMachine, storage, intervalMs: 30_000 });

    prober.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(stateMachine.getHostState("nas-1")?.status).toBe("online");
    expect(stateMachine.getHostState("nas-2")?.status).toBe("online");

    prober.stop();
  });

  it("signals the state machine down for a non-zero exit ping", async () => {
    mockPingResults({ "10.0.0.1": "fail", "10.0.0.2": "ok" });
    const prober = createNasProber({ hosts, stateMachine, storage, intervalMs: 30_000 });

    prober.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(stateMachine.getHostState("nas-1")?.status).toBe("disconnected");
    expect(stateMachine.getHostState("nas-2")?.status).toBe("online");

    prober.stop();
  });

  it("signals the state machine down when spawn emits an error event", async () => {
    mockPingResults({ "10.0.0.1": "spawn-error", "10.0.0.2": "ok" });
    const prober = createNasProber({ hosts, stateMachine, storage, intervalMs: 30_000 });

    prober.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(stateMachine.getHostState("nas-1")?.status).toBe("disconnected");

    prober.stop();
  });

  it("stops polling after stop() is called", async () => {
    mockPingResults({ "10.0.0.1": "ok", "10.0.0.2": "ok" });
    const intervalMs = 30_000;
    const prober = createNasProber({ hosts, stateMachine, storage, intervalMs });

    prober.start();
    await vi.advanceTimersByTimeAsync(0);

    spawnMock.mockClear();
    prober.stop();

    await vi.advanceTimersByTimeAsync(intervalMs * 3);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("never records metric snapshots for NAS pings", async () => {
    mockPingResults({ "10.0.0.1": "ok", "10.0.0.2": "fail" });
    const insertSpy = vi.spyOn(storage, "insertMetricSnapshot");
    const prober = createNasProber({ hosts, stateMachine, storage, intervalMs: 30_000 });

    prober.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(insertSpy).not.toHaveBeenCalled();

    prober.stop();
  });
});
