import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { hasMetamodPath, parseSteamInf, patchGameinfo } from "../src/game/gameinfo.js";
import { decodePackets, encodePacket, rconExec } from "../src/game/rcon.js";
import { parseInfoResponse } from "../src/game/a2s.js";
import { portProblem, slugify } from "../src/servers/validation.js";
import { normalizeConfigPath } from "../src/servers/configs.js";
import { isAllowedUpperPath } from "../src/servers/instance-files.js";
import { buildLoginUrl, verifyCallback } from "../src/auth/steam-openid.js";
import { resolveSteamId, xmlTag } from "../src/auth/steam-profile.js";
import { SecretBox } from "../src/crypto.js";
import { can } from "../src/auth/permissions.js";

const GAMEINFO = `"GameInfo"
{
	FileSystem
	{
		SearchPaths
		{
			Game_LowViolence	csgo_lv // Perfect World content override
			Game	csgo
			Game	csgo_imported
			Mod	csgo
		}
	}
}
`;

describe("gameinfo.gi patching", () => {
  it("inserts the Metamod path above `Game csgo` with matching indent", () => {
    const out = patchGameinfo(GAMEINFO);
    const lines = out.split("\n");
    const i = lines.indexOf("\t\t\tGame\tcsgo/addons/metamod");
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toBe("\t\t\tGame\tcsgo");
    expect(lines[i - 1]).toContain("Game_LowViolence");
    expect(hasMetamodPath(out)).toBe(true);
  });

  it("is idempotent", () => {
    const once = patchGameinfo(GAMEINFO);
    expect(patchGameinfo(once)).toBe(once);
  });

  it("keeps CRLF line endings", () => {
    const out = patchGameinfo(GAMEINFO.replace(/\n/g, "\r\n"));
    expect(out).toContain("\t\t\tGame\tcsgo/addons/metamod\r\n\t\t\tGame\tcsgo\r\n");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("falls back to the top of SearchPaths when there is no `Game csgo` line", () => {
    const out = patchGameinfo(GAMEINFO.replace("\t\t\tGame\tcsgo\n", ""));
    expect(out).toContain("\t\t{\n\t\t\tGame\tcsgo/addons/metamod\n\t\t\tGame_LowViolence");
  });

  it("rejects a file without SearchPaths", () => {
    expect(() => patchGameinfo('"GameInfo"\n{\n}\n')).toThrow(/SearchPaths/);
  });

  it("parses steam.inf", () => {
    expect(parseSteamInf("PatchVersion=1.40.9.1\r\nServerVersion=2000123\n")).toEqual({
      PatchVersion: "1.40.9.1",
      ServerVersion: "2000123",
    });
  });
});

describe("validation", () => {
  it("slugifies names", () => {
    expect(slugify("Retakes #1")).toBe("retakes-1");
    expect(slugify("  Ågård DM  ")).toBe("agard-dm");
    expect(slugify("!!!")).toBe("server");
    expect(slugify("a".repeat(40))).toHaveLength(32);
  });

  it("checks ports against other servers with a margin", () => {
    const others = [{ port: 27015, name: "One" }];
    expect(portProblem(27025, others)).toBeNull();
    expect(portProblem(27015, others)).toMatch(/already used by "One"/);
    expect(portProblem(27019, others)).toMatch(/too close/);
    expect(portProblem(27021, others)).toBeNull();
    expect(portProblem(80, [])).toMatch(/between 1024/);
    expect(portProblem(27015.5, [])).toMatch(/whole number/);
  });

  it("only allows editing under cfg/ and the CSSharp configs dir", () => {
    expect(normalizeConfigPath("cfg/server.cfg")).toBe("cfg/server.cfg");
    expect(normalizeConfigPath("cfg/./sub/../server.cfg")).toBe("cfg/server.cfg");
    expect(normalizeConfigPath("addons/counterstrikesharp/configs/core.json")).toBe("addons/counterstrikesharp/configs/core.json");
    for (const bad of ["../cfg/x.cfg", "cfg/../../etc/passwd.cfg", "/etc/x.cfg", "gameinfo.gi", "cfg/x.so", "cfg\\x.cfg", "addons/metamod/x.cfg"]) {
      expect(() => normalizeConfigPath(bad), bad).toThrow();
    }
  });

  it("knows which upper-dir paths are allowed", () => {
    expect(isAllowedUpperPath("game/csgo/cfg")).toBe(true);
    expect(isAllowedUpperPath("game/csgo/cfg/server.cfg")).toBe(true);
    expect(isAllowedUpperPath("game/csgo/gameinfo.gi")).toBe(true);
    expect(isAllowedUpperPath("game/csgo/cfgx/a")).toBe(false);
    expect(isAllowedUpperPath("game/csgo/pak01_dir.vpk")).toBe(false);
    expect(isAllowedUpperPath("game")).toBe(false);
  });
});

describe("permissions", () => {
  it("matches the design's role table", () => {
    expect(can("moderator", "players.moderate")).toBe(true);
    expect(can("moderator", "server.control")).toBe(false);
    expect(can("admin", "server.manage")).toBe(true);
    expect(can("admin", "server.delete")).toBe(false);
    expect(can("admin", "users.manage")).toBe(false);
    expect(can("owner", "server.delete")).toBe(true);
  });
});

describe("secrets", () => {
  it("round-trips and detects tampering", () => {
    const box = new SecretBox("ab".repeat(32));
    const sealed = box.seal("hunter2");
    expect(sealed).not.toContain("hunter2");
    expect(box.open(sealed)).toBe("hunter2");
    const parts = sealed.split(":");
    parts[3] = Buffer.from("x").toString("base64");
    expect(() => box.open(parts.join(":"))).toThrow();
  });
});

describe("RCON", () => {
  it("encodes and decodes packets, including split ones", () => {
    const a = encodePacket(7, 2, "status");
    const b = encodePacket(8, 0, "hello");
    const both = Buffer.concat([a, b]);
    const partial = decodePackets(both.subarray(0, a.length + 3));
    expect(partial.packets).toEqual([{ id: 7, type: 2, body: "status" }]);
    expect(partial.rest.length).toBe(3);
    expect(decodePackets(both).packets[1]).toEqual({ id: 8, type: 0, body: "hello" });
  });

  it("talks to a server: auth, command, multi-packet response", async () => {
    const srv = createServer((sock) => {
      let buf: Buffer = Buffer.alloc(0);
      sock.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const { packets, rest } = decodePackets(buf);
        buf = rest;
        for (const p of packets) {
          if (p.type === 3) {
            sock.write(encodePacket(p.body === "secret" ? p.id : -1, 2, ""));
          } else if (p.type === 2) {
            sock.write(encodePacket(p.id, 0, `you said ${p.body};`));
            sock.write(encodePacket(p.id, 0, " part two"));
          }
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      await expect(rconExec({ port, password: "secret" }, "status")).resolves.toBe("you said status; part two");
      await expect(rconExec({ port, password: "wrong" }, "status")).rejects.toThrow(/rejected/);
    } finally {
      srv.close();
    }
  });

  it("reports a refused connection clearly", async () => {
    await expect(rconExec({ port: 1, password: "x", timeoutMs: 1000 }, "status")).rejects.toThrow(/refused|running/);
  });
});

describe("A2S_INFO", () => {
  it("parses a response", () => {
    const str = (s: string) => Buffer.from(s + "\0", "utf8");
    const msg = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]),
      str("My Server"),
      str("de_dust2"),
      str("csgo"),
      str("Counter-Strike 2"),
      Buffer.from([0xda, 0x02, 7, 10, 1, 0x64, 0x6c, 0x00, 0x01]),
      str("1.40.9.1"),
    ]);
    expect(parseInfoResponse(msg)).toEqual({ name: "My Server", map: "de_dust2", players: 7, maxPlayers: 10, bots: 1, version: "1.40.9.1" });
  });
});

describe("Steam OpenID", () => {
  const base = "http://192.168.1.10:8080";
  const id = "76561198000000001";
  const callback = (overrides: Record<string, string> = {}) => ({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.claimed_id": `https://steamcommunity.com/openid/id/${id}`,
    "openid.identity": `https://steamcommunity.com/openid/id/${id}`,
    "openid.return_to": `${base}/api/auth/steam/callback`,
    "openid.response_nonce": `${new Date().toISOString().slice(0, 19)}Z${Math.random()}`,
    "openid.assoc_handle": "1234567890",
    "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "abc=",
    ...overrides,
  });
  const steamSays = (valid: boolean) =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(init?.body)).toContain("openid.mode=check_authentication");
      return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${valid}\n`);
    }) as typeof fetch;

  it("builds a login URL pointing back at the panel", () => {
    const url = new URL(buildLoginUrl(base));
    expect(url.origin).toBe("https://steamcommunity.com");
    expect(url.searchParams.get("openid.return_to")).toBe(`${base}/api/auth/steam/callback`);
    expect(url.searchParams.get("openid.realm")).toBe(base);
  });

  it("accepts a response Steam confirms", async () => {
    await expect(verifyCallback(callback(), base, steamSays(true))).resolves.toBe(id);
  });

  it("rejects what Steam doesn't confirm, wrong return addresses, foreign providers and replays", async () => {
    await expect(verifyCallback(callback(), base, steamSays(false))).rejects.toThrow(/could not confirm/);
    await expect(verifyCallback(callback({ "openid.return_to": "http://evil/api/auth/steam/callback" }), base, steamSays(true))).rejects.toThrow(/different address/);
    await expect(verifyCallback(callback({ "openid.op_endpoint": "https://evil.example/openid" }), base, steamSays(true))).rejects.toThrow(/provider/);
    await expect(verifyCallback(callback({ "openid.claimed_id": "https://evil.example/id/1" }), base, steamSays(true))).rejects.toThrow(/identity/);
    const once = callback();
    await verifyCallback(once, base, steamSays(true));
    await expect(verifyCallback(once, base, steamSays(true))).rejects.toThrow(/already used/);
    const old = callback({ "openid.response_nonce": "2020-01-01T00:00:00Zabc" });
    await expect(verifyCallback(old, base, steamSays(true))).rejects.toThrow(/expired/);
  });
});

describe("Steam profile input", () => {
  const xml = `<?xml version="1.0"?><profile><steamID64>76561198000000002</steamID64><steamID><![CDATA[Player <One>]]></steamID><avatarMedium><![CDATA[https://avatars.example/a.jpg]]></avatarMedium></profile>`;
  const fakeFetch = (async () => new Response(xml)) as typeof fetch;

  it("accepts ids, profile URLs and vanity URLs", async () => {
    await expect(resolveSteamId("76561198000000001")).resolves.toBe("76561198000000001");
    await expect(resolveSteamId("https://steamcommunity.com/profiles/76561198000000001/")).resolves.toBe("76561198000000001");
    await expect(resolveSteamId("steamcommunity.com/id/someone", fakeFetch)).resolves.toBe("76561198000000002");
  });

  it("rejects other input", async () => {
    await expect(resolveSteamId("hello")).rejects.toThrow();
    await expect(resolveSteamId("https://example.com/profiles/76561198000000001")).rejects.toThrow(/steamcommunity/);
  });

  it("reads CDATA and plain XML tags", () => {
    expect(xmlTag(xml, "steamID")).toBe("Player <One>");
    expect(xmlTag(xml, "steamID64")).toBe("76561198000000002");
    expect(xmlTag(xml, "missing")).toBeNull();
  });
});
