import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { availableParallelism } from "node:os";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { promisify } from "node:util";
import type { Cs2ctlVerb, Host, LogStream, ServiceState, ServiceStatus } from "./host.js";

const execFileP = promisify(execFile);

/** The real host: systemd, sudo + cs2ctl, journald. */
export class SystemHost implements Host {
  constructor(
    private readonly cs2ctlPath: string,
    private readonly cs2Root: string,
  ) {}

  async isMounted(slug: string): Promise<boolean> {
    const target = `${this.cs2Root}/instances/${slug}/merged`;
    const info = await readFile("/proc/self/mountinfo", "utf8");
    return mountPoints(info).includes(target);
  }

  async cs2ctl(verb: Cs2ctlVerb, slug: string): Promise<string> {
    try {
      const { stdout } = await execFileP("sudo", ["-n", this.cs2ctlPath, verb, slug], { timeout: 120_000 });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      throw new Error((e.stderr || e.message).trim());
    }
  }

  steamUpdate(validate: boolean, onLine: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ["-n", this.cs2ctlPath, "steam-update", ...(validate ? ["validate"] : [])];
      const child = spawn("sudo", args, { stdio: ["ignore", "pipe", "pipe"] });
      // SteamCMD redraws progress with \r; split on both.
      const pipe = (stream: NodeJS.ReadableStream) => {
        let buf = "";
        stream.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          const parts = buf.split(/\r\n|\r|\n/);
          buf = parts.pop() ?? "";
          for (const p of parts) if (p.trim()) onLine(p);
        });
        stream.on("end", () => {
          if (buf.trim()) onLine(buf);
        });
      };
      pipe(child.stdout);
      pipe(child.stderr);
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`steam update exited with code ${code}`))));
    });
  }

  async serviceStatus(slug: string): Promise<ServiceStatus> {
    try {
      const { stdout } = await execFileP("systemctl", [
        "show",
        `cs2@${slug}.service`,
        "--property=ActiveState,MainPID,ActiveEnterTimestamp",
      ]);
      return parseSystemctlShow(stdout);
    } catch {
      return { state: "unknown", pid: null, since: null };
    }
  }

  async isPortInUse(port: number): Promise<boolean> {
    const tcp = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(true));
      srv.listen({ port, host: "0.0.0.0", exclusive: true }, () => srv.close(() => resolve(false)));
    });
    if (tcp) return true;
    return new Promise<boolean>((resolve) => {
      const sock = createSocket("udp4");
      sock.once("error", () => resolve(true));
      sock.bind({ port, address: "0.0.0.0", exclusive: true }, () => sock.close(() => resolve(false)));
    });
  }

  followLogs(slug: string, backlog: number, onLine: (line: string) => void): LogStream {
    const child = spawn(
      "journalctl",
      ["-u", `cs2@${slug}.service`, "-f", "-n", String(backlog), "-o", "short-iso", "--no-hostname"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    createInterface({ input: child.stdout }).on("line", onLine);
    createInterface({ input: child.stderr }).on("line", (l) => onLine(`[journalctl] ${l}`));
    child.on("error", (e) => onLine(`[panel] could not read logs: ${e.message}`));
    return { stop: () => child.kill() };
  }

  cpuCount(): number {
    return availableParallelism();
  }
}

const KNOWN_STATES: ServiceState[] = ["active", "activating", "deactivating", "inactive", "failed"];

/** Parses `systemctl show --property=ActiveState,MainPID,ActiveEnterTimestamp`. Never throws. */
export function parseSystemctlShow(stdout: string): ServiceStatus {
  const props: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) props[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const state = KNOWN_STATES.includes(props.ActiveState as ServiceState) ? (props.ActiveState as ServiceState) : "unknown";
  const pid = Number(props.MainPID) || null;
  const since = state === "active" ? parseSystemdTimestamp(props.ActiveEnterTimestamp) : null;
  return { state, pid, since };
}

/**
 * systemd prints timestamps like "Thu 2026-11-05 21:30:20 CET" (local time of
 * this machine, which the panel shares) or "@1762374620" with --timestamp=unix.
 * Returns ISO time, or null if it can't be read.
 */
export function parseSystemdTimestamp(value: string | undefined): string | null {
  if (!value || value === "n/a") return null;
  const unix = /^@(\d+)$/.exec(value);
  if (unix) return new Date(Number(unix[1]) * 1000).toISOString();
  const m = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(value);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}`); // no zone: interpreted as local time
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Mount points listed in /proc/self/mountinfo (5th field, with \040-style escapes decoded). */
export function mountPoints(mountinfo: string): string[] {
  return mountinfo
    .split("\n")
    .map((l) => l.split(" ")[4])
    .filter((m): m is string => !!m)
    .map((m) => m.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))));
}
