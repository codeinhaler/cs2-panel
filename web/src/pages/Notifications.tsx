import { useEffect, useState } from "react";
import { api, type DiscordSettings, type EventGroup } from "../api";
import { useAction, useApp } from "../app-context";

/** Discord notifications: a webhook and which kinds of events to send. */
export function NotificationsPage() {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const [saved, setSaved] = useState<DiscordSettings | null>(null);
  const [groups, setGroups] = useState<Record<EventGroup, string> | null>(null);
  const [webhook, setWebhook] = useState("");
  const [events, setEvents] = useState<Record<EventGroup, boolean> | null>(null);

  useEffect(() => {
    api
      .notifications()
      .then((r) => {
        setSaved(r.discord);
        setGroups(r.groups);
        setEvents(r.discord.events);
      })
      .catch((e: Error) => toast(e.message, "error"));
  }, [toast]);

  if (!can("server.manage")) return <p className="hint">Only Admins and the Owner can set up notifications.</p>;
  if (!saved || !groups || !events) return null;

  const dirty = webhook.trim() !== "" || JSON.stringify(events) !== JSON.stringify(saved.events);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.saveNotifications({ ...(webhook.trim() ? { webhook: webhook.trim() } : {}), events }), "Notification settings saved.");
    if (r) {
      setSaved(r.discord);
      setEvents(r.discord.events);
      setWebhook("");
    }
  };
  const remove = async () => {
    if (!window.confirm("Stop sending notifications to Discord and forget the webhook?")) return;
    const r = await run(() => api.saveNotifications({ webhook: "", events }), "Discord webhook removed.");
    if (r) setSaved(r.discord);
  };
  const test = () => run(() => api.testNotification(), "Test message sent. Check the Discord channel.");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Notifications</h1>
          <p>Send warnings and other events to a Discord channel, so you hear about problems without having the panel open.</p>
        </div>
      </div>

      <form className="panel" onSubmit={save}>
        <h2 style={{ marginBottom: 6 }}>Discord</h2>
        <p className="hint" style={{ marginTop: 0, maxWidth: "75ch" }}>
          In Discord, open the channel's settings → <b>Integrations</b> → <b>Webhooks</b> → <b>New Webhook</b>, then <b>Copy Webhook URL</b> and paste it here.
          Anyone with the link can post to that channel, so the panel stores it encrypted and never shows it again.
        </p>

        <div className="field" style={{ maxWidth: 640 }}>
          <span>Webhook link</span>
          <input
            type="password"
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            placeholder={saved.webhookSet ? `Saved (${saved.webhookHint}). Paste a new link to replace it.` : "https://discord.com/api/webhooks/…"}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <fieldset className="choice-list" style={{ marginTop: 16 }}>
          <legend style={{ marginBottom: 8, fontWeight: 500 }}>Send</legend>
          {(Object.keys(groups) as EventGroup[]).map((g) => (
            <label key={g} className="choice">
              <input type="checkbox" checked={events[g]} onChange={(e) => setEvents({ ...events, [g]: e.target.checked })} />
              <span>{groups[g]}</span>
            </label>
          ))}
        </fieldset>

        <div className="row-actions" style={{ marginTop: 16, flexWrap: "wrap" }}>
          <button className="btn primary" disabled={busy || !dirty}>
            Save
          </button>
          {saved.webhookSet && (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => void test()}>
                Send a test message
              </button>
              <button type="button" className="btn ghost danger" disabled={busy} onClick={() => void remove()}>
                Remove webhook
              </button>
            </>
          )}
        </div>
      </form>
    </>
  );
}
