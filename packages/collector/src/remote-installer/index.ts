/**
 * Remote Installer submodule.
 *
 * A task-based SSH execution engine. The only task type today is "install the
 * Agent binary on a target Ubuntu host", exposed as the single public method
 * installAgent(). It is deliberately NOT a general remote-shell API -- see
 * ssh-session.ts for why an open exec(anyCommand) surface is a non-goal.
 *
 * Config (env vars):
 *   COLLECTOR_SSH_KEY_PATH  Where the collector's own persistent Ed25519
 *                           identity keypair lives. Generated lazily on first
 *                           use if missing. Default "./data/ssh/collector_id_ed25519".
 *   AGENT_BINARY_PATH       Local path to the built Agent binary to upload.
 *                           Default "../agent/dist-bin/agent" relative to this
 *                           package (packages/agent/dist-bin/agent).
 *   COLLECTOR_WS_URL        The URL the freshly installed agent should dial
 *                           back to, written into its config.json, e.g.
 *                           "ws://<this-host>:8080".
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstallProgressEvent, InstallRequest } from "@labmon/shared";
import type { Storage } from "../storage/db.js";
import type { OfflineStateMachine } from "../state-machine.js";
import { runInstall } from "./install-agent.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

const DEFAULT_SSH_KEY_PATH = "./data/ssh/collector_id_ed25519";
// remote-installer/ -> src|dist -> collector -> packages, then into agent/.
const DEFAULT_AGENT_BINARY_PATH = resolve(moduleDir, "../../../agent/dist-bin/agent");
const DEFAULT_COLLECTOR_WS_URL = "ws://localhost:8080";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_FOR_CONNECTION_TIMEOUT_MS = 30_000;

export interface RemoteInstallerOptions {
  storage: Storage;
  stateMachine: OfflineStateMachine;
  sshKeyPath?: string;
  agentBinaryPath?: string;
  collectorWsUrl?: string;
  connectTimeoutMs?: number;
  waitForConnectionTimeoutMs?: number;
}

export interface RemoteInstallerEvents {
  /** Fired for every stage transition of every installAgent() call, tagged by installId. */
  progress: (event: InstallProgressEvent) => void;
}

export declare interface RemoteInstaller {
  on<E extends keyof RemoteInstallerEvents>(event: E, listener: RemoteInstallerEvents[E]): this;
  off<E extends keyof RemoteInstallerEvents>(event: E, listener: RemoteInstallerEvents[E]): this;
  emit<E extends keyof RemoteInstallerEvents>(event: E, ...args: Parameters<RemoteInstallerEvents[E]>): boolean;
}

export class RemoteInstaller extends EventEmitter {
  private readonly storage: Storage;
  private readonly stateMachine: OfflineStateMachine;
  private readonly sshKeyPath: string;
  private readonly agentBinaryPath: string;
  private readonly collectorWsUrl: string;
  private readonly connectTimeoutMs: number;
  private readonly waitForConnectionTimeoutMs: number;

  constructor(options: RemoteInstallerOptions) {
    super();
    this.storage = options.storage;
    this.stateMachine = options.stateMachine;
    this.sshKeyPath = options.sshKeyPath ?? process.env.COLLECTOR_SSH_KEY_PATH ?? DEFAULT_SSH_KEY_PATH;
    this.agentBinaryPath = options.agentBinaryPath ?? process.env.AGENT_BINARY_PATH ?? DEFAULT_AGENT_BINARY_PATH;
    this.collectorWsUrl = options.collectorWsUrl ?? process.env.COLLECTOR_WS_URL ?? DEFAULT_COLLECTOR_WS_URL;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.waitForConnectionTimeoutMs = options.waitForConnectionTimeoutMs ?? DEFAULT_WAIT_FOR_CONNECTION_TIMEOUT_MS;
  }

  /**
   * Mints and returns an installId synchronously; the SSH flow itself runs in
   * the background. Observe progress via the "progress" event, filtering on
   * this installId -- future HTTP/WS wiring can relay those events as-is to
   * the frontend using InstallProgressEvent's shape directly.
   */
  installAgent(request: InstallRequest): string {
    const installId = randomUUID();

    void runInstall(installId, request, {
      storage: this.storage,
      stateMachine: this.stateMachine,
      sshKeyPath: this.sshKeyPath,
      agentBinaryPath: this.agentBinaryPath,
      collectorWsUrl: this.collectorWsUrl,
      connectTimeoutMs: this.connectTimeoutMs,
      waitForConnectionTimeoutMs: this.waitForConnectionTimeoutMs,
      emit: (event) => this.emit("progress", event),
    });

    return installId;
  }
}

export function createRemoteInstaller(options: RemoteInstallerOptions): RemoteInstaller {
  return new RemoteInstaller(options);
}
