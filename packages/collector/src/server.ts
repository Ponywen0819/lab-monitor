import {
  METRIC_RETENTION_MS,
  RETENTION_SWEEP_INTERVAL_MS,
  type AgentReportMessage,
} from "@labmon/shared";
import { WsServer } from "./ws-server.js";
import { createOfflineStateMachine, type OfflineStateMachine } from "./state-machine.js";
import { createStorage, type Storage } from "./storage/db.js";
import { getHostSnapshot } from "./host-snapshot.js";
import { createNasProber, type NasHostConfig } from "./nas-prober.js";
import { createEmailNotifier } from "./email-notifier.js";
import { createRemoteInstaller, type RemoteInstaller } from "./remote-installer/index.js";
import { createHttpServer } from "./http-server.js";

export interface CollectorServerOptions {
  wsPort: number;
  httpPort: number;
  dbPath: string;
  nasHosts: NasHostConfig[];
}

export interface CollectorServer {
  storage: Storage;
  stateMachine: OfflineStateMachine;
  wsServer: WsServer;
  remoteInstaller: RemoteInstaller;
  getHostSnapshot(hostId: string): ReturnType<typeof getHostSnapshot>;
  stop(): void;
}

function handleAgentReport(storage: Storage, stateMachine: OfflineStateMachine, wsServer: WsServer) {
  return (message: AgentReportMessage): void => {
    // Preserve any name assigned later (e.g. by the future installer/naming
    // UI) -- only seed a default row the first time this hostId is seen.
    if (!storage.getHost(message.hostId)) {
      storage.upsertHost({ id: message.hostId, name: message.hostId, type: "agent" });
    }

    storage.insertMetricSnapshot({
      hostId: message.hostId,
      timestamp: message.timestamp,
      metrics: message.metrics,
    });

    stateMachine.signalUp(message.hostId, message.timestamp);

    const snapshot = getHostSnapshot(message.hostId, storage, stateMachine);
    if (snapshot) {
      wsServer.broadcastToFrontends({ type: "host_update", host: snapshot });
    }
  };
}

export function createCollectorServer(options: CollectorServerOptions): CollectorServer {
  const storage = createStorage(options.dbPath);
  const stateMachine = createOfflineStateMachine();
  const wsServer = new WsServer({ port: options.wsPort });

  wsServer.on("agent_report", handleAgentReport(storage, stateMachine, wsServer));

  // WS disconnect is just a liveness signal, funneled through the same
  // transport-agnostic entry point the future NAS prober will use.
  wsServer.on("agent_down", (hostId) => stateMachine.signalDown(hostId));

  stateMachine.on("statusChange", (event) => {
    // "disconnected" is transient network jitter, not a real offline event --
    // see HostStatus doc comment in @labmon/shared for the rationale.
    if (event.status !== "disconnected") {
      storage.insertStatusEvent({ hostId: event.hostId, status: event.status, timestamp: event.timestamp });
    }

    wsServer.broadcastToFrontends({
      type: "host_status",
      hostId: event.hostId,
      status: event.status,
      timestamp: event.timestamp,
    });

    const snapshot = getHostSnapshot(event.hostId, storage, stateMachine);
    if (snapshot) {
      wsServer.broadcastToFrontends({ type: "host_update", host: snapshot });
    }
  });

  const sweepInterval = setInterval(() => {
    storage.deleteMetricsOlderThan(Date.now() - METRIC_RETENTION_MS);
  }, RETENTION_SWEEP_INTERVAL_MS);

  const nasProber = createNasProber({ hosts: options.nasHosts, stateMachine, storage });
  const emailNotifier = createEmailNotifier({ stateMachine, storage });
  const remoteInstaller = createRemoteInstaller({ storage, stateMachine });

  remoteInstaller.on("progress", (event) => {
    wsServer.broadcastToFrontends({ type: "install_progress", event });
  });

  const httpServer = createHttpServer({
    port: options.httpPort,
    storage,
    stateMachine,
    remoteInstaller,
  });

  wsServer.start();
  httpServer.start();
  nasProber.start();
  emailNotifier.start();

  return {
    storage,
    stateMachine,
    wsServer,
    remoteInstaller,
    getHostSnapshot: (hostId: string) => getHostSnapshot(hostId, storage, stateMachine),
    stop(): void {
      clearInterval(sweepInterval);
      nasProber.stop();
      emailNotifier.stop();
      httpServer.stop();
      wsServer.stop();
      storage.close();
    },
  };
}
