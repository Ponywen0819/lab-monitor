import type { HostSnapshot } from "@labmon/shared";
import type { Storage } from "./storage/db.js";
import type { OfflineStateMachine } from "./state-machine.js";

/**
 * Combines state-machine liveness with storage-persisted host/metric data
 * into the wire-format HostSnapshot. Kept standalone (not inlined in the ws
 * handler) so the future HTTP snapshot endpoint can reuse it verbatim.
 */
export function getHostSnapshot(
  hostId: string,
  storage: Storage,
  stateMachine: OfflineStateMachine
): HostSnapshot | null {
  const host = storage.getHost(hostId);
  if (!host) return null;

  const liveness = stateMachine.getHostState(hostId);
  const latest = storage.getLatestMetricSnapshot(hostId);

  return {
    id: host.id,
    name: host.name,
    type: host.type,
    // A host known to storage but never signaled to the state machine yet
    // (e.g. freshly registered by the future installer) has no liveness
    // opinion -- "offline" is the safe default until a signal arrives.
    status: liveness?.status ?? "offline",
    lastSeenAt: liveness?.lastSeenAt ?? null,
    offlineSinceAt: liveness?.offlineSinceAt ?? null,
    latestMetrics: latest?.metrics ?? null,
  };
}
