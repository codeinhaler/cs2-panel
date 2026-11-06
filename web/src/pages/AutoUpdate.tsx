import { useEffect, useState } from "react";
import { api, fullTime, timeAgo, type AutoUpdateStatus, type UpdatePolicy, type UpdateSettings } from "../api";
import { useAction, useApp } from "../app-context";

const POLICIES: { value: UpdatePolicy; label: string; hint: string }[] = [
  { value: "when-empty", label: "Update when the servers are empty", hint: "Waits until nobody is playing, or until the longest wait below is over." },
  { value: "now", label: "Update right away", hint: "Players get a warning, then every server restarts." },
  { value: "notify", label: "Only tell me", hint: "Shows that an update is available. You start it yourself." },
  { value: "off", label: "Don't look for updates", hint: "The panel never checks Steam on its own." },
];

/** Settings and status for finding and installing new CS2 builds on its own. */
export function AutoUpdatePanel({ auto, onChange }: { auto: AutoUpdateStatus; onChange: (a: AutoUpdateStatus) => void }) {
  const { can } = useApp();
  const { busy, run } = useAction();
  const [form, setForm] = useState<UpdateSettings>(auto.settings);
  const [checking, setChecking] = useState(false);

  // Follow saved settings when they change elsewhere, but not while editing.
  const savedKey = JSON.stringify(auto.settings);
  useEffect(() => setForm(auto.settings), [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = can("game.update");
  const dirty = JSON.stringify(form) !== savedKey;
  const set = <K extends keyof UpdateSettings>(k: K, v: UpdateSettings[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const r = await run(() => api.saveAutoUpdate(form), "Automatic update settings saved.");
    if (r) onChange(r.auto);
  };
  const checkNow = async () => {
    setChecking(true);
    const r = await run(() => api.checkForUpdate());
    setChecking(false);
    if (r) onChange(r.auto);
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>Automatic updates</h2>
          <p className="hint" style={{ margin: "4px 0 0", maxWidth: "70ch" }}>
            When Valve releases a CS2 update, players can't join servers that haven't updated. The panel can look for new builds and install them for you.
          </p>
        </div>
        {edit && (
          <button className="btn small" onClick={() => void checkNow()} disabled={busy || checking || auto.checking}>
            {checking || auto.checking ? "Checking…" : "Check now"}
          </button>
        )}
      </div>

      <UpdateStatusLine auto={auto} />

      {edit ? (
        <div style={{ marginTop: 16 }}>
          <fieldset className="choice-list">
            <legend className="visually-hidden">When a new CS2 build is out</legend>
            {POLICIES.map((p) => (
              <label key={p.value} className="choice">
                <input type="radio" name="policy" value={p.value} checked={form.policy === p.value} onChange={() => set("policy", p.value)} />
                <span>
                  {p.label}
                  <small className="hint" style={{ display: "block" }}>
                    {p.hint}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          {form.policy !== "off" && (
            <div className="form-grid" style={{ maxWidth: 640, marginTop: 12 }}>
              <label className="field">
                <span>Look for updates every</span>
                <select value={form.checkMinutes} onChange={(e) => set("checkMinutes", Number(e.target.value))}>
                  {[5, 10, 15, 30, 60].map((m) => (
                    <option key={m} value={m}>
                      {m} minutes
                    </option>
                  ))}
                </select>
              </label>
              {form.policy === "when-empty" && (
                <label className="field">
                  <span>Longest wait for empty servers</span>
                  <select value={form.maxWaitMinutes} onChange={(e) => set("maxWaitMinutes", Number(e.target.value))}>
                    {[15, 30, 60, 120, 240, 480].map((m) => (
                      <option key={m} value={m}>
                        {m < 60 ? `${m} minutes` : `${m / 60} ${m === 60 ? "hour" : "hours"}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {(form.policy === "now" || form.policy === "when-empty") && (
                <label className="field">
                  <span>Warn players first</span>
                  <select value={form.warnSeconds} onChange={(e) => set("warnSeconds", Number(e.target.value))}>
                    <option value={0}>No warning</option>
                    <option value={30}>30 seconds</option>
                    <option value={60}>1 minute</option>
                    <option value={180}>3 minutes</option>
                    <option value={300}>5 minutes</option>
                  </select>
                </label>
              )}
            </div>
          )}
          <div className="row-actions" style={{ marginTop: 16 }}>
            <button className="btn primary" onClick={() => void save()} disabled={busy || !dirty}>
              Save
            </button>
            {dirty && (
              <button className="btn ghost" onClick={() => setForm(auto.settings)} disabled={busy}>
                Undo changes
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="hint">{POLICIES.find((p) => p.value === auto.settings.policy)?.label}. Only Admins and the Owner can change this.</p>
      )}
    </div>
  );
}

function UpdateStatusLine({ auto }: { auto: AutoUpdateStatus }) {
  if (auto.settings.policy === "off" && !auto.checkedAt) return null;
  if (auto.error) {
    return (
      <div className="notice error">
        Couldn't ask Steam for the latest build{auto.checkedAt && <> (<span title={fullTime(auto.checkedAt)}>{timeAgo(auto.checkedAt)}</span>)</>}: {auto.error}
      </div>
    );
  }
  if (!auto.checkedAt) return <p className="hint">Hasn't checked yet. The first check runs within a minute.</p>;
  const checked = (
    <>
      Last checked <span title={fullTime(auto.checkedAt)}>{timeAgo(auto.checkedAt)}</span>.
    </>
  );
  if (!auto.updateAvailable) {
    return (
      <p className="hint">
        <span className="state-pill" data-state="active">
          Up to date
        </span>{" "}
        Build {auto.installedBuild ?? "unknown"} is the latest. {checked}
      </p>
    );
  }
  return (
    <div className="notice info">
      <strong>A CS2 update is available</strong>: Steam build {auto.latestBuild}
      {auto.latestUpdatedAt && <> (released <span title={fullTime(auto.latestUpdatedAt)}>{timeAgo(auto.latestUpdatedAt)}</span>)</>}, you have{" "}
      {auto.installedBuild}.{" "}
      {auto.settings.policy === "when-empty" && auto.deadline && (
        <>
          It installs as soon as nobody is playing, at the latest <span title={fullTime(auto.deadline)}>{fullTime(auto.deadline)}</span>.{" "}
        </>
      )}
      {auto.settings.policy === "now" && <>It installs within a minute. </>}
      {auto.settings.policy === "notify" && <>Start it with Update now below. </>}
      {checked}
    </div>
  );
}
