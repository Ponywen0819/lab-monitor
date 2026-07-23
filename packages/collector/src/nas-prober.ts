import { spawn } from "node:child_process";
import { NAS_PING_INTERVAL_MS, type NasHostConfig } from "@labmon/shared";
import type { OfflineStateMachine } from "./state-machine.js";
import type { Storage } from "./storage/db.js";

/** Well under the poll interval so one hung ping can never delay the next cycle noticeably. */
const DEFAULT_PING_TIMEOUT_SECONDS = 2;

/**
 * Spawns the system `ping` rather than a raw-socket ICMP library, since the
 * collector process isn't assumed to have CAP_NET_RAW.
 */
function pingOnce(ip: string, timeoutSeconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("ping", ["-c", "1", "-W", String(timeoutSeconds), ip]);
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

export interface NasProberOptions {
  stateMachine: OfflineStateMachine;
  storage: Storage;
  intervalMs?: number;
  pingTimeoutSeconds?: number;
}

export interface NasProber {
  start(): void;
  stop(): void;
  /** Starts polling a newly frontend-added host without waiting for the next full cycle. */
  addHost(host: NasHostConfig): void;
  /** No-op if the id isn't currently tracked. */
  removeHost(id: string): void;
}

/**
 * Feeds ping results into the same OfflineStateMachine agent liveness uses,
 * so NAS hosts get identical disconnected/offline/notified escalation for free.
 * The host list itself lives in storage (added/removed via the HTTP API, see
 * http-server.ts POST/DELETE) -- this only tracks who to poll right now.
 */
export function createNasProber(options: NasProberOptions): NasProber {
  const { stateMachine, storage } = options;
  const intervalMs = options.intervalMs ?? NAS_PING_INTERVAL_MS;
  const pingTimeoutSeconds = options.pingTimeoutSeconds ?? DEFAULT_PING_TIMEOUT_SECONDS;

  const hosts = new Map<string, NasHostConfig>();
  let timer: NodeJS.Timeout | null = null;

  async function probe(host: NasHostConfig): Promise<void> {
    const alive = await pingOnce(host.ip, pingTimeoutSeconds);
    if (alive) {
      stateMachine.signalUp(host.id);
    } else {
      stateMachine.signalDown(host.id);
    }
  }

  async function pollOnce(): Promise<void> {
    await Promise.all([...hosts.values()].map(probe));
  }

  return {
    start(): void {
      for (const host of storage.listNasHosts()) {
        hosts.set(host.id, host);
      }

      void pollOnce();
      timer = setInterval(() => void pollOnce(), intervalMs);
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    addHost(host: NasHostConfig): void {
      hosts.set(host.id, host);
      void probe(host);
    },
    removeHost(id: string): void {
      hosts.delete(id);
    },
  };
}
