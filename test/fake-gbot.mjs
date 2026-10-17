#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const stateFile = process.env.FAKE_GBOT_STATE;
const BOT = "11111111-2222-4333-8444-555555555555";
const GROUP = "99999999-2222-4333-8444-555555555555";
const load = () =>
  existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : { entries: [{ id: "t0s0", seq: 1, kind: "send-message", timestampMs: 1, message: { type: "text", content: "old" } }], pending: [], sends: 0, polls: 0 };
const save = (s) => writeFileSync(stateFile, JSON.stringify(s));
const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const args = process.argv.slice(2).filter((a) => a !== "--json" && a !== "--no-history");
const state = load();
const status = () => ({
  running: state.pending.length > 0,
  runningTurn: state.pending.length > 0,
  awaitingUserResponse: false,
  newestEntryId: state.entries.at(-1)?.id ?? null,
});
const bot = { id: BOT, name: "Fakey", kind: "bot", description: "A fake bot" };
const group = { id: GROUP, name: "FakeRoom", kind: "group", members: [BOT] };

if (args[0] === "--version") process.stdout.write("gbot 9.9.9-fake\n");
else if (args[0] === "doctor") out({ gatewayAuthPresent: true, grokBotAppSession: { present: true, usable: true } });
else if (args[0] === "bots" && args[1] === "list") out([bot]);
else if (args[0] === "groups" && args[1] === "list") out([group]);
else if (args[0] === "bots" && args[1] === "get") {
  if (state.pending.length > 0) {
    state.polls += 1;
    if (state.polls >= 2) {
      for (const entry of state.pending) state.entries.push({ ...entry, seq: state.entries.length + 1 });
      state.pending = [];
    }
  }
  save(state);
  out({ ...(args[2] === GROUP ? group : bot), status: status() });
} else if (args[0] === "send") {
  const dash = args.indexOf("--");
  const sent = args.slice(dash + 1).join(" ");
  const text = sent.split("\n\n").at(-1);
  state.lastSent = sent;
  state.sends += 1;
  const n = state.sends;
  const now = Date.now();
  // Grok keeps exactly what was sent, identity header included.
  state.entries.push({ id: `t${n}u`, seq: state.entries.length + 1, kind: "message", role: "user", timestampMs: now, content: sent });
  state.pending = [
    { id: `t${n}s0`, kind: "send-message", timestampMs: now + 1, message: { type: "text", content: `reply to: ${text}` }, ...(process.env.FAKE_GBOT_GROUP_AUTHOR ? { author: { id: BOT, name: "Fakey" } } : {}) },
    { id: `t${n}s1`, kind: "send-message", timestampMs: now + 2, message: { type: "attachment", file_name: "report.pdf" } },
  ];
  state.polls = 0;
  save(state);
  out({ delivery: "accepted", messageId: `t${n}u`, exitCode: 0 });
} else if (args[0] === "thread") {
  const i = args.indexOf("--after");
  const after = i === -1 ? null : args[i + 1];
  const idx = after === null ? -1 : state.entries.findIndex((e) => e.id === after);
  const entries = idx === -1 && after !== null ? state.entries : state.entries.slice(idx + 1);
  out({ target: { id: args[1] }, transcript: { entries }, cursor: state.entries.at(-1)?.id, entryCount: entries.length, gapReset: idx === -1 && after !== null });
} else {
  process.stderr.write(`fake gbot: unsupported ${args.join(" ")}\n`);
  process.exit(2);
}
