import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrokAuthError, loadCredentials, loadPolicy, parseBaseUrl } from "../src/auth.js";
import { getAgent, listAgents, readThread, resolveApi, sendMessage, setFetchForTesting } from "../src/grok-api.js";
import { FAKE_BOT, FAKE_TOKEN, OTHER_BOT, calls, installFakeBackend, writeConfig } from "./fake-backend.js";

let workDir: string;
let dir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bb-grok-bot-auth-"));
  dir = writeConfig(workDir, [FAKE_BOT]);
  installFakeBackend(join(workDir, "state.json"));
});

afterEach(() => {
  setFetchForTesting(null);
  rmSync(workDir, { recursive: true, force: true });
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof GrokAuthError ? error.code : "other";
  }
  return "ok";
};

describe("token loading", () => {
  it("reads a 0600 token file and keeps the token out of JSON", () => {
    const creds = loadCredentials();
    expect(creds.accessToken).toBe(FAKE_TOKEN);
    expect(JSON.stringify(creds)).not.toContain(FAKE_TOKEN);
    expect(Object.keys(creds)).not.toContain("accessToken");
  });

  it("refuses a token file readable by group or others", () => {
    chmodSync(join(dir, "token"), 0o640);
    expect(code(() => loadCredentials())).toBe("insecure");
    chmodSync(join(dir, "token"), 0o604);
    expect(code(() => loadCredentials())).toBe("insecure");
  });

  it("refuses an open config directory", () => {
    chmodSync(dir, 0o755);
    expect(code(() => loadCredentials())).toBe("insecure");
  });

  it("refuses a symlinked token file", () => {
    const real = join(workDir, "elsewhere");
    writeFileSync(real, FAKE_TOKEN, { mode: 0o600 });
    rmSync(join(dir, "token"));
    symlinkSync(real, join(dir, "token"));
    expect(code(() => loadCredentials())).toBe("insecure");
  });

  it("reports a missing token without leaking anything", () => {
    rmSync(join(dir, "token"));
    expect(code(() => loadCredentials())).toBe("not-configured");
  });

  it("prefers GROK_BOT_ACCESS_TOKEN and validates it", () => {
    process.env.GROK_BOT_ACCESS_TOKEN = "env-token-abcdefgh";
    expect(loadCredentials().accessToken).toBe("env-token-abcdefgh");
    process.env.GROK_BOT_ACCESS_TOKEN = "bad token with spaces";
    let message = "";
    try {
      loadCredentials();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("bad token");
    delete process.env.GROK_BOT_ACCESS_TOKEN;
  });
});

describe("host allowlist", () => {
  it.each([
    "http://api2.cursor.sh",
    "https://evil.example",
    "https://api2.cursor.sh.evil.example",
    "https://evil.example#api2.cursor.sh",
    "https://user:pw@api2.cursor.sh",
    "https://api2.cursor.sh:8443",
    "https://api2.cursor.sh/x",
    "https://api2.cursor.sh/?a=1",
    "https://127.0.0.1",
    "not a url",
  ])("rejects %s", (url) => {
    expect(code(() => parseBaseUrl(url))).toBe("invalid");
  });

  it("accepts the default host", () => {
    expect(parseBaseUrl("https://API2.cursor.sh/")).toBe("https://api2.cursor.sh");
  });

  it("refuses to load credentials when GROK_BOT_API_BASE_URL points elsewhere", () => {
    process.env.GROK_BOT_API_BASE_URL = "https://attacker.example";
    expect(code(() => loadCredentials())).toBe("invalid");
    delete process.env.GROK_BOT_API_BASE_URL;
  });

  it("sends the token only to the allowed origin, without following redirects", async () => {
    await listAgents(resolveApi());
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(new URL(call.url).origin).toBe("https://api2.cursor.sh");
      expect(call.redirect).toBe("manual");
    }
  });

  it("treats a redirect as a failure and keeps the token out of the error", async () => {
    setFetchForTesting(async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }));
    const error = await listAgents(resolveApi()).catch((e: Error) => e);
    expect(String(error)).toContain("302");
    expect(String(error)).not.toContain(FAKE_TOKEN);
  });
});

describe("bot allowlist", () => {
  it("fails closed when the allowlist is empty", async () => {
    writeConfig(workDir, []);
    await expect(listAgents(resolveApi())).rejects.toThrow(/allowlisted/);
    expect(calls).toHaveLength(0);
  });

  it("lists, reads and messages only allowlisted bots", async () => {
    const api = resolveApi();
    expect((await listAgents(api)).map((a) => a.id)).toEqual([FAKE_BOT]);
    await expect(getAgent(api, OTHER_BOT)).rejects.toThrow(/not allowlisted/);
    await expect(readThread(api, OTHER_BOT, null)).rejects.toThrow(/not allowlisted/);
    await expect(sendMessage(api, OTHER_BOT, "hi")).rejects.toThrow(/not allowlisted/);
    expect(calls.some((c) => c.method !== "ListGrokBotAgents" && c.body.agentId === OTHER_BOT)).toBe(false);
  });

  it("matches a unique owned bot by name", async () => {
    writeConfig(workDir, ["fakey"]);
    expect((await listAgents(resolveApi())).map((a) => a.id)).toEqual([FAKE_BOT]);
  });

  it("does not admit a bot shared by someone else by name", async () => {
    writeConfig(workDir, ["intruder"]);
    setFetchForTesting(async () =>
      new Response(
        JSON.stringify({ agents: [{ agentId: OTHER_BOT, name: "Intruder", viewerIsOwner: false }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    expect(await listAgents(resolveApi())).toEqual([]);
  });

  it("admits a group only by id", async () => {
    writeConfig(workDir, ["fakeroom"]);
    expect(await listAgents(resolveApi())).toEqual([]);
  });

  it("does not reuse a cached roster after the token changes", async () => {
    await listAgents(resolveApi());
    const before = calls.length;
    process.env.GROK_BOT_ACCESS_TOKEN = "another-token-abcdef";
    await expect(listAgents(resolveApi())).rejects.toThrow(/401/);
    expect(calls.length).toBe(before + 1);
    delete process.env.GROK_BOT_ACCESS_TOKEN;
  });

  it("does not admit duplicate names", async () => {
    writeConfig(workDir, ["twin"]);
    setFetchForTesting(async () =>
      new Response(
        JSON.stringify({ agents: [{ agentId: FAKE_BOT, name: "Twin" }, { agentId: OTHER_BOT, name: "twin" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    expect(await listAgents(resolveApi())).toEqual([]);
  });

  it("env GROK_BOT_ALLOWED_BOTS overrides the file", () => {
    process.env.GROK_BOT_ALLOWED_BOTS = ` ${OTHER_BOT.toUpperCase()} ,`;
    expect(loadPolicy().allowedBots).toEqual([OTHER_BOT]);
    delete process.env.GROK_BOT_ALLOWED_BOTS;
  });

  it("refuses a group-writable config file", () => {
    chmodSync(join(dir, "config.json"), 0o664);
    expect(code(() => loadPolicy())).toBe("insecure");
  });

  it("keeps the local agent bridge off unless opted in", () => {
    expect(loadPolicy().localAgentBridge).toBe(false);
    writeConfig(workDir, [FAKE_BOT], { localAgentBridge: true });
    expect(loadPolicy().localAgentBridge).toBe(true);
  });
});
