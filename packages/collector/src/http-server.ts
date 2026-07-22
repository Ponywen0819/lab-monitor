import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { METRIC_RETENTION_MS, type HostSnapshot, type InstallRequest } from "@labmon/shared";
import { getHostSnapshot } from "./host-snapshot.js";
import type { Storage } from "./storage/db.js";
import type { OfflineStateMachine } from "./state-machine.js";
import type { RemoteInstaller } from "./remote-installer/index.js";

const NOTIFY_EMAIL_CONFIG_KEY = "notify_email";

export interface HttpServerOptions {
  port: number;
  storage: Storage;
  stateMachine: OfflineStateMachine;
  remoteInstaller: RemoteInstaller;
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

function parseInstallRequest(body: unknown): InstallRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const { targetIp, sshPort, username, password } = body as Record<string, unknown>;

  if (!isNonEmptyString(targetIp)) return null;
  if (typeof sshPort !== "number" || !Number.isInteger(sshPort) || sshPort <= 0) return null;
  if (!isNonEmptyString(username)) return null;
  if (!isNonEmptyString(password)) return null;

  return { targetIp, sshPort, username, password };
}

/**
 * Internal-network-only tool by design (see blueprint non-goals) -- no auth,
 * wide-open CORS so the frontend can be served from a different origin in dev.
 */
export function createHttpServer(options: HttpServerOptions): HttpServer {
  const { port, storage, stateMachine, remoteInstaller } = options;
  let server: Server | null = null;

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
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
        const request = parseInstallRequest(body);
        if (!request) {
          sendJson(res, 400, {
            error: "body must include targetIp (string), sshPort (positive integer), username (string), password (string)",
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
