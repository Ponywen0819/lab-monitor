import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiskPartition, GpuInfo, Host, MetricSnapshot } from "@labmon/shared";
import { Storage, createStorage } from "./db.js";

describe("Storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "labmon-test-"));
    storage = createStorage(join(dir, "test.db"));
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const host: Host = { id: "host-1", name: "Alpha", type: "agent" };

  function snapshot(overrides: Partial<MetricSnapshot> & { timestamp: number }): MetricSnapshot {
    return {
      hostId: host.id,
      metrics: {
        cpuUsagePct: 10,
        memUsedMB: 100,
        memTotalMB: 1000,
        disks: null,
        gpus: null,
        errors: {},
      },
      ...overrides,
    };
  }

  describe("upsertHost / getHost / listHosts", () => {
    it("inserts a new host and updates it in place on conflict", () => {
      storage.upsertHost(host);
      expect(storage.getHost(host.id)).toEqual(host);

      storage.upsertHost({ id: host.id, name: "Beta", type: "nas" });
      expect(storage.getHost(host.id)).toEqual({ id: host.id, name: "Beta", type: "nas" });
    });

    it("returns undefined for an unknown id", () => {
      expect(storage.getHost("nope")).toBeUndefined();
    });

    it("lists all inserted hosts", () => {
      storage.upsertHost(host);
      storage.upsertHost({ id: "host-2", name: "Beta", type: "nas" });

      const hosts = storage.listHosts();
      expect(hosts).toHaveLength(2);
      expect(hosts).toEqual(
        expect.arrayContaining([host, { id: "host-2", name: "Beta", type: "nas" }])
      );
    });
  });

  describe("insertMetricSnapshot / getRecentMetrics / getLatestMetricSnapshot", () => {
    beforeEach(() => {
      storage.upsertHost(host);
    });

    it("filters by sinceTimestamp and orders results ascending", () => {
      storage.insertMetricSnapshot(snapshot({ timestamp: 100 }));
      storage.insertMetricSnapshot(snapshot({ timestamp: 300 }));
      storage.insertMetricSnapshot(snapshot({ timestamp: 200 }));

      const recent = storage.getRecentMetrics(host.id, 200);
      expect(recent.map((s) => s.timestamp)).toEqual([200, 300]);
    });

    it("round-trips populated disks/gpus JSON", () => {
      const disks: DiskPartition[] = [{ mount: "/", totalBytes: 1000, usedBytes: 500 }];
      const gpus: GpuInfo[] = [
        { name: "GPU0", tempC: 60, utilizationPct: 50, memUsedMB: 2000, memTotalMB: 8000 },
      ];

      storage.insertMetricSnapshot(
        snapshot({ timestamp: 100, metrics: { ...snapshot({ timestamp: 100 }).metrics, disks, gpus } })
      );

      const [result] = storage.getRecentMetrics(host.id, 0);
      expect(result.metrics.disks).toEqual(disks);
      expect(result.metrics.gpus).toEqual(gpus);
    });

    it("round-trips null disks/gpus as null, not an empty array", () => {
      storage.insertMetricSnapshot(snapshot({ timestamp: 100 }));

      const [result] = storage.getRecentMetrics(host.id, 0);
      expect(result.metrics.disks).toBeNull();
      expect(result.metrics.gpus).toBeNull();
    });

    it("getLatestMetricSnapshot returns the most recent snapshot", () => {
      storage.insertMetricSnapshot(snapshot({ timestamp: 100 }));
      storage.insertMetricSnapshot(snapshot({ timestamp: 300 }));
      storage.insertMetricSnapshot(snapshot({ timestamp: 200 }));

      expect(storage.getLatestMetricSnapshot(host.id)?.timestamp).toBe(300);
    });

    it("getLatestMetricSnapshot returns null when none exist for that host", () => {
      expect(storage.getLatestMetricSnapshot(host.id)).toBeNull();
    });
  });

  describe("insertStatusEvent", () => {
    it("does not throw", () => {
      storage.upsertHost(host);
      expect(() =>
        storage.insertStatusEvent({ hostId: host.id, status: "online", timestamp: Date.now() })
      ).not.toThrow();
    });
  });

  describe("getSystemConfig / setSystemConfig", () => {
    it("round-trips a value", () => {
      storage.setSystemConfig("notifyEmail", "a@example.com");
      expect(storage.getSystemConfig("notifyEmail")).toBe("a@example.com");
    });

    it("returns null for an unknown key", () => {
      expect(storage.getSystemConfig("nope")).toBeNull();
    });

    it("updates rather than erroring when setting an existing key again", () => {
      storage.setSystemConfig("notifyEmail", "a@example.com");
      storage.setSystemConfig("notifyEmail", "b@example.com");
      expect(storage.getSystemConfig("notifyEmail")).toBe("b@example.com");
    });
  });

  describe("deleteHost", () => {
    it("removes the host row along with its metric snapshots and status events", () => {
      storage.upsertHost(host);
      storage.insertMetricSnapshot(snapshot({ timestamp: 100 }));
      storage.insertStatusEvent({ hostId: host.id, status: "offline", timestamp: 100 });

      storage.deleteHost(host.id);

      expect(storage.getHost(host.id)).toBeUndefined();
      expect(storage.getRecentMetrics(host.id, 0)).toEqual([]);
    });

    it("does not affect other hosts' rows", () => {
      storage.upsertHost(host);
      storage.upsertHost({ id: "host-2", name: "Beta", type: "nas" });
      storage.insertMetricSnapshot(snapshot({ timestamp: 100 }));
      storage.insertMetricSnapshot({ ...snapshot({ timestamp: 100 }), hostId: "host-2" });

      storage.deleteHost(host.id);

      expect(storage.getHost("host-2")).toBeDefined();
      expect(storage.getRecentMetrics("host-2", 0)).toHaveLength(1);
    });

    it("does not throw when deleting a host with no metrics/status rows", () => {
      storage.upsertHost(host);
      expect(() => storage.deleteHost(host.id)).not.toThrow();
    });

    it("also removes a matching nas_host row", () => {
      storage.addNasHost({ id: "nas-1", name: "Synology", ip: "10.0.0.5" });

      storage.deleteHost("nas-1");

      expect(storage.getHost("nas-1")).toBeUndefined();
      expect(storage.listNasHosts()).toEqual([]);
    });
  });

  describe("addNasHost / listNasHosts", () => {
    it("writes both the nas_host row and a matching host row", () => {
      storage.addNasHost({ id: "nas-1", name: "Synology", ip: "10.0.0.5" });

      expect(storage.getHost("nas-1")).toEqual({ id: "nas-1", name: "Synology", type: "nas" });
      expect(storage.listNasHosts()).toEqual([{ id: "nas-1", name: "Synology", ip: "10.0.0.5" }]);
    });

    it("lists multiple added hosts", () => {
      storage.addNasHost({ id: "nas-1", name: "Synology", ip: "10.0.0.5" });
      storage.addNasHost({ id: "nas-2", name: "QNAP", ip: "10.0.0.6" });

      expect(storage.listNasHosts()).toEqual(
        expect.arrayContaining([
          { id: "nas-1", name: "Synology", ip: "10.0.0.5" },
          { id: "nas-2", name: "QNAP", ip: "10.0.0.6" },
        ])
      );
    });

    it("returns [] when none have been added", () => {
      expect(storage.listNasHosts()).toEqual([]);
    });
  });

  describe("deleteMetricsOlderThan", () => {
    beforeEach(() => {
      storage.upsertHost(host);
    });

    it("removes only snapshots strictly older than the cutoff", () => {
      storage.insertMetricSnapshot(snapshot({ timestamp: 100 }));
      storage.insertMetricSnapshot(snapshot({ timestamp: 200 }));
      storage.insertMetricSnapshot(snapshot({ timestamp: 300 }));

      storage.deleteMetricsOlderThan(200);

      const remaining = storage.getRecentMetrics(host.id, 0).map((s) => s.timestamp);
      expect(remaining).toEqual([200, 300]);
    });
  });
});
