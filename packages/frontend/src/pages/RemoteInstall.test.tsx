import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallProgressEvent } from "@labmon/shared";
import { postInstall } from "../api/client";
import { useHosts } from "../ws/WsProvider";
import { RemoteInstall } from "./RemoteInstall";

vi.mock("../api/client", () => ({
  postInstall: vi.fn(),
}));

vi.mock("../ws/WsProvider", () => ({
  useHosts: vi.fn(),
}));

const mockedPostInstall = vi.mocked(postInstall);
const mockedUseHosts = vi.mocked(useHosts);

function setInstallEvents(events: Map<string, InstallProgressEvent[]>): void {
  mockedUseHosts.mockReturnValue({ hosts: new Map(), connected: true, installEvents: events });
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

async function fillValidForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Target IP"), "  10.0.0.5  ");
  const portInput = screen.getByLabelText("SSH port");
  await user.clear(portInput);
  await user.type(portInput, "2222");
  await user.type(screen.getByLabelText("Username"), "  root  ");
  await user.type(screen.getByLabelText("Password"), "hunter2");
  await user.type(screen.getByLabelText("Sudo password"), "sudosecret");
}

beforeEach(() => {
  setInstallEvents(new Map());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RemoteInstall", () => {
  it("shows a validation error and does not call postInstall when required fields are empty", async () => {
    const user = userEvent.setup();
    render(<RemoteInstall />);

    await user.click(screen.getByRole("button", { name: "Install" }));

    expect(screen.getByText("Target IP is required.")).toBeInTheDocument();
    expect(mockedPostInstall).not.toHaveBeenCalled();
  });

  it("shows a validation error and does not call postInstall for a non-positive or non-integer SSH port", async () => {
    const user = userEvent.setup();
    render(<RemoteInstall />);

    await user.type(screen.getByLabelText("Target IP"), "10.0.0.5");
    await user.type(screen.getByLabelText("Username"), "root");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.type(screen.getByLabelText("Sudo password"), "sudosecret");

    const portInput = screen.getByLabelText("SSH port");
    const form = screen.getByRole("button", { name: "Install" }).closest("form")!;

    await user.clear(portInput);
    await user.type(portInput, "0");
    fireEvent.submit(form);
    expect(screen.getByText("SSH port must be a positive integer.")).toBeInTheDocument();
    expect(mockedPostInstall).not.toHaveBeenCalled();

    await user.clear(portInput);
    await user.type(portInput, "2.5");
    fireEvent.submit(form);
    expect(screen.getByText("SSH port must be a positive integer.")).toBeInTheDocument();
    expect(mockedPostInstall).not.toHaveBeenCalled();
  });

  it("shows a validation error and does not call postInstall when the sudo password is empty", async () => {
    const user = userEvent.setup();
    render(<RemoteInstall />);

    await user.type(screen.getByLabelText("Target IP"), "10.0.0.5");
    await user.type(screen.getByLabelText("Username"), "root");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Install" }));

    expect(screen.getByText("Sudo password is required.")).toBeInTheDocument();
    expect(mockedPostInstall).not.toHaveBeenCalled();
  });

  it("calls postInstall with the exact trimmed values and switches to the progress view on success", async () => {
    const user = userEvent.setup();
    mockedPostInstall.mockResolvedValue({ installId: "install-1" });
    render(<RemoteInstall />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Install" }));

    expect(mockedPostInstall).toHaveBeenCalledWith({
      targetIp: "10.0.0.5",
      sshPort: 2222,
      username: "root",
      password: "hunter2",
      sudoPassword: "sudosecret",
    });

    expect(screen.getByText("Waiting for progress updates…")).toBeInTheDocument();
    const status = document.querySelector(".empty-state");
    expect(status?.textContent).toContain("Installing on");
  });

  it("renders each install_progress event as installEvents grows", async () => {
    const user = userEvent.setup();
    mockedPostInstall.mockResolvedValue({ installId: "install-1" });
    const { rerender } = render(<RemoteInstall />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Install" }));

    const e1 = makeInstallEvent({ stage: "connecting", message: "Connecting to host" });
    setInstallEvents(new Map([["install-1", [e1]]]));
    rerender(<RemoteInstall />);

    expect(screen.getByText("Connecting")).toBeInTheDocument();
    expect(screen.getByText("Connecting to host")).toBeInTheDocument();

    const e2 = makeInstallEvent({ stage: "deploying_key", message: "Deploying SSH key" });
    setInstallEvents(new Map([["install-1", [e1, e2]]]));
    rerender(<RemoteInstall />);

    expect(screen.getByText("Connecting to host")).toBeInTheDocument();
    expect(screen.getByText("Deploying key")).toBeInTheDocument();
    expect(screen.getByText("Deploying SSH key")).toBeInTheDocument();
  });

  it("shows a success banner and a reset button on a terminal done/success event", async () => {
    const user = userEvent.setup();
    mockedPostInstall.mockResolvedValue({ installId: "install-1" });
    const { rerender } = render(<RemoteInstall />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Install" }));

    const doneEvent = makeInstallEvent({ stage: "done", message: "All set", success: true });
    setInstallEvents(new Map([["install-1", [doneEvent]]]));
    rerender(<RemoteInstall />);

    const banner = screen.getByText("Install succeeded: All set");
    expect(banner).toHaveClass("install-result-ok");

    const resetButton = screen.getByRole("button", { name: "Start new install" });
    await user.click(resetButton);

    expect(screen.getByLabelText("Target IP")).toHaveValue("");
    expect(screen.queryByText("Install succeeded: All set")).toBeNull();
  });

  it("shows a failure banner with the message on a terminal failed event", async () => {
    const user = userEvent.setup();
    mockedPostInstall.mockResolvedValue({ installId: "install-1" });
    const { rerender } = render(<RemoteInstall />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Install" }));

    const failedEvent = makeInstallEvent({ stage: "failed", message: "Connection refused", success: false });
    setInstallEvents(new Map([["install-1", [failedEvent]]]));
    rerender(<RemoteInstall />);

    const banner = screen.getByText("Install failed: Connection refused");
    expect(banner).toHaveClass("install-result-fail");
  });

  it("shows a visible error and does not swallow a rejected postInstall call", async () => {
    const user = userEvent.setup();
    mockedPostInstall.mockRejectedValue(new Error("400 Bad Request"));
    render(<RemoteInstall />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Install" }));

    expect(await screen.findByText(/400 Bad Request/)).toBeInTheDocument();
    expect(screen.queryByText("Waiting for progress updates…")).toBeNull();
  });
});
