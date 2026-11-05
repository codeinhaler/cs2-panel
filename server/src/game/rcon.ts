import { Socket } from "node:net";

/**
 * Minimal Source RCON client. Opens a connection per command, which is fine on
 * localhost and avoids stale-connection handling.
 */

const SERVERDATA_AUTH = 3;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_RESPONSE_VALUE = 0;

export function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, "utf8");
  const size = 4 + 4 + bodyBuf.length + 2;
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  // two trailing NUL bytes are already zero from alloc
  return buf;
}

export interface Packet {
  id: number;
  type: number;
  body: string;
}

/** Splits as many complete packets as possible off the front of buf. */
export function decodePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (buf.length - offset >= 4) {
    const size = buf.readInt32LE(offset);
    if (size < 10 || size > 1_000_000) throw new Error("invalid RCON packet");
    if (buf.length - offset - 4 < size) break;
    const id = buf.readInt32LE(offset + 4);
    const type = buf.readInt32LE(offset + 8);
    const body = buf.toString("utf8", offset + 12, offset + 4 + size - 2);
    packets.push({ id, type, body });
    offset += 4 + size;
  }
  return { packets, rest: buf.subarray(offset) };
}

export interface RconOptions {
  host?: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

export type RconExec = (opts: RconOptions, command: string) => Promise<string>;

export const rconExec: RconExec = (opts, command) =>
  new Promise((resolve, reject) => {
    const sock = new Socket();
    const timeoutMs = opts.timeoutMs ?? 5000;
    let buf: Buffer = Buffer.alloc(0);
    let authed = false;
    let output = "";
    let settleTimer: NodeJS.Timeout | undefined;
    const AUTH_ID = 1;
    const CMD_ID = 2;

    const finish = (err?: Error) => {
      clearTimeout(timer);
      clearTimeout(settleTimer);
      sock.destroy();
      if (err) reject(err);
      else resolve(output);
    };
    const timer = setTimeout(
      () => (authed ? finish() : finish(new Error("RCON timed out. Is the server running?"))),
      timeoutMs,
    );

    sock.on("error", (e: NodeJS.ErrnoException) =>
      finish(new Error(e.code === "ECONNREFUSED" ? "RCON connection refused. Is the server running?" : e.message)),
    );
    sock.on("close", () => finish(authed ? undefined : new Error("RCON connection closed before login.")));
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let decoded;
      try {
        decoded = decodePackets(buf);
      } catch (e) {
        return finish(e as Error);
      }
      buf = decoded.rest;
      for (const p of decoded.packets) {
        if (!authed && p.type === SERVERDATA_AUTH_RESPONSE) {
          if (p.id === -1) return finish(new Error("RCON password was rejected."));
          authed = true;
          sock.write(encodePacket(CMD_ID, SERVERDATA_EXECCOMMAND, command));
        } else if (authed && p.type === SERVERDATA_RESPONSE_VALUE && p.id === CMD_ID) {
          output += p.body;
          // Responses can span several packets; finish once they stop arriving.
          clearTimeout(settleTimer);
          settleTimer = setTimeout(() => finish(), 250);
        }
      }
    });

    sock.connect(opts.port, opts.host ?? "127.0.0.1", () => {
      sock.write(encodePacket(AUTH_ID, SERVERDATA_AUTH, opts.password));
    });
  });
