import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "@labmon/shared";
import { useHosts } from "../ws/WsProvider";
import { Dashboard } from "./Dashboard";

vi.mock("../ws/WsProvider", () => ({
  useHosts: vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: vi.fn() };
});

const mockedUseHosts = vi.mocked(useHosts);
const mockedUseNavigate = vi.mocked(useNavigate);

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

function setHosts(hosts: HostSnapshot[], connected = true): void {
  const map = new Map(hosts.map((h) => [h.id, h]));
  mockedUseHosts.mockReturnValue({ hosts: map, connected, installEvents: new Map(), uninstallEvents: new Map(), forbidden: false });
}

let navigateSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  navigateSpy = vi.fn();
  mockedUseNavigate.mockReturnValue(navigateSpy);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

describe("Dashboard", () => {
  it("renders an empty state when there are no hosts", () => {
    setHosts([]);
    renderDashboard();
    expect(screen.getByText("No hosts reported yet.")).toBeInTheDocument();
  });

  it("renders an agent host's name, status, and formatted metrics", () => {
    const host = makeHost({
      id: "agent-1",
      name: "Agent Box",
      type: "agent",
      status: "online",
      latestMetrics: {
        cpuUsagePct: 42,
        memUsedMB: 2048,
        memTotalMB: 8192,
        disks: [{ mount: "/", totalBytes: 1000, usedBytes: 250 }],
        gpus: null,
        errors: {},
      },
    });
    setHosts([host]);
    renderDashboard();

    expect(screen.getByText("Agent Box")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();

    const dot = document.querySelector(".status-dot");
    expect(dot).toHaveClass("status-online");

    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("2.0 GB / 8.0 GB")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
  });

  it("renders only the status indicator for a NAS host, with no metric bars", () => {
    const host = makeHost({
      id: "nas-1",
      name: "Storage Box",
      type: "nas",
      status: "offline",
      latestMetrics: null,
    });
    setHosts([host]);
    renderDashboard();

    expect(screen.getByText("Storage Box")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    const dot = document.querySelector(".status-dot");
    expect(dot).toHaveClass("status-offline");

    expect(document.querySelector(".host-metrics")).toBeNull();
    expect(screen.queryByText("CPU")).toBeNull();
    expect(screen.queryByText("Memory")).toBeNull();
    expect(screen.queryByText("Disk")).toBeNull();
  });

  it("renders multiple hosts sorted alphabetically by name", () => {
    setHosts([
      makeHost({ id: "c", name: "Charlie" }),
      makeHost({ id: "a", name: "Alice" }),
      makeHost({ id: "b", name: "Bob" }),
    ]);
    renderDashboard();

    const names = [...document.querySelectorAll(".host-name")].map((el) => el.textContent);
    expect(names).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("splits agent hosts and NAS hosts into separate sections", () => {
    setHosts([
      makeHost({ id: "agent-1", name: "Agent Box", type: "agent" }),
      makeHost({ id: "nas-1", name: "Storage Box", type: "nas" }),
    ]);
    renderDashboard();

    const sections = document.querySelectorAll(".host-section");
    expect(sections).toHaveLength(2);
    expect(sections[0].querySelector("h3")?.textContent).toBe("Hosts");
    expect(sections[0].textContent).toContain("Agent Box");
    expect(sections[1].querySelector("h3")?.textContent).toBe("NAS");
    expect(sections[1].textContent).toContain("Storage Box");
  });

  it("shows a section-specific empty state when one type has no hosts", () => {
    setHosts([makeHost({ id: "agent-1", name: "Agent Box", type: "agent" })]);
    renderDashboard();

    expect(screen.getByText("No NAS hosts added yet.")).toBeInTheDocument();
  });

  it("navigates to the host detail page when a host card is clicked", async () => {
    const user = userEvent.setup();
    setHosts([makeHost({ id: "agent-42", name: "Clickable Host" })]);
    renderDashboard();

    await user.click(screen.getByText("Clickable Host"));

    expect(navigateSpy).toHaveBeenCalledWith("/hosts/agent-42");
  });
});
