import {
  type ClientTurnRequestId,
  type DeltaPresentation,
  type PromptInput,
  type ProviderHealthResult,
  type ThreadDelta,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  type GrokAgent,
  type GrokApi,
  type TranscriptEntry,
  GrokApiError,
  getAgent,
  listAgents,
  readThread,
  resolveApi,
  sendMessage,
} from "./grok-api.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_START_GRACE_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  REGISTER_MARKER,
  SYNC_MARKER,
  grokBotProviderOptionsSchema,
  identityHeader,
  type GrokBotProviderOptions,
} from "./vocabulary.js";

const BOT_MESSAGE_PRESENTATION: DeltaPresentation = {
  label: { pending: "Grok Bot is replying", completed: "Grok Bot replied" },
  icon: { glyph: "Bot" },
};

const AGENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ActiveTurn {
  agentId: string;
  cancelled: boolean;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Session {
  threadId: string;
  providerThreadId: string;
  defaultAgentId: string | null;
  turn: ActiveTurn | null;
  follower: ReturnType<typeof setTimeout> | null;
  providerOptions: unknown;
  openedAt: number;
  closed: boolean;
}

const FOLLOW_INTERVAL_MS = 5_000;
const MAX_PAGES_PER_PULL = 10;
const BB_SYSTEM_PREFIX = "[bb system]";

const sessions = new Map<string, Session>();

// Mirror state per provider thread: the Grok transcript cursor already shown in bb,
// and whether the thread's history has been backfilled. Persisted so a bb restart
// resumes exactly where the mirror left off.
interface MirrorState {
  agentId: string;
  cursor: string | null;
  backfilled: boolean;
  lastSeq: number | null;
}

const mirrorStateSchema = z.object({
  agentId: z.string(),
  cursor: z.string().nullable(),
  backfilled: z.boolean(),
  lastSeq: z.number().nullable().default(null),
});

// bb can run several bridge workers for this plugin at once (one per artifact and
// launch context; an old worker lingers after a reinstall), so everything shared lives
// in per-thread files that every worker re-reads, never in one process's memory:
//   mirror/<providerThreadId>.json  what of the Grok transcript is already in bb
//   live/<threadId>.json            which worker follows the thread (latest attach wins)
//   retired/<threadId>              a replaced mirror thread; its follower stops
//   locks/<providerThreadId>        held while one worker reads and shows new entries
let dataDir: string | null = null;

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function stateFile(kind: "mirror" | "live" | "retired" | "locks", id: string): string | null {
  if (dataDir === null) return null;
  return join(dataDir, kind, `${id.replace(/[^\w.-]/g, "_")}${kind === "mirror" || kind === "live" ? ".json" : ""}`);
}

function writeState(kind: "mirror" | "live", id: string, value: unknown): void {
  const file = stateFile(kind, id);
  if (file === null) return;
  try {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value)}\n`);
    renameSync(temp, file);
  } catch {
    return;
  }
}

// Tests run without a data dir; they keep state in memory instead.
const memoryMirrors = new Map<string, MirrorState>();

function readMirror(providerThreadId: string): MirrorState | null {
  const file = stateFile("mirror", providerThreadId);
  if (file === null) return memoryMirrors.get(providerThreadId) ?? null;
  const parsed = mirrorStateSchema.safeParse(readJsonFile(file));
  return parsed.success ? parsed.data : null;
}

function saveMirror(providerThreadId: string, state: MirrorState): void {
  if (dataDir === null) memoryMirrors.set(providerThreadId, state);
  else writeState("mirror", providerThreadId, state);
}

function loadMirrors(dir: string): void {
  dataDir = dir;
  for (const kind of ["mirror", "live", "retired", "locks"]) {
    mkdirSync(join(dir, kind), { recursive: true });
  }
  // One-time migration from the single-file layouts.
  const whole = z
    .record(z.string(), mirrorStateSchema)
    .safeParse(readJsonFile(join(dir, "mirror.json")));
  const legacy = z
    .record(z.string(), z.record(z.string(), z.string()))
    .safeParse(readJsonFile(join(dir, "cursors.json")));
  const migrated: Record<string, MirrorState> = whole.success ? { ...whole.data } : {};
  if (legacy.success) {
    for (const [providerThreadId, byAgent] of Object.entries(legacy.data)) {
      const [agentId, cursor] = Object.entries(byAgent)[0] ?? [];
      if (agentId === undefined || migrated[providerThreadId]) continue;
      migrated[providerThreadId] = { agentId, cursor: cursor ?? null, backfilled: true, lastSeq: null };
    }
  }
  for (const [providerThreadId, state] of Object.entries(migrated)) {
    if (readMirror(providerThreadId) === null) saveMirror(providerThreadId, state);
  }
  for (const name of ["mirror.json", "cursors.json", "live.json"]) {
    rmSync(join(dir, name), { force: true });
  }
}

const liveSchema = z.object({ pid: z.number(), at: z.number() });

function claimThread(threadId: string): void {
  writeState("live", threadId, { pid: process.pid, at: Date.now() });
}

// False once another worker attached the thread after us, or the thread was retired.
function ownsThread(threadId: string): boolean {
  if (dataDir === null) return true;
  if (existsSync(stateFile("retired", threadId)!)) return false;
  const parsed = liveSchema.safeParse(readJsonFile(stateFile("live", threadId)!));
  return !parsed.success || parsed.data.pid === process.pid;
}

function releaseThread(threadId: string): void {
  const file = stateFile("live", threadId);
  if (file === null) return;
  const parsed = liveSchema.safeParse(readJsonFile(file));
  if (parsed.success && parsed.data.pid === process.pid) rmSync(file, { force: true });
}

const LOCK_STALE_MS = 60_000;

async function withFileLock<T>(providerThreadId: string, run: () => Promise<T>): Promise<T> {
  const lock = stateFile("locks", providerThreadId);
  if (lock === null) return run();
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // Released between the failed mkdir and the stat.
      }
      if (Date.now() > deadline) throw new Error("Grok Bot mirror is busy");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  try {
    return await run();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

type JsonRpcId = string | number;
type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

const io = createBridgeIo<OutboundMessage>();

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
}

function emitDeltas(threadId: string, deltas: ThreadDelta[]): void {
  if (deltas.length === 0) return;
  notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
}

function parseOptions(value: unknown): GrokBotProviderOptions {
  const parsed = grokBotProviderOptionsSchema.safeParse(value ?? {});
  return parsed.success
    ? parsed.data
    : grokBotProviderOptionsSchema.parse({});
}

function promptText(input: readonly PromptInput[]): string {
  return input
    .filter(
      (item): item is Extract<PromptInput, { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("");
}

function directiveValue(value: string): string {
  return value.replace(/["{}\\\n\r]/g, "").trim();
}

export function authorDirective(agentId: string, name: string): string {
  return `::grok-bot-author{agent="${directiveValue(agentId)}" name="${directiveValue(name)}"}`;
}

interface MirrorContext {
  agent: { id: string; name: string };
  threadId: string;
  backfill: boolean;
}

const entryExtrasSchema = z
  .object({
    seq: z.number().optional(),
    revision: z.number().optional(),
    content: z.string().optional(),
    toAgent: z.object({ id: z.string(), name: z.string() }).passthrough().optional(),
    fromAgent: z.object({ id: z.string(), name: z.string() }).passthrough().optional(),
    fromUser: z.object({ name: z.string() }).passthrough().optional(),
    call: z.object({ durationMs: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();

const sendMessageSchema = z
  .object({
    type: z.string(),
    content: z.string().optional(),
    file_name: z.string().optional(),
  })
  .passthrough();

function entrySeq(entry: TranscriptEntry): number | null {
  const parsed = entryExtrasSchema.safeParse(entry);
  return parsed.success ? (parsed.data.revision ?? parsed.data.seq ?? null) : null;
}

function botItem(key: string, author: { id: string; name: string }, body: string): ThreadDelta[] {
  const text = `${authorDirective(author.id, author.name)}\n\n${body}`;
  const itemKey = { providerItemId: key };
  return [
    {
      kind: "item.open",
      key: itemKey,
      item: { type: "agentMessage", text: "" },
      presentation: BOT_MESSAGE_PRESENTATION,
    },
    { kind: "item.textDelta", key: itemKey, channel: "agentMessage", text },
    { kind: "item.textClose", key: itemKey, channel: "agentMessage", text },
  ];
}

// One Grok transcript entry as bb sees it in the Grok Bot app: your messages become
// your bb messages, everything the bots say becomes their bubbles. Messages bb itself
// sent carry the identity header and already exist as bb rows, so live mirroring
// skips them; a backfill shows them without the header.
export function entryDeltas(
  entry: TranscriptEntry,
  context: MirrorContext,
): ThreadDelta[] {
  const extras = entryExtrasSchema.safeParse(entry);
  if (!extras.success) return [];
  const data = extras.data;
  const key = `grok-bot-${entry.id}`;
  const bot = {
    id: entry.author?.id ?? context.agent.id,
    name: entry.author?.name ?? context.agent.name,
  };

  if (entry.kind === "send-message") {
    const message = sendMessageSchema.safeParse(entry.message);
    if (!message.success) return [];
    if (message.data.type === "text" && message.data.content) {
      return botItem(key, bot, message.data.content);
    }
    if (message.data.type === "attachment") {
      return botItem(key, bot, `📎 ${message.data.file_name ?? "attachment"} (open it in Grok Bot)`);
    }
    return [];
  }

  if (entry.kind === "voice-call") {
    const seconds = Math.round((data.call?.durationMs ?? 0) / 1000);
    return botItem(key, context.agent, `📞 Voice call${seconds > 0 ? ` · ${seconds}s` : ""}`);
  }

  if (entry.kind !== "message" || !data.content?.trim()) return [];
  const content = data.content;

  if (entry.role === "assistant") {
    const body = data.toAgent ? `↗ **to ${data.toAgent.name}**\n\n${content}` : content;
    return botItem(key, context.agent, body);
  }
  if (entry.role !== "user") return [];

  if (data.fromAgent) {
    return botItem(key, data.fromAgent, `↘ **to ${context.agent.name}**\n\n${content}`);
  }
  if (data.fromUser || (entry.author?.name && entry.author.name !== "")) {
    const name = data.fromUser?.name ?? entry.author?.name ?? "Grok Bot";
    return botItem(key, { id: `system-${name}`, name }, content);
  }
  if (content.startsWith(REGISTER_MARKER) || content.startsWith(SYNC_MARKER)) return [];
  const header = /^\[bb identity: [^\]]*\]\s*/.exec(content);
  if (header) {
    if (!context.backfill) return [];
    const text = content.slice(header[0].length).trim();
    // Older bridges forwarded bb's own notices to the bot; they were never yours.
    if (!text || text.startsWith(BB_SYSTEM_PREFIX)) return [];
    return [{ kind: "input.provider", text }];
  }
  return [{ kind: "input.provider", text: content }];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveAgentId(
  session: Session,
  model: string | undefined,
): string | null {
  if (model && AGENT_ID_RE.test(model)) return model.toLowerCase();
  return session.defaultAgentId;
}

const BOT_NAMES = new Map<string, string>();

async function agentName(api: GrokApi, agentId: string, signal?: AbortSignal): Promise<string> {
  const known = BOT_NAMES.get(agentId);
  if (known) return known;
  const agent = await getAgent(api, agentId, signal);
  BOT_NAMES.set(agentId, agent.name);
  return agent.name;
}

// Serialises everything that reads the transcript for one thread, so a live turn and
// the idle follower never mirror the same entry twice.
const mirrorLocks = new Map<string, Promise<unknown>>();

function withMirrorLock<T>(session: Session, run: () => Promise<T>): Promise<T> {
  const threadId = session.threadId;
  const locked = () => withFileLock(session.providerThreadId, run);
  const previous = mirrorLocks.get(threadId) ?? Promise.resolve();
  const next = previous.then(locked, locked);
  mirrorLocks.set(threadId, next.catch(() => undefined));
  return next;
}

// Reads every Grok entry bb hasn't shown yet and returns the deltas that show them,
// committing the cursor only through `commit` once the deltas are on the wire.
async function pullTranscript(args: {
  api: GrokApi;
  session: Session;
  agentId: string;
  signal?: AbortSignal;
}): Promise<{ deltas: ThreadDelta[]; commit: () => void }> {
  const { api, session, agentId } = args;
  const name = await agentName(api, agentId, args.signal);
  const previous = readMirror(session.providerThreadId);
  const state: MirrorState =
    previous && previous.agentId === agentId
      ? { ...previous }
      : { agentId, cursor: null, backfilled: false, lastSeq: null };
  const backfill = !state.backfilled;
  const context: MirrorContext = {
    agent: { id: agentId, name },
    threadId: session.threadId,
    backfill,
  };
  const deltas: ThreadDelta[] = [];
  for (let page = 0; page < MAX_PAGES_PER_PULL; page += 1) {
    const result = await readThread(api, agentId, backfill ? null : state.cursor, args.signal);
    // Entries come in seq order but are compared by revision (an edited entry's
    // updatedSeq), so the floor must be fixed for the page, not raised mid-page.
    const floor = state.lastSeq;
    for (const entry of result.entries) {
      const seq = entrySeq(entry);
      if (seq !== null && floor !== null && seq <= floor) continue;
      if (
        seq === null &&
        result.gapReset &&
        (entry.timestampMs ?? 0) < session.openedAt - 5_000
      ) {
        continue;
      }
      const out = entryDeltas(entry, context);
      // An entry already mirrored and now only edited (a reaction or a finished stream
      // bumps updatedSeq) may refresh its keyed bot item, but must never replay a
      // user message as a second input row.
      const revisit = floor !== null && entry.seq !== undefined && entry.seq <= floor;
      deltas.push(...(revisit ? out.filter((d) => d.kind.startsWith("item.")) : out));
      if (seq !== null) state.lastSeq = Math.max(state.lastSeq ?? seq, seq);
    }
    if (result.cursor) state.cursor = result.cursor;
    if (backfill || result.entries.length < 200) break;
  }
  state.backfilled = true;
  return { deltas, commit: () => saveMirror(session.providerThreadId, state) };
}

// Grok activity bb didn't ask for (you typing in the Grok Bot app, a bot posting on its
// own) arrives as a bridge-opened turn, so the thread reads the same as the app.
function followLater(session: Session, delayMs = FOLLOW_INTERVAL_MS): void {
  if (session.closed || session.follower !== null) return;
  session.follower = setTimeout(() => {
    session.follower = null;
    void follow(session);
  }, delayMs);
}

async function follow(session: Session): Promise<void> {
  if (session.closed) return;
  const agentId = session.defaultAgentId;
  if (agentId === null || session.turn !== null) {
    followLater(session);
    return;
  }
  if (!ownsThread(session.threadId)) {
    // Another worker attached this thread (or it was replaced); it follows from here.
    session.follower = null;
    return;
  }
  claimThread(session.threadId);
  try {
    const api = resolveApi();
    await withMirrorLock(session, async () => {
      if (session.turn !== null || session.closed) return;
      const pulled = await pullTranscript({ api, session, agentId });
      if (session.turn !== null || session.closed) return;
      if (pulled.deltas.length > 0) {
        emitDeltas(session.threadId, [
          { kind: "turn.open" },
          ...pulled.deltas,
          { kind: "turn.boundary", status: "completed" },
        ]);
      }
      pulled.commit();
    });
  } catch {
    // The next tick retries.
  }
  followLater(session);
}

async function runTurn(args: {
  session: Session;
  input: readonly PromptInput[];
  model: string | undefined;
  providerOptions: unknown;
  clientRequestId?: ClientTurnRequestId;
}): Promise<void> {
  const { session } = args;
  session.providerOptions = args.providerOptions;
  // bb routed this turn here, so this worker owns the thread now.
  claimThread(session.threadId);
  const options = parseOptions(args.providerOptions);
  const opening: ThreadDelta[] = [];
  if (args.clientRequestId !== undefined) {
    opening.push({ kind: "input.accepted", clientRequestId: args.clientRequestId });
  }
  opening.push({ kind: "turn.open" });
  emitDeltas(session.threadId, opening);

  const fail = (message: string) => {
    session.turn = null;
    emitDeltas(session.threadId, [
      { kind: "turn.boundary", status: "failed", error: { message } },
    ]);
    followLater(session);
  };

  const text = promptText(args.input).trim();
  if (!text) {
    fail("Grok Bot only accepts text messages from BB.");
    return;
  }

  let api: GrokApi;
  try {
    api = resolveApi();
  } catch (error) {
    fail(errorMessage(error));
    return;
  }

  let agentId = resolveAgentId(session, args.model);
  if (agentId === null) {
    try {
      const agents = await listAgents(api);
      agentId = agents.find((agent) => agent.kind === "bot")?.id ?? null;
    } catch (error) {
      fail(errorMessage(error));
      return;
    }
  }
  if (agentId === null) {
    fail("No Grok Bot bots found. Create one in the Grok Bot app first.");
    return;
  }
  session.defaultAgentId = agentId;

  const turn: ActiveTurn = {
    agentId,
    cancelled: false,
    abort: new AbortController(),
    timer: null,
  };
  session.turn = turn;
  const turnKey = randomUUID().slice(0, 8);

  const drain = (): Promise<number> =>
    withMirrorLock(session, async () => {
      if (turn.cancelled || session.turn !== turn) return 0;
      const pulled = await pullTranscript({
        api,
        session,
        agentId,
        signal: turn.abort.signal,
      });
      if (turn.cancelled || session.turn !== turn) return 0;
      emitDeltas(session.threadId, pulled.deltas);
      pulled.commit();
      return pulled.deltas.filter((delta) => delta.kind === "item.open").length;
    });

  const finish = (note: string | null) => {
    if (session.turn !== turn) return;
    session.turn = null;
    const deltas: ThreadDelta[] = [];
    if (note !== null) {
      const key = { providerItemId: `grok-bot-${turnKey}-note` };
      deltas.push(
        {
          kind: "item.open",
          key,
          item: { type: "agentMessage", text: "" },
          presentation: BOT_MESSAGE_PRESENTATION,
        },
        { kind: "item.textClose", key, channel: "agentMessage", text: note },
      );
    }
    deltas.push({ kind: "turn.boundary", status: "completed" });
    emitDeltas(session.threadId, deltas);
    followLater(session);
  };

  let agent: GrokAgent;
  try {
    agent = await getAgent(api, agentId, turn.abort.signal);
    BOT_NAMES.set(agentId, agent.name);
    // Anything already in Grok that bb hasn't shown (the history on a new thread,
    // messages typed in the Grok Bot app) lands before this turn's own traffic.
    await drain();
  } catch (error) {
    if (!turn.cancelled) fail(errorMessage(error));
    return;
  }
  if (turn.cancelled) return;

  if (text.startsWith(REGISTER_MARKER)) {
    finish(`Registered as ${agent.name}'s persistent BB thread. Other agents can message ${agent.name} with: bb thread tell ${session.threadId} "…"`);
    return;
  }
  if (text.startsWith(SYNC_MARKER) || text.startsWith(BB_SYSTEM_PREFIX)) {
    finish(null);
    return;
  }

  const outgoing =
    options.identityHeader === false
      ? text
      : `${identityHeader(agent.name, session.threadId, api.policy.localAgentBridge)}\n\n${text}`;
  try {
    await sendMessage(api, agentId, outgoing);
  } catch (error) {
    if (!turn.cancelled) fail(errorMessage(error));
    return;
  }
  if (turn.cancelled) return;

  const startedAt = Date.now();
  let sawBusy = false;
  let replies = 0;
  let lastNewest: string | null = null;

  const tick = async (): Promise<void> => {
    turn.timer = null;
    if (turn.cancelled || session.turn !== turn) return;
    try {
      const status = (await getAgent(api, agentId, turn.abort.signal)).status;
      if (turn.cancelled) return;
      const newest = status?.newestEntryId ?? null;
      if (newest !== lastNewest) {
        replies += await drain();
        lastNewest = newest;
      }
      if (turn.cancelled) return;
      const busy = status ? status.running || status.runningTurn : false;
      if (busy) sawBusy = true;
      const elapsed = Date.now() - startedAt;
      if (!busy && (sawBusy || replies > 0 || status?.awaitingUserResponse)) {
        replies += await drain();
        finish(null);
        return;
      }
      if (!busy && elapsed > (options.startGraceMs ?? DEFAULT_START_GRACE_MS)) {
        finish(
          "Grok Bot hasn't picked this up yet. Anything it sends later will show up here on its own.",
        );
        return;
      }
      if (elapsed > (options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS)) {
        finish(
          "Stopped waiting: Grok Bot is still working. Its later messages will show up here on their own.",
        );
        return;
      }
    } catch (error) {
      if (turn.cancelled) return;
      if (error instanceof GrokApiError && error.code !== "failed") {
        fail(error.message);
        return;
      }
    }
    turn.timer = setTimeout(
      () => void tick(),
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
  };

  turn.timer = setTimeout(() => void tick(), 1_500);
}

function cancelTurn(session: Session, interrupted: boolean): void {
  const turn = session.turn;
  if (turn === null) return;
  turn.cancelled = true;
  turn.abort.abort();
  if (turn.timer !== null) clearTimeout(turn.timer);
  session.turn = null;
  if (interrupted) {
    emitDeltas(session.threadId, [
      { kind: "turn.boundary", status: "interrupted" },
    ]);
  }
}

function openSession(args: {
  threadId: string;
  providerThreadId: string;
  model: string | undefined;
  providerOptions: unknown;
}): Session {
  const existing = sessions.get(args.threadId);
  if (existing) closeSession(existing);
  const session: Session = {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    defaultAgentId:
      (args.model && AGENT_ID_RE.test(args.model) ? args.model.toLowerCase() : null) ??
      readMirror(args.providerThreadId)?.agentId ??
      null,
    turn: null,
    follower: null,
    providerOptions: args.providerOptions,
    openedAt: Date.now(),
    closed: false,
  };
  sessions.set(args.threadId, session);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
  });
  emitDeltas(args.threadId, [{ kind: "session.reset" }]);
  claimThread(args.threadId);
  followLater(session, 500);
  return session;
}

function closeSession(session: Session): void {
  session.closed = true;
  cancelTurn(session, false);
  if (session.follower !== null) clearTimeout(session.follower);
  session.follower = null;
  releaseThread(session.threadId);
}

type HealthStatus = Extract<ProviderHealthResult, { supported: true }>["health"]["status"];

function health(
  status: HealthStatus,
  statusMessage: string | null,
  installedVersion: string | null,
): ProviderHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage,
      accountEmail: null,
      planLabel: null,
      installedVersion,
      minimumSupportedVersion: null,
      canInstall: false,
      canUpdate: false,
      loginCommand: null,
    },
  };
}

async function checkHealth(_providerOptions: unknown): Promise<ProviderHealthResult> {
  // Local checks only (token file present and private, allowlist set); no network.
  let api: GrokApi;
  try {
    api = resolveApi();
  } catch (error) {
    return health("unauthenticated", errorMessage(error), null);
  }
  if (api.policy.allowedBots.length === 0) {
    return health(
      "unauthenticated",
      "No Grok Bots are allowlisted. Add bot ids to allowedBots in ~/.config/bb-grok-bot/config.json.",
      null,
    );
  }
  return health("ready", null, null);
}

function modelEntry(agent: GrokAgent, isDefault: boolean) {
  const description =
    agent.kind === "group"
      ? `Group chat with ${agent.members?.length ?? 0} bots`
      : (agent.description?.trim().slice(0, 160) ?? "") || "Grok Bot";
  return {
    id: agent.id,
    model: agent.id,
    displayName: agent.kind === "group" ? `${agent.name} (group)` : agent.name,
    description,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium" as const, description: "Default" },
    ],
    defaultReasoningEffort: "medium" as const,
    isDefault,
  };
}

type RequestHandler = (id: JsonRpcId, params: unknown) => void | Promise<void>;

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.send({
    jsonrpc: "2.0",
    id,
    error: {
      code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      message: `Invalid params for ${method}`,
      data: issues,
    },
  });
}

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
      return;
    }
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        sessionRestore: true,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        approvalEnforcedBy: "runtime",
        steerMode: "queue",
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: async (id, params) => {
    const parsed = modelListParamsSchema
      .extend({ providerOptions: z.record(z.string(), z.unknown()).optional() })
      .safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    try {
      const api = resolveApi();
      const agents = await listAgents(api);
      const firstBot = agents.findIndex((agent) => agent.kind === "bot");
      const defaultIndex = firstBot === -1 ? 0 : firstBot;
      io.sendResult(id, {
        models: agents.map((agent, index) =>
          modelEntry(agent, index === defaultIndex),
        ),
        selectedOnlyModels: [],
      });
    } catch (error) {
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, errorMessage(error));
    }
  },

  [BRIDGE_REQUEST_METHODS.providerHealth]: async (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.providerHealth, parsed.error.issues);
      return;
    }
    io.sendResult(id, await checkHealth(parsed.data.providerOptions));
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStart, parsed.error.issues);
      return;
    }
    const providerThreadId = `grok-bot_${randomUUID()}`;
    const session = openSession({
      threadId: parsed.data.threadId,
      providerThreadId,
      model: parsed.data.options.model,
      providerOptions: parsed.data.options.providerOptions,
    });
    // Not restorable on purpose: an idle session is the mirror following Grok, so bb
    // must not reap it.
    io.sendResult(id, { providerThreadId, sessionRestorable: false });
    if (parsed.data.input !== undefined && parsed.data.input.length > 0) {
      void runTurn({
        session,
        input: parsed.data.input,
        model: parsed.data.options.model,
        providerOptions: parsed.data.options.providerOptions,
      });
    }
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadResume, parsed.error.issues);
      return;
    }
    openSession({
      threadId: parsed.data.threadId,
      providerThreadId: parsed.data.providerThreadId,
      model: parsed.data.options.model,
      providerOptions: parsed.data.options.providerOptions,
    });
    io.sendResult(id, {
      providerThreadId: parsed.data.providerThreadId,
      sessionRestorable: false,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `No session for thread ${parsed.data.threadId}; send thread/start or thread/resume first`,
      );
      return;
    }
    io.sendResult(id, {});
    void runTurn({
      session,
      input: parsed.data.input,
      model: parsed.data.options.model,
      providerOptions: parsed.data.options.providerOptions,
      clientRequestId: parsed.data.clientRequestId,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
      `Grok Bot turns cannot be steered (expected ${parsed.data.expectedTurnId})`,
    );
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session) {
      cancelTurn(session, parsed.data.intent === "interrupt");
      if (parsed.data.intent === "release") {
        closeSession(session);
        sessions.delete(parsed.data.threadId);
      } else {
        followLater(session);
      }
    }
    io.sendResult(id, {});
  },
};

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return;
  }
  const { id, method, params } = message as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (typeof method !== "string") return;
  if (typeof id !== "string" && typeof id !== "number") return;
  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    return;
  }
  runBridgeRequest({
    request: { id, method, params },
    sendError: io.sendError,
    handleRequest: async (request) => handler(request.id, request.params),
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    loadMirrors(context.dataDir);
  },
  onClose() {
    for (const session of sessions.values()) closeSession(session);
  },
});
