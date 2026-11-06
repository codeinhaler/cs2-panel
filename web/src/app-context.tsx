import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Me, Permission } from "./api";
import { setFormatPrefs, type Prefs } from "./format";

interface Toast {
  kind: "ok" | "error" | "info" | "warn";
  text: string;
}

interface AppContextValue {
  me: Me;
  can: (p: Permission) => boolean;
  toast: (text: string, kind?: Toast["kind"]) => void;
  setPrefs: (prefs: Prefs) => void;
}

const Ctx = createContext<AppContextValue | null>(null);

export function AppProvider({ me: initialMe, children }: { me: Me; children: ReactNode }) {
  const [me, setMe] = useState(initialMe);
  setFormatPrefs(me.user.prefs);
  const setPrefs = useCallback((prefs: Prefs) => setMe((m) => ({ ...m, user: { ...m.user, prefs } })), []);
  const [current, setCurrent] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const toast = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    setCurrent({ text, kind });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCurrent(null), kind === "error" ? 8000 : 4000);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const can = useCallback((p: Permission) => me.permissions.includes(p), [me]);

  return (
    <Ctx.Provider value={{ me, can, toast, setPrefs }}>
      {children}
      {current && (
        <div className={`notice ${current.kind} toast`} role={current.kind === "error" ? "alert" : "status"}>
          {current.text}
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

/** Runs an async action, reporting failure as a toast. Returns undefined on failure. */
export function useAction() {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (success) toast(success);
        return r;
      } catch (e) {
        toast((e as Error).message, "error");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}

/** Polls a loader on an interval while the page is visible. */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, refresh, setData };
}
