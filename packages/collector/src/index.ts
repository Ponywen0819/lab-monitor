import { createCollectorServer } from "./server.js";
import { parseNasHostsConfig } from "./nas-prober.js";

const wsPort = Number(process.env.WS_PORT ?? 8080);
const httpPort = Number(process.env.HTTP_PORT ?? 8081);
const dbPath = process.env.DB_PATH ?? "./data/collector.db";
// Malformed NAS_HOSTS must crash startup loudly rather than silently probe
// zero hosts -- see parseNasHostsConfig doc comment.
const nasHosts = parseNasHostsConfig(process.env.NAS_HOSTS);

const server = createCollectorServer({ wsPort, httpPort, dbPath, nasHosts });

console.log(
  `[collector] listening on ws://0.0.0.0:${wsPort}, http://0.0.0.0:${httpPort}, db at ${dbPath}`
);

function shutdown(): void {
  console.log("[collector] shutting down");
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
