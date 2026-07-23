import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { InstallProgressEvent, InstallRequest, InstallStage } from "@labmon/shared";
import type { Storage } from "../storage/db.js";
import type { OfflineStateMachine, StatusChangeEvent } from "../state-machine.js";
import { ensureCollectorKeyPair } from "./ssh-key.js";
import { SshSession } from "./ssh-session.js";
import { renderSystemdUnit } from "./systemd-unit.js";

export interface InstallAgentDeps {
  storage: Storage;
  stateMachine: OfflineStateMachine;
  sshKeyPath: string;
  agentBinaryPath: string;
  collectorWsUrl: string;
  connectTimeoutMs: number;
  waitForConnectionTimeoutMs: number;
  emit: (event: InstallProgressEvent) => void;
}

const AGENT_REMOTE_DIR = "/opt/labmon-agent";
const CONFIG_REMOTE_DIR = "/etc/labmon-agent";
const CONFIG_REMOTE_PATH = `${CONFIG_REMOTE_DIR}/config.json`;
const SYSTEMD_UNIT_PATH = "/etc/systemd/system/labmon-agent.service";

async function deployAuthorizedKey(session: SshSession, publicKey: string): Promise<void> {
  // publicKey is our own freshly generated key, not caller input, but it's
  // still quoted defensively since it's interpolated into a shell command.
  const escaped = publicKey.replace(/'/g, `'\\''`);
  const cmd = [
    "mkdir -p ~/.ssh",
    "chmod 700 ~/.ssh",
    "touch ~/.ssh/authorized_keys",
    "chmod 600 ~/.ssh/authorized_keys",
    `grep -qxF '${escaped}' ~/.ssh/authorized_keys || echo '${escaped}' >> ~/.ssh/authorized_keys`,
  ].join(" && ");

  const result = await session.exec(cmd);
  if (result.code !== 0) {
    throw new Error(`failed to deploy authorized_keys (exit ${result.code}): ${result.stderr || result.stdout}`);
  }
}

// sudo -S reads exactly one line per invocation and otherwise ignores stdin
// (a NOPASSWD sudoer never touches it at all), so supplying one password
// line per chained "sudo -S" in the command is correct whether or not this
// target actually needs one -- no upfront detection required.
function sudoStdin(sudoPassword: string, command: string): string {
  const invocations = command.split("sudo -S").length - 1;
  return `${sudoPassword}\n`.repeat(invocations);
}

async function uploadAgent(
  session: SshSession,
  agentBinaryPath: string,
  hostId: string,
  collectorWsUrl: string,
  sudoPassword: string
): Promise<void> {
  const stagingDir = `/tmp/labmon-install-${hostId}`;
  const mkdirResult = await session.exec(`mkdir -p ${stagingDir}`);
  if (mkdirResult.code !== 0) {
    throw new Error(`failed to create staging dir (exit ${mkdirResult.code}): ${mkdirResult.stderr}`);
  }

  await session.uploadLocalFile(agentBinaryPath, `${stagingDir}/agent`);
  await session.uploadFile(`${stagingDir}/config.json`, JSON.stringify({ hostId, collectorWsUrl }, null, 2));
  await session.uploadFile(`${stagingDir}/labmon-agent.service`, renderSystemdUnit());

  // The staging dir is writable by the SSH user without sudo; moving into
  // place under /opt and /etc is what needs privilege. -p '' suppresses the
  // "[sudo] password for x:" prompt text, which would otherwise land in
  // stdout/stderr since this runs over a non-interactive exec channel.
  const installCmd = [
    `sudo -S -p '' mkdir -p ${AGENT_REMOTE_DIR} ${CONFIG_REMOTE_DIR}`,
    `sudo -S -p '' mv ${stagingDir}/agent ${AGENT_REMOTE_DIR}/agent`,
    `sudo -S -p '' chmod 755 ${AGENT_REMOTE_DIR}/agent`,
    `sudo -S -p '' mv ${stagingDir}/config.json ${CONFIG_REMOTE_PATH}`,
    `sudo -S -p '' chmod 644 ${CONFIG_REMOTE_PATH}`,
    `sudo -S -p '' mv ${stagingDir}/labmon-agent.service ${SYSTEMD_UNIT_PATH}`,
    `sudo -S -p '' chmod 644 ${SYSTEMD_UNIT_PATH}`,
    `rmdir ${stagingDir}`,
  ].join(" && ");

  const result = await session.exec(installCmd, sudoStdin(sudoPassword, installCmd));
  if (result.code !== 0) {
    throw new Error(`failed to install agent files (exit ${result.code}): ${result.stderr || result.stdout}`);
  }
}

async function startService(session: SshSession, sudoPassword: string): Promise<void> {
  const command = "sudo -S -p '' systemctl daemon-reload && sudo -S -p '' systemctl enable --now labmon-agent.service";
  const result = await session.exec(command, sudoStdin(sudoPassword, command));
  if (result.code !== 0) {
    throw new Error(`failed to start labmon-agent.service (exit ${result.code}): ${result.stderr || result.stdout}`);
  }
}

/**
 * Resolves once the agent phones home over WS, or false on timeout. Listens
 * on the shared state-machine's statusChange event rather than polling on an
 * interval: signalUp() already emits synchronously the moment the agent's WS
 * connection is accepted, so there's nothing a poll loop would catch sooner.
 */
function waitForOnline(stateMachine: OfflineStateMachine, hostId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (stateMachine.getHostState(hostId)?.status === "online") {
      resolve(true);
      return;
    }

    const onChange = (event: StatusChangeEvent): void => {
      if (event.hostId !== hostId || event.status !== "online") return;
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

export async function runInstall(installId: string, request: InstallRequest, deps: InstallAgentDeps): Promise<void> {
  const emitStage = (stage: InstallStage, message: string, extra?: Partial<InstallProgressEvent>): void => {
    deps.emit({ installId, stage, message, timestamp: Date.now(), ...extra });
  };

  let session: SshSession | undefined;

  try {
    emitStage("connecting", `Connecting to ${request.targetIp}:${request.sshPort} as ${request.username}`);

    const keyPair = ensureCollectorKeyPair(deps.sshKeyPath);

    session = await SshSession.connect(
      { host: request.targetIp, port: request.sshPort, username: request.username },
      { method: "password", password: request.password },
      deps.connectTimeoutMs
    );

    emitStage("deploying_key", "Installing collector's public key into authorized_keys");
    await deployAuthorizedKey(session, keyPair.publicKey);

    const hostId = randomUUID();
    // Registered as soon as the hostId exists, before uploading/waiting, so
    // the host is visible (as not-yet-online) even while install is in flight.
    deps.storage.upsertHost({ id: hostId, name: request.targetIp, type: "agent" });

    emitStage("uploading_agent", "Uploading agent binary and configuration", { hostId });

    if (!existsSync(deps.agentBinaryPath)) {
      emitStage(
        "failed",
        `agent binary not found at ${deps.agentBinaryPath} -- build packages/agent first`,
        { hostId, success: false }
      );
      return;
    }

    await uploadAgent(session, deps.agentBinaryPath, hostId, deps.collectorWsUrl, request.sudoPassword);

    emitStage("starting_service", "Enabling and starting labmon-agent.service", { hostId });
    await startService(session, request.sudoPassword);

    emitStage("waiting_for_connection", "Waiting for the agent to connect back to the collector", { hostId });

    // The SSH steps all reporting success is not proof the agent is actually
    // running and reachable (wrong systemd state, binary crash-looping,
    // firewall blocking the WS port, wrong collectorWsUrl, ...). The only
    // signal that matters is the agent itself showing up over WS, so success
    // is gated on the state machine, never on exec exit codes alone.
    const connected = await waitForOnline(deps.stateMachine, hostId, deps.waitForConnectionTimeoutMs);

    if (connected) {
      emitStage("done", "Agent installed and connected successfully", { hostId, success: true });
    } else {
      emitStage(
        "failed",
        `SSH install steps completed but the agent never connected back within ${deps.waitForConnectionTimeoutMs}ms`,
        { hostId, success: false }
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitStage("failed", `Install failed: ${message}`, { success: false });
  } finally {
    session?.close();
  }
}
