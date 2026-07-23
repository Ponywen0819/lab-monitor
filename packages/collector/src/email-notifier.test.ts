import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMailMock, createTransportMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn().mockResolvedValue(undefined);
  const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
  return { sendMailMock, createTransportMock };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

import { createEmailNotifier } from "./email-notifier.js";
import { OfflineStateMachine, type StatusChangeEvent } from "./state-machine.js";
import { Storage } from "./storage/db.js";

const ENV_KEYS = ["SMTP_USER", "SMTP_APP_PASSWORD", "SMTP_HOST", "SMTP_PORT"] as const;

function makeEvent(overrides: Partial<StatusChangeEvent> = {}): StatusChangeEvent {
  return {
    hostId: "host-1",
    status: "notified",
    previousStatus: "offline",
    timestamp: Date.now(),
    wasNotified: false,
    ...overrides,
  };
}

describe("createEmailNotifier", () => {
  let dir: string;
  let storage: Storage;
  let stateMachine: OfflineStateMachine;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "labmon-email-notifier-"));
    storage = new Storage(join(dir, "test.db"));
    stateMachine = new OfflineStateMachine();
    storage.upsertHost({ id: "host-1", name: "Host One", type: "agent" });

    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    sendMailMock.mockClear();
    createTransportMock.mockClear();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function setValidSmtpEnv(): void {
    process.env.SMTP_USER = "notifier@example.com";
    process.env.SMTP_APP_PASSWORD = "app-password";
  }

  it("sends an offline notification email when status becomes notified", async () => {
    setValidSmtpEnv();
    storage.setSystemConfig("notify_email", "recipient@example.com");
    const notifier = createEmailNotifier({ stateMachine, storage });
    notifier.start();

    stateMachine.emit("statusChange", makeEvent({ status: "notified", previousStatus: "offline" }));

    await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));

    const call = sendMailMock.mock.calls[0][0];
    expect(call.to).toBe("recipient@example.com");
    expect(call.from).toBe("notifier@example.com");
    expect(call.subject).toContain("Host One");
    expect(call.subject.toLowerCase()).toContain("offline");
    expect(call.text).toContain("Host One");
    expect(call.text.toLowerCase()).toContain("offline");

    notifier.stop();
  });

  it("sends a recovery email when status becomes online with wasNotified true", async () => {
    setValidSmtpEnv();
    storage.setSystemConfig("notify_email", "recipient@example.com");
    const notifier = createEmailNotifier({ stateMachine, storage });
    notifier.start();

    stateMachine.emit(
      "statusChange",
      makeEvent({ status: "online", previousStatus: "notified", wasNotified: true })
    );

    await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));

    const call = sendMailMock.mock.calls[0][0];
    expect(call.to).toBe("recipient@example.com");
    expect(call.subject).toContain("Host One");
    expect(call.subject.toLowerCase()).toContain("recovered");

    notifier.stop();
  });

  it("does not send anything when status becomes online with wasNotified false", async () => {
    setValidSmtpEnv();
    storage.setSystemConfig("notify_email", "recipient@example.com");
    const notifier = createEmailNotifier({ stateMachine, storage });
    notifier.start();

    stateMachine.emit(
      "statusChange",
      makeEvent({ status: "online", previousStatus: "disconnected", wasNotified: false })
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendMailMock).not.toHaveBeenCalled();

    notifier.stop();
  });

  it("does not send anything for a plain offline status change", async () => {
    setValidSmtpEnv();
    storage.setSystemConfig("notify_email", "recipient@example.com");
    const notifier = createEmailNotifier({ stateMachine, storage });
    notifier.start();

    stateMachine.emit("statusChange", makeEvent({ status: "offline", previousStatus: "disconnected" }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendMailMock).not.toHaveBeenCalled();

    notifier.stop();
  });

  it("does not send anything for a disconnected status change", async () => {
    setValidSmtpEnv();
    storage.setSystemConfig("notify_email", "recipient@example.com");
    const notifier = createEmailNotifier({ stateMachine, storage });
    notifier.start();

    stateMachine.emit("statusChange", makeEvent({ status: "disconnected", previousStatus: "online" }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendMailMock).not.toHaveBeenCalled();

    notifier.stop();
  });

  it("skips sending and does not throw when no notify_email is configured", async () => {
    setValidSmtpEnv();
    const notifier = createEmailNotifier({ stateMachine, storage });
    notifier.start();

    expect(() => {
      stateMachine.emit("statusChange", makeEvent({ status: "notified", previousStatus: "offline" }));
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendMailMock).not.toHaveBeenCalled();

    notifier.stop();
  });

  it("does not throw at construction time when SMTP credentials are missing, and never sends mail", async () => {
    storage.setSystemConfig("notify_email", "recipient@example.com");

    expect(() => createEmailNotifier({ stateMachine, storage })).not.toThrow();
    expect(createTransportMock).not.toHaveBeenCalled();

    const notifier = createEmailNotifier({ stateMachine, storage });
    notifier.start();

    stateMachine.emit("statusChange", makeEvent({ status: "notified", previousStatus: "offline" }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendMailMock).not.toHaveBeenCalled();

    notifier.stop();
  });

  it("stop() unsubscribes so later events do not trigger mail", async () => {
    setValidSmtpEnv();
    storage.setSystemConfig("notify_email", "recipient@example.com");
    const notifier = createEmailNotifier({ stateMachine, storage });
    notifier.start();

    stateMachine.emit("statusChange", makeEvent({ status: "notified", previousStatus: "offline" }));
    await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));

    notifier.stop();

    stateMachine.emit("statusChange", makeEvent({ status: "notified", previousStatus: "offline", hostId: "host-1" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});
