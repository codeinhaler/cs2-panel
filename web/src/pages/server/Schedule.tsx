import { useEffect, useState } from "react";
import { api, fullTime, type RestartSchedule, type ScheduleView, type Server } from "../../api";
import { useAction } from "../../app-context";
import { TimeSelect } from "../../components/TimeSelect";

/** Daily restart for one server. */
export function SchedulePanel({ server }: { server: Server }) {
  const { busy, run } = useAction();
  const [view, setView] = useState<ScheduleView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [form, setForm] = useState<RestartSchedule>({ restartAt: "06:00", ifPlayers: "wait", maxWaitMinutes: 120 });

  const adopt = (v: ScheduleView) => {
    setView(v);
    setEnabled(!!v.schedule.restartAt);
    setForm({ ...v.schedule, restartAt: v.schedule.restartAt ?? "06:00" });
  };
  useEffect(() => {
    void api.schedule(server.id).then(adopt);
  }, [server.id]);

  if (!view) return null;
  const saved = view.schedule;
  const wanted: RestartSchedule = { ...form, restartAt: enabled ? form.restartAt : null };
  const dirty = JSON.stringify(wanted) !== JSON.stringify(saved);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.saveSchedule(server.id, wanted), enabled ? "Restart schedule saved." : "Scheduled restart turned off.");
    if (r) adopt(r);
  };

  return (
    <form className="panel" onSubmit={save}>
      <h2 style={{ marginBottom: 6 }}>Scheduled restart</h2>
      <p className="hint" style={{ marginTop: 0, maxWidth: "70ch" }}>
        A daily restart keeps a long-running server fresh. It only happens while the server is running.
      </p>
      {view.waitingSince ? (
        <div className="notice info" style={{ marginBottom: 12 }}>
          Today's restart is waiting for players to leave. It happens at the latest {fullTime(view.deadline)}.
        </div>
      ) : (
        view.nextAt && <p className="hint">Next restart: {fullTime(view.nextAt)}.</p>
      )}
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Restart this server every day</span>
      </label>
      {enabled && (
        <div className="form-grid" style={{ maxWidth: 640, marginTop: 12 }}>
          <div className="field">
            <span>At</span>
            <TimeSelect value={form.restartAt ?? "06:00"} onChange={(v) => setForm({ ...form, restartAt: v })} label="Restart time" />
            <small className="hint">The machine's time ({view.timezone})</small>
          </div>
          <label className="field">
            <span>If players are on</span>
            <select value={form.ifPlayers} onChange={(e) => setForm({ ...form, ifPlayers: e.target.value as RestartSchedule["ifPlayers"] })}>
              <option value="wait">Wait until they leave</option>
              <option value="restart">Warn them and restart</option>
            </select>
          </label>
          {form.ifPlayers === "wait" && (
            <label className="field">
              <span>Longest wait</span>
              <select value={form.maxWaitMinutes} onChange={(e) => setForm({ ...form, maxWaitMinutes: Number(e.target.value) })}>
                {[30, 60, 120, 240, 480, 720].map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} minutes` : `${m / 60} ${m === 60 ? "hour" : "hours"}`}
                  </option>
                ))}
              </select>
              <small className="hint">Then players get a 1-minute warning and it restarts.</small>
            </label>
          )}
        </div>
      )}
      <div className="row-actions" style={{ marginTop: 16 }}>
        <button className="btn primary" disabled={busy || !dirty}>
          Save schedule
        </button>
      </div>
    </form>
  );
}
