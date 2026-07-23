import { useState, type FormEvent } from "react";
import type { InstallProgressEvent, InstallStage } from "@labmon/shared";
import { postInstall } from "../api/client";
import { useHosts } from "../ws/WsProvider";

interface FormState {
  targetIp: string;
  sshPort: string;
  username: string;
  password: string;
}

const EMPTY_FORM: FormState = { targetIp: "", sshPort: "22", username: "", password: "" };

const STAGE_LABEL: Record<InstallStage, string> = {
  connecting: "Connecting",
  deploying_key: "Deploying key",
  uploading_agent: "Uploading agent",
  starting_service: "Starting service",
  waiting_for_connection: "Waiting for connection",
  done: "Done",
  failed: "Failed",
};

function validate(form: FormState): string | null {
  if (!form.targetIp.trim()) return "Target IP is required.";
  if (!form.username.trim()) return "Username is required.";
  if (!form.password) return "Password is required.";
  const port = Number(form.sshPort);
  if (!Number.isInteger(port) || port <= 0) return "SSH port must be a positive integer.";
  return null;
}

function isTerminal(event: InstallProgressEvent): boolean {
  return event.stage === "done" || event.stage === "failed";
}

export function RemoteInstall() {
  const { installEvents } = useHosts();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [installId, setInstallId] = useState<string | null>(null);

  const events = installId ? (installEvents.get(installId) ?? []) : [];
  const terminalEvent = events.find(isTerminal) ?? null;

  function updateField(field: keyof FormState, value: string): void {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const error = validate(form);
    setValidationError(error);
    if (error) return;

    setSubmitError(null);
    setSubmitting(true);
    try {
      const { installId: newInstallId } = await postInstall({
        targetIp: form.targetIp.trim(),
        sshPort: Number(form.sshPort),
        username: form.username.trim(),
        password: form.password,
      });
      setInstallId(newInstallId);
    } catch (err) {
      setSubmitError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleReset(): void {
    setForm(EMPTY_FORM);
    setValidationError(null);
    setSubmitError(null);
    setInstallId(null);
  }

  if (installId) {
    return (
      <div>
        <h2>Remote Install</h2>
        <p className="empty-state">
          Installing on {form.targetIp}:{form.sshPort}…
        </p>

        <ol className="install-log">
          {events.map((event, i) => (
            <li key={i} className="install-log-entry">
              <span className="install-log-stage">{STAGE_LABEL[event.stage]}</span>
              <span className="install-log-message">{event.message}</span>
            </li>
          ))}
          {events.length === 0 && <li className="empty-state">Waiting for progress updates…</li>}
        </ol>

        {terminalEvent && (
          <p className={terminalEvent.success ? "install-result-ok" : "install-result-fail"}>
            {terminalEvent.success ? "Install succeeded: " : "Install failed: "}
            {terminalEvent.message}
          </p>
        )}

        {terminalEvent && (
          <button type="button" onClick={handleReset}>
            Start new install
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <h2>Remote Install</h2>
      <form className="settings-form" noValidate onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Target IP
          <input
            type="text"
            value={form.targetIp}
            onChange={(e) => updateField("targetIp", e.target.value)}
            placeholder="192.168.1.50"
          />
        </label>

        <label>
          SSH port
          <input
            type="number"
            min={1}
            value={form.sshPort}
            onChange={(e) => updateField("sshPort", e.target.value)}
          />
        </label>

        <label>
          Username
          <input type="text" value={form.username} onChange={(e) => updateField("username", e.target.value)} />
        </label>

        <label>
          Password
          <input
            type="password"
            value={form.password}
            onChange={(e) => updateField("password", e.target.value)}
          />
        </label>

        {validationError && <p className="error-text">{validationError}</p>}
        {submitError && <p className="error-text">{submitError}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Starting…" : "Install"}
        </button>
      </form>
    </div>
  );
}
