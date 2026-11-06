export const DURATIONS = [
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "1 day", minutes: 1440 },
  { label: "1 week", minutes: 10080 },
  { label: "30 days", minutes: 43200 },
  { label: "Permanent", minutes: 0 },
];

export function lengthText(minutes: number): string {
  if (minutes === 0) return "Permanent";
  return DURATIONS.find((d) => d.minutes === minutes)?.label ?? (minutes % 1440 === 0 ? `${minutes / 1440} days` : `${minutes} min`);
}

export function SteamLink({ id }: { id: string | null }) {
  if (!id) return <span className="hint">unknown</span>;
  return (
    <a href={`https://steamcommunity.com/profiles/${id}`} target="_blank" rel="noreferrer" className="mono">
      {id}
    </a>
  );
}

export function DurationSelect({ value, onChange }: { value: number; onChange: (minutes: number) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {DURATIONS.map((d) => (
        <option key={d.minutes} value={d.minutes}>
          {d.label}
        </option>
      ))}
    </select>
  );
}
