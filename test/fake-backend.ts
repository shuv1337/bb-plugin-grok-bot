// In-process fake of the Grok Bot backend (Connect-JSON). Never touches the network.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setFetchForTesting } from "../src/grok-api.js";

export const FAKE_BOT = "11111111-2222-4333-8444-555555555555";
export const FAKE_GROUP = "99999999-2222-4333-8444-555555555555";
export const OTHER_BOT = "22222222-2222-4333-8444-555555555555";
export const FAKE_TOKEN = "fake-token-0123456789abcdef";

export interface FakeCall {
  url: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown>;
  redirect: string | undefined;
}

export const calls: FakeCall[] = [];

/** A private XDG config dir with a token file and an allowlist. */
export function writeConfig(workDir: string, allowedBots: string[], extra: Record<string, unknown> = {}): string {
  const dir = join(workDir, "xdg", "bb-grok-bot");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(workDir, "xdg"), 0o700);
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "token"), `${FAKE_TOKEN}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ allowedBots, ...extra }), { mode: 0o600 });
  process.env.XDG_CONFIG_HOME = join(workDir, "xdg");
  delete process.env.GROK_BOT_ACCESS_TOKEN;
  delete process.env.GROK_BOT_ALLOWED_BOTS;
  delete process.env.GROK_BOT_API_BASE_URL;
  return dir;
}

type Entry = Record<string, unknown> & { id: string; seq?: number };
interface State {
  entries: Entry[];
  pending: Entry[];
  sends: number;
  polls: number;
  lastSent?: string;
}

function load(file: string): State {
  return existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { entries: [{ id: "t0s0", seq: 1, kind: "send-message", timestampMs: 1, message: { type: "text", content: "old" } }], pending: [], sends: 0, polls: 0 };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export function installFakeBackend(stateFile: string): void {
  calls.length = 0;
  setFetchForTesting(async (url, init) => {
    const headers = new Headers(init.headers);
    const body = JSON.parse(String(init.body ?? "{}"));
    const method = url.slice(url.lastIndexOf("/") + 1);
    calls.push({ url, method, authorization: headers.get("authorization"), body, redirect: init.redirect });
    if (headers.get("authorization") !== `Bearer ${FAKE_TOKEN}`) return json({ code: "unauthenticated" }, 401);
    const state = load(stateFile);
    const save = () => writeFileSync(stateFile, JSON.stringify(state));
    const running = state.pending.length > 0;
    save();
    if (method === "ListGrokBotAgents") {
      if (running) {
        state.polls += 1;
        if (state.polls >= 2) {
          for (const entry of state.pending) state.entries.push({ ...entry, seq: state.entries.length + 1 });
          state.pending = [];
        }
        save();
      }
      return json({
        agents: [
          { id: "row-1", agentId: FAKE_BOT, name: "Fakey", description: "A fake bot", kind: "GROK_BOT_AGENT_KIND_BOT", viewerIsOwner: true, isRunningTurn: running },
          { id: "row-2", agentId: FAKE_GROUP, name: "FakeRoom", kind: "GROK_BOT_AGENT_KIND_ROOM", memberAgentIds: [FAKE_BOT], viewerIsOwner: true, isRunningTurn: running },
          { id: "row-3", agentId: OTHER_BOT, name: "Secret", kind: "GROK_BOT_AGENT_KIND_BOT", viewerIsOwner: true },
        ],
      });
    }
    if (method === "ListGrokBotTranscriptEntries") {
      return json({
        entries: state.entries.map((e) => ({
          seq: String(e.seq ?? 0),
          entryId: e.id,
          body: Buffer.from(JSON.stringify(e)).toString("base64"),
        })),
      });
    }
    if (method === "SendGrokBotUserMessage") {
      const sent = String(body.text);
      const text = sent.split("\n\n").at(-1);
      state.lastSent = sent;
      state.sends += 1;
      const n = state.sends;
      const now = Date.now();
      state.entries.push({ id: `t${n}u`, seq: state.entries.length + 1, kind: "message", role: "user", timestampMs: now, content: sent });
      state.pending = [
        { id: `t${n}s0`, kind: "send-message", timestampMs: now + 1, message: { type: "text", content: `reply to: ${text}` }, ...(process.env.FAKE_GROUP_AUTHOR ? { author: { id: FAKE_BOT, name: "Fakey" } } : {}) },
        { id: `t${n}s1`, kind: "send-message", timestampMs: now + 2, message: { type: "attachment", file_name: "report.pdf" } },
      ];
      state.polls = 0;
      save();
      return json({});
    }
    return json({ code: "unimplemented" }, 404);
  });
}

export function readState(stateFile: string): State {
  return load(stateFile);
}
