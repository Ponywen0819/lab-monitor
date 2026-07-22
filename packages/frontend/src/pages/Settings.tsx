import { useEffect, useState, type FormEvent } from "react";
import { fetchConfig, updateConfig } from "../api/client";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
        <form className="settings-form" onSubmit={(e) => void handleSubmit(e)}>
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
    </div>
  );
}
