import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type {
  CollectorToFrontendMessage,
  HostMetrics,
  HostStatusMessage,
  HostUpdateMessage,
} from "@labmon/shared";
import { createCollectorServer, type CollectorServer } from "./server.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function connectClientRetrying(port: number, attempts = 10): Promise<WebSocket> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await connectClient(port);
    } catch (err) {
      lastErr = err;
      await sleep(30);
    }
  }
  throw lastErr;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(20);
  }
}

const sampleMetrics: HostMetrics = {
  cpuUsagePct: 33,
  memUsedMB: 512,
  memTotalMB: 2048,
  disks: null,
  gpus: null,
  errors: {},
};

describe("createCollectorServer integration", () => {
  let dir: string;
  let dbPath: string;
  let wsPort: number;
  let httpPort: number;
  let server: CollectorServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "labmon-integration-"));
    dbPath = join(dir, "test.db");
    wsPort = await getFreePort();
    httpPort = await getFreePort();
    server = createCollectorServer({ wsPort, httpPort, dbPath, nasHosts: [] });
  });

  afterEach(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("propagates an agent report through the dashboard WS channel and the HTTP API, then reflects disconnect", async () => {
    const hostId = "integration-host";

    const dashboard = await connectClientRetrying(wsPort);
    const messages: CollectorToFrontendMessage[] = [];
    dashboard.on("message", (raw) => messages.push(JSON.parse(String(raw)) as CollectorToFrontendMessage));
    dashboard.send(JSON.stringify({ type: "dashboard_subscribe" }));
    await sleep(150);

    const agent = await connectClientRetrying(wsPort);
    agent.send(
      JSON.stringify({ type: "agent_report", hostId, timestamp: Date.now(), metrics: sampleMetrics })
    );

    await waitFor(() => messages.some((m) => m.type === "host_update"));
    const update = messages.find((m) => m.type === "host_update") as HostUpdateMessage;
    expect(update.host).toMatchObject({ id: hostId, status: "online", latestMetrics: sampleMetrics });

    const res = await fetch(`http://localhost:${httpPort}/api/hosts`);
    const hosts = (await res.json()) as Array<{ id: string; status: string; latestMetrics: unknown }>;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ id: hostId, status: "online", latestMetrics: sampleMetrics });

    messages.length = 0;
    agent.close();

    await waitFor(() => messages.some((m) => m.type === "host_status"));
    const statusMessage = messages.find((m) => m.type === "host_status") as HostStatusMessage;
    expect(statusMessage).toMatchObject({ type: "host_status", hostId, status: "disconnected" });

    dashboard.close();
  });
});
