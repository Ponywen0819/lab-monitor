import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { InstallProgressEvent, InstallRequest, InstallStage } from "@labmon/shared";
import type { Storage } from "../storage/db.js";
import type { OfflineStateMachine, StatusChangeEvent } from "../state-machine.js";
import { SshSession } from "./ssh-session.js";
import { renderSystemdUnit } from "./systemd-unit.js";

export interface InstallAgentDeps {
  storage: Storage;
  stateMachine: OfflineStateMachine;
  agentBinaryDir: string;
  collectorWsUrl: string;
  connectTimeoutMs: number;
  waitForConnectionTimeoutMs: number;
  emit: (event: InstallProgressEvent) => void;
}

type AgentArch = "x64" | "arm64";

// The lab isn't necessarily one CPU architecture (e.g. a mix of x86_64
// desktops and ARM boards) -- packages/collector/Dockerfile builds one Bun
// binary per architecture, so the right one is picked per target instead of
// baking in a single assumption at build time.
async function detectRemoteArch(session: SshSession): Promise<AgentArch> {
  const result = await session.exec("uname -m");
  const arch = result.stdout.trim();
  if (arch === "x86_64") return "x64";
  if (arch === "aarch64" || arch === "arm64") return "arm64";
  throw new Error(`unsupported target architecture "${arch}" from uname -m (only x86_64 and aarch64/arm64 are built)`);
}

function agentBinaryPathFor(agentBinaryDir: string, arch: AgentArch): string {
  return join(agentBinaryDir, `agent-linux-${arch}`);
}

// Best-effort only -- a locked-down shell without `hostname`, or one that
// returns nothing, falls back to the IP the operator typed in rather than
// failing the whole install over what's just a cosmetic dashboard label.
async function detectRemoteHostname(session: SshSession): Promise<string | null> {
  const result = await session.exec("hostname");
  const hostname = result.stdout.trim();
  return result.code === 0 && hostname.length > 0 ? hostname : null;
}

const AGENT_REMOTE_DIR = "/opt/labmon-agent";
const CONFIG_REMOTE_DIR = "/etc/labmon-agent";
const CONFIG_REMOTE_PATH = `${CONFIG_REMOTE_DIR}/config.json`;
const SYSTEMD_UNIT_PATH = "/etc/systemd/system/labmon-agent.service";

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

    session = await SshSession.connect(
      { host: request.targetIp, port: request.sshPort, username: request.username },
      { method: "password", password: request.password },
      deps.connectTimeoutMs
    );

    const remoteHostname = await detectRemoteHostname(session);

    const hostId = randomUUID();
    // Registered as soon as the hostId exists, before uploading/waiting, so
    // the host is visible (as not-yet-online) even while install is in flight.
    deps.storage.upsertHost({ id: hostId, name: remoteHostname ?? request.targetIp, type: "agent" });

    emitStage("uploading_agent", "Uploading agent binary and configuration", { hostId });

    const arch = await detectRemoteArch(session);
    const agentBinaryPath = agentBinaryPathFor(deps.agentBinaryDir, arch);

    if (!existsSync(agentBinaryPath)) {
      emitStage(
        "failed",
        `agent binary not found at ${agentBinaryPath} -- build packages/agent first`,
        { hostId, success: false }
      );
      return;
    }

    await uploadAgent(session, agentBinaryPath, hostId, deps.collectorWsUrl, request.sudoPassword);

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
