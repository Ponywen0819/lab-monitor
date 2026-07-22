import { spawn } from "node:child_process";
import { NAS_PING_INTERVAL_MS } from "@labmon/shared";
import type { OfflineStateMachine } from "./state-machine.js";
import type { Storage } from "./storage/db.js";

export interface NasHostConfig {
  id: string;
  name: string;
  ip: string;
}

/**
 * Parses and validates the NAS_HOSTS env var. Throws with a message pinpointing
 * the offending entry, since a malformed value should fail collector startup
 * loudly rather than silently probe zero hosts.
 */
export function parseNasHostsConfig(raw: string | undefined): NasHostConfig[] {
  if (!raw || raw.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`NAS_HOSTS is not valid JSON: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("NAS_HOSTS must be a JSON array");
  }

  return parsed.map((entry, index) => validateNasHost(entry, index));
}

function validateNasHost(entry: unknown, index: number): NasHostConfig {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`NAS_HOSTS[${index}] must be an object`);
  }

  const { id, name, ip } = entry as Record<string, unknown>;

  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`NAS_HOSTS[${index}].id must be a non-empty string`);
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`NAS_HOSTS[${index}].name must be a non-empty string`);
  }
  if (typeof ip !== "string" || ip.length === 0) {
    throw new Error(`NAS_HOSTS[${index}].ip must be a non-empty string`);
  }

  return { id, name, ip };
}

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
  hosts: NasHostConfig[];
  stateMachine: OfflineStateMachine;
  storage: Storage;
  intervalMs?: number;
  pingTimeoutSeconds?: number;
}

export interface NasProber {
  start(): void;
  stop(): void;
}

/**
 * Feeds ping results into the same OfflineStateMachine agent liveness uses,
 * so NAS hosts get identical disconnected/offline/notified escalation for free.
 */
export function createNasProber(options: NasProberOptions): NasProber {
  const { hosts, stateMachine, storage } = options;
  const intervalMs = options.intervalMs ?? NAS_PING_INTERVAL_MS;
  const pingTimeoutSeconds = options.pingTimeoutSeconds ?? DEFAULT_PING_TIMEOUT_SECONDS;

  let timer: NodeJS.Timeout | null = null;

  async function pollOnce(): Promise<void> {
    await Promise.all(
      hosts.map(async (host) => {
        const alive = await pingOnce(host.ip, pingTimeoutSeconds);
        if (alive) {
          stateMachine.signalUp(host.id);
        } else {
          stateMachine.signalDown(host.id);
        }
      })
    );
  }

  return {
    start(): void {
      for (const host of hosts) {
        storage.upsertHost({ id: host.id, name: host.name, type: "nas" });
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
  };
}
