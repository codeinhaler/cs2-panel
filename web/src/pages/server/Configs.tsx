import "../../monaco-setup";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { api, timeAgo, type ConfigFile, type ConfigFileInfo, type Revision, type Server } from "../../api";
import { useAction, useApp } from "../../app-context";
import { languageFor } from "../../monaco-setup";

const SOURCE_TEXT = { stock: "stock", modified: "edited", custom: "added" } as const;

function useDarkMode(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return dark;
}

export function ConfigsTab({ server }: { server: Server }) {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const dark = useDarkMode();
  const [files, setFiles] = useState<ConfigFileInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<ConfigFile | null>(null);
  const [draft, setDraft] = useState("");
  const [comment, setComment] = useState("");
  const [compare, setCompare] = useState<{ rev: Revision; content: string | null } | null>(null);
  const newDialog = useRef<HTMLDialogElement>(null);
  const [newPath, setNewPath] = useState("cfg/");

  const editable = can("config.edit") && !!file && !file.readOnly;
  const dirty = !!file && draft !== file.content;

  const loadList = useCallback(async () => {
    const r = await api.configs(server.id);
    setFiles(r.files);
    return r.files;
  }, [server.id]);

  const open = useCallback(
    async (path: string) => {
      if (dirty && !window.confirm("Discard your unsaved changes?")) return;
      try {
        const f = await api.config(server.id, path);
        setSelected(path);
        setFile(f);
        setDraft(f.content);
        setComment("");
        setCompare(null);
      } catch (e) {
        toast((e as Error).message, "error");
      }
    },
    [server.id, dirty, toast],
  );

  useEffect(() => {
    void loadList().then((list) => {
      const first = list.find((f) => f.path === "cfg/server.cfg") ?? list[0];
      if (first) void open(first.path);
    });
    // Only on server change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = async (apply: "save" | "exec" | "restart") => {
    if (!file) return;
    const r = await run(() => api.saveConfig(server.id, { path: file.path, content: draft, comment: comment.trim() || undefined, apply }));
    if (!r) return;
    setFile(r.file);
    setDraft(r.file.content);
    setComment("");
    toast(r.changed ? `Saved ${file.path}${r.applied !== "saved" ? `: ${r.applied}` : ""}.` : `No changes to ${file.path}.`, "ok");
    void loadList();
  };

  const revert = async () => {
    if (!file) return;
    const what = file.source === "modified" ? "go back to the stock version" : "be deleted";
    if (!window.confirm(`${file.path} will ${what}. Its history stays in the panel. Continue?`)) return;
    const r = await run(() => api.revertConfig(server.id, file.path));
    if (!r) return;
    toast(r.result === "stock" ? `${file.path} is back to stock.` : `Deleted ${file.path}.`);
    const list = await loadList();
    if (list.some((f) => f.path === file.path)) await open(file.path);
    else {
      setFile(null);
      setSelected(null);
    }
  };

  const showRevision = async (rev: Revision) => {
    const r = await run(() => api.revision(server.id, rev.id));
    if (r) setCompare({ rev, content: r.content });
  };

  const rollback = async (rev: Revision) => {
    if (!file) return;
    if (!window.confirm(`Restore ${file.path} to the version from ${timeAgo(rev.createdAt)}?`)) return;
    const r = await run(() => api.rollback(server.id, rev.id), `Restored ${file.path}.`);
    if (!r) return;
    await loadList();
    await open(r.path);
  };

  const createFile = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.saveConfig(server.id, { path: newPath.trim(), content: "", comment: "New file", apply: "save" }));
    if (!r) return;
    newDialog.current?.close();
    await loadList();
    await open(r.file.path);
  };

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const shown = files.filter((x) => !f || x.path.toLowerCase().includes(f));
    const byDir = new Map<string, ConfigFileInfo[]>();
    for (const x of shown) {
      const dir = x.path.slice(0, x.path.lastIndexOf("/") + 1);
      byDir.set(dir, [...(byDir.get(dir) ?? []), x]);
    }
    return [...byDir.entries()];
  }, [files, filter]);

  const canExec = !!file && file.path.startsWith("cfg/") && file.path.endsWith(".cfg") && can("rcon") && server.status.state === "active";

  return (
    <div className="cfg-layout">
      <div>
        <div className="row-actions" style={{ marginBottom: 8 }}>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files" aria-label="Filter files" />
          {can("config.edit") && (
            <button className="btn" onClick={() => newDialog.current?.showModal()}>
              New file
            </button>
          )}
        </div>
        <div className="file-list">
          {groups.map(([dir, items]) => (
            <div key={dir}>
              <div className="file-group">{dir}</div>
              {items.map((f) => (
                <button key={f.path} className={`file-item${f.path === selected ? " selected" : ""}`} onClick={() => void open(f.path)}>
                  <span className="name" title={f.path}>
                    {f.path.slice(dir.length)}
                  </span>
                  {f.readOnly ? <span className="tag">panel</span> : <span className={`tag ${f.source}`}>{SOURCE_TEXT[f.source]}</span>}
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 && <p className="hint" style={{ padding: 8 }}>No matching files.</p>}
        </div>
        <p className="hint">
          <span className="tag">stock</span> comes with CS2. <span className="tag modified">edited</span> is this server's changed copy.{" "}
          <span className="tag custom">added</span> exists only on this server.
        </p>
      </div>

      <div>
        {file ? (
          <>
            <div className="editor-frame">
              <div className="editor-bar">
                <span className="path">
                  {file.path}
                  {dirty && " (unsaved)"}
                </span>
                <div className="row-actions">
                  {compare && (
                    <button className="btn small" onClick={() => setCompare(null)}>
                      Back to editing
                    </button>
                  )}
                  {editable && file.source !== "stock" && !compare && (
                    <button className="btn small ghost" onClick={revert} disabled={busy}>
                      {file.source === "modified" ? "Revert to stock" : "Delete file"}
                    </button>
                  )}
                </div>
              </div>
              {compare ? (
                <DiffEditor
                  height="520px"
                  language={languageFor(file.path)}
                  original={compare.content ?? ""}
                  modified={draft}
                  theme={dark ? "vs-dark" : "light"}
                  options={{ readOnly: true, renderSideBySide: window.innerWidth > 1100, minimap: { enabled: false } }}
                />
              ) : (
                <Editor
                  height="520px"
                  path={`server-${server.id}/${file.path}`}
                  language={languageFor(file.path)}
                  value={draft}
                  onChange={(v) => setDraft(v ?? "")}
                  theme={dark ? "vs-dark" : "light"}
                  options={{
                    readOnly: !editable,
                    minimap: { enabled: false },
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 13,
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                  }}
                />
              )}
              {compare && (
                <div className="editor-foot">
                  <span className="hint">
                    Left: version from {timeAgo(compare.rev.createdAt)}
                    {compare.content === null ? " (file did not exist)" : ""}. Right: current text.
                  </span>
                </div>
              )}
              {editable && !compare && (
                <div className="editor-foot">
                  <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What changed? (optional)" maxLength={200} />
                  <button className="btn primary" disabled={busy || !dirty} onClick={() => void save("save")}>
                    Save
                  </button>
                  {canExec && (
                    <button className="btn" disabled={busy} onClick={() => void save("exec")} title="Save, then run this file on the live server">
                      Save and run
                    </button>
                  )}
                  {server.status.state === "active" && (
                    <button className="btn" disabled={busy} onClick={() => void save("restart")}>
                      Save and restart
                    </button>
                  )}
                </div>
              )}
            </div>
            {file.readOnly && (
              <p className="hint">The panel writes this file from the server's settings. Change those on the Settings tab instead.</p>
            )}

            <div className="panel revisions">
              <h3>History</h3>
              {file.revisions.length === 0 && <p className="hint">No changes made through the panel yet.</p>}
              {file.revisions.map((rev, i) => (
                <div key={rev.id} className="revision">
                  <div>
                    <div>{rev.comment || (rev.deleted ? "Removed" : "Saved")}</div>
                    <div className="when">
                      {timeAgo(rev.createdAt)}
                      {rev.authorName ? ` by ${rev.authorName}` : ""}
                      {i === 0 ? " (current)" : ""}
                    </div>
                  </div>
                  <div className="row-actions">
                    <button className="btn small ghost" onClick={() => void showRevision(rev)}>
                      Compare
                    </button>
                    {editable && i > 0 && (
                      <button className="btn small" onClick={() => void rollback(rev)} disabled={busy}>
                        Restore
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="empty">
            <h2>Pick a file</h2>
            <p>Choose a config file on the left to view or edit it.</p>
          </div>
        )}
      </div>

      <dialog ref={newDialog}>
        <form onSubmit={createFile}>
          <h2>New config file</h2>
          <label className="field">
            <span>Path</span>
            <input value={newPath} onChange={(e) => setNewPath(e.target.value)} autoFocus spellCheck={false} />
            <small>Under cfg/ or addons/counterstrikesharp/configs/, e.g. cfg/practice.cfg</small>
          </label>
          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={() => newDialog.current?.close()}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy}>
              Create file
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
