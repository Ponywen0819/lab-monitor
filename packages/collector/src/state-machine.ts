import { EventEmitter } from "node:events";
import type { HostStatus } from "@labmon/shared";
import { DISCONNECTED_GRACE_MS, OFFLINE_TO_NOTIFIED_MS } from "@labmon/shared";

export interface StatusChangeEvent {
  hostId: string;
  status: HostStatus;
  previousStatus: HostStatus | null;
  timestamp: number;
  /**
   * True only for a recovery ("...->online") that started from "notified".
   * The future email module uses this to decide whether a recovery email is
   * warranted (a jitter-only "disconnected"->"online" bounce should not page anyone).
   */
  wasNotified: boolean;
}

interface HostLivenessState {
  status: HostStatus;
  lastSeenAt: number | null;
  /** Timestamp the host left "online"; null while online. Covers disconnected/offline/notified. */
  offlineSinceAt: number | null;
  escalationTimer: NodeJS.Timeout | null;
}

export interface HostLivenessSnapshot {
  status: HostStatus;
  lastSeenAt: number | null;
  offlineSinceAt: number | null;
}

/**
 * Transport-agnostic offline-detection state machine (blueprint 1.4/3.3).
 *
 * Driven purely by signalUp(hostId) / signalDown(hostId) so both the WS
 * server (agent liveness) and the future NAS prober (ping success/failure)
 * can share one implementation without either depending on the other's
 * transport types.
 */
export class OfflineStateMachine extends EventEmitter {
  private readonly hosts = new Map<string, HostLivenessState>();

  signalUp(hostId: string, timestamp: number = Date.now()): void {
    const host = this.hosts.get(hostId);

    if (!host) {
      this.hosts.set(hostId, {
        status: "online",
        lastSeenAt: timestamp,
        offlineSinceAt: null,
        escalationTimer: null,
      });
      // A brand-new hostId's first signalUp must still emit -- the Remote
      // Installer's success detection (waitForOnline) has nothing else to
      // key off of for a host it just minted and has never seen before.
      this.emitStatusChange({
        hostId,
        status: "online",
        previousStatus: null,
        timestamp,
        wasNotified: false,
      });
      return;
    }

    host.lastSeenAt = timestamp;

    if (host.status === "online") {
      return;
    }

    this.clearTimer(host);
    const previousStatus = host.status;
    host.status = "online";
    host.offlineSinceAt = null;

    this.emitStatusChange({
      hostId,
      status: "online",
      previousStatus,
      timestamp,
      wasNotified: previousStatus === "notified",
    });
  }

  signalDown(hostId: string, timestamp: number = Date.now()): void {
    let host = this.hosts.get(hostId);

    if (!host) {
      host = { status: "online", lastSeenAt: null, offlineSinceAt: null, escalationTimer: null };
      this.hosts.set(hostId, host);
    }

    // Repeated down-signals (e.g. NAS ping failing every interval) must not
    // reset the escalation timers, or a host could stay "disconnected" forever.
    if (host.status !== "online") {
      return;
    }

    this.transitionToDisconnected(hostId, host, timestamp);
  }

  getHostState(hostId: string): HostLivenessSnapshot | undefined {
    const host = this.hosts.get(hostId);
    if (!host) return undefined;
    return {
      status: host.status,
      lastSeenAt: host.lastSeenAt,
      offlineSinceAt: host.offlineSinceAt,
    };
  }

  /**
   * Drops all liveness state for a deleted host, clearing any pending
   * escalation timer. A later signalUp for the same hostId (e.g. a NAS
   * still configured in NAS_HOSTS, or an agent that reconnects) is then
   * treated as brand-new rather than resuming stale state.
   */
  removeHost(hostId: string): void {
    const host = this.hosts.get(hostId);
    if (!host) return;
    this.clearTimer(host);
    this.hosts.delete(hostId);
  }

  private transitionToDisconnected(hostId: string, host: HostLivenessState, timestamp: number): void {
    const previousStatus = host.status;
    host.status = "disconnected";
    host.offlineSinceAt = timestamp;

    this.emitStatusChange({
      hostId,
      status: "disconnected",
      previousStatus,
      timestamp,
      wasNotified: false,
    });

    this.clearTimer(host);
    host.escalationTimer = setTimeout(() => this.escalateToOffline(hostId), DISCONNECTED_GRACE_MS);
  }

  private escalateToOffline(hostId: string): void {
    const host = this.hosts.get(hostId);
    if (!host || host.status !== "disconnected") return;

    const timestamp = Date.now();
    const previousStatus = host.status;
    host.status = "offline";

    this.emitStatusChange({
      hostId,
      status: "offline",
      previousStatus,
      timestamp,
      wasNotified: false,
    });

    this.clearTimer(host);
    host.escalationTimer = setTimeout(() => this.escalateToNotified(hostId), OFFLINE_TO_NOTIFIED_MS);
  }

  private escalateToNotified(hostId: string): void {
    const host = this.hosts.get(hostId);
    if (!host || host.status !== "offline") return;

    const timestamp = Date.now();
    const previousStatus = host.status;
    host.status = "notified";
    host.escalationTimer = null;

    this.emitStatusChange({
      hostId,
      status: "notified",
      previousStatus,
      timestamp,
      wasNotified: false,
    });
  }

  private clearTimer(host: HostLivenessState): void {
    if (host.escalationTimer) {
      clearTimeout(host.escalationTimer);
      host.escalationTimer = null;
    }
  }

  private emitStatusChange(event: StatusChangeEvent): void {
    this.emit("statusChange", event);
  }
}

export function createOfflineStateMachine(): OfflineStateMachine {
  return new OfflineStateMachine();
}
