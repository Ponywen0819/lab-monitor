import type { UninstallProgressEvent, UninstallRequest, UninstallStage } from "@labmon/shared";
import type { Storage } from "../storage/db.js";
import type { OfflineStateMachine, StatusChangeEvent } from "../state-machine.js";
import { AGENT_REMOTE_DIR, CONFIG_REMOTE_DIR, SYSTEMD_UNIT_PATH, sudoStdin } from "./install-agent.js";
import { SshSession } from "./ssh-session.js";

export interface UninstallAgentDeps {
  storage: Storage;
  stateMachine: OfflineStateMachine;
  connectTimeoutMs: number;
  waitForDisconnectTimeoutMs: number;
  /** Same callback http-server.ts's DELETE uses -- keeps nasProber/broadcast in sync. */
  onHostRemoved: (hostId: string) => void;
  emit: (event: UninstallProgressEvent) => void;
}

async function stopAndRemoveAgent(session: SshSession, sudoPassword: string): Promise<void> {
  const command = [
    `sudo -S -p '' systemctl disable --now labmon-agent.service`,
    `sudo -S -p '' rm -rf ${AGENT_REMOTE_DIR}`,
    `sudo -S -p '' rm -rf ${CONFIG_REMOTE_DIR}`,
    `sudo -S -p '' rm -f ${SYSTEMD_UNIT_PATH}`,
    `sudo -S -p '' systemctl daemon-reload`,
  ].join(" && ");

  const result = await session.exec(command, sudoStdin(sudoPassword, command));
  if (result.code !== 0) {
    throw new Error(`failed to stop/remove labmon-agent.service (exit ${result.code}): ${result.stderr || result.stdout}`);
  }
}

/**
 * Resolves once the state machine sees the host leave "online" (the WS
 * connection drops the instant systemctl kills the process), or false on
 * timeout. Mirrors install-agent.ts's waitForOnline.
 */
function waitForOffline(stateMachine: OfflineStateMachine, hostId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (stateMachine.getHostState(hostId)?.status !== "online") {
      resolve(true);
      return;
    }

    const onChange = (event: StatusChangeEvent): void => {
      if (event.hostId !== hostId || event.status === "online") return;
      clearTimeout(timer);
      stateMachine.off("statusChange", onChange);
      resolve(true);
    };

    const timer = setTimeout(() => {
      stateMachine.off("statusChange", onChange);
      resolve(false);
    }, timeoutMs);

    stateMachine.on("statusChange", onChange);
  });
}

export async function runUninstall(
  uninstallId: string,
  hostId: string,
  request: UninstallRequest,
  deps: UninstallAgentDeps
): Promise<void> {
  const emitStage = (stage: UninstallStage, message: string, extra?: Partial<UninstallProgressEvent>): void => {
    deps.emit({ uninstallId, hostId, stage, message, timestamp: Date.now(), ...extra });
  };

  let session: SshSession | undefined;

  try {
    emitStage("connecting", `Connecting to ${request.targetIp}:${request.sshPort} as ${request.username}`);

    session = await SshSession.connect(
      { host: request.targetIp, port: request.sshPort, username: request.username },
      { method: "password", password: request.password },
      deps.connectTimeoutMs
    );

    emitStage("stopping_service", "Stopping and removing labmon-agent.service");
    await stopAndRemoveAgent(session, request.sudoPassword);

    emitStage("waiting_for_disconnect", "Waiting for the agent to disconnect");

    // Same rationale as install's waitForOnline gate: the SSH steps
    // succeeding isn't proof the process is actually gone, only the state
    // machine observing the WS connection drop is.
    const disconnected = await waitForOffline(deps.stateMachine, hostId, deps.waitForDisconnectTimeoutMs);

    if (!disconnected) {
      emitStage(
        "failed",
        `Agent files removed but it never disconnected within ${deps.waitForDisconnectTimeoutMs}ms -- record was not deleted`,
        { success: false }
      );
      return;
    }

    deps.storage.deleteHost(hostId);
    deps.stateMachine.removeHost(hostId);
    deps.onHostRemoved(hostId);

    emitStage("done", "Agent uninstalled and host record removed", { success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitStage("failed", `Uninstall failed: ${message}`, { success: false });
  } finally {
    session?.close();
  }
}
