import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient } from "./ws-client.js";
import type { AgentReportMessage } from "@labmon/shared";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sentMessages: string[] = [];
  private listeners: Record<string, Array<(event?: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(event: string, cb: (event?: unknown) => void): void {
    (this.listeners[event] ??= []).push(cb);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.listeners.open?.forEach((cb) => cb());
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.listeners.close?.forEach((cb) => cb());
  }

  simulateError(err: unknown): void {
    this.listeners.error?.forEach((cb) => cb(err));
  }
}

let instances: MockWebSocket[];

beforeEach(() => {
  instances = [];
  vi.useFakeTimers();
  vi.stubGlobal(
    "WebSocket",
    class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WsClient", () => {
  it("start() connects to the configured URL", () => {
    const client = new WsClient("ws://collector.example/agent");
    client.start();

    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe("ws://collector.example/agent");
  });

  it("reconnects ~5s after the socket closes", () => {
    const client = new WsClient("ws://collector.example/agent");
    client.start();

    expect(instances).toHaveLength(1);
    instances[0].simulateClose();

    vi.advanceTimersByTime(4_999);
    expect(instances).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(instances).toHaveLength(2);
    expect(instances[1].url).toBe("ws://collector.example/agent");
  });

  it("does not reconnect after stop() closes the socket", () => {
    const client = new WsClient("ws://collector.example/agent");
    client.start();
    client.stop();
    instances[0].simulateClose();

    vi.advanceTimersByTime(60_000);

    expect(instances).toHaveLength(1);
  });

  it("does not throw when the socket reports an error", () => {
    const client = new WsClient("ws://collector.example/agent");
    client.start();

    expect(() => instances[0].simulateError(new Error("boom"))).not.toThrow();
  });

  it("send() forwards the JSON-serialized message when the socket is open", () => {
    const client = new WsClient("ws://collector.example/agent");
    client.start();
    instances[0].simulateOpen();

    const message: AgentReportMessage = {
      type: "agent_report",
      hostId: "host-1",
      timestamp: 1234,
      metrics: {
        cpuUsagePct: 10,
        memUsedMB: 100,
        memTotalMB: 200,
        disks: null,
        gpus: null,
        errors: {},
      },
    };
    client.send(message);

    expect(instances[0].sentMessages).toEqual([JSON.stringify(message)]);
  });

  it("send() does not throw or forward anything when the socket is not open", () => {
    const client = new WsClient("ws://collector.example/agent");
    client.start();

    const message: AgentReportMessage = {
      type: "agent_report",
      hostId: "host-1",
      timestamp: 1234,
      metrics: {
        cpuUsagePct: null,
        memUsedMB: null,
        memTotalMB: null,
        disks: null,
        gpus: null,
        errors: {},
      },
    };

    expect(() => client.send(message)).not.toThrow();
    expect(instances[0].sentMessages).toEqual([]);
  });
});
