import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UninstallProgressEvent } from "@labmon/shared";
import { deleteHost, fetchHostMetrics, postUninstall } from "../api/client";
import { useHosts } from "../ws/WsProvider";
import { HostDetail } from "./HostDetail";

vi.mock("../ws/WsProvider", () => ({
  useHosts: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchHostMetrics: vi.fn(),
  deleteHost: vi.fn(),
  postUninstall: vi.fn(),
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
const mockedPostUninstall = vi.mocked(postUninstall);

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

let uninstallEvents: Map<string, UninstallProgressEvent[]>;

function setHost(host: HostSnapshot): void {
  mockedUseHosts.mockReturnValue({
    hosts: new Map([[host.id, host]]),
    connected: true,
    installEvents: new Map(),
    uninstallEvents,
  });
}

let navigateSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  navigateSpy = vi.fn();
  uninstallEvents = new Map();
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

describe("HostDetail remove button - offline/NAS hosts (plain delete)", () => {
  it("is enabled while the host is offline", () => {
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
    mockedDeleteHost.mockRejectedValue(new Error("DELETE /api/hosts/h1 failed: 500 internal error"));
    setHost(makeHost({ id: "h1", status: "offline" }));
    renderHostDetail();

    await user.click(screen.getByRole("button", { name: "Remove host" }));

    expect(await screen.findByText(/Failed to remove host:/)).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("deletes an online NAS host directly, without asking for SSH credentials", async () => {
    const user = userEvent.setup();
    mockedDeleteHost.mockResolvedValue(undefined);
    setHost(makeHost({ id: "h1", type: "nas", status: "online" }));
    renderHostDetail();

    await user.click(screen.getByRole("button", { name: "Remove host" }));

    expect(mockedDeleteHost).toHaveBeenCalledWith("h1");
    expect(mockedPostUninstall).not.toHaveBeenCalled();
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/"));
  });
});

describe("HostDetail remove button - online agent host (SSH uninstall flow)", () => {
  it("shows the SSH credentials form instead of the plain confirm dialog", async () => {
    const user = userEvent.setup();
    setHost(makeHost({ status: "online" }));
    renderHostDetail();

    await user.click(screen.getByRole("button", { name: "Remove host" }));

    expect(window.confirm).not.toHaveBeenCalled();
    expect(mockedDeleteHost).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Uninstall & remove" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes the modal on Cancel without submitting", async () => {
    const user = userEvent.setup();
    setHost(makeHost({ status: "online" }));
    renderHostDetail();

    await user.click(screen.getByRole("button", { name: "Remove host" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockedPostUninstall).not.toHaveBeenCalled();
  });

  it("validates the SSH form before submitting", async () => {
    const user = userEvent.setup();
    setHost(makeHost({ status: "online" }));
    renderHostDetail();

    await user.click(screen.getByRole("button", { name: "Remove host" }));
    await user.click(screen.getByRole("button", { name: "Uninstall & remove" }));

    expect(await screen.findByText("Target IP is required.")).toBeInTheDocument();
    expect(mockedPostUninstall).not.toHaveBeenCalled();
  });

  it("submits SSH credentials and defaults sudoPassword to the SSH password when left blank", async () => {
    const user = userEvent.setup();
    mockedPostUninstall.mockResolvedValue({ uninstallId: "uninstall-1" });
    setHost(makeHost({ id: "h1", status: "online" }));
    renderHostDetail();

    await user.click(screen.getByRole("button", { name: "Remove host" }));
    await user.type(screen.getByPlaceholderText("192.168.1.50"), "10.0.0.9");
    await user.type(screen.getByLabelText("Username"), "ubuntu");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Uninstall & remove" }));

    await waitFor(() =>
      expect(mockedPostUninstall).toHaveBeenCalledWith("h1", {
        targetIp: "10.0.0.9",
        sshPort: 22,
        username: "ubuntu",
        password: "hunter2",
        sudoPassword: "hunter2",
      }),
    );
  });

  it("renders progress events and navigates home once a terminal success event arrives", async () => {
    const user = userEvent.setup();
    mockedPostUninstall.mockResolvedValue({ uninstallId: "uninstall-1" });
    setHost(makeHost({ id: "h1", status: "online" }));
    const { rerender } = renderHostDetail();

    await user.click(screen.getByRole("button", { name: "Remove host" }));
    await user.type(screen.getByPlaceholderText("192.168.1.50"), "10.0.0.9");
    await user.type(screen.getByLabelText("Username"), "ubuntu");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Uninstall & remove" }));

    await waitFor(() => expect(mockedPostUninstall).toHaveBeenCalled());

    uninstallEvents = new Map([
      [
        "uninstall-1",
        [{ uninstallId: "uninstall-1", hostId: "h1", stage: "connecting", message: "Connecting to 10.0.0.9", timestamp: 1 }],
      ],
    ]);
    setHost(makeHost({ id: "h1", status: "online" }));
    rerender(
      <MemoryRouter>
        <HostDetail />
      </MemoryRouter>,
    );

    expect(screen.getByText("Connecting to 10.0.0.9")).toBeInTheDocument();

    uninstallEvents = new Map([
      [
        "uninstall-1",
        [
          { uninstallId: "uninstall-1", hostId: "h1", stage: "connecting", message: "Connecting to 10.0.0.9", timestamp: 1 },
          {
            uninstallId: "uninstall-1",
            hostId: "h1",
            stage: "done",
            message: "Agent uninstalled and host record removed",
            success: true,
            timestamp: 2,
          },
        ],
      ],
    ]);
    setHost(makeHost({ id: "h1", status: "online" }));
    rerender(
      <MemoryRouter>
        <HostDetail />
      </MemoryRouter>,
    );

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/"));
  });
});
