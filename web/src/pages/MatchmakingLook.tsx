import { useRef, useState, type CSSProperties } from "react";
import { api, type MatchmakingInfo, type MmColorKey, type MmLook, type MmTheme } from "../api";
import { useApp } from "../app-context";

const COLOR_LABELS: Record<MmColorKey, string> = {
  paper: "Background",
  panel: "Boxes",
  ink: "Text",
  accent: "Buttons and links",
  teamA: "Team 1",
  teamB: "Team 2",
};
const KEYS = Object.keys(COLOR_LABELS) as MmColorKey[];

const STATUS = {
  light: { run: "#12805c", fail: "#c2372b" },
  dark: { run: "#3cc496", fail: "#ef7468" },
};

/** Same colours the matchmaking site works out from a theme (server/src/matchmaking/look.ts). */
function previewVars(theme: MmTheme, look: MmLook): CSSProperties | null {
  if (!theme.colors || theme.mode === "auto") return null;
  const c = { ...theme.colors, ...Object.fromEntries(Object.entries(look.colors).filter(([, v]) => v)) } as Record<MmColorKey, string>;
  const st = STATUS[theme.mode];
  const lum = (hex: string) =>
    [1, 3, 5]
      .map((i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      })
      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  return {
    colorScheme: theme.mode,
    "--paper": c.paper,
    "--panel": c.panel,
    "--panel-sunk": `color-mix(in srgb, ${c.panel} 70%, ${c.paper})`,
    "--ink": c.ink,
    "--ink-soft": `color-mix(in srgb, ${c.ink} 74%, ${c.panel})`,
    "--ink-faint": `color-mix(in srgb, ${c.ink} 52%, ${c.panel})`,
    "--line": `color-mix(in srgb, ${c.ink} 20%, ${c.panel})`,
    "--line-soft": `color-mix(in srgb, ${c.ink} 11%, ${c.panel})`,
    "--accent": c.accent,
    "--accent-ink": lum(c.accent) > 0.4 ? "#111418" : "#ffffff",
    "--team-a": c.teamA,
    "--team-b": c.teamB,
    "--run": st.run,
    "--run-soft": `color-mix(in srgb, ${st.run} 16%, ${c.panel})`,
  } as CSSProperties;
}

/** The look of the matchmaking site: theme, colours, icon and banner. */
export function LookSettings({
  info,
  look,
  manage,
  onChange,
  onImages,
}: {
  info: MatchmakingInfo;
  look: MmLook;
  manage: boolean;
  onChange: (look: MmLook) => void;
  onImages: () => void;
}) {
  const theme = info.themes.find((t) => t.id === look.theme) ?? info.themes[0]!;
  const vars = previewVars(theme, look);
  const colors = theme.colors ? { ...theme.colors, ...look.colors } : null;

  return (
    <div className="panel">
      <h2 style={{ marginBottom: 6 }}>Look of the site</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Pick a theme, change its colours if you like, and add your own icon and banner. Colour changes show in the preview right away and on the site once you
        save.
      </p>

      {info.layouts && (
        <>
          <h3 style={{ margin: "4px 0 8px" }}>Layout</h3>
          <div className="mm-themes" role="radiogroup" aria-label="Layout" style={{ marginBottom: 16 }}>
            {info.layouts.map((l) => (
              <label key={l.id} className={`mm-theme ${(look.layout ?? "classic") === l.id ? "on" : ""}`} title={l.hint}>
                <input
                  type="radio"
                  name="mm-layout"
                  checked={(look.layout ?? "classic") === l.id}
                  disabled={!manage}
                  onChange={() => onChange({ ...look, layout: l.id })}
                />
                <span>
                  <b>{l.label}</b>
                  <br />
                  <span className="hint">{l.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <h3 style={{ margin: "4px 0 8px" }}>Colours</h3>
        </>
      )}
      <div className="mm-themes" role="radiogroup" aria-label="Theme">
        {info.themes.map((t) => (
          <label key={t.id} className={`mm-theme ${t.id === look.theme ? "on" : ""}`}>
            <input
              type="radio"
              name="mm-theme"
              checked={t.id === look.theme}
              disabled={!manage}
              onChange={() => onChange({ ...look, theme: t.id, colors: {} })}
            />
            <span className="mm-swatches" aria-hidden="true">
              {t.colors ? (
                (["paper", "panel", "accent", "teamA", "teamB"] as const).map((k) => <span key={k} style={{ background: t.colors![k] }} />)
              ) : (
                <>
                  <span style={{ background: "#eef1f4" }} />
                  <span style={{ background: "#121820" }} />
                  <span style={{ background: "#1f5fbf" }} />
                  <span style={{ background: "#1f5fbf" }} />
                  <span style={{ background: "#c76a1a" }} />
                </>
              )}
            </span>
            <span>
              {t.label}
              <span className="hint"> {t.mode === "auto" ? "· follows the device" : t.mode === "dark" ? "· dark" : "· light"}</span>
            </span>
          </label>
        ))}
      </div>

      {colors ? (
        <div className="mm-colors">
          {KEYS.map((k) => (
            <label key={k} className="mm-color">
              <input
                type="color"
                value={colors[k]}
                disabled={!manage}
                onChange={(e) => onChange({ ...look, colors: { ...look.colors, [k]: e.target.value } })}
                aria-label={COLOR_LABELS[k]}
              />
              <span>
                {COLOR_LABELS[k]}
                <span className="hint"> {colors[k]}</span>
              </span>
            </label>
          ))}
          {Object.keys(look.colors).length > 0 && manage && (
            <button type="button" className="btn small ghost" onClick={() => onChange({ ...look, colors: {} })}>
              Back to the theme's colours
            </button>
          )}
        </div>
      ) : (
        <p className="hint">The default theme follows each player's light or dark setting. Pick another theme to change the colours.</p>
      )}

      <div className="mm-preview-wrap">
        <span className="hint">Preview</span>
        <div className="mm-preview" style={vars ?? undefined}>
          <div className="mm-preview-head">
            {info.images.icon ? (
              <img src="/api/matchmaking/images/icon" alt="" className="mm-preview-icon" />
            ) : (
              <span className="mm-preview-mark" aria-hidden="true">
                <span />
                <span />
              </span>
            )}
            <b>{info.settings.title}</b>
          </div>
          {info.images.banner && <img src="/api/matchmaking/images/banner" alt="" className="mm-preview-banner" />}
          <div className="mm-preview-box">
            <div className="mm-preview-teams">
              <div className="mm-preview-team a">
                <b>Team 1</b>
                <span>Alex · 14,200</span>
                <span>Sam · 9,800</span>
              </div>
              <div className="mm-preview-team b">
                <b>Team 2</b>
                <span>Kim · 12,400</span>
                <span>Jo · 11,600</span>
              </div>
            </div>
            <div className="mm-preview-row">
              <span className="mm-preview-btn">Join the server</span>
              <span className="mm-preview-ok">Ready</span>
              <span className="mm-preview-faint">2 of 4 players in</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mm-images">
        <ImageField
          kind="icon"
          label="Icon"
          help="Square PNG, JPG or WebP, at most 512 KB. Shown next to the site's name and in the browser tab."
          info={info}
          manage={manage}
          onDone={onImages}
        />
        <ImageField
          kind="banner"
          label="Banner"
          help="Wide PNG, JPG or WebP, at most 3 MB (about 1600 × 300 looks good). Shown at the top of the page."
          info={info}
          manage={manage}
          onDone={onImages}
        />
      </div>
    </div>
  );
}

function ImageField({
  kind,
  label,
  help,
  info,
  manage,
  onDone,
}: {
  kind: "icon" | "banner";
  label: string;
  help: string;
  info: MatchmakingInfo;
  manage: boolean;
  onDone: () => void;
}) {
  const { toast } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const url = info.images[kind];
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, "ok");
      onDone();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div className="mm-image">
      <b>{label}</b>
      {url ? (
        <img src={`/api/matchmaking/images/${kind}?${url.split("?")[1] ?? ""}`} alt="" className={`mm-image-${kind}`} />
      ) : (
        <span className="hint">None uploaded.</span>
      )}
      <span className="hint">{help}</span>
      {manage && (
        <div className="row-actions">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void run(() => api.mmUploadImage(kind, file), `${label} uploaded.`);
            }}
          />
          <button type="button" className="btn small" disabled={busy} onClick={() => input.current?.click()}>
            {url ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
          </button>
          {url && (
            <button type="button" className="btn small ghost danger" disabled={busy} onClick={() => run(() => api.mmRemoveImage(kind), `${label} removed.`)}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
