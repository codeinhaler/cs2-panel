import { useCallback, useEffect, useState } from "react";
import { api, type CheckResult, type DiscordBotInfo, type DiscordBotInput } from "../api";
import { useAction, useApp } from "../app-context";

const STATE_TEXT = {
  off: ["Off", "inactive"],
  "not-set-up": ["Not set up", "activating"],
  checking: ["Connecting", "activating"],
  ready: ["Ready", "active"],
  error: ["Error", "failed"],
} as const;

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "never");

/**
 * The optional Discord bot: moves players who opted in from a waiting room into their match's voice channel.
 * Separate from the channel links above (which it reuses) and from the Discord notifications.
 */
export function DiscordBotPanel() {
  const { can } = useApp();
  const { busy, run } = useAction();
  const manage = can("server.manage");
  const [info, setInfo] = useState<DiscordBotInfo | null>(null);
  const [form, setForm] = useState<DiscordBotInput | null>(null);
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [result, setResult] = useState<{ title: string; r: CheckResult } | null>(null);

  const load = useCallback(async () => {
    const i = await api.discordBot();
    setInfo(i);
    const { hasToken: _t, hasSecret: _s, ...rest } = i.settings;
    setForm((f) => f ?? rest);
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
    const t = setInterval(
      () =>
        void api
          .discordBot()
          .then(setInfo)
          .catch(() => undefined),
      15_000,
    );
    return () => clearInterval(t);
  }, [load]);

  if (!info || !form) return null;
  const st = STATE_TEXT[info.status.state];
  const set = <K extends keyof DiscordBotInput>(k: K, v: DiscordBotInput[K]) => setForm({ ...form, [k]: v });
  const temporary = form.teamMode === "temporary" || form.duelMode === "temporary";

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.saveDiscordBot({ ...form, ...(token ? { token } : {}), ...(secret ? { clientSecret: secret } : {}) }), "Discord bot saved.");
    if (!r) return;
    setToken("");
    setSecret("");
    setForm(null);
    await load();
  };
  const check = async (title: string, fn: () => Promise<CheckResult>) => {
    const r = await run(fn);
    if (r) setResult({ title, r });
    void load();
  };

  return (
    <form className="panel" onSubmit={save}>
      <div className="row-actions" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Discord bot</h2>
        <span className="state-pill" data-state={st[1]}>
          {st[0]}
        </span>
      </div>
      <p className="hint" style={{ marginTop: 6 }}>
        Optional. Players who link their Discord on the matchmaking site and switch it on are moved from the waiting room into their match's voice channel when
        the match starts, and back afterwards. Everyone else keeps the Join Discord channel button. If the bot is off or Discord is down, matchmaking carries on
        as normal.
      </p>
      <dl className="cpu-facts">
        <dt>Discord server</dt>
        <dd>{info.status.guildName ?? info.guildId ?? "not set"}</dd>
        <dt>Bot</dt>
        <dd>{info.status.botUser ?? "–"}</dd>
        <dt>Last OK</dt>
        <dd>{when(info.status.lastOk)}</dd>
        {info.status.lastError && (
          <>
            <dt>Last problem</dt>
            <dd className="text-fail">{info.status.lastError}</dd>
          </>
        )}
        <dt>Players</dt>
        <dd>
          {info.linked} linked, {info.optedIn} moved automatically
        </dd>
      </dl>

      <details className="mm-config" open={!info.settings.hasToken}>
        <summary>Set up the bot in Discord (once)</summary>
        <ol className="hint" style={{ lineHeight: 1.6 }}>
          <li>
            On the{" "}
            <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">
              Discord Developer Portal
            </a>{" "}
            make a New Application. Copy its <b>Application ID</b> into the field below.
          </li>
          <li>
            Under <b>Bot</b>, press Reset Token and paste the token below. No privileged intents are needed.
          </li>
          <li>
            Under <b>OAuth2</b>, copy the <b>Client Secret</b> below and add this redirect:{" "}
            {info.redirectUri ? (
              <code>{info.redirectUri}</code>
            ) : (
              <span>https://your-site/api/discord/callback (switch on HTTPS for the site to see the exact address)</span>
            )}
          </li>
          <li>
            Save, then invite the bot with{" "}
            {info.inviteUrl ? (
              <a href={info.inviteUrl} target="_blank" rel="noreferrer">
                this link
              </a>
            ) : (
              "the link that appears here once the Application ID is saved"
            )}
            . It asks for View Channels, Connect, Move Members and Manage Channels; no Administrator.
          </li>
          <li>Make a waiting-room voice channel (and a category for temporary channels, if you use them) and paste their links below.</li>
        </ol>
      </details>

      <label className="check" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} disabled={!manage} />
        <span>
          <b>Move players automatically</b>
        </span>
      </label>
      <div className="mm-bot-grid">
        <label className="field">
          <span>Application ID</span>
          <input value={form.applicationId} onChange={(e) => set("applicationId", e.target.value.trim())} disabled={!manage} spellCheck={false} />
        </label>
        <label className="field">
          <span>Bot token {info.settings.hasToken && <span className="hint">· saved</span>}</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={info.settings.hasToken ? "Leave empty to keep" : ""}
            disabled={!manage}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>Client secret {info.settings.hasSecret && <span className="hint">· saved</span>}</span>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={info.settings.hasSecret ? "Leave empty to keep" : ""}
            disabled={!manage}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>
            Discord server ID <span className="hint">· optional, taken from the links</span>
          </span>
          <input value={form.guildId} onChange={(e) => set("guildId", e.target.value.trim())} disabled={!manage} spellCheck={false} />
        </label>
      </div>
      <label className="field" style={{ maxWidth: 480, marginTop: 10 }}>
        <span>Waiting room voice channels (one per line)</span>
        <textarea
          rows={2}
          value={form.waitingChannels.join("\n")}
          onChange={(e) =>
            set(
              "waitingChannels",
              e.target.value.split("\n").map((x) => x.trim()),
            )
          }
          placeholder="https://discord.com/channels/…"
          disabled={!manage}
        />
        <small className="hint">Only players sitting in one of these are moved. Nobody is pulled out of other conversations.</small>
      </label>
      <div className="mm-bot-grid" style={{ marginTop: 10 }}>
        <label className="field">
          <span>Competitive and Wingman</span>
          <select value={form.teamMode} onChange={(e) => set("teamMode", e.target.value as DiscordBotInput["teamMode"])} disabled={!manage}>
            <option value="configured">The Team 1 / Team 2 channels above</option>
            <option value="temporary">Temporary channel per team ("Match #42 · Team 1")</option>
          </select>
        </label>
        <label className="field">
          <span>1v1</span>
          <select value={form.duelMode} onChange={(e) => set("duelMode", e.target.value as DiscordBotInput["duelMode"])} disabled={!manage}>
            <option value="shared">The shared 1v1 channel above</option>
            <option value="temporary">Temporary channel per match ("1v1 #101")</option>
          </select>
        </label>
        <label className="field">
          <span>Category for temporary channels</span>
          <input value={form.category} onChange={(e) => set("category", e.target.value)} placeholder="Category link or ID" disabled={!manage || !temporary} />
        </label>
      </div>
      <div className="exec-list" style={{ marginTop: 10 }}>
        <label className="check">
          <input type="checkbox" checked={form.privateChannels} onChange={(e) => set("privateChannels", e.target.checked)} disabled={!manage || !temporary} />
          <span>
            Private temporary channels <span className="hint">· only that team's linked players can see and join (the other team can't listen in)</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={form.returnAfter} onChange={(e) => set("returnAfter", e.target.checked)} disabled={!manage} />
          <span>
            Move players back after the match <span className="hint">· only those still in the match's channel, if they chose it</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={form.orphanCleanup} onChange={(e) => set("orphanCleanup", e.target.checked)} disabled={!manage || !temporary} />
          <span>
            Remove leftover temporary channels{" "}
            <span className="hint">· panel-named channels in the category from matches that aren't running, older than 10 minutes</span>
          </span>
        </label>
      </div>
      {manage && (
        <div className="row-actions" style={{ marginTop: 12, flexWrap: "wrap" }}>
          <button className="btn primary" disabled={busy}>
            Save bot settings
          </button>
          <button type="button" className="btn" disabled={busy || !info.settings.hasToken} onClick={() => void check("Permission check", api.checkDiscordBot)}>
            Check permissions
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !info.settings.enabled}
            title="Moves you (your own linked Discord, while you're in a voice channel) to a test channel and back."
            onClick={() => void check("Voice test", api.testDiscordMove)}
          >
            Test: move me
          </button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void run(api.reconcileDiscordBot, "Tidied up.").then(() => load())}>
            Tidy up now
          </button>
        </div>
      )}
      {result && (
        <div className="cpu-detail">
          <b>{result.title}</b>
          <ul className="mm-check-list">
            {result.r.items.map((i, n) => (
              <li key={n} className={i.ok ? "ok" : "bad"}>
                {i.ok ? "✓" : "✗"} {i.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3 className="mm-discord-head">Right now</h3>
      {info.sessions.length === 0 && info.channels.length === 0 && <p className="hint">No players in match voice channels and no temporary channels.</p>}
      {info.sessions.length > 0 && (
        <ul className="hint">
          {info.sessions.map((s) => (
            <li key={s.discord_id}>
              {s.username ?? s.discord_id} · match {s.match_id}
            </li>
          ))}
        </ul>
      )}
      {info.channels.length > 0 && (
        <ul className="hint">
          {info.channels.map((c) => (
            <li key={c.channel_id}>
              {c.name}
              {c.ended_at ? " · match over, removed once empty" : ""}
            </li>
          ))}
        </ul>
      )}
      {info.actions.length > 0 && (
        <details className="mm-config">
          <summary>Recent actions</summary>
          <ul className="mm-check-list">
            {info.actions.slice(0, 30).map((a, n) => (
              <li key={n} className={a.ok ? "ok" : "bad"}>
                <span className="hint">{new Date(a.at).toLocaleTimeString()}</span> {a.ok ? "" : "✗ "}
                {a.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </form>
  );
}
