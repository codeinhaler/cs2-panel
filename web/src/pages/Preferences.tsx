import { useState } from "react";
import { api } from "../api";
import { useAction, useApp } from "../app-context";
import { formatDate, formatTime, type Prefs } from "../format";

const SAMPLE = new Date(2026, 10, 6, 21, 30);

export function PreferencesPage() {
  const { me, setPrefs } = useApp();
  const { busy, run } = useAction();
  const [draft, setDraft] = useState<Prefs>(me.user.prefs);
  const changed = draft.timeFormat !== me.user.prefs.timeFormat || draft.dateFormat !== me.user.prefs.dateFormat;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.savePrefs(draft), "Preferences saved.");
    if (r) setPrefs(r.prefs);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Preferences</h1>
          <p>How the panel shows things to you. Other admins keep their own settings.</p>
        </div>
      </div>
      <form className="panel" onSubmit={save}>
        <div className="form-grid" style={{ maxWidth: 640 }}>
          <fieldset className="field choice">
            <legend>Time</legend>
            <label className="check">
              <input type="radio" name="time" checked={draft.timeFormat === "24h"} onChange={() => setDraft({ ...draft, timeFormat: "24h" })} />
              <span>24-hour ({formatTime(SAMPLE, { ...draft, timeFormat: "24h" })})</span>
            </label>
            <label className="check">
              <input type="radio" name="time" checked={draft.timeFormat === "12h"} onChange={() => setDraft({ ...draft, timeFormat: "12h" })} />
              <span>12-hour ({formatTime(SAMPLE, { ...draft, timeFormat: "12h" })})</span>
            </label>
          </fieldset>
          <fieldset className="field choice">
            <legend>Date</legend>
            {(["dmy", "ymd", "mdy"] as const).map((f) => (
              <label key={f} className="check">
                <input type="radio" name="date" checked={draft.dateFormat === f} onChange={() => setDraft({ ...draft, dateFormat: f })} />
                <span>{formatDate(SAMPLE, { ...draft, dateFormat: f })}</span>
              </label>
            ))}
          </fieldset>
        </div>
        <div className="row-actions" style={{ marginTop: 20 }}>
          <button className="btn primary" disabled={busy || !changed}>
            Save preferences
          </button>
        </div>
      </form>
    </>
  );
}
