import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { CapturedBridgeJsonRpcOutput } from "@get-bb/plugin-sdk/provider-bridge/testing";

import { handleLine } from "../src/provider-bridge.js";
import { FAKE_BOT, FAKE_GROUP, installFakeBackend, writeConfig } from "./fake-backend.js";
import { setFetchForTesting } from "../src/grok-api.js";

const FAKEY_TAG = `::grok-bot-author{agent="${FAKE_BOT}" name="Fakey"}\n\n`;
const ROOM_TAG = `::grok-bot-author{agent="${FAKE_GROUP}" name="FakeRoom"}\n\n`;

type Delta = { kind: string; text?: string; status?: string; channel?: string };

let output: CapturedBridgeJsonRpcOutput;
let workDir: string;
let requestId = 0;
const deltasByThread = new Map<string, Delta[]>();

function options(model: string) {
  return {
    model,
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
    providerOptions: { pollIntervalMs: 1_000 },
  };
}

function send(method: string, params: Record<string, unknown>): void {
  requestId += 1;
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
}

function collect(): void {
  for (const message of output.takeMessages()) {
    const m = message as { method?: string; params?: { threadId: string; deltas: Delta[] } };
    if (m.method !== "thread/delta" || !m.params) continue;
    const list = deltasByThread.get(m.params.threadId) ?? [];
    list.push(...m.params.deltas);
    deltasByThread.set(m.params.threadId, list);
  }
}

async function waitForBoundary(threadId: string, count: number): Promise<Delta[]> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    collect();
    const deltas = deltasByThread.get(threadId) ?? [];
    if (deltas.filter((d) => d.kind === "turn.boundary").length >= count) return deltas;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no turn.boundary for ${threadId}`);
}

function messages(deltas: Delta[]): string[] {
  return deltas.filter((d) => d.kind === "item.textClose").map((d) => d.text ?? "");
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bb-grok-bot-turns-"));
  process.env.FAKE_GBOT_STATE = join(workDir, "state.json");
  writeConfig(workDir, [FAKE_BOT, FAKE_GROUP]);
  installFakeBackend(process.env.FAKE_GBOT_STATE);
  output = captureBridgeJsonRpcOutput();
  deltasByThread.clear();
  send("initialize", { protocolVersion: 2, client: { name: "test", version: "0" } });
});

afterEach(() => {
  for (const threadId of deltasByThread.keys()) {
    send("thread/stop", { threadId, providerThreadId: "ignored", activeTurnId: null, intent: "release" });
  }
  output.restore();
  setFetchForTesting(null);
  rmSync(workDir, { recursive: true, force: true });
});

it("backfills history, then streams each turn's replies without echoing bb's own message", async () => {
  send("thread/start", { threadId: "thr_a", cwd: workDir, instructionMode: "append", options: options(FAKE_BOT) });
  send("turn/start", {
    threadId: "thr_a",
    providerThreadId: "ignored",
    clientRequestId: "creq_aaaaaaaaaa",
    input: [{ type: "text", text: "hello bot", mentions: [] }],
    options: options(FAKE_BOT),
  });
  const deltas = await waitForBoundary("thr_a", 1);
  expect(messages(deltas)).toEqual([
    `${FAKEY_TAG}old`,
    `${FAKEY_TAG}reply to: hello bot`,
    `${FAKEY_TAG}📎 report.pdf (open it in Grok Bot)`,
  ]);
  expect(deltas.find((d) => d.kind === "turn.boundary")?.status).toBe("completed");
  expect(deltas[1]?.kind).toBe("input.accepted");
  const state = JSON.parse(readFileSync(process.env.FAKE_GBOT_STATE!, "utf8"));
  expect(state.lastSent).toBe(
    `[bb identity: you are Fakey; your BB thread is thr_a.]\n\nhello bot`,
  );

  send("turn/start", {
    threadId: "thr_a",
    providerThreadId: "ignored",
    clientRequestId: "creq_bbbbbbbbbb",
    input: [{ type: "text", text: "again", mentions: [] }],
    options: options(FAKE_BOT),
  });
  const second = await waitForBoundary("thr_a", 2);
  expect(second.filter((d) => d.kind === "input.provider")).toEqual([]);
  expect(messages(second)).toEqual([
    `${FAKEY_TAG}old`,
    `${FAKEY_TAG}reply to: hello bot`,
    `${FAKEY_TAG}📎 report.pdf (open it in Grok Bot)`,
    `${FAKEY_TAG}reply to: again`,
    `${FAKEY_TAG}📎 report.pdf (open it in Grok Bot)`,
  ]);
});

it("labels group replies with the author", async () => {
  process.env.FAKE_GROUP_AUTHOR = "1";
  send("thread/start", { threadId: "thr_g", cwd: workDir, instructionMode: "append", options: options(FAKE_GROUP) });
  send("turn/start", {
    threadId: "thr_g",
    providerThreadId: "ignored",
    clientRequestId: "creq_cccccccccc",
    input: [{ type: "text", text: "hi room", mentions: [] }],
    options: options(FAKE_GROUP),
  });
  const deltas = await waitForBoundary("thr_g", 1);
  expect(messages(deltas)).toEqual([
    `${ROOM_TAG}old`,
    `${FAKEY_TAG}reply to: hi room`,
    `${ROOM_TAG}📎 report.pdf (open it in Grok Bot)`,
  ]);
  delete process.env.FAKE_GROUP_AUTHOR;
});

it("interrupts a running turn", async () => {
  send("thread/start", { threadId: "thr_i", cwd: workDir, instructionMode: "append", options: options(FAKE_BOT) });
  send("turn/start", {
    threadId: "thr_i",
    providerThreadId: "ignored",
    clientRequestId: "creq_dddddddddd",
    input: [{ type: "text", text: "long job", mentions: [] }],
    options: options(FAKE_BOT),
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  send("thread/stop", { threadId: "thr_i", providerThreadId: "ignored", activeTurnId: null, intent: "interrupt" });
  const deltas = await waitForBoundary("thr_i", 1);
  expect(deltas.filter((d) => d.kind === "turn.boundary").map((d) => d.status)).toEqual(["interrupted"]);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  collect();
  expect((deltasByThread.get("thr_i") ?? []).filter((d) => d.kind === "turn.boundary")).toHaveLength(1);
});

it("registers a thread with its Grok history, without messaging the bot", async () => {
  send("thread/start", { threadId: "thr_r", cwd: workDir, instructionMode: "append", options: options(FAKE_BOT) });
  send("turn/start", {
    threadId: "thr_r",
    providerThreadId: "ignored",
    clientRequestId: "creq_eeeeeeeeee",
    input: [{ type: "text", text: "[grok-bot:register] Fakey", mentions: [] }],
    options: options(FAKE_BOT),
  });
  const deltas = await waitForBoundary("thr_r", 1);
  expect(messages(deltas)).toEqual([
    `${FAKEY_TAG}old`,
    'Registered as Fakey\'s persistent BB thread. Other agents can message Fakey with: bb thread tell thr_r "…"',
  ]);
  const state = JSON.parse(readFileSync(process.env.FAKE_GBOT_STATE!, "utf8"));
  expect(state.sends).toBe(0);
});

it("mirrors Grok app activity into a bridge-opened turn", async () => {
  send("thread/start", { threadId: "thr_m", cwd: workDir, instructionMode: "append", options: options(FAKE_BOT) });
  send("turn/start", {
    threadId: "thr_m",
    providerThreadId: "ignored",
    clientRequestId: "creq_ffffffffff",
    input: [{ type: "text", text: "[grok-bot:register] Fakey", mentions: [] }],
    options: options(FAKE_BOT),
  });
  await waitForBoundary("thr_m", 1);
  const state = JSON.parse(readFileSync(process.env.FAKE_GBOT_STATE!, "utf8"));
  state.entries.push(
    { id: "t9u", seq: 2, kind: "message", role: "user", timestampMs: Date.now(), content: "typed in the app" },
    { id: "t9s3", seq: 3, kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: "app reply" } },
    { id: "t10u", seq: 4, kind: "message", role: "user", timestampMs: Date.now(), content: "from a bot", fromAgent: { id: "abc", name: "Other" } },
  );
  writeFileSync(process.env.FAKE_GBOT_STATE!, JSON.stringify(state));
  const deltas = await waitForBoundary("thr_m", 2);
  const mirrored = deltas.slice(deltas.findIndex((d) => d.kind === "turn.boundary") + 1);
  expect(mirrored[0]?.kind).toBe("turn.open");
  expect(mirrored.some((d) => d.kind === "input.accepted")).toBe(false);
  expect(mirrored.filter((d) => d.kind === "input.provider").map((d) => d.text)).toEqual(["typed in the app"]);
  expect(messages(mirrored)).toEqual([
    `${FAKEY_TAG}app reply`,
    `::grok-bot-author{agent="abc" name="Other"}\n\n↘ **to Fakey**\n\nfrom a bot`,
  ]);
  send("thread/stop", { threadId: "thr_m", providerThreadId: "ignored", activeTurnId: null, intent: "release" });
}, 20_000);

it("refreshes an entry edited in place (updatedSeq) under the same bb item", async () => {
  send("thread/start", { threadId: "thr_u", cwd: workDir, instructionMode: "append", options: options(FAKE_BOT) });
  send("turn/start", {
    threadId: "thr_u",
    providerThreadId: "ignored",
    clientRequestId: "creq_uuuuuuuuuu",
    input: [{ type: "text", text: "[grok-bot:register] Fakey", mentions: [] }],
    options: options(FAKE_BOT),
  });
  await waitForBoundary("thr_u", 1);
  let state = JSON.parse(readFileSync(process.env.FAKE_GBOT_STATE!, "utf8"));
  state.entries.push(
    { id: "u1", seq: 2, kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: "partial" } },
  );
  writeFileSync(process.env.FAKE_GBOT_STATE!, JSON.stringify(state));
  await waitForBoundary("thr_u", 2);
  state = JSON.parse(readFileSync(process.env.FAKE_GBOT_STATE!, "utf8"));
  const edited = state.entries.find((e: { id: string }) => e.id === "u1");
  edited.message.content = "final";
  edited.updatedSeq = 4;
  const user = state.entries.find((e: { kind: string; role?: string }) => e.kind === "message" && e.role === "user");
  if (user) user.updatedSeq = 5;
  else state.entries.push({ id: "u0", seq: 1, updatedSeq: 5, kind: "message", role: "user", timestampMs: 1, content: "old user" });
  state.entries.push({ id: "u2", seq: 3, kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: "next" } });
  writeFileSync(process.env.FAKE_GBOT_STATE!, JSON.stringify(state));
  const deltas = await waitForBoundary("thr_u", 3);
  const lastTurn = deltas.slice(deltas.map((d) => d.kind).lastIndexOf("turn.boundary", deltas.length - 2) + 1);
  expect(messages(lastTurn)).toEqual([`${FAKEY_TAG}final`, `${FAKEY_TAG}next`]);
  const keys = lastTurn.filter((d) => d.kind === "item.open").map((d) => (d as { key: { providerItemId: string } }).key.providerItemId);
  expect(keys).toEqual(["grok-bot-u1", "grok-bot-u2"]);
  expect(lastTurn.some((d) => d.kind === "input.provider")).toBe(false);
  send("thread/stop", { threadId: "thr_u", providerThreadId: "ignored", activeTurnId: null, intent: "release" });
}, 30_000);

it("does not forward bb system notices to the bot", async () => {
  send("thread/start", { threadId: "thr_s", cwd: workDir, instructionMode: "append", options: options(FAKE_BOT) });
  send("turn/start", {
    threadId: "thr_s",
    providerThreadId: "ignored",
    clientRequestId: "creq_gggggggggg",
    input: [{ type: "text", text: "[bb system]\n\n@thread:thr_x is now a child of this thread.", mentions: [] }],
    options: options(FAKE_BOT),
  });
  await waitForBoundary("thr_s", 1);
  const state = JSON.parse(readFileSync(process.env.FAKE_GBOT_STATE!, "utf8"));
  expect(state.sends).toBe(0);
});
