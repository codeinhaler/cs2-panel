import { useCallback, useEffect, useState } from "react";
import { api, type CpuOverview, type CpuServerRow } from "../api";
import { useAction, useApp } from "../app-context";

/** A server's CPUs as the editor holds them: automatic (by the CPU policy) or a list picked by hand. */
export interface CpuChoice {
  mode: "auto" | "manual";
  cpus: string;
}

/** "2-4,14" → [2,3,4,14]; null when it isn't a CPU list (the server says exactly what's wrong on save). */
export function parseCpus(text: string): number[] | null {
  const t = text.trim();
  if (!t) return [];
  const out = new Set<number>();
  for (const part of t.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (b < a || b > 1023) return null;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

export function formatCpus(cpus: Iterable<number>): string {
  const ids = [...new Set(cpus)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < ids.length;) {
    let j = i;
    while (j + 1 < ids.length && ids[j + 1] === ids[j]! + 1) j++;
    if (j - i >= 2) parts.push(`${ids[i]}-${ids[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(ids[k]));
    i = j + 1;
  }
  return parts.join(",");
}

const POLICY_TEXT = {
  legacy: "the least-used CPU, like before",
  auto: "a free core by the CPU policy",
  manual: "a free core by the CPU policy",
} as const;

/**
 * Picks a server's CPUs: automatic, or by hand from the machine's cores/vCPUs (each CPU shows who else uses it).
 * Used on CPU Management, its overview, a server's Settings tab and the New server page.
 */
export function CpuPicker({
  overview,
  value,
  onChange,
  serverId,
  disabled,
}: {
  overview: CpuOverview | null;
  value: CpuChoice;
  onChange: (v: CpuChoice) => void;
  serverId?: number;
  disabled?: boolean;
}) {
  const selected = parseCpus(value.cpus) ?? [];
  const reserved = new Set(parseCpus(overview?.policy.reserved ?? "") ?? []);
  const usersOf = (cpu: number) => (overview?.servers ?? []).filter((r) => r.id !== serverId && r.configured.includes(cpu)).map((r) => r.name);
  const toggle = (cpu: number) => {
    const next = selected.includes(cpu) ? selected.filter((c) => c !== cpu) : [...selected, cpu];
    onChange({ mode: "manual", cpus: formatCpus(next) });
  };
  const unitName = overview?.topology.kind === "logical" ? (overview.topology.virtualization.detected ? "vCPU" : "CPU") : "core";
  return (
    <div className="cpu-picker">
      <div className="row-actions" role="radiogroup" aria-label="How this server gets its CPUs">
        <label className="check">
          <input type="radio" checked={value.mode === "auto"} onChange={() => onChange({ ...value, mode: "auto" })} disabled={disabled} />
          <span>
            Automatic <span className="hint">· {POLICY_TEXT[overview?.policy.mode ?? "legacy"]}</span>
          </span>
        </label>
        <label className="check">
          <input type="radio" checked={value.mode === "manual"} onChange={() => onChange({ ...value, mode: "manual" })} disabled={disabled} />
          <span>Choose CPUs</span>
        </label>
      </div>
      {value.mode === "manual" && (
        <>
          {overview && (
            <div className="cpu-picker-blocks">
              {overview.groups
                .flatMap((g) => g.blocks)
                .map((b) => (
                  <div key={b.key} className="cpu-picker-block" title={b.type ? `${b.type === "performance" ? "P" : "E"}-core` : undefined}>
                    <span className="cpu-picker-label">
                      {b.label}
                      {b.type && <span className="hint"> {b.type === "performance" ? "P" : "E"}</span>}
                    </span>
                    <span className="cpu-picker-cpus">
                      {b.cpus.map((c) => {
                        const users = usersOf(c);
                        const on = selected.includes(c);
                        return (
                          <button
                            type="button"
                            key={c}
                            className={`cpu-chip${on ? " on" : ""}${users.length ? " used" : ""}${reserved.has(c) ? " reserved" : ""}`}
                            aria-pressed={on}
                            onClick={() => toggle(c)}
                            disabled={disabled}
                            title={[users.length ? `Used by ${users.join(", ")}` : "Free", reserved.has(c) ? "reserved" : ""].filter(Boolean).join(" · ")}
                          >
                            {c}
                            {users.length > 0 && <span className="cpu-chip-dot" aria-label={`used by ${users.join(", ")}`} />}
                          </button>
                        );
                      })}
                    </span>
                  </div>
                ))}
            </div>
          )}
          <label className="field" style={{ maxWidth: 320, marginTop: 8 }}>
            <span>CPU list</span>
            <input
              value={value.cpus}
              onChange={(e) => onChange({ mode: "manual", cpus: e.target.value })}
              placeholder="e.g. 2,14 or 2-4"
              disabled={disabled}
              spellCheck={false}
              aria-invalid={parseCpus(value.cpus) === null}
            />
            <small className="hint">
              Click CPUs above or type a list. A dot means another server uses that CPU
              {unitName === "core" ? "; CPUs in the same box are threads of one core" : ""}.
            </small>
          </label>
        </>
      )}
    </div>
  );
}

/** One line about a server's CPUs: what it's set to, what it runs on, and anything to act on. */
export function CpuStatusLine({ row, allowSharing }: { row: CpuServerRow; allowSharing: boolean }) {
  return (
    <span className="cpu-status-line">
      <span>
        Set to <b className="mono">{row.configuredText}</b> ({row.mode === "auto" ? "automatic" : "manual"})
      </span>
      {row.actualText && (
        <span>
          {" · "}runs on <b className="mono">{row.actualText}</b>
        </span>
      )}
      {row.pendingRestart && (
        <span className="state-pill" data-state="activating">
          Restart required
        </span>
      )}
      {row.verify === "mismatch" && (
        <span className="state-pill" data-state="failed">
          Runs on other CPUs than it was started with
        </span>
      )}
      {row.verify === "unknown" && <span className="hint"> · couldn't read what it runs on</span>}
      {row.missing.length > 0 && (
        <span className="state-pill" data-state="failed">
          CPU {formatCpus(row.missing)} not on this machine
        </span>
      )}
      {row.conflicts.length > 0 && (
        <span className="state-pill" data-state={allowSharing ? "inactive" : "failed"}>
          {allowSharing ? "Shares with " : "Conflicts with "}
          {row.conflicts.map((c) => c.name).join(", ")}
        </span>
      )}
    </span>
  );
}

/** The CPUs panel on a server's Settings tab: same data and save as CPU Management. */
export function ServerCpuPanel({ serverId, canEdit }: { serverId: number; canEdit: boolean }) {
  const { toast } = useApp();
  const { busy, run } = useAction();
  const [overview, setOverview] = useState<CpuOverview | null>(null);
  const [choice, setChoice] = useState<CpuChoice | null>(null);
  const row = overview?.servers.find((r) => r.id === serverId) ?? null;

  const load = useCallback(async () => {
    const o = await api.cpu();
    setOverview(o);
    const r = o.servers.find((x) => x.id === serverId);
    if (r) setChoice({ mode: r.mode, cpus: r.configuredText });
  }, [serverId]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  if (!overview || !row || !choice) return null;
  const dirty = choice.mode !== row.mode || (choice.mode === "manual" && formatCpus(parseCpus(choice.cpus) ?? []) !== row.configuredText);
  const save = async () => {
    const r = await run(() => api.setServerCpu(serverId, choice.mode === "auto" ? { mode: "auto" } : { mode: "manual", cpus: choice.cpus }));
    if (!r) return;
    for (const w of r.warnings) toast(w, "info");
    toast(r.row.pendingRestart ? "CPUs saved. They apply when the server restarts." : "CPUs saved.");
    await load();
  };
  return (
    <div className="panel">
      <h2 style={{ marginBottom: 6 }}>CPUs</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        <CpuStatusLine row={row} allowSharing={overview.policy.allowSharing} />
      </p>
      {canEdit ? (
        <>
          <CpuPicker overview={overview} value={choice} onChange={setChoice} serverId={serverId} disabled={busy} />
          <div className="row-actions" style={{ marginTop: 12 }}>
            <button type="button" className="btn primary" onClick={() => void save()} disabled={busy || !dirty}>
              Save CPUs
            </button>
            <span className="hint">A running server keeps its CPUs until it's restarted. All servers: CS2 Panel → Settings.</span>
          </div>
        </>
      ) : (
        <p className="hint">Only Admins and the Owner can change CPUs.</p>
      )}
    </div>
  );
}
