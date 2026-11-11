import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type CpuBlock, type CpuFlag, type CpuOverview, type CpuPolicy, type CpuServerRow } from "../api";
import { useAction, useApp } from "../app-context";
import { CpuPicker, CpuStatusLine, formatCpus, type CpuChoice } from "../components/CpuAssign";

/** CS2 Panel → Settings. For now one section: CPU Management. */
export function SettingsPage() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="hint" style={{ margin: 0 }}>
            Settings for the panel and the machine it runs on.
          </p>
        </div>
      </div>
      <CpuManagement />
    </div>
  );
}

const FLAG_TEXT: Record<CpuFlag, string> = {
  free: "Free",
  assigned: "In use",
  shared: "Shared",
  conflict: "Conflict",
  reserved: "Reserved",
  pending: "Restart required",
  mismatch: "Mismatch",
};

const USAGE_MS = 3_000;
const FULL_MS = 20_000;

function CpuManagement() {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const manage = can("server.manage");
  const [data, setData] = useState<CpuOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; choice: CpuChoice } | null>(null);
  const [policy, setPolicy] = useState<CpuPolicy | null>(null);
  const policyDirty = useRef(false);

  const load = useCallback(async (refresh = false) => {
    try {
      const d = await api.cpu(refresh);
      setData(d);
      setError(null);
      // Don't overwrite a policy the admin is in the middle of changing.
      if (!policyDirty.current) setPolicy(d.policy);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    // Usage numbers every few seconds (cheap); everything else now and then. Selections stay put.
    const usage = setInterval(() => {
      if (document.hidden) return;
      void api
        .cpuUsage()
        .then((u) =>
          setData((d) =>
            d
              ? {
                  ...d,
                  usageAvailable: u.available,
                  groups: d.groups.map((g) => ({
                    ...g,
                    blocks: g.blocks.map((b) => ({
                      ...b,
                      usage: u.blocks[b.key] ?? null,
                      cpuUsage: Object.fromEntries(b.cpus.map((c) => [c, u.cpus[c] ?? null])),
                    })),
                  })),
                }
              : d,
          ),
        )
        .catch(() => undefined);
    }, USAGE_MS);
    const full = setInterval(() => {
      if (!document.hidden) void load();
    }, FULL_MS);
    return () => {
      clearInterval(usage);
      clearInterval(full);
    };
  }, [load]);

  if (error && !data) return <p className="notice error">{error}</p>;
  if (!data || !policy) return <p className="hint">Reading the CPUs…</p>;

  const t = data.topology;
  const blocks = data.groups.flatMap((g) => g.blocks);
  const block = blocks.find((b) => b.key === selected) ?? null;
  const rowOf = (id: number) => data.servers.find((r) => r.id === id)!;
  const cores = data.summary.unit === "cores";
  const unit = cores ? "core" : t.virtualization.detected ? "vCPU" : "CPU";
  const layoutTitle =
    t.kind === "physical"
      ? "Physical cores"
      : t.kind === "guest"
        ? "Virtual machine layout (guest-visible)"
        : t.virtualization.detected
          ? "Virtual CPU topology"
          : "Logical CPUs";

  const saveAssignment = async () => {
    if (!editing) return;
    const r = await run(() => api.setServerCpu(editing.id, editing.choice.mode === "auto" ? { mode: "auto" } : { mode: "manual", cpus: editing.choice.cpus }));
    if (!r) return;
    for (const w of r.warnings) toast(w, "info");
    toast(r.row.pendingRestart ? `${r.row.name}: saved. Applies when it restarts.` : `${r.row.name}: saved.`);
    setEditing(null);
    await load();
  };

  const savePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.setCpuPolicy(policy), 'CPU policy saved. It\'s used for new servers and "Automatic"; existing servers keep their CPUs.');
    if (!r) return;
    policyDirty.current = false;
    await load();
  };
  const setP = <K extends keyof CpuPolicy>(k: K, v: CpuPolicy[K]) => {
    policyDirty.current = true;
    setPolicy({ ...policy, [k]: v });
  };

  const editor = (id: number) =>
    editing?.id === id ? (
      <div className="cpu-editor">
        <CpuPicker overview={data} value={editing.choice} onChange={(choice) => setEditing({ id, choice })} serverId={id} disabled={busy} />
        <div className="row-actions" style={{ marginTop: 10 }}>
          <button type="button" className="btn primary" onClick={() => void saveAssignment()} disabled={busy}>
            Save
          </button>
          <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
            Cancel
          </button>
          {rowOf(id).state === "active" && <span className="hint">The server keeps running on its current CPUs until it's restarted.</span>}
        </div>
      </div>
    ) : null;
  const startEdit = (r: CpuServerRow) => setEditing({ id: r.id, choice: { mode: r.mode, cpus: r.configuredText } });

  return (
    <>
      <div className="panel">
        <div className="row-actions" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2 style={{ margin: 0 }}>CPU Management</h2>
            <p className="hint" style={{ margin: "4px 0 0" }}>
              {t.model ?? "Unknown CPU"} · {layoutTitle}
              {t.virtualization.detected && ` · ${t.virtualization.vendor ?? "virtual machine"}`}
            </p>
          </div>
          <button type="button" className="btn ghost small" onClick={() => void load(true)}>
            Read CPUs again
          </button>
        </div>
        {t.notes.map((n) => (
          <p key={n} className="notice info" style={{ marginTop: 10 }}>
            {n}
          </p>
        ))}
        {t.virtualization.detected && (
          <p className="hint">
            Tip: if the hypervisor pins vCPUs to cores (on ESXi, <span className="mono">sched.vcpuN.affinity</span>), reserve the vCPUs on slower cores below so
            automatic allocation leaves them for the system.
          </p>
        )}
        {t.restricted && (
          <p className="notice warn">
            The panel may only use CPUs {t.allowed} (of {t.online}), e.g. because of a container or cgroup limit. Only those are shown.
          </p>
        )}

        <div className="stat-tiles cpu-stats" style={{ marginTop: 14 }}>
          {cores && <Stat label="Cores" value={data.summary.cores ?? 0} sub={t.kind === "guest" ? "as the VM shows them" : undefined} />}
          <Stat label={t.virtualization.detected ? "vCPUs" : "Logical CPUs"} value={data.summary.logical} />
          <Stat label={`Assigned ${unit}s`} value={data.summary.assigned} />
          <Stat label={`Reserved ${unit}s`} value={data.summary.reserved} />
          <Stat label={`Free ${unit}s`} value={data.summary.free} sub="no game server set to it" />
          <Stat label="Conflicts" value={data.summary.conflicts} warn={data.summary.conflicts > 0} />
          <Stat label="Mismatches" value={data.summary.mismatches} warn={data.summary.mismatches > 0} />
          {data.summary.pending > 0 && <Stat label="Restart required" value={data.summary.pending} warn />}
        </div>

        <div className="cpu-legend" aria-label="Legend">
          {(["free", "assigned", "shared", "conflict", "reserved", "pending", "mismatch"] as CpuFlag[]).map((f) => (
            <span key={f} className="cpu-legend-item" data-status={f}>
              <i aria-hidden="true" /> {FLAG_TEXT[f]}
            </span>
          ))}
          {!data.usageAvailable && <span className="hint">· CPU usage isn't available right now</span>}
        </div>

        {data.groups.map((g) => (
          <details key={g.key} className="cpu-group" open={data.groups.length === 1 || g.blocks.length <= 32}>
            <summary>
              {g.label} <span className="hint">· {g.blocks.length}</span>
            </summary>
            <div className="cpu-grid">
              {g.blocks.map((b) => (
                <CoreBlock key={b.key} b={b} selected={selected === b.key} onClick={() => setSelected(selected === b.key ? null : b.key)} />
              ))}
            </div>
          </details>
        ))}

        {block && (
          <div className="cpu-detail" aria-live="polite">
            <div className="row-actions" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>{block.label}</h3>
              <button type="button" className="btn ghost small" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
            <dl className="cpu-facts">
              <dt>{cores ? "Logical CPUs" : "CPU ID"}</dt>
              <dd className="mono">{formatCpus(block.cpus)}</dd>
              {cores && block.cpus.length > 1 && (
                <>
                  <dt>SMT threads</dt>
                  <dd>{block.cpus.join(" and ")} are threads of this one core</dd>
                </>
              )}
              {block.package !== null && t.packages > 1 && (
                <>
                  <dt>{t.kind === "guest" ? "Virtual socket" : "Socket"}</dt>
                  <dd>{block.package}</dd>
                </>
              )}
              {block.node !== null && t.nodes > 1 && (
                <>
                  <dt>NUMA node</dt>
                  <dd>{block.node}</dd>
                </>
              )}
              {block.llc && t.llcGroups > 1 && (
                <>
                  <dt>Shares cache with</dt>
                  <dd className="mono">{block.llc}</dd>
                </>
              )}
              {block.type && (
                <>
                  <dt>Core type</dt>
                  <dd>{block.type === "performance" ? "Performance (P-core)" : "Efficiency (E-core)"}</dd>
                </>
              )}
              <dt>Usage</dt>
              <dd>
                {block.usage === null ? "–" : `${Math.round(block.usage)}%`}
                {block.cpus.length > 1 &&
                  ` (${block.cpus.map((c) => `CPU ${c}: ${block.cpuUsage[c] == null ? "–" : `${Math.round(block.cpuUsage[c]!)}%`}`).join(", ")})`}
                {t.virtualization.detected && <span className="hint"> · inside the VM; the host's cores may be busier</span>}
              </dd>
              <dt>Status</dt>
              <dd>{block.flags.map((f) => FLAG_TEXT[f]).join(", ")}</dd>
              {block.reservedCpus.length > 0 && (
                <>
                  <dt>Reserved</dt>
                  <dd className="mono">{formatCpus(block.reservedCpus)}</dd>
                </>
              )}
            </dl>
            {block.servers.length === 0 && <p className="hint">No game server is set to this {unit}.</p>}
            {block.servers.map((s) => {
              const r = rowOf(s.id);
              return (
                <div key={s.id} className="cpu-detail-server">
                  <div className="row-actions" style={{ justifyContent: "space-between" }}>
                    <span>
                      <Link to={`/servers/${s.id}/settings`}>
                        <b>{s.name}</b>
                      </Link>{" "}
                      <CpuStatusLine row={r} allowSharing={data.policy.allowSharing} />
                    </span>
                    {manage && editing?.id !== s.id && (
                      <button type="button" className="btn small" onClick={() => startEdit(r)}>
                        Edit assignment
                      </button>
                    )}
                  </div>
                  {editor(s.id)}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel">
        <h2 style={{ marginBottom: 6 }}>Servers</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Server</th>
                <th>Status</th>
                <th>Assignment</th>
                <th>Configured</th>
                <th>Actual</th>
                <th>Notes</th>
                {manage && <th />}
              </tr>
            </thead>
            <tbody>
              {data.servers.length === 0 && (
                <tr>
                  <td colSpan={7} className="hint">
                    No servers yet.
                  </td>
                </tr>
              )}
              {data.servers.map((r) => (
                <ServerRow
                  key={r.id}
                  r={r}
                  manage={manage}
                  allowSharing={data.policy.allowSharing}
                  onEdit={() => startEdit(r)}
                  editing={editing?.id === r.id}
                  editor={editor(r.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <form className="panel" onSubmit={savePolicy}>
        <h2 style={{ marginBottom: 6 }}>Allocation policy</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          How new servers (and servers set to Automatic) get their CPUs. Existing servers keep their CPUs until you change them; nothing is moved in the
          background and running servers are never restarted.
        </p>
        <div className="exec-list" role="radiogroup" aria-label="Allocation mode">
          {(
            [
              ["legacy", "Legacy", "One CPU per server, the least-used one, as the panel always did."],
              [
                "auto",
                "Automatic (topology-aware)",
                "Each new server gets its own core: not a thread of a core another server uses, P-cores first, never reserved CPUs.",
              ],
              ["manual", "Manual", "You choose the CPUs for each new server; the page suggests a free core."],
            ] as const
          ).map(([v, label, hint]) => (
            <label key={v} className="check">
              <input type="radio" name="cpu-mode" checked={policy.mode === v} onChange={() => setP("mode", v)} disabled={!manage} />
              <span>
                <b>{label}</b> <span className="hint">· {hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="exec-list" style={{ marginTop: 12 }}>
          <label className="check">
            <input type="checkbox" checked={policy.topologyAware} onChange={(e) => setP("topologyAware", e.target.checked)} disabled={!manage} />
            <span>
              Use the core layout <span className="hint">· cores and SMT threads when known; off: every logical CPU on its own</span>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={policy.includeSmtSiblings} onChange={(e) => setP("includeSmtSiblings", e.target.checked)} disabled={!manage} />
            <span>
              Give a server all threads of its core <span className="hint">· e.g. 2 and 14 together{!t.smt && "; this machine shows no SMT threads"}</span>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={policy.preferPerformance} onChange={(e) => setP("preferPerformance", e.target.checked)} disabled={!manage} />
            <span>
              Prefer P-cores over E-cores{" "}
              <span className="hint">· {t.hybrid ? "detected on this machine" : "not detected here; reserve slow CPUs instead"}</span>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={policy.allowSharing} onChange={(e) => setP("allowSharing", e.target.checked)} disabled={!manage} />
            <span>
              Allow servers to share a core <span className="hint">· shown as Shared instead of Conflict</span>
            </span>
          </label>
        </div>
        <label className="field" style={{ maxWidth: 320, marginTop: 12 }}>
          <span>Reserved CPUs</span>
          <input
            value={policy.reserved}
            onChange={(e) => setP("reserved", e.target.value)}
            placeholder="none, e.g. 4 or 0,12"
            disabled={!manage}
            spellCheck={false}
          />
          <small className="hint">Never handed out automatically. You can still pick them by hand. Nothing is reserved unless you add it here.</small>
        </label>
        {manage && (
          <button className="btn primary" style={{ marginTop: 12 }} disabled={busy || !policyDirty.current}>
            Save policy
          </button>
        )}
      </form>
    </>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: number; sub?: string; warn?: boolean }) {
  return (
    <div className={`stat-tile${warn ? " warn" : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function CoreBlock({ b, selected, onClick }: { b: CpuBlock; selected: boolean; onClick: () => void }) {
  const names = b.servers.map((s) => s.name);
  return (
    <button type="button" className={`cpu-block${selected ? " selected" : ""}`} data-status={b.status} onClick={onClick} aria-pressed={selected}>
      <span className="cpu-block-head">
        <span>{b.label}</span>
        {b.type && <span className="cpu-type">{b.type === "performance" ? "P" : "E"}</span>}
      </span>
      <span className="cpu-block-who" title={names.join(", ")}>
        {names.length ? names.join(", ") : b.reservedCpus.length ? "Reserved" : "Free"}
      </span>
      <span className="cpu-block-ids mono">{formatCpus(b.cpus)}</span>
      <span className="cpu-block-usage">
        <span className="meter" aria-hidden="true">
          <i style={{ width: `${b.usage ?? 0}%` }} className={b.usage !== null && b.usage >= 90 ? "warn" : undefined} />
        </span>
        <span className="mono">{b.usage === null ? "–" : `${Math.round(b.usage)}%`}</span>
      </span>
      {b.status !== "free" && b.status !== "assigned" && <span className="cpu-block-flag">{FLAG_TEXT[b.status]}</span>}
    </button>
  );
}

function ServerRow({
  r,
  manage,
  allowSharing,
  onEdit,
  editing,
  editor,
}: {
  r: CpuServerRow;
  manage: boolean;
  allowSharing: boolean;
  onEdit: () => void;
  editing: boolean;
  editor: React.ReactNode;
}) {
  const running = r.state === "active" || r.state === "activating";
  return (
    <>
      <tr>
        <td>
          <Link to={`/servers/${r.id}/settings`}>{r.name}</Link>
        </td>
        <td>
          <span className="state-pill" data-state={r.state}>
            {running ? "Running" : r.state === "failed" ? "Failed" : "Stopped"}
          </span>
        </td>
        <td>{r.mode === "auto" ? "Automatic" : "Manual"}</td>
        <td className="mono">{r.configuredText}</td>
        <td className="mono">{r.actualText ?? (running ? "?" : "–")}</td>
        <td>
          {r.pendingRestart && (
            <span className="state-pill" data-state="activating">
              Restart required
            </span>
          )}
          {r.verify === "mismatch" && (
            <span className="state-pill" data-state="failed">
              Mismatch
            </span>
          )}
          {r.missing.length > 0 && (
            <span className="state-pill" data-state="failed">
              CPU {formatCpus(r.missing)} missing
            </span>
          )}
          {r.conflicts.length > 0 && (
            <span className="state-pill" data-state={allowSharing ? "inactive" : "failed"}>
              {allowSharing ? "Shares with" : "Conflicts with"} {r.conflicts.map((c) => c.name).join(", ")}
            </span>
          )}
          {!r.pendingRestart && r.verify === "match" && r.conflicts.length === 0 && r.missing.length === 0 && <span className="hint">OK</span>}
        </td>
        {manage && (
          <td>
            {!editing && (
              <button type="button" className="btn small" onClick={onEdit}>
                Edit
              </button>
            )}
          </td>
        )}
      </tr>
      {editing && (
        <tr>
          <td colSpan={manage ? 7 : 6}>{editor}</td>
        </tr>
      )}
    </>
  );
}
