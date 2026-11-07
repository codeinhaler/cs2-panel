import { currentPrefs } from "../format";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A time of day as "HH:MM" (24h), shown in the user's 12h/24h preference.
 * (The browser's own time input follows the computer's language instead.)
 */
export function TimeSelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const twelve = currentPrefs().timeFormat === "12h";
  const [h, m] = (/^(\d{2}):(\d{2})$/.exec(value) ?? ["", "06", "00"]).slice(1).map(Number) as [number, number];
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5);
  if (!minutes.includes(m)) minutes.push(m), minutes.sort((a, b) => a - b);
  const hourLabel = (hour: number) => (twelve ? `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}` : pad(hour));
  return (
    <span className="time-select" role="group" aria-label={label}>
      <select value={h} onChange={(e) => onChange(`${pad(Number(e.target.value))}:${pad(m)}`)} aria-label="Hour">
        {Array.from({ length: 24 }, (_, hour) => (
          <option key={hour} value={hour}>
            {hourLabel(hour)}
          </option>
        ))}
      </select>
      <span aria-hidden="true">:</span>
      <select value={m} onChange={(e) => onChange(`${pad(h)}:${pad(Number(e.target.value))}`)} aria-label="Minute">
        {minutes.map((min) => (
          <option key={min} value={min}>
            {pad(min)}
          </option>
        ))}
      </select>
    </span>
  );
}
