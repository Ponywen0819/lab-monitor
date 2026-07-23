import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, InstallProgressEvent } from "@labmon/shared";
import { fetchHosts } from "../api/client";
import { WsProvider, useHosts } from "./WsProvider";

vi.mock("../api/client", () => ({
  fetchHosts: vi.fn(),
}));

const mockedFetchHosts = vi.mocked(fetchHosts);

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function makeHost(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    id: "h1",
    name: "Host One",
    type: "agent",
    status: "online",
    lastSeenAt: 1000,
    offlineSinceAt: null,
    latestMetrics: null,
    ...overrides,
  };
}

function makeInstallEvent(overrides: Partial<InstallProgressEvent> = {}): InstallProgressEvent {
  return {
    installId: "install-1",
    stage: "connecting",
    message: "Connecting...",
    timestamp: 1000,
    ...overrides,
  };
}

function Consumer() {
  const { hosts, connected, installEvents } = useHosts();
  return (
    <div>
      <div data-testid="connected">{String(connected)}</div>
      <div data-testid="hosts">{JSON.stringify([...hosts.entries()])}</div>
      <div data-testid="install-events">{JSON.stringify([...installEvents.entries()])}</div>
    </div>
  );
}

function readHosts(): Map<string, HostSnapshot> {
  return new Map(JSON.parse(screen.getByTestId("hosts").textContent ?? "[]"));
}

function readInstallEvents(): Map<string, InstallProgressEvent[]> {
  return new Map(JSON.parse(screen.getByTestId("install-events").textContent ?? "[]"));
}

function readConnected(): boolean {
  return screen.getByTestId("connected").textContent === "true";
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  mockedFetchHosts.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WsProvider", () => {
  it("seeds hosts from the initial HTTP fetch", async () => {
    mockedFetchHosts.mockResolvedValue([makeHost({ id: "a", name: "Alpha" })]);
    render(
      <WsProvider>
        <Consumer />
      </WsProvider>,
    );

    await waitFor(() => {
      expect(readHosts().get("a")?.name).toBe("Alpha");
    });
  });

  it("does not let a delayed HTTP seed clobber a host already reported over WS", async () => {
    let resolveFetch: (hosts: HostSnapshot[]) => void = () => {};
    mockedFetchHosts.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(
      <WsProvider>
        <Consumer />
      </WsProvider>,
    );
    const ws = FakeWebSocket.instances[0];

    const wsHost = makeHost({ id: "a", name: "WS Alpha", status: "notified" });
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: "host_update", host: wsHost }) });
    });

    await waitFor(() => expect(readHosts().get("a")?.name).toBe("WS Alpha"));

    const seedHost = makeHost({ id: "a", name: "Seed Alpha", status: "online" });
    const otherSeedHost = makeHost({ id: "b", name: "Beta" });
    await act(async () => {
      resolveFetch([seedHost, otherSeedHost]);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      const hosts = readHosts();
      expect(hosts.get("a")?.name).toBe("WS Alpha");
      expect(hosts.get("a")?.status).toBe("notified");
      expect(hosts.get("b")?.name).toBe("Beta");
    });
  });

  it("host_update replaces the full snapshot for that host id", async () => {
    mockedFetchHosts.mockResolvedValue([]);
    render(
      <WsProvider>
        <Consumer />
      </WsProvider>,
    );
    const ws = FakeWebSocket.instances[0];

    const host1 = makeHost({ id: "a", name: "Alpha", status: "online" });
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: "host_update", host: host1 }) }));
    await waitFor(() => expect(readHosts().get("a")?.status).toBe("online"));

    const host2 = makeHost({ id: "a", name: "Alpha", status: "offline", lastSeenAt: 5000 });
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: "host_update", host: host2 }) }));
    await waitFor(() => {
      const a = readHosts().get("a");
      expect(a?.status).toBe("offline");
      expect(a?.lastSeenAt).toBe(5000);
    });
  });

  it("host_status patches only the status field, leaving other fields untouched", async () => {
    mockedFetchHosts.mockResolvedValue([makeHost({ id: "a", name: "Alpha", status: "online", lastSeenAt: 111 })]);
    render(
      <WsProvider>
        <Consumer />
      </WsProvider>,
    );
    await waitFor(() => expect(readHosts().get("a")).toBeDefined());
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "host_status", hostId: "a", status: "offline", timestamp: 222 }),
      });
    });

    await waitFor(() => {
      const a = readHosts().get("a");
      expect(a?.status).toBe("offline");
      expect(a?.name).toBe("Alpha");
      expect(a?.lastSeenAt).toBe(111);
    });
  });

  it("host_status for an unknown host id is a no-op", async () => {
    mockedFetchHosts.mockResolvedValue([makeHost({ id: "a" })]);
    render(
      <WsProvider>
        <Consumer />
      </WsProvider>,
    );
    await waitFor(() => expect(readHosts().size).toBe(1));
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "host_status", hostId: "unknown", status: "offline", timestamp: 1 }),
      });
    });

    expect(readHosts().size).toBe(1);
    expect(readHosts().has("unknown")).toBe(false);
  });

  it("install_progress appends events per installId; a second event for the same id grows the array", async () => {
    mockedFetchHosts.mockResolvedValue([]);
    render(
      <WsProvider>
        <Consumer />
      </WsProvider>,
    );
    const ws = FakeWebSocket.instances[0];

    const e1 = makeInstallEvent({ stage: "connecting", message: "starting" });
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: "install_progress", event: e1 }) }));
    await waitFor(() => expect(readInstallEvents().get("install-1")?.length).toBe(1));

    const e2 = makeInstallEvent({ stage: "deploying_key", message: "key" });
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: "install_progress", event: e2 }) }));
    await waitFor(() => {
      const events = readInstallEvents().get("install-1");
      expect(events?.length).toBe(2);
      expect(events?.[0].stage).toBe("connecting");
      expect(events?.[1].stage).toBe("deploying_key");
    });
  });

  it("flips connected to false on close, and reconnects after the fixed delay", () => {
    mockedFetchHosts.mockResolvedValue([]);
    render(
      <WsProvider>
        <Consumer />
      </WsProvider>,
    );
    const first = FakeWebSocket.instances[0];

    act(() => first.onopen?.());
    expect(readConnected()).toBe(true);

    vi.useFakeTimers();
    act(() => first.onclose?.());
    expect(readConnected()).toBe(false);
    expect(FakeWebSocket.instances.length).toBe(1);

    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(FakeWebSocket.instances.length).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeWebSocket.instances.length).toBe(2);

    const second = FakeWebSocket.instances[1];
    act(() => second.onopen?.());
    expect(readConnected()).toBe(true);
  });
});
