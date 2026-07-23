import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemConfig } from "@labmon/shared";
import { fetchConfig, updateConfig } from "../api/client";
import { Settings } from "./Settings";

vi.mock("../api/client", () => ({
  fetchConfig: vi.fn(),
  updateConfig: vi.fn(),
}));

const mockedFetchConfig = vi.mocked(fetchConfig);
const mockedUpdateConfig = vi.mocked(updateConfig);

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
