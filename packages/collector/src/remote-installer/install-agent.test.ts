import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallProgressEvent, InstallRequest } from "@labmon/shared";
import { OfflineStateMachine } from "../state-machine.js";
import { Storage } from "../storage/db.js";

const { execMock, uploadFileMock, uploadLocalFileMock, closeMock, connectMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  uploadFileMock: vi.fn(),
  uploadLocalFileMock: vi.fn(),
  closeMock: vi.fn(),
  connectMock: vi.fn(),
}));

vi.mock("./ssh-session.js", () => ({
  SshSession: { connect: connectMock },
}));

vi.mock("./ssh-key.js", () => ({
  ensureCollectorKeyPair: vi.fn(() => ({
    privateKeyPath: "/fake/collector_id_ed25519",
    publicKey: "ssh-ed25519 AAAAfakekeydata collector",
  })),
}));

import { runInstall, type InstallAgentDeps } from "./install-agent.js";
import { createRemoteInstaller } from "./index.js";

const sessionMock = {
  exec: execMock,
  uploadFile: uploadFileMock,
  uploadLocalFile: uploadLocalFileMock,
  close: closeMock,
};

function okExecResult() {
  return { code: 0, stdout: "", stderr: "" };
}

const request: InstallRequest = {
  targetIp: "192.168.1.50",
  sshPort: 22,
  username: "ubuntu",
  password: "hunter2",
};

describe("runInstall", () => {
  let dir: string;
  let storage: Storage;
  let stateMachine: OfflineStateMachine;
  let agentBinaryPath: string;
  let events: InstallProgressEvent[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "labmon-install-agent-"));
    storage = new Storage(join(dir, "test.db"));
    stateMachine = new OfflineStateMachine();
    agentBinaryPath = join(dir, "agent-binary");
    writeFileSync(agentBinaryPath, "fake binary contents");
    events = [];

    connectMock.mockReset().mockResolvedValue(sessionMock);
    execMock.mockReset().mockResolvedValue(okExecResult());
    uploadFileMock.mockReset().mockResolvedValue(undefined);
    uploadLocalFileMock.mockReset().mockResolvedValue(undefined);
    closeMock.mockReset();
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function makeDeps(overrides: Partial<InstallAgentDeps> = {}): InstallAgentDeps {
    return {
      storage,
      stateMachine,
      sshKeyPath: "/fake/collector_id_ed25519",
      agentBinaryPath,
      collectorWsUrl: "ws://localhost:8080",
      connectTimeoutMs: 500,
      waitForConnectionTimeoutMs: 500,
      emit: (event) => events.push(event),
      ...overrides,
    };
  }

  it("succeeds end to end once the state machine sees the new host come online", async () => {
    const deps = makeDeps({
      emit: (event) => {
        events.push(event);
        if (event.stage === "waiting_for_connection" && event.hostId) {
          setTimeout(() => stateMachine.signalUp(event.hostId as string), 10);
        }
      },
    });

    await runInstall(randomUUID(), request, deps);

    const last = events[events.length - 1];
    expect(last.stage).toBe("done");
    expect(last.success).toBe(true);
    expect(last.hostId).toBeDefined();

    const host = storage.getHost(last.hostId as string);
    expect(host).toEqual({ id: last.hostId, name: request.targetIp, type: "agent" });

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("fails with the underlying error message when SSH connect fails", async () => {
    connectMock.mockRejectedValueOnce(new Error("ECONNREFUSED test"));
    const deps = makeDeps();

    await runInstall(randomUUID(), request, deps);

    const last = events[events.length - 1];
    expect(last.stage).toBe("failed");
    expect(last.success).toBe(false);
    expect(last.message).toContain("ECONNREFUSED test");
  });

  it("fails with a connection-timeout message (not a generic SSH error) when the agent never phones home", async () => {
    vi.useFakeTimers();
    const waitForConnectionTimeoutMs = 500;
    const deps = makeDeps({ waitForConnectionTimeoutMs });

    const installPromise = runInstall(randomUUID(), request, deps);
    await vi.advanceTimersByTimeAsync(waitForConnectionTimeoutMs + 50);
    await installPromise;

    const last = events[events.length - 1];
    expect(last.stage).toBe("failed");
    expect(last.success).toBe(false);
    expect(last.message).toContain("never connected back");
    expect(last.message).not.toContain("ECONNREFUSED");
    expect(last.message).not.toMatch(/exit \d/i);
  });

  it("fails naming the missing path when the agent binary does not exist, without attempting the upload", async () => {
    const missingPath = join(dir, "does-not-exist-agent");
    const deps = makeDeps({ agentBinaryPath: missingPath });

    await runInstall(randomUUID(), request, deps);

    const last = events[events.length - 1];
    expect(last.stage).toBe("failed");
    expect(last.success).toBe(false);
    expect(last.message).toContain(missingPath);

    expect(uploadLocalFileMock).not.toHaveBeenCalled();
  });
});

describe("RemoteInstaller.installAgent", () => {
  let dir: string;
  let storage: Storage;
  let stateMachine: OfflineStateMachine;
  let agentBinaryPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "labmon-remote-installer-"));
    storage = new Storage(join(dir, "test.db"));
    stateMachine = new OfflineStateMachine();
    agentBinaryPath = join(dir, "agent-binary");
    writeFileSync(agentBinaryPath, "fake binary contents");

    connectMock.mockReset().mockResolvedValue(sessionMock);
    execMock.mockReset().mockResolvedValue(okExecResult());
    uploadFileMock.mockReset().mockResolvedValue(undefined);
    uploadLocalFileMock.mockReset().mockResolvedValue(undefined);
    closeMock.mockReset();
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an installId synchronously without waiting for the SSH flow to finish", () => {
    const remoteInstaller = createRemoteInstaller({
      storage,
      stateMachine,
      agentBinaryPath,
      connectTimeoutMs: 50,
      waitForConnectionTimeoutMs: 50,
    });

    const installId = remoteInstaller.installAgent(request);

    expect(typeof installId).toBe("string");
    expect(installId.length).toBeGreaterThan(0);
  });
});
