import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NasHostConfig, SystemConfig } from "@labmon/shared";
import { addNasHost, deleteHost, fetchConfig, fetchNasHosts, updateConfig } from "../api/client";
import { Settings } from "./Settings";

vi.mock("../api/client", () => ({
  fetchConfig: vi.fn(),
  updateConfig: vi.fn(),
  fetchNasHosts: vi.fn(),
  addNasHost: vi.fn(),
  deleteHost: vi.fn(),
}));

const mockedFetchConfig = vi.mocked(fetchConfig);
const mockedUpdateConfig = vi.mocked(updateConfig);
const mockedFetchNasHosts = vi.mocked(fetchNasHosts);
const mockedAddNasHost = vi.mocked(addNasHost);
const mockedDeleteHost = vi.mocked(deleteHost);

beforeEach(() => {
  // Most tests below only exercise the notify-email form; give the NasHosts
  // section a harmless empty default so it doesn't dangle in a loading state.
  mockedFetchNasHosts.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Settings", () => {
  it("shows a loading state before fetchConfig resolves, then populates the input", async () => {
    let resolveFetch: (config: SystemConfig) => void = () => {};
    mockedFetchConfig.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    render(<Settings />);

    expect(screen.getByText("Loading settings…")).toBeInTheDocument();

    resolveFetch({ notifyEmail: "existing@example.com" });

    await waitFor(() => {
      expect(screen.getByLabelText("Notification email")).toHaveValue("existing@example.com");
    });
    expect(screen.queryByText("Loading settings…")).toBeNull();
  });

  it("populates an empty input when the fetched notifyEmail is null", async () => {
    mockedFetchConfig.mockResolvedValue({ notifyEmail: null });
    render(<Settings />);

    await waitFor(() => {
      expect(screen.getByLabelText("Notification email")).toHaveValue("");
    });
  });

  it("shows a load-error state when fetchConfig rejects", async () => {
    mockedFetchConfig.mockRejectedValue(new Error("network down"));
    render(<Settings />);

    expect(await screen.findByText(/Failed to load settings:/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Notification email")).toBeNull();
  });

  it("shows a validation error for an invalid email and does not call updateConfig", async () => {
    const user = userEvent.setup();
    mockedFetchConfig.mockResolvedValue({ notifyEmail: null });
    render(<Settings />);

    const input = await screen.findByLabelText("Notification email");
    await user.type(input, "foo@bar");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(mockedUpdateConfig).not.toHaveBeenCalled();
  });

  it("calls updateConfig with the typed valid email and shows a saved confirmation", async () => {
    const user = userEvent.setup();
    mockedFetchConfig.mockResolvedValue({ notifyEmail: null });
    mockedUpdateConfig.mockResolvedValue({ notifyEmail: "new@example.com" });
    render(<Settings />);

    const input = await screen.findByLabelText("Notification email");
    await user.type(input, "new@example.com");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mockedUpdateConfig).toHaveBeenCalledWith("new@example.com");
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("shows a visible save error when updateConfig rejects", async () => {
    const user = userEvent.setup();
    mockedFetchConfig.mockResolvedValue({ notifyEmail: null });
    mockedUpdateConfig.mockRejectedValue(new Error("500 Internal Server Error"));
    render(<Settings />);

    const input = await screen.findByLabelText("Notification email");
    await user.type(input, "new@example.com");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/500 Internal Server Error/)).toBeInTheDocument();
    expect(screen.queryByText("Saved.")).toBeNull();
  });
});

describe("Settings NAS hosts", () => {
  beforeEach(() => {
    mockedFetchConfig.mockResolvedValue({ notifyEmail: null });
  });

  it("shows an empty state when no NAS hosts exist", async () => {
    render(<Settings />);
    expect(await screen.findByText("No NAS hosts added yet.")).toBeInTheDocument();
  });

  it("lists previously added NAS hosts with their IP", async () => {
    const hosts: NasHostConfig[] = [{ id: "nas-1", name: "Synology", ip: "10.0.0.5" }];
    mockedFetchNasHosts.mockResolvedValue(hosts);
    render(<Settings />);

    expect(await screen.findByText("Synology")).toBeInTheDocument();
    expect(screen.getByText("(10.0.0.5)")).toBeInTheDocument();
  });

  it("adds a NAS host and appends it to the list", async () => {
    const user = userEvent.setup();
    mockedAddNasHost.mockResolvedValue({ id: "nas-2", name: "QNAP", ip: "10.0.0.6" });
    render(<Settings />);

    await screen.findByText("No NAS hosts added yet.");
    await user.type(screen.getByPlaceholderText("Synology NAS"), "QNAP");
    await user.type(screen.getByPlaceholderText("10.0.0.5"), "10.0.0.6");
    await user.click(screen.getByRole("button", { name: "Add NAS host" }));

    expect(mockedAddNasHost).toHaveBeenCalledWith("QNAP", "10.0.0.6");
    expect(await screen.findByText("QNAP")).toBeInTheDocument();
  });

  it("shows a validation error instead of calling addNasHost when a field is blank", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    await screen.findByText("No NAS hosts added yet.");
    await user.type(screen.getByPlaceholderText("Synology NAS"), "QNAP");
    await user.click(screen.getByRole("button", { name: "Add NAS host" }));

    expect(screen.getByText("Enter both a name and an IP address.")).toBeInTheDocument();
    expect(mockedAddNasHost).not.toHaveBeenCalled();
  });

  it("removes a NAS host from the list on Remove", async () => {
    const user = userEvent.setup();
    mockedFetchNasHosts.mockResolvedValue([{ id: "nas-1", name: "Synology", ip: "10.0.0.5" }]);
    mockedDeleteHost.mockResolvedValue(undefined);
    render(<Settings />);

    await screen.findByText("Synology");
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(mockedDeleteHost).toHaveBeenCalledWith("nas-1");
    await waitFor(() => expect(screen.queryByText("Synology")).toBeNull());
  });
});
