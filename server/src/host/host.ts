/**
 * Everything that touches systemd, sudo or the network stack goes through this
 * interface, so the rest of the panel can run against a fake in development
 * and tests.
 */

export type ServiceState = "active" | "activating" | "deactivating" | "inactive" | "failed" | "unknown";

export interface ServiceStatus {
  state: ServiceState;
  /** When the service last entered the active state (ISO), if running. */
  since: string | null;
  pid: number | null;
}

export type Cs2ctlVerb = "start" | "stop" | "restart" | "kill" | "enable" | "disable" | "mount" | "umount" | "archive";

export interface LogStream {
  stop(): void;
}

export interface Host {
  /** Runs a cs2ctl verb for one server. Rejects with the helper's error output. */
  cs2ctl(verb: Cs2ctlVerb, slug: string): Promise<string>;
  /** Updates the shared CS2 install. Each output line is passed to onLine. */
  steamUpdate(validate: boolean, onLine: (line: string) => void): Promise<void>;
  serviceStatus(slug: string): Promise<ServiceStatus>;
  /** True if the server's overlay is mounted on its merged/ dir. */
  isMounted(slug: string): Promise<boolean>;
  /** True if anything on the host is listening on this UDP or TCP port. */
  isPortInUse(port: number): Promise<boolean>;
  /** Follows the server's journal. Starts with the last `backlog` lines. */
  followLogs(slug: string, backlog: number, onLine: (line: string) => void): LogStream;
  cpuCount(): number;
}
