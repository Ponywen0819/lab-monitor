import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISCONNECTED_GRACE_MS, OFFLINE_TO_NOTIFIED_MS } from "@labmon/shared";
import type { StatusChangeEvent } from "./state-machine.js";
import { OfflineStateMachine, createOfflineStateMachine } from "./state-machine.js";

// Escalation is driven by real setTimeout calls under the hood, so fake
// timers let us assert 30s/5min transitions without actually waiting.
describe("OfflineStateMachine", () => {
  let machine: OfflineStateMachine;
  let events: StatusChangeEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    machine = createOfflineStateMachine();
    events = [];
    machine.on("statusChange", (event: StatusChangeEvent) => events.push(event));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signalUp on a never-seen hostId creates it as online and emits with previousStatus null", () => {
    machine.signalUp("host-1");

    expect(machine.getHostState("host-1")?.status).toBe("online");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "online", previousStatus: null, wasNotified: false });
  });

  it("signalDown from online transitions immediately to disconnected", () => {
    machine.signalUp("host-1");
    events.length = 0; // drop the first-seen "online" bootstrap event
    machine.signalDown("host-1");

    expect(machine.getHostState("host-1")?.status).toBe("disconnected");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "disconnected",
      previousStatus: "online",
      wasNotified: false,
    });
  });

  it("escalates disconnected -> offline -> notified when no signalUp arrives", () => {
    machine.signalUp("host-1");
    events.length = 0; // drop the first-seen "online" bootstrap event
    machine.signalDown("host-1");
    expect(machine.getHostState("host-1")?.status).toBe("disconnected");

    vi.advanceTimersByTime(DISCONNECTED_GRACE_MS);
    expect(machine.getHostState("host-1")?.status).toBe("offline");

    vi.advanceTimersByTime(OFFLINE_TO_NOTIFIED_MS);
    expect(machine.getHostState("host-1")?.status).toBe("notified");

    const statuses = events.map((e) => e.status);
    expect(statuses).toEqual(["disconnected", "offline", "notified"]);
  });

  it("signalUp during disconnected clears the pending timer and returns to online", () => {
    machine.signalUp("host-1");
    machine.signalDown("host-1");

    vi.advanceTimersByTime(DISCONNECTED_GRACE_MS / 2);
    machine.signalUp("host-1");

    expect(machine.getHostState("host-1")?.status).toBe("online");
    const recovery = events[events.length - 1];
    expect(recovery).toMatchObject({ status: "online", previousStatus: "disconnected", wasNotified: false });

    events.length = 0;
    vi.advanceTimersByTime(DISCONNECTED_GRACE_MS + OFFLINE_TO_NOTIFIED_MS + 1);
    expect(machine.getHostState("host-1")?.status).toBe("online");
    expect(events).toHaveLength(0);
  });

  it("signalUp during offline clears the pending timer and returns to online", () => {
    machine.signalUp("host-1");
    machine.signalDown("host-1");
    vi.advanceTimersByTime(DISCONNECTED_GRACE_MS);
    expect(machine.getHostState("host-1")?.status).toBe("offline");

    machine.signalUp("host-1");
    expect(machine.getHostState("host-1")?.status).toBe("online");
    const recovery = events[events.length - 1];
    expect(recovery).toMatchObject({ status: "online", previousStatus: "offline", wasNotified: false });

    events.length = 0;
    vi.advanceTimersByTime(OFFLINE_TO_NOTIFIED_MS + 1);
    expect(machine.getHostState("host-1")?.status).toBe("online");
    expect(events).toHaveLength(0);
  });

  it("signalUp after reaching notified returns to online with wasNotified true", () => {
    machine.signalUp("host-1");
    machine.signalDown("host-1");
    vi.advanceTimersByTime(DISCONNECTED_GRACE_MS + OFFLINE_TO_NOTIFIED_MS);
    expect(machine.getHostState("host-1")?.status).toBe("notified");

    machine.signalUp("host-1");

    expect(machine.getHostState("host-1")?.status).toBe("online");
    const recovery = events[events.length - 1];
    expect(recovery).toMatchObject({ status: "online", previousStatus: "notified", wasNotified: true });
  });

  it("repeated signalDown calls while already non-online do not reset the escalation timer", () => {
    machine.signalUp("host-1");
    events.length = 0; // drop the first-seen "online" bootstrap event

    machine.signalDown("host-1");
    vi.advanceTimersByTime(20_000);
    machine.signalDown("host-1");
    vi.advanceTimersByTime(15_000);

    expect(machine.getHostState("host-1")?.status).toBe("offline");
    const statuses = events.map((e) => e.status);
    expect(statuses).toEqual(["disconnected", "offline"]);
  });

  it("getHostState returns undefined for an unknown hostId", () => {
    expect(machine.getHostState("nope")).toBeUndefined();
  });

  it("keeps independent hostIds from interfering with each other's timers/state", () => {
    machine.signalUp("host-a");
    machine.signalUp("host-b");

    machine.signalDown("host-a");
    vi.advanceTimersByTime(DISCONNECTED_GRACE_MS);

    expect(machine.getHostState("host-a")?.status).toBe("offline");
    expect(machine.getHostState("host-b")?.status).toBe("online");

    machine.signalDown("host-b");
    expect(machine.getHostState("host-b")?.status).toBe("disconnected");
    expect(machine.getHostState("host-a")?.status).toBe("offline");
  });
});
