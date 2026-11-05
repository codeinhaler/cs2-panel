import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { availableParallelism } from "node:os";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { promisify } from "node:util";
import type { Cs2ctlVerb, Host, LogStream, ServiceState, ServiceStatus } from "./host.js";

const execFileP = promisify(execFile);

/** The real host: systemd, sudo + cs2ctl, journald. */
export class SystemHost implements Host {
  constructor(private readonly cs2ctlPath: string) {}

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
      const props = Object.fromEntries(
        stdout
          .trim()
          .split("\n")
          .map((l) => {
            const i = l.indexOf("=");
            return [l.slice(0, i), l.slice(i + 1)];
          }),
      ) as Record<string, string>;
      const known: ServiceState[] = ["active", "activating", "deactivating", "inactive", "failed"];
      const state = known.includes(props.ActiveState as ServiceState) ? (props.ActiveState as ServiceState) : "unknown";
      const pid = Number(props.MainPID) || null;
      const since = state === "active" && props.ActiveEnterTimestamp ? new Date(props.ActiveEnterTimestamp).toISOString() : null;
      return { state, pid, since: since && since !== "Invalid Date" ? since : null };
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
