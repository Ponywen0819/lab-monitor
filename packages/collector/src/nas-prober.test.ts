import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import type { NasHostConfig } from "@labmon/shared";
import { createNasProber } from "./nas-prober.js";
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
    for (const host of hosts) storage.addNasHost(host);
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("signals the state machine up for a successful ping", async () => {
    mockPingResults({ "10.0.0.1": "ok", "10.0.0.2": "ok" });
    const prober = createNasProber({ stateMachine, storage, intervalMs: 30_000 });

    prober.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(stateMachine.getHostState("nas-1")?.status).toBe("online");
    expect(stateMachine.getHostState("nas-2")?.status).toBe("online");

    prober.stop();
  });

  it("signals the state machine down for a non-zero exit ping", async () => {
    mockPingResults({ "10.0.0.1": "fail", "10.0.0.2": "ok" });
    const prober = createNasProber({ stateMachine, storage, intervalMs: 30_000 });

    prober.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(stateMachine.getHostState("nas-1")?.status).toBe("disconnected");
    expect(stateMachine.getHostState("nas-2")?.status).toBe("online");

    prober.stop();
  });

  it("signals the state machine down when spawn emits an error event", async () => {
    mockPingResults({ "10.0.0.1": "spawn-error", "10.0.0.2": "ok" });
    const prober = createNasProber({ stateMachine, storage, intervalMs: 30_000 });

    prober.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(stateMachine.getHostState("nas-1")?.status).toBe("disconnected");

    prober.stop();
  });

  it("stops polling after stop() is called", async () => {
    mockPingResults({ "10.0.0.1": "ok", "10.0.0.2": "ok" });
    const intervalMs = 30_000;
    const prober = createNasProber({ stateMachine, storage, intervalMs });

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
    const prober = createNasProber({ stateMachine, storage, intervalMs: 30_000 });

    prober.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(insertSpy).not.toHaveBeenCalled();

    prober.stop();
  });

  it("addHost() probes the new host immediately rather than waiting for the next cycle", async () => {
    mockPingResults({ "10.0.0.9": "ok" });
    const prober = createNasProber({ stateMachine, storage, intervalMs: 30_000 });
    prober.start();
    await vi.advanceTimersByTimeAsync(0);
    spawnMock.mockClear();

    prober.addHost({ id: "nas-3", name: "NAS Three", ip: "10.0.0.9" });
    await vi.advanceTimersByTimeAsync(0);

    expect(stateMachine.getHostState("nas-3")?.status).toBe("online");

    prober.stop();
  });

  it("addHost() is included in subsequent poll cycles", async () => {
    mockPingResults({ "10.0.0.1": "ok", "10.0.0.2": "ok", "10.0.0.9": "fail" });
    const intervalMs = 30_000;
    const prober = createNasProber({ stateMachine, storage, intervalMs });
    prober.start();
    await vi.advanceTimersByTimeAsync(0);

    prober.addHost({ id: "nas-3", name: "NAS Three", ip: "10.0.0.9" });
    await vi.advanceTimersByTimeAsync(0);

    mockPingResults({ "10.0.0.1": "ok", "10.0.0.2": "ok", "10.0.0.9": "ok" });
    await vi.advanceTimersByTimeAsync(intervalMs);

    expect(stateMachine.getHostState("nas-3")?.status).toBe("online");

    prober.stop();
  });

  it("removeHost() excludes a host from the next poll cycle", async () => {
    mockPingResults({ "10.0.0.1": "ok", "10.0.0.2": "ok" });
    const intervalMs = 30_000;
    const prober = createNasProber({ stateMachine, storage, intervalMs });
    prober.start();
    await vi.advanceTimersByTimeAsync(0);

    prober.removeHost("nas-2");
    spawnMock.mockClear();
    await vi.advanceTimersByTimeAsync(intervalMs);

    const pingedIps = spawnMock.mock.calls.map((call) => (call[1] as string[])[(call[1] as string[]).length - 1]);
    expect(pingedIps).not.toContain("10.0.0.2");

    prober.stop();
  });
});
