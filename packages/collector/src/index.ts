import { createCollectorServer } from "./server.js";
import { parseCidrList } from "./ip-allowlist.js";

const wsPort = Number(process.env.WS_PORT ?? 8080);
const httpPort = Number(process.env.HTTP_PORT ?? 8081);
const dbPath = process.env.DB_PATH ?? "./data/collector.db";
const allowedCidrs = parseCidrList(process.env.ALLOWED_CIDRS);

const server = createCollectorServer({ wsPort, httpPort, dbPath, allowedCidrs });

console.log(
  `[collector] listening on ws://0.0.0.0:${wsPort}, http://0.0.0.0:${httpPort}, db at ${dbPath}` +
    (allowedCidrs.length > 0 ? `, HTTP API restricted to: ${allowedCidrs.join(", ")}` : "")
);

function shutdown(): void {
  console.log("[collector] shutting down");
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
