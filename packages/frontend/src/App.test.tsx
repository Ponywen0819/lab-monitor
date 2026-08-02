import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHosts } from "./ws/WsProvider";
import App from "./App";

vi.mock("./ws/WsProvider", () => ({
  useHosts: vi.fn(),
}));

const mockedUseHosts = vi.mocked(useHosts);

function setForbidden(forbidden: boolean): void {
  mockedUseHosts.mockReturnValue({
    hosts: new Map(),
    connected: true,
    forbidden,
    installEvents: new Map(),
    uninstallEvents: new Map(),
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderApp() {
  return render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
}

describe("App", () => {
  it("renders the normal nav and routes when not forbidden", () => {
    setForbidden(false);
    renderApp();

    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Remote Install" })).toBeInTheDocument();
  });

  it("replaces the whole page with an access-denied message when forbidden, hiding navigation", () => {
    setForbidden(true);
    renderApp();

    expect(screen.getByText(/Access denied/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
  });
});
