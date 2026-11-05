import { useEffect, useState } from "react";
import { api, type HostInfo } from "../api";

/** Manual port entry with a live check against other servers and the host. */
export function PortField({
  value,
  onChange,
  host,
  serverId,
  disabled,
  disabledHint,
}: {
  value: string;
  onChange: (v: string) => void;
  host: HostInfo | null;
  serverId?: number;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setProblem(null);
    const port = Number(value);
    if (!value || disabled) return;
    if (!Number.isInteger(port)) {
      setProblem("Enter a whole number.");
      return;
    }
    const t = window.setTimeout(() => {
      setChecking(true);
      api
        .checkPort(port, serverId)
        .then((r) => setProblem(r.problem))
        .catch(() => undefined)
        .finally(() => setChecking(false));
    }, 350);
    return () => window.clearTimeout(t);
  }, [value, serverId, disabled]);

  const others = host?.usedPorts.filter((p) => p.serverId !== serverId) ?? [];

  return (
    <label className="field">
      <span>Game port</span>
      <input
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder="27015"
        aria-invalid={!!problem}
        disabled={disabled}
        required
      />
      {disabled && disabledHint ? (
        <small>{disabledHint}</small>
      ) : problem ? (
        <span className="error-text">{problem}</span>
      ) : value && !checking ? (
        <small>Forward UDP {value} on your router so players can connect.</small>
      ) : (
        <small>
          {others.length
            ? `In use: ${others.map((p) => `${p.port} (${p.name})`).join(", ")}`
            : "No ports in use yet. 27015 is the usual first one."}
        </small>
      )}
    </label>
  );
}
