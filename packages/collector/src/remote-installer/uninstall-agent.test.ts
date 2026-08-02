import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UninstallProgressEvent, UninstallRequest } from "@labmon/shared";
import { OfflineStateMachine } from "../state-machine.js";
import { Storage } from "../storage/db.js";

const { execMock, closeMock, connectMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  closeMock: vi.fn(),
  connectMock: vi.fn(),
}));

vi.mock("./ssh-session.js", () => ({
  SshSession: { connect: connectMock },
}));

import { runUninstall, type UninstallAgentDeps } from "./uninstall-agent.js";

const sessionMock = { exec: execMock, close: closeMock };

function okExecResult() {
  return { code: 0, stdout: "", stderr: "" };
}

const request: UninstallRequest = {
  targetIp: "192.168.1.50",
  sshPort: 22,
  username: "ubuntu",
  password: "hunter2",
  sudoPassword: "sudosecret",
};

describe("runUninstall", () => {
  let dir: string;
  let storage: Storage;
  let stateMachine: OfflineStateMachine;
  let onHostRemovedMock: ReturnType<typeof vi.fn>;
  let events: UninstallProgressEvent[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "labmon-uninstall-agent-"));
    storage = new Storage(join(dir, "test.db"));
    stateMachine = new OfflineStateMachine();
    onHostRemovedMock = vi.fn();
    events = [];

    connectMock.mockReset().mockResolvedValue(sessionMock);
    execMock.mockReset().mockResolvedValue(okExecResult());
    closeMock.mockReset();
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function makeDeps(overrides: Partial<UninstallAgentDeps> = {}): UninstallAgentDeps {
    return {
      storage,
      stateMachine,
      connectTimeoutMs: 500,
      waitForDisconnectTimeoutMs: 500,
      onHostRemoved: onHostRemovedMock,
      emit: (event) => events.push(event),
      ...overrides,
    };
  }

  it("stops/removes the service, deletes the DB row, and notifies onHostRemoved once the agent disconnects", async () => {
    storage.upsertHost({ id: "h1", name: "Host One", type: "agent" });
    stateMachine.signalUp("h1");

    const deps = makeDeps({
      emit: (event) => {
        events.push(event);
        if (event.stage === "waiting_for_disconnect") {
          setTimeout(() => stateMachine.signalDown("h1"), 10);
        }
      },
    });

    await runUninstall(randomUUID(), "h1", request, deps);

    const last = events[events.length - 1];
    expect(last.stage).toBe("done");
    expect(last.success).toBe(true);

    expect(storage.getHost("h1")).toBeUndefined();
    expect(stateMachine.getHostState("h1")).toBeUndefined();
    expect(onHostRemovedMock).toHaveBeenCalledWith("h1");
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("pipes the sudo password once per chained sudo -S invocation", async () => {
    storage.upsertHost({ id: "h1", name: "Host One", type: "agent" });
    stateMachine.signalUp("h1");

    const deps = makeDeps({
      emit: (event) => {
        events.push(event);
        if (event.stage === "waiting_for_disconnect") {
          setTimeout(() => stateMachine.signalDown("h1"), 10);
        }
      },
    });

    await runUninstall(randomUUID(), "h1", request, deps);

    const sudoCalls = execMock.mock.calls.filter(([command]: [string]) => command.includes("sudo -S"));
    expect(sudoCalls).toHaveLength(1);

    const [command, stdin] = sudoCalls[0];
    const sudoCount = (command.match(/sudo -S/g) ?? []).length;
    expect(stdin).toBe("sudosecret\n".repeat(sudoCount));
  });

  it("does not delete the DB row when the agent never disconnects within the timeout", async () => {
    vi.useFakeTimers();
    storage.upsertHost({ id: "h1", name: "Host One", type: "agent" });
    stateMachine.signalUp("h1");
    const waitForDisconnectTimeoutMs = 500;
    const deps = makeDeps({ waitForDisconnectTimeoutMs });

    const uninstallPromise = runUninstall(randomUUID(), "h1", request, deps);
    await vi.advanceTimersByTimeAsync(waitForDisconnectTimeoutMs + 50);
    await uninstallPromise;

    const last = events[events.length - 1];
    expect(last.stage).toBe("failed");
    expect(last.success).toBe(false);
    expect(last.message).toContain("never disconnected");

    expect(storage.getHost("h1")).toBeDefined();
    expect(onHostRemovedMock).not.toHaveBeenCalled();
  });

  it("fails with the underlying error message when SSH connect fails, without touching storage", async () => {
    storage.upsertHost({ id: "h1", name: "Host One", type: "agent" });
    stateMachine.signalUp("h1");
    connectMock.mockRejectedValueOnce(new Error("ECONNREFUSED test"));

    await runUninstall(randomUUID(), "h1", request, makeDeps());

    const last = events[events.length - 1];
    expect(last.stage).toBe("failed");
    expect(last.success).toBe(false);
    expect(last.message).toContain("ECONNREFUSED test");
    expect(storage.getHost("h1")).toBeDefined();
  });

  it("fails when the remote stop/remove command exits non-zero, without touching storage", async () => {
    storage.upsertHost({ id: "h1", name: "Host One", type: "agent" });
    stateMachine.signalUp("h1");
    execMock.mockResolvedValue({ code: 1, stdout: "", stderr: "permission denied" });

    await runUninstall(randomUUID(), "h1", request, makeDeps());

    const last = events[events.length - 1];
    expect(last.stage).toBe("failed");
    expect(last.success).toBe(false);
    expect(last.message).toContain("permission denied");
    expect(storage.getHost("h1")).toBeDefined();
  });
});
