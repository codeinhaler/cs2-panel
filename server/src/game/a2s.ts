import { createSocket } from "node:dgram";

/** Result of an A2S_INFO query: what the server browser shows. */
export interface A2sInfo {
  name: string;
  map: string;
  players: number;
  maxPlayers: number;
  bots: number;
  version: string;
}

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const REQUEST = Buffer.concat([HEADER, Buffer.from("TSource Engine Query\0", "latin1")]);

export function buildInfoRequest(challenge?: Buffer): Buffer {
  return challenge ? Buffer.concat([REQUEST, challenge]) : REQUEST;
}

export function parseInfoResponse(msg: Buffer): A2sInfo {
  let o = 4;
  const type = msg[o++];
  if (type !== 0x49) throw new Error("not an A2S_INFO response");
  o++; // protocol
  const str = () => {
    const end = msg.indexOf(0, o);
    if (end < 0) throw new Error("truncated A2S_INFO response");
    const s = msg.toString("utf8", o, end);
    o = end + 1;
    return s;
  };
  const name = str();
  const map = str();
  str(); // folder
  str(); // game
  o += 2; // app id
  const players = msg[o++] ?? 0;
  const maxPlayers = msg[o++] ?? 0;
  const bots = msg[o++] ?? 0;
  o += 4; // server type, environment, visibility, VAC
  const version = str();
  return { name, map, players, maxPlayers, bots, version };
}

/** Queries a server on localhost. Returns null if it doesn't answer in time. */
export function queryInfo(port: number, host = "127.0.0.1", timeoutMs = 1500): Promise<A2sInfo | null> {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    const done = (v: A2sInfo | null) => {
      clearTimeout(timer);
      sock.close();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on("error", () => done(null));
    sock.on("message", (msg) => {
      if (msg.length < 5 || !msg.subarray(0, 4).equals(HEADER)) return;
      // Servers may answer with a challenge (0x41) that must be echoed back.
      if (msg[4] === 0x41 && msg.length >= 9) {
        sock.send(buildInfoRequest(msg.subarray(5, 9)), port, host);
        return;
      }
      try {
        done(parseInfoResponse(msg));
      } catch {
        done(null);
      }
    });
    sock.send(REQUEST, port, host);
  });
}
