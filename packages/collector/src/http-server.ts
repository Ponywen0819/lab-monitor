import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  METRIC_RETENTION_MS,
  type HostSnapshot,
  type InstallRequest,
  type NasHostConfig,
  type UninstallRequest,
} from "@labmon/shared";
import { getHostSnapshot } from "./host-snapshot.js";
import { isIpAllowed } from "./ip-allowlist.js";
import type { Storage } from "./storage/db.js";
import type { OfflineStateMachine } from "./state-machine.js";
import type { RemoteInstaller } from "./remote-installer/index.js";
import type { NasProber } from "./nas-prober.js";

const NOTIFY_EMAIL_CONFIG_KEY = "notify_email";

export interface HttpServerOptions {
  port: number;
  storage: Storage;
  stateMachine: OfflineStateMachine;
  remoteInstaller: RemoteInstaller;
  nasProber: NasProber;
  onHostRemoved: (hostId: string) => void;
  onHostUpdated: (hostId: string) => void;
  /** Empty (the default) means unrestricted -- see ip-allowlist.ts. */
  allowedCidrs?: string[];
}

export interface HttpServer {
  start(): void;
  stop(): void;
}

function listHostSnapshots(storage: Storage, stateMachine: OfflineStateMachine): HostSnapshot[] {
  return storage
    .listHosts()
    .map((host) => getHostSnapshot(host.id, storage, stateMachine))
    .filter((snapshot): snapshot is HostSnapshot => snapshot !== null);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseNasHostRequest(body: unknown): { name: string; ip: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const { name, ip } = body as Record<string, unknown>;

  if (!isNonEmptyString(name)) return null;
  if (!isNonEmptyString(ip)) return null;

  return { name, ip };
}

// InstallRequest and UninstallRequest are structurally identical (both are
// just "one-time SSH credentials for a target host"), so both the install
// and uninstall HTTP handlers share this one parser.
function parseSshCredentialsRequest(body: unknown): InstallRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const { targetIp, sshPort, username, password, sudoPassword } = body as Record<string, unknown>;

  if (!isNonEmptyString(targetIp)) return null;
  if (typeof sshPort !== "number" || !Number.isInteger(sshPort) || sshPort <= 0) return null;
  if (!isNonEmptyString(username)) return null;
  if (!isNonEmptyString(password)) return null;
  if (!isNonEmptyString(sudoPassword)) return null;

  return { targetIp, sshPort, username, password, sudoPassword };
}

/**
 * Internal-network-only tool by design (see blueprint non-goals) -- no auth,
 * wide-open CORS so the frontend can be served from a different origin in
 * dev. `allowedCidrs` (see ip-allowlist.ts) is the one optional exception:
 * an operator can scope "internal network" down to a specific subnet.
 */
export function createHttpServer(options: HttpServerOptions): HttpServer {
  const { port, storage, stateMachine, remoteInstaller, nasProber, onHostRemoved, onHostUpdated } = options;
  const allowedCidrs = options.allowedCidrs ?? [];
  let server: Server | null = null;

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isIpAllowed(req.socket.remoteAddress, allowedCidrs)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const segments = url.pathname.split("/").filter(Boolean);

    try {
      if (segments.length === 2 && segments[0] === "api" && segments[1] === "hosts" && method === "GET") {
        sendJson(res, 200, listHostSnapshots(storage, stateMachine));
        return;
      }

      if (
        segments.length === 4 &&
        segments[0] === "api" &&
        segments[1] === "hosts" &&
        segments[3] === "metrics" &&
        method === "GET"
      ) {
        const hostId = decodeURIComponent(segments[2]);
        const sinceMsParam = url.searchParams.get("sinceMs");
        const lookbackMs = sinceMsParam !== null ? Number(sinceMsParam) : METRIC_RETENTION_MS;
        if (!Number.isFinite(lookbackMs) || lookbackMs < 0) {
          sendJson(res, 400, { error: "sinceMs must be a non-negative number" });
          return;
        }
        const sinceTimestamp = Date.now() - lookbackMs;
        sendJson(res, 200, storage.getRecentMetrics(hostId, sinceTimestamp));
        return;
      }

      if (segments.length === 3 && segments[0] === "api" && segments[1] === "hosts" && method === "DELETE") {
        const hostId = decodeURIComponent(segments[2]);
        const snapshot = getHostSnapshot(hostId, storage, stateMachine);
        if (!snapshot) {
          sendJson(res, 404, { error: "host not found" });
          return;
        }
        // An online agent still has a live process on the target host --
        // deleting the DB row here would just let it re-register itself on
        // its next report. NAS hosts have no agent to leave behind, so
        // there's nothing to gate on for them.
        if (snapshot.type === "agent" && snapshot.status === "online") {
          sendJson(res, 409, {
            error: "host is online -- use POST /api/hosts/:id/uninstall to remove its agent first",
          });
          return;
        }
        storage.deleteHost(hostId);
        stateMachine.removeHost(hostId);
        nasProber.removeHost(hostId);
        onHostRemoved(hostId);
        sendJson(res, 200, { id: hostId });
        return;
      }

      if (
        segments.length === 4 &&
        segments[0] === "api" &&
        segments[1] === "hosts" &&
        segments[3] === "uninstall" &&
        method === "POST"
      ) {
        const hostId = decodeURIComponent(segments[2]);
        const snapshot = getHostSnapshot(hostId, storage, stateMachine);
        if (!snapshot) {
          sendJson(res, 404, { error: "host not found" });
          return;
        }
        if (snapshot.type !== "agent") {
          sendJson(res, 400, { error: "only agent hosts have an agent to uninstall" });
          return;
        }
        const body = await readJsonBody(req);
        const request: UninstallRequest | null = parseSshCredentialsRequest(body);
        if (!request) {
          sendJson(res, 400, {
            error:
              "body must include targetIp (string), sshPort (positive integer), username (string), password (string), sudoPassword (string)",
          });
          return;
        }
        const uninstallId = remoteInstaller.uninstallAgent(hostId, request);
        sendJson(res, 202, { uninstallId });
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "nas-hosts") {
        if (method === "GET") {
          sendJson(res, 200, storage.listNasHosts());
          return;
        }

        if (method === "POST") {
          const body = await readJsonBody(req);
          const parsed = parseNasHostRequest(body);
          if (!parsed) {
            sendJson(res, 400, { error: "body must include name (string) and ip (string)" });
            return;
          }
          const nasHost: NasHostConfig = { id: randomUUID(), name: parsed.name, ip: parsed.ip };
          storage.addNasHost(nasHost);
          nasProber.addHost(nasHost);
          onHostUpdated(nasHost.id);
          sendJson(res, 201, nasHost);
          return;
        }

        sendJson(res, 405, { error: "method not allowed" });
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "config") {
        if (method === "GET") {
          sendJson(res, 200, { notifyEmail: storage.getSystemConfig(NOTIFY_EMAIL_CONFIG_KEY) });
          return;
        }

        if (method === "PUT") {
          const body = await readJsonBody(req);
          const notifyEmail = (body as Record<string, unknown> | undefined)?.notifyEmail;
          if (!isNonEmptyString(notifyEmail)) {
            sendJson(res, 400, { error: "notifyEmail must be a non-empty string" });
            return;
          }
          storage.setSystemConfig(NOTIFY_EMAIL_CONFIG_KEY, notifyEmail);
          sendJson(res, 200, { notifyEmail });
          return;
        }

        sendJson(res, 405, { error: "method not allowed" });
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "install" && method === "POST") {
        const body = await readJsonBody(req);
        const request = parseSshCredentialsRequest(body);
        if (!request) {
          sendJson(res, 400, {
            error:
              "body must include targetIp (string), sshPort (positive integer), username (string), password (string), sudoPassword (string)",
          });
          return;
        }
        const installId = remoteInstaller.installAgent(request);
        sendJson(res, 202, { installId });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof SyntaxError) {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }
      console.error("[http-server] unhandled error:", err);
      sendJson(res, 500, { error: "internal error" });
    }
  }

  return {
    start(): void {
      server = createServer((req, res) => void handleRequest(req, res));
      server.listen(port);
    },
    stop(): void {
      server?.close();
      server = null;
    },
  };
}
