/**
 * Email Notifier submodule.
 *
 * Listens to OfflineStateMachine "statusChange" events and sends two kinds
 * of email via a dedicated Gmail SMTP account:
 *   - "notified"                       -> offline notification
 *   - "online" with wasNotified=true   -> recovery notification
 *
 * Config (env vars):
 *   SMTP_HOST          default "smtp.gmail.com"
 *   SMTP_PORT          default "587"
 *   SMTP_USER          Gmail address used as the sender (dedicated notifier account)
 *   SMTP_APP_PASSWORD  Gmail App Password for SMTP_USER (NOT the account login password)
 *
 * Recipient address comes from Storage.getSystemConfig("notify_email"), not env.
 */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { OfflineStateMachine, StatusChangeEvent } from "./state-machine.js";
import type { Storage } from "./storage/db.js";

export interface EmailNotifierOptions {
  stateMachine: OfflineStateMachine;
  storage: Storage;
}

export interface EmailNotifier {
  start(): void;
  stop(): void;
}

const NOTIFY_EMAIL_CONFIG_KEY = "notify_email";

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function createTransporter(): Transporter | null {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_APP_PASSWORD;

  if (!user || !pass) {
    console.warn(
      "[email-notifier] SMTP_USER/SMTP_APP_PASSWORD not set -- email notifications are disabled."
    );
    return null;
  }

  const host = process.env.SMTP_HOST ?? "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT ?? "587");

  return nodemailer.createTransport({
    host,
    port,
    // 587 is STARTTLS, not implicit TLS -- only 465 needs secure:true.
    secure: port === 465,
    auth: { user, pass },
  });
}

export function createEmailNotifier({ stateMachine, storage }: EmailNotifierOptions): EmailNotifier {
  const transporter = createTransporter();

  const handleStatusChange = (event: StatusChangeEvent): void => {
    const isOfflineNotification = event.status === "notified";
    const isRecoveryNotification = event.status === "online" && event.wasNotified;

    if (!isOfflineNotification && !isRecoveryNotification) return;

    void sendNotificationEmail(event, isOfflineNotification);
  };

  async function sendNotificationEmail(event: StatusChangeEvent, isOffline: boolean): Promise<void> {
    if (!transporter) return;

    const recipient = storage.getSystemConfig(NOTIFY_EMAIL_CONFIG_KEY);
    if (!recipient) {
      console.warn(
        `[email-notifier] No "${NOTIFY_EMAIL_CONFIG_KEY}" configured in system_config -- skipping ${
          isOffline ? "offline" : "recovery"
        } email for host ${event.hostId}.`
      );
      return;
    }

    const host = storage.getHost(event.hostId);
    const hostName = host?.name ?? event.hostId;
    const timestamp = new Date(event.timestamp).toISOString();

    let subject: string;
    let text: string;

    if (isOffline) {
      // offlineSinceAt may already be null by the time this async send runs
      // (a fast recovery could beat it) -- state-machine snapshot is a
      // best-effort source, the event timestamp is always the fallback.
      const offlineSinceAt = stateMachine.getHostState(event.hostId)?.offlineSinceAt ?? event.timestamp;
      const offlineDurationMs = event.timestamp - offlineSinceAt;

      subject = `[Lab Monitor] ${hostName} is offline`;
      text = [
        `Host: ${hostName}`,
        `Event: offline`,
        `Timestamp: ${timestamp}`,
        `Offline duration: ${formatDuration(offlineDurationMs)}`,
      ].join("\n");
    } else {
      subject = `[Lab Monitor] ${hostName} has recovered`;
      text = [`Host: ${hostName}`, `Event: recovered`, `Timestamp: ${timestamp}`].join("\n");
    }

    try {
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: recipient,
        subject,
        text,
      });
    } catch (err) {
      console.error(`[email-notifier] Failed to send email for host ${event.hostId}:`, err);
    }
  }

  return {
    start(): void {
      stateMachine.on("statusChange", handleStatusChange);
    },
    stop(): void {
      stateMachine.off("statusChange", handleStatusChange);
    },
  };
}
