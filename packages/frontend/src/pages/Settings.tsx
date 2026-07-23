import { useEffect, useState, type FormEvent } from "react";
import type { NasHostConfig } from "@labmon/shared";
import { addNasHost, deleteHost, fetchConfig, fetchNasHosts, updateConfig } from "../api/client";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function NasHosts() {
  const [hosts, setHosts] = useState<NasHostConfig[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchNasHosts()
      .then((data) => {
        if (!cancelled) setHosts(data);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || !ip.trim()) {
      setSaveError("Enter both a name and an IP address.");
      return;
    }
    setSaveError(null);
    setSaving(true);
    try {
      const created = await addNasHost(name.trim(), ip.trim());
      setHosts((prev) => [...(prev ?? []), created]);
      setName("");
      setIp("");
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(id: string): Promise<void> {
    setRemovingId(id);
    try {
      await deleteHost(id);
      setHosts((prev) => (prev ?? []).filter((h) => h.id !== id));
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div>
      <h3>NAS hosts</h3>

      {loadError && <p className="error-text">Failed to load NAS hosts: {loadError}</p>}
      {hosts && hosts.length === 0 && <p className="empty-state">No NAS hosts added yet.</p>}

      {hosts && hosts.length > 0 && (
        <ul className="nas-host-list">
          {hosts.map((h) => (
            <li key={h.id}>
              <span>
                {h.name} <span className="nas-host-ip">({h.ip})</span>
              </span>
              <button
                type="button"
                className="danger-button"
                disabled={removingId === h.id}
                onClick={() => void handleRemove(h.id)}
              >
                {removingId === h.id ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="settings-form" onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Synology NAS" />
        </label>
        <label>
          IP address
          <input type="text" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="10.0.0.5" />
        </label>

        {saveError && <p className="error-text">{saveError}</p>}

        <button type="submit" disabled={saving}>
          {saving ? "Adding…" : "Add NAS host"}
        </button>
      </form>
    </div>
  );
}

export function Settings() {
  const [notifyEmail, setNotifyEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((config) => {
        if (cancelled) return;
        setNotifyEmail(config.notifyEmail ?? "");
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSaved(false);

    if (!EMAIL_RE.test(notifyEmail)) {
      setValidationError("Enter a valid email address.");
      return;
    }
    setValidationError(null);

    setSaveError(null);
    setSaving(true);
    try {
      const config = await updateConfig(notifyEmail);
      setNotifyEmail(config.notifyEmail ?? "");
      setSaved(true);
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2>Settings</h2>

      {loading && <p className="empty-state">Loading settings…</p>}
      {loadError && <p className="error-text">Failed to load settings: {loadError}</p>}

      {!loading && !loadError && (
        <form className="settings-form" noValidate onSubmit={(e) => void handleSubmit(e)}>
          <label>
            Notification email
            <input
              type="email"
              value={notifyEmail}
              onChange={(e) => {
                setNotifyEmail(e.target.value);
                setSaved(false);
              }}
              placeholder="you@example.com"
            />
          </label>

          {validationError && <p className="error-text">{validationError}</p>}
          {saveError && <p className="error-text">{saveError}</p>}
          {saved && <p className="install-result-ok">Saved.</p>}

          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
      )}

      <NasHosts />
    </div>
  );
}
