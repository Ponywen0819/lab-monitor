import {
  METRIC_RETENTION_MS,
  RETENTION_SWEEP_INTERVAL_MS,
  type AgentReportMessage,
} from "@labmon/shared";
import { WsServer } from "./ws-server.js";
import { createOfflineStateMachine, type OfflineStateMachine } from "./state-machine.js";
import { createStorage, type Storage } from "./storage/db.js";
import { getHostSnapshot } from "./host-snapshot.js";
import { createNasProber } from "./nas-prober.js";
import { createEmailNotifier } from "./email-notifier.js";
import { createRemoteInstaller, type RemoteInstaller } from "./remote-installer/index.js";
import { createHttpServer } from "./http-server.js";

export interface CollectorServerOptions {
  wsPort: number;
  httpPort: number;
  dbPath: string;
  /**
   * Restricts the HTTP API, and the dashboard's WS subscription (not agent
   * connections -- see ws-server.ts), to these CIDRs. Empty/omitted means
   * unrestricted. See ip-allowlist.ts.
   */
  allowedCidrs?: string[];
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
  const wsServer = new WsServer({ port: options.wsPort, allowedCidrs: options.allowedCidrs });

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

  const nasProber = createNasProber({ stateMachine, storage });
  const emailNotifier = createEmailNotifier({ stateMachine, storage });

  // Shared by the plain DELETE endpoint and by uninstallAgent() once its SSH
  // flow confirms the agent actually disconnected -- both need the exact
  // same nasProber/broadcast cleanup after the DB row is gone.
  const onHostRemoved = (hostId: string): void => {
    nasProber.removeHost(hostId);
    wsServer.broadcastToFrontends({ type: "host_removed", hostId });
  };

  const remoteInstaller = createRemoteInstaller({ storage, stateMachine, onHostRemoved });

  remoteInstaller.on("progress", (event) => {
    wsServer.broadcastToFrontends({ type: "install_progress", event });
  });
  remoteInstaller.on("uninstallProgress", (event) => {
    wsServer.broadcastToFrontends({ type: "uninstall_progress", event });
  });

  const httpServer = createHttpServer({
    port: options.httpPort,
    storage,
    stateMachine,
    remoteInstaller,
    nasProber,
    onHostRemoved,
    allowedCidrs: options.allowedCidrs,
    onHostUpdated: (hostId) => {
      const snapshot = getHostSnapshot(hostId, storage, stateMachine);
      if (snapshot) wsServer.broadcastToFrontends({ type: "host_update", host: snapshot });
    },
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
