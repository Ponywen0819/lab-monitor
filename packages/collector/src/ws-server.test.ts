import { createServer } from "node:net";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AgentReportMessage, HostMetrics, HostSnapshot, HostUpdateMessage } from "@labmon/shared";
import { WsServer } from "./ws-server.js";

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

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once("message", (raw) => {
      try {
        resolve(JSON.parse(String(raw)));
      } catch (err) {
        reject(err);
      }
    });
  });
}

const sampleMetrics: HostMetrics = {
  cpuUsagePct: 12.5,
  memUsedMB: 2048,
  memTotalMB: 8192,
  disks: null,
  gpus: null,
  errors: {},
};

function agentReport(hostId: string): AgentReportMessage {
  return { type: "agent_report", hostId, timestamp: Date.now(), metrics: sampleMetrics };
}

const sampleSnapshot: HostSnapshot = {
  id: "h1",
  name: "h1",
  type: "agent",
  status: "online",
  lastSeenAt: Date.now(),
  offlineSinceAt: null,
  latestMetrics: sampleMetrics,
};

describe("WsServer", () => {
  let port: number;
  let server: WsServer;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    port = await getFreePort();
    server = new WsServer({ port });
    server.start();
    clients.length = 0;
  });

  afterEach(() => {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
    server.stop();
  });

  async function client(): Promise<WebSocket> {
    const ws = await connectClientRetrying(port);
    clients.push(ws);
    return ws;
  }

  it("emits agent_report for a well-formed message", async () => {
    const ws = await client();
    const message = agentReport("h1");
    const eventPromise = once(server, "agent_report");

    ws.send(JSON.stringify(message));

    const [received] = await eventPromise;
    expect(received).toEqual(message);
  });

  it("routes a dashboard_subscribe client into the frontend broadcast set", async () => {
    const ws = await client();
    const messagePromise = waitForMessage(ws);

    ws.send(JSON.stringify({ type: "dashboard_subscribe" }));
    await sleep(100);

    const payload: HostUpdateMessage = { type: "host_update", host: sampleSnapshot };
    server.broadcastToFrontends(payload);

    const received = await messagePromise;
    expect(received).toEqual(payload);
  });

  it("does not broadcast to a client that only sent agent_report", async () => {
    const ws = await client();
    const reportPromise = once(server, "agent_report");
    ws.send(JSON.stringify(agentReport("h1")));
    await reportPromise;

    const received: unknown[] = [];
    ws.on("message", (raw) => received.push(JSON.parse(String(raw))));

    server.broadcastToFrontends({ type: "host_update", host: sampleSnapshot });
    await sleep(100);

    expect(received).toHaveLength(0);
  });

  it("ignores malformed JSON and keeps serving subsequent valid messages", async () => {
    const ws = await client();
    ws.send("this is not { valid json");
    await sleep(50);

    const message = agentReport("h1");
    const eventPromise = once(server, "agent_report");
    ws.send(JSON.stringify(message));

    const [received] = await eventPromise;
    expect(received).toEqual(message);
  });

  it("emits agent_down when an agent connection closes", async () => {
    const ws = await client();
    const reportPromise = once(server, "agent_report");
    ws.send(JSON.stringify(agentReport("h1")));
    await reportPromise;

    const downPromise = once(server, "agent_down");
    ws.close();

    const [hostId] = await downPromise;
    expect(hostId).toBe("h1");
  });

  it("does not emit agent_down for a stale connection closing after a reconnect took over its hostId", async () => {
    const first = await client();
    const firstReport = once(server, "agent_report");
    first.send(JSON.stringify(agentReport("h1")));
    await firstReport;

    const second = await client();
    const secondReport = once(server, "agent_report");
    second.send(JSON.stringify(agentReport("h1")));
    await secondReport;

    const downEvents: string[] = [];
    server.on("agent_down", (hostId) => downEvents.push(hostId));

    first.close();
    await sleep(150);
    expect(downEvents).toHaveLength(0);

    const downPromise = once(server, "agent_down");
    second.close();
    const [hostId] = await downPromise;

    expect(hostId).toBe("h1");
    expect(downEvents).toEqual(["h1"]);
  });

  it("stop() closes existing tracked connections and stops accepting new ones", async () => {
    const ws = await client();
    ws.send(JSON.stringify({ type: "dashboard_subscribe" }));
    await sleep(100);

    const closePromise = once(ws, "close");
    server.stop();
    await closePromise;

    await expect(connectClient(port)).rejects.toThrow();
  });
});
