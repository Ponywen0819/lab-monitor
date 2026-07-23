import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { METRIC_RETENTION_MS, type HostMetrics, type InstallRequest } from "@labmon/shared";
import { createHttpServer, type HttpServer } from "./http-server.js";
import { createStorage, type Storage } from "./storage/db.js";
import { createOfflineStateMachine, type OfflineStateMachine } from "./state-machine.js";
import type { RemoteInstaller } from "./remote-installer/index.js";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const sampleMetrics: HostMetrics = {
  cpuUsagePct: 42,
  memUsedMB: 1024,
  memTotalMB: 4096,
  disks: null,
  gpus: null,
  errors: {},
};

const jsonHeaders = { "Content-Type": "application/json" };

describe("createHttpServer", () => {
  let dir: string;
  let storage: Storage;
  let stateMachine: OfflineStateMachine;
  let installAgentMock: ReturnType<typeof vi.fn>;
  let remoteInstaller: RemoteInstaller;
  let onHostRemovedMock: ReturnType<typeof vi.fn>;
  let port: number;
  let server: HttpServer;
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "labmon-http-test-"));
    storage = createStorage(join(dir, "test.db"));
    stateMachine = createOfflineStateMachine();
    installAgentMock = vi.fn((_request: InstallRequest) => "install-id");
    remoteInstaller = { installAgent: installAgentMock } as unknown as RemoteInstaller;
    onHostRemovedMock = vi.fn();

    port = await getFreePort();
    base = `http://localhost:${port}`;
    server = createHttpServer({ port, storage, stateMachine, remoteInstaller, onHostRemoved: onHostRemovedMock });
    server.start();
  });

  afterEach(() => {
    server.stop();
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("GET /api/hosts", () => {
    it("returns [] on empty storage", async () => {
      const res = await fetch(`${base}/api/hosts`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("reflects a host after upsertHost + a metric snapshot + signalUp", async () => {
      storage.upsertHost({ id: "h1", name: "Host One", type: "agent" });
      storage.insertMetricSnapshot({ hostId: "h1", timestamp: 1000, metrics: sampleMetrics });
      stateMachine.signalUp("h1", 1000);

      const res = await fetch(`${base}/api/hosts`);
      const body = await res.json();

      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: "h1",
        name: "Host One",
        type: "agent",
        status: "online",
        lastSeenAt: 1000,
        offlineSinceAt: null,
        latestMetrics: sampleMetrics,
      });
    });
  });

  describe("GET /api/hosts/:id/metrics", () => {
    beforeEach(() => {
      storage.upsertHost({ id: "h1", name: "Host One", type: "agent" });
    });

    it("returns both an old and a recent snapshot within the default retention window", async () => {
      const now = Date.now();
      storage.insertMetricSnapshot({
        hostId: "h1",
        timestamp: now - METRIC_RETENTION_MS + 60_000,
        metrics: sampleMetrics,
      });
      storage.insertMetricSnapshot({ hostId: "h1", timestamp: now - 1_000, metrics: sampleMetrics });

      const res = await fetch(`${base}/api/hosts/h1/metrics`);
      const body = await res.json();
      expect(body).toHaveLength(2);
    });

    it("narrows the window with ?sinceMs", async () => {
      const now = Date.now();
      const recent = now - 500;
      storage.insertMetricSnapshot({ hostId: "h1", timestamp: now - 10_000, metrics: sampleMetrics });
      storage.insertMetricSnapshot({ hostId: "h1", timestamp: recent, metrics: sampleMetrics });

      const res = await fetch(`${base}/api/hosts/h1/metrics?sinceMs=5000`);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].timestamp).toBe(recent);
    });

    it("returns 400 for a negative sinceMs", async () => {
      const res = await fetch(`${base}/api/hosts/h1/metrics?sinceMs=-1`);
      expect(res.status).toBe(400);
    });

    it("returns 400 for a non-numeric sinceMs", async () => {
      const res = await fetch(`${base}/api/hosts/h1/metrics?sinceMs=notanumber`);
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/hosts/:id", () => {
    it("returns 404 for an unknown host", async () => {
      const res = await fetch(`${base}/api/hosts/nope`, { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(onHostRemovedMock).not.toHaveBeenCalled();
    });

    it("returns 409 and does not delete when the host is online", async () => {
      storage.upsertHost({ id: "h1", name: "Host One", type: "agent" });
      stateMachine.signalUp("h1");

      const res = await fetch(`${base}/api/hosts/h1`, { method: "DELETE" });

      expect(res.status).toBe(409);
      expect(storage.getHost("h1")).toBeDefined();
      expect(onHostRemovedMock).not.toHaveBeenCalled();
    });

    it("deletes a non-online host, its metrics/status history, and notifies onHostRemoved", async () => {
      storage.upsertHost({ id: "h1", name: "Host One", type: "agent" });
      storage.insertMetricSnapshot({ hostId: "h1", timestamp: 1000, metrics: sampleMetrics });
      storage.insertStatusEvent({ hostId: "h1", status: "offline", timestamp: 1000 });
      stateMachine.signalUp("h1");
      stateMachine.signalDown("h1"); // -> "disconnected", still not "online"

      const res = await fetch(`${base}/api/hosts/h1`, { method: "DELETE" });

      expect(res.status).toBe(200);
      expect(storage.getHost("h1")).toBeUndefined();
      expect(storage.getRecentMetrics("h1", 0)).toEqual([]);
      expect(stateMachine.getHostState("h1")).toBeUndefined();
      expect(onHostRemovedMock).toHaveBeenCalledWith("h1");
    });

    it("allows re-registering the same hostId as brand-new after deletion", async () => {
      storage.upsertHost({ id: "h1", name: "Host One", type: "agent" });
      stateMachine.signalUp("h1");
      stateMachine.signalDown("h1");
      await fetch(`${base}/api/hosts/h1`, { method: "DELETE" });

      stateMachine.signalUp("h1");
      expect(stateMachine.getHostState("h1")?.status).toBe("online");
    });
  });

  describe("GET /api/config", () => {
    it("returns null when no notify_email has been set", async () => {
      const res = await fetch(`${base}/api/config`);
      expect(await res.json()).toEqual({ notifyEmail: null });
    });

    it("reflects a previously set notify_email", async () => {
      storage.setSystemConfig("notify_email", "a@example.com");
      const res = await fetch(`${base}/api/config`);
      expect(await res.json()).toEqual({ notifyEmail: "a@example.com" });
    });
  });

  describe("PUT /api/config", () => {
    it("updates and echoes back a valid notifyEmail", async () => {
      const res = await fetch(`${base}/api/config`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ notifyEmail: "b@example.com" }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ notifyEmail: "b@example.com" });
      expect(storage.getSystemConfig("notify_email")).toBe("b@example.com");
    });

    it("returns 400 when notifyEmail is missing", async () => {
      const res = await fetch(`${base}/api/config`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when notifyEmail is empty", async () => {
      const res = await fetch(`${base}/api/config`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ notifyEmail: "" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when notifyEmail is not a string", async () => {
      const res = await fetch(`${base}/api/config`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ notifyEmail: 12345 }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("returns 405 for a non-GET/PUT method on /api/config", async () => {
    const res = await fetch(`${base}/api/config`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  describe("POST /api/install", () => {
    it("calls remoteInstaller.installAgent and returns 202 with its installId", async () => {
      installAgentMock.mockReturnValue("install-abc");
      const request = {
        targetIp: "10.0.0.5",
        sshPort: 22,
        username: "root",
        password: "hunter2",
        sudoPassword: "sudosecret",
      };

      const res = await fetch(`${base}/api/install`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(request),
      });

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ installId: "install-abc" });
      expect(installAgentMock).toHaveBeenCalledWith(request);
    });

    const invalidBodies: Record<string, unknown> = {
      "missing targetIp": { sshPort: 22, username: "root", password: "p", sudoPassword: "p" },
      "non-integer sshPort": { targetIp: "10.0.0.5", sshPort: 22.5, username: "root", password: "p", sudoPassword: "p" },
      "negative sshPort": { targetIp: "10.0.0.5", sshPort: -1, username: "root", password: "p", sudoPassword: "p" },
      "missing username": { targetIp: "10.0.0.5", sshPort: 22, password: "p", sudoPassword: "p" },
      "missing password": { targetIp: "10.0.0.5", sshPort: 22, username: "root", sudoPassword: "p" },
      "missing sudoPassword": { targetIp: "10.0.0.5", sshPort: 22, username: "root", password: "p" },
    };

    for (const [label, body] of Object.entries(invalidBodies)) {
      it(`returns 400 without calling installAgent for ${label}`, async () => {
        const res = await fetch(`${base}/api/install`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(body),
        });

        expect(res.status).toBe(400);
        expect(installAgentMock).not.toHaveBeenCalled();
      });
    }
  });

  it("includes CORS headers on a normal response", async () => {
    const res = await fetch(`${base}/api/hosts`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type");
  });

  it("returns 204 for an OPTIONS preflight request", async () => {
    const res = await fetch(`${base}/api/hosts`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });

  it("returns 404 for an unknown route", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
  });

  it("returns 400 rather than crashing on malformed JSON in a PUT body", async () => {
    const res = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: jsonHeaders,
      body: "{not valid json",
    });
    expect(res.status).toBe(400);

    const followUp = await fetch(`${base}/api/hosts`);
    expect(followUp.status).toBe(200);
  });

  it("returns 400 rather than crashing on malformed JSON in a POST body", async () => {
    const res = await fetch(`${base}/api/install`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    expect(installAgentMock).not.toHaveBeenCalled();
  });

  it("stop() closes the listener so a subsequent request fails", async () => {
    server.stop();
    await expect(fetch(`${base}/api/hosts`)).rejects.toThrow();
  });
});
