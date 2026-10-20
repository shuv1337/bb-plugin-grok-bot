// Direct client for the Grok Bot backend (Connect-JSON over HTTPS), modelled on
// botdeck's desktop transport. Replaces the patched gbot CLI: no child process, no
// desktop-app storage, no Keychain. Every call is gated by the bot allowlist.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type AccessPolicy,
  type Credentials,
  GrokAuthError,
  loadCredentials,
  loadPolicy,
} from "./auth.js";

export const SERVICE_PATH = "/aiserver.v1.GrokBotService/";
const TIMEOUT_MS = 30_000;
const ROSTER_TTL_MS = 15_000;
const THREAD_LIMIT = 200;

/** The only backend methods this plugin may call, with response caps. */
const METHODS = {
  ListGrokBotAgents: { maxBytes: 4 * 1024 * 1024 },
  ListGrokBotTranscriptEntries: { maxBytes: 16 * 1024 * 1024 },
  SendGrokBotUserMessage: { maxBytes: 64 * 1024 },
} as const;
export type GrokMethod = keyof typeof METHODS;

export class GrokApiError extends Error {
  constructor(
    message: string,
    readonly code: "not-configured" | "not-allowed" | "failed",
  ) {
    super(message);
    this.name = "GrokApiError";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init);

/** Test seam: swap the network. Production code never calls this. */
export function setFetchForTesting(fn: FetchLike | null): void {
  fetchImpl = fn ?? ((url, init) => globalThis.fetch(url, init));
  rosterCache = null;
}

export interface GrokApi {
  readonly credentials: Credentials;
  readonly policy: AccessPolicy;
}

/** Loads credentials and policy fresh each time so edits and revocations apply at once. */
export function resolveApi(): GrokApi {
  try {
    return { credentials: loadCredentials(), policy: loadPolicy() };
  } catch (error) {
    if (error instanceof GrokAuthError) throw new GrokApiError(error.message, "not-configured");
    throw error;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new GrokApiError("Grok Bot response too large", "failed");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new GrokApiError("Grok Bot response too large", "failed");
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function call(api: GrokApi, method: GrokMethod, body: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const { credentials } = api;
  const headers: Record<string, string> = {
    authorization: `Bearer ${credentials.accessToken}`,
    "content-type": "application/json",
    accept: "application/json",
    "connect-protocol-version": "1",
  };
  if (credentials.teamId) headers["x-cursor-team-id"] = credentials.teamId;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${credentials.baseUrl}${SERVICE_PATH}${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    // The underlying error can echo request details; report only the method.
    throw new GrokApiError(`Grok Bot ${method}: network error`, "failed");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    const hint =
      response.status === 401
        ? " (token expired or revoked; replace it)"
        : response.status >= 300 && response.status < 400
          ? " (redirect refused)"
          : "";
    throw new GrokApiError(`Grok Bot ${method} failed: ${response.status}${hint}`, "failed");
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    await response.body?.cancel().catch(() => {});
    throw new GrokApiError(`Grok Bot ${method} returned a non-JSON response`, "failed");
  }
  const text = await readCapped(response, METHODS[method].maxBytes);
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new GrokApiError(`Grok Bot ${method} returned malformed JSON`, "failed");
}

// ---- agents ---------------------------------------------------------------

const agentStatusSchema = z.object({
  running: z.boolean(),
  runningTurn: z.boolean(),
  awaitingUserResponse: z.boolean(),
  newestEntryId: z.string().nullable(),
  lastMessagePreview: z.string().nullable().optional(),
  lastActivityAt: z.number().nullable().optional(),
  unreadCount: z.number().optional(),
});
export type GrokAgentStatus = z.infer<typeof agentStatusSchema>;

export interface GrokAgent {
  id: string;
  name: string;
  kind: "bot" | "group";
  description?: string;
  members?: string[];
  avatarShape?: string;
  avatarColor?: string;
  status?: GrokAgentStatus;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

interface RawAgent {
  agent: GrokAgent;
  ownedByViewer: boolean;
}

function normalizeAgent(raw: unknown): RawAgent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  // Bots address each other by agentId; botdeck reads transcripts by it too.
  const id = [r.agentId, r.id].find((v): v is string => typeof v === "string" && ID_RE.test(v));
  if (!id) return null;
  const kindRaw = typeof r.kind === "string" ? r.kind.toUpperCase() : "";
  const kind: "bot" | "group" = /ROOM|GROUP/.test(kindRaw) ? "group" : "bot";
  const running = r.isRunningTurn === true;
  const agent: GrokAgent = {
    id: id.toLowerCase(),
    name: str(r.name, 200) ?? str(r.title, 200) ?? id,
    kind,
    status: {
      running,
      runningTurn: running,
      awaitingUserResponse: false,
      // No cheap "newest entry" field upstream: a fresh value makes the bridge read
      // the transcript on every poll, which is what we want while a turn runs.
      newestEntryId: running ? `poll:${Date.now()}` : null,
    },
  };
  const description = str(r.description, 2000);
  if (description) agent.description = description;
  const shape = str(r.avatarShape, 40);
  if (shape) agent.avatarShape = shape;
  const color = str(r.avatarColor, 40);
  if (color) agent.avatarColor = color;
  if (Array.isArray(r.memberAgentIds)) {
    agent.members = r.memberAgentIds.filter((m): m is string => typeof m === "string" && ID_RE.test(m));
  }
  return { agent, ownedByViewer: r.viewerIsOwner !== false };
}

let rosterCache: { at: number; key: string; agents: RawAgent[] } | null = null;

async function fetchRoster(api: GrokApi, signal?: AbortSignal): Promise<RawAgent[]> {
  // Keyed by a digest of the token too, so a swapped token never sees another account's roster.
  const tokenDigest = createHash("sha256").update(api.credentials.accessToken).digest("hex");
  const key = `${api.credentials.baseUrl}|${api.credentials.teamId ?? ""}|${tokenDigest}`;
  if (rosterCache && rosterCache.key === key && Date.now() - rosterCache.at < ROSTER_TTL_MS) {
    return rosterCache.agents;
  }
  const response = await call(api, "ListGrokBotAgents", {}, signal);
  const rawAgents = Array.isArray(response.agents) ? response.agents : [];
  const seen = new Set<string>();
  const agents: RawAgent[] = [];
  for (const raw of rawAgents) {
    const normalized = normalizeAgent(raw);
    if (!normalized || seen.has(normalized.agent.id)) continue;
    seen.add(normalized.agent.id);
    agents.push(normalized);
  }
  rosterCache = { at: Date.now(), key, agents };
  return agents;
}

/**
 * The allowlist is matched by id, or by exact name for a bot (not a group) you own
 * whose name is unique on the account. A name never admits a bot shared with you by
 * someone else, so renaming a shared bot cannot widen access. Groups need their id:
 * a group's transcript carries its members' messages.
 */
export function filterAllowed(policy: AccessPolicy, agents: readonly RawAgent[]): GrokAgent[] {
  if (policy.allowedBots.length === 0) return [];
  const allowed = new Set(policy.allowedBots);
  const nameCounts = new Map<string, number>();
  for (const { agent } of agents) {
    const name = agent.name.toLowerCase();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  return agents
    .filter(({ agent, ownedByViewer }) => {
      if (allowed.has(agent.id)) return true;
      const name = agent.name.toLowerCase();
      return agent.kind === "bot" && ownedByViewer && nameCounts.get(name) === 1 && allowed.has(name);
    })
    .map(({ agent }) => agent);
}

function emptyAllowlist(): GrokApiError {
  return new GrokApiError(
    "No Grok Bots are allowlisted. Add bot ids to allowedBots in ~/.config/bb-grok-bot/config.json or GROK_BOT_ALLOWED_BOTS.",
    "not-allowed",
  );
}

export async function listAgents(api: GrokApi, signal?: AbortSignal): Promise<GrokAgent[]> {
  if (api.policy.allowedBots.length === 0) throw emptyAllowlist();
  return filterAllowed(api.policy, await fetchRoster(api, signal));
}

/** Resolves an allowlisted agent or throws; nothing else is ever read or messaged. */
export async function getAgent(api: GrokApi, agentId: string, signal?: AbortSignal): Promise<GrokAgent> {
  if (api.policy.allowedBots.length === 0) throw emptyAllowlist();
  const id = agentId.toLowerCase();
  // A bot that starts a turn shows up as running only on a fresh read.
  rosterCache = null;
  const agent = (await listAgents(api, signal)).find((a) => a.id === id);
  if (!agent) throw new GrokApiError(`Grok Bot ${agentId} is not allowlisted`, "not-allowed");
  return agent;
}

// ---- transcripts ----------------------------------------------------------

export interface TranscriptEntry {
  id: string;
  kind: string;
  seq?: number;
  role?: string;
  timestampMs?: number;
  author?: { id?: string; name?: string };
  message?: unknown;
  [key: string]: unknown;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBody(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value || !BASE64_RE.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toEntry(raw: unknown): TranscriptEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const seq = Number(r.seq ?? 0);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  const body = decodeBody(r.body) ?? {};
  const entryId = str(r.entryId, 200) ?? str(body.id, 200);
  const kind = str(body.kind, 100) ?? str(r.entryKind, 100) ?? str(body.type, 100) ?? "unknown";
  return { ...body, id: entryId ?? `seq:${seq}`, kind, seq };
}

export async function readThread(
  api: GrokApi,
  agentId: string,
  after: string | null,
  signal?: AbortSignal,
): Promise<{ entries: TranscriptEntry[]; cursor: string | null; gapReset: boolean }> {
  const agent = await getAgent(api, agentId, signal);
  const response = await call(api, "ListGrokBotTranscriptEntries", { agentId: agent.id, limit: THREAD_LIMIT }, signal);
  const raws = Array.isArray(response.entries) ? response.entries : [];
  const entries = raws
    .map(toEntry)
    .filter((e): e is TranscriptEntry => e !== null)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const afterSeq = after !== null && /^\d+$/.test(after) ? Number(after) : null;
  const fresh = afterSeq === null ? entries : entries.filter((e) => (e.seq ?? 0) > afterSeq);
  const oldest = entries[0]?.seq ?? null;
  const gapReset = afterSeq !== null && oldest !== null && oldest > afterSeq + 1 && entries.length >= THREAD_LIMIT;
  const newest = entries.at(-1)?.seq;
  return { entries: fresh, cursor: newest === undefined ? after : String(newest), gapReset };
}

export async function sendMessage(
  api: GrokApi,
  agentId: string,
  text: string,
): Promise<{ delivery: string; messageId: string | null }> {
  const agent = await getAgent(api, agentId);
  const messageId = randomUUID();
  await call(api, "SendGrokBotUserMessage", {
    agentId: agent.id,
    messageId,
    text,
    sentAtMs: String(Date.now()),
  });
  return { delivery: "accepted", messageId };
}

/** Local readiness only: never contacts the network. */
export function doctor(): { configured: boolean; allowlisted: number; error?: string } {
  try {
    const api = resolveApi();
    return { configured: true, allowlisted: api.policy.allowedBots.length };
  } catch (error) {
    return { configured: false, allowlisted: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
