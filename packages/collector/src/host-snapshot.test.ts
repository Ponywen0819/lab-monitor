import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Host, MetricSnapshot } from "@labmon/shared";
import { getHostSnapshot } from "./host-snapshot.js";
import { Storage, createStorage } from "./storage/db.js";
import { OfflineStateMachine, createOfflineStateMachine } from "./state-machine.js";

describe("getHostSnapshot", () => {
  let dir: string;
  let storage: Storage;
  let stateMachine: OfflineStateMachine;

  const host: Host = { id: "host-1", name: "Alpha", type: "agent" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "labmon-test-"));
    storage = createStorage(join(dir, "test.db"));
    stateMachine = createOfflineStateMachine();
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for a hostId with no host row", () => {
    expect(getHostSnapshot("nope", storage, stateMachine)).toBeNull();
  });

  it("merges storage host/metrics with state-machine liveness", () => {
    storage.upsertHost(host);
    const metricSnapshot: MetricSnapshot = {
      hostId: host.id,
      timestamp: 1000,
      metrics: {
        cpuUsagePct: 42,
        memUsedMB: 512,
        memTotalMB: 2048,
        disks: null,
        gpus: null,
        errors: {},
      },
    };
    storage.insertMetricSnapshot(metricSnapshot);
    stateMachine.signalUp(host.id, 500);

    const result = getHostSnapshot(host.id, storage, stateMachine);

    expect(result).toEqual({
      id: host.id,
      name: host.name,
      type: host.type,
      status: "online",
      lastSeenAt: 500,
      offlineSinceAt: null,
      latestMetrics: metricSnapshot.metrics,
    });
  });

  it("defaults to offline status for a host known to storage but never signaled", () => {
    storage.upsertHost(host);

    const result = getHostSnapshot(host.id, storage, stateMachine);

    expect(result).toEqual({
      id: host.id,
      name: host.name,
      type: host.type,
      status: "offline",
      lastSeenAt: null,
      offlineSinceAt: null,
      latestMetrics: null,
    });
  });
});
