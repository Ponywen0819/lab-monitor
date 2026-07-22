import { createCollectorServer } from "./server.js";

const wsPort = Number(process.env.WS_PORT ?? 8080);
const dbPath = process.env.DB_PATH ?? "./data/collector.db";

const server = createCollectorServer({ wsPort, dbPath });

console.log(`[collector] listening on ws://0.0.0.0:${wsPort}, db at ${dbPath}`);

function shutdown(): void {
  console.log("[collector] shutting down");
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
