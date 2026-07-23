import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "@labmon/shared";
import { deleteHost, fetchHostMetrics } from "../api/client";
import { useHosts } from "../ws/WsProvider";
import { HostDetail } from "./HostDetail";

vi.mock("../ws/WsProvider", () => ({
  useHosts: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchHostMetrics: vi.fn(),
  deleteHost: vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: vi.fn(), useParams: vi.fn() };
});

const mockedUseHosts = vi.mocked(useHosts);
const mockedUseNavigate = vi.mocked(useNavigate);
const mockedUseParams = vi.mocked(useParams);
const mockedFetchHostMetrics = vi.mocked(fetchHostMetrics);
const mockedDeleteHost = vi.mocked(deleteHost);

function makeHost(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    id: "h1",
    name: "Host One",
    type: "agent",
    status: "offline",
    lastSeenAt: 1000,
    offlineSinceAt: 2000,
    latestMetrics: null,
    ...overrides,
  };
}

function setHost(host: HostSnapshot): void {
  mockedUseHosts.mockReturnValue({ hosts: new Map([[host.id, host]]), connected: true, installEvents: new Map() });
}

let navigateSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  navigateSpy = vi.fn();
  mockedUseNavigate.mockReturnValue(navigateSpy);
  mockedUseParams.mockReturnValue({ id: "h1" });
  mockedFetchHostMetrics.mockResolvedValue([]);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderHostDetail() {
  return render(
    <MemoryRouter>
      <HostDetail />
    </MemoryRouter>,
  );
}

describe("HostDetail remove button", () => {
  it("is disabled while the host is online", () => {
    setHost(makeHost({ status: "online" }));
    renderHostDetail();

    expect(screen.getByRole("button", { name: "Remove host" })).toBeDisabled();
  });

  it("is enabled once the host is not online", () => {
    setHost(makeHost({ status: "offline" }));
    renderHostDetail();

    expect(screen.getByRole("button", { name: "Remove host" })).toBeEnabled();
  });

  it("does nothing if the user cancels the confirm dialog", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    setHost(makeHost({ status: "offline" }));
    renderHostDetail();

    await user.click(screen.getByRole("button", { name: "Remove host" }));

    expect(mockedDeleteHost).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("calls deleteHost with the host id and navigates to the dashboard on confirm", async () => {
    const user = userEvent.setup();
    mockedDeleteHost.mockResolvedValue(undefined);
    setHost(makeHost({ id: "h1", status: "offline" }));
    renderHostDetail();

    await user.click(screen.getByRole("button", { name: "Remove host" }));

    expect(mockedDeleteHost).toHaveBeenCalledWith("h1");
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/"));
  });

  it("shows an error and stays on the page when deleteHost rejects", async () => {
    const user = userEvent.setup();
    mockedDeleteHost.mockRejectedValue(new Error("DELETE /api/hosts/h1 failed: 409 cannot delete a host that is currently online"));
    setHost(makeHost({ id: "h1", status: "offline" }));
    renderHostDetail();

    await user.click(screen.getByRole("button", { name: "Remove host" }));

    expect(await screen.findByText(/Failed to remove host:/)).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
