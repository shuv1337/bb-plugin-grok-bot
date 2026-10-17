import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";

const GBOT_TIMEOUT_MS = 60_000;
const GBOT_MAX_BUFFER = 16 * 1024 * 1024;

export class GbotError extends Error {
  constructor(
    message: string,
    readonly code: "not-installed" | "failed",
  ) {
    super(message);
    this.name = "GbotError";
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateDirs(): string[] {
  const home = homedir();
  return [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    join(home, ".local", "bin"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".npm-global", "bin"),
    "/usr/local/bin",
    "/usr/bin",
  ];
}

export function resolveGbot(configured: string | undefined): string {
  const explicit = configured?.trim();
  if (explicit) {
    if (!isExecutable(explicit)) {
      throw new GbotError(`gbot not found at ${explicit}`, "not-installed");
    }
    return realpathSync(explicit);
  }
  for (const dir of candidateDirs()) {
    const path = join(dir, "gbot");
    if (isExecutable(path)) return realpathSync(path);
  }
  throw new GbotError(
    "gbot is not installed. Install grok-bot-cli (npm install --global grok-bot-cli) or set the plugin's gbotPath setting.",
    "not-installed",
  );
}

function spawnArgs(gbot: string, args: string[]): [string, string[]] {
  if (gbot.endsWith(".mjs") || gbot.endsWith(".js")) {
    return [process.execPath, [gbot, ...args]];
  }
  return [gbot, args];
}

function runGbot(
  gbot: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const [command, argv] = spawnArgs(gbot, args);
  return new Promise((resolve, reject) => {
    execFile(
      command,
      argv,
      {
        timeout: GBOT_TIMEOUT_MS,
        maxBuffer: GBOT_MAX_BUFFER,
        encoding: "utf8",
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error && !stdout.trim()) {
          const detail = stderr.trim() || error.message;
          reject(new GbotError(`gbot ${args[0]} failed: ${detail}`, "failed"));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

const gbotErrorSchema = z.object({
  error: z.union([
    z.string(),
    z.object({ message: z.string() }).passthrough(),
  ]),
});

const TRANSIENT_GATEWAY_RE = /failed: (?:417|429|5\d\d)\b/;
const READ_RETRY_DELAYS_MS = [1_000, 3_000];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GbotError("cancelled", "failed"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new GbotError("cancelled", "failed"));
      },
      { once: true },
    );
  });
}

async function gbotJson<T>(
  gbot: string,
  args: string[],
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await gbotJsonOnce(gbot, args, schema, signal);
    } catch (error) {
      const delay = READ_RETRY_DELAYS_MS[attempt];
      if (
        delay === undefined ||
        !(error instanceof GbotError) ||
        !TRANSIENT_GATEWAY_RE.test(error.message)
      ) {
        throw error;
      }
      await sleep(delay, signal);
    }
  }
}

async function gbotJsonOnce<T>(
  gbot: string,
  args: string[],
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const stdout = await runGbot(gbot, [...args, "--json"], signal);
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new GbotError(
      `gbot ${args[0]} returned non-JSON output: ${stdout.slice(0, 300)}`,
      "failed",
    );
  }
  const failure = gbotErrorSchema.safeParse(value);
  if (failure.success) {
    const { error } = failure.data;
    throw new GbotError(
      `gbot ${args.slice(0, 2).join(" ")}: ${typeof error === "string" ? error : error.message}`,
      "failed",
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new GbotError(
      `gbot ${args[0]} returned an unexpected shape: ${parsed.error.message.slice(0, 300)}`,
      "failed",
    );
  }
  return parsed.data;
}

const agentStatusSchema = z.object({
  running: z.boolean(),
  runningTurn: z.boolean(),
  awaitingUserResponse: z.boolean(),
  newestEntryId: z.string().nullable(),
  lastMessagePreview: z.string().nullable().optional(),
  lastActivityAt: z.number().nullable().optional(),
  unreadCount: z.number().optional(),
});

const agentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["bot", "group"]),
    description: z.string().optional(),
    members: z.array(z.string()).optional(),
    avatarShape: z.string().optional(),
    avatarColor: z.string().optional(),
    status: agentStatusSchema.optional(),
  })
  .passthrough();

export type GrokAgent = z.infer<typeof agentSchema>;
export type GrokAgentStatus = z.infer<typeof agentStatusSchema>;

export async function listAgents(gbot: string): Promise<GrokAgent[]> {
  const [bots, groups] = await Promise.all([
    gbotJson(gbot, ["bots", "list"], z.array(agentSchema)),
    gbotJson(gbot, ["groups", "list"], z.array(agentSchema)),
  ]);
  return [...bots, ...groups];
}

export function getAgent(
  gbot: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<GrokAgent> {
  return gbotJson(gbot, ["bots", "get", agentId], agentSchema, signal);
}

const sendResultSchema = z
  .object({
    delivery: z.string(),
    messageId: z.string().optional(),
    exitCode: z.number().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

export async function sendMessage(
  gbot: string,
  agentId: string,
  text: string,
): Promise<{ delivery: string; messageId: string | null }> {
  const stdout = await runGbot(gbot, [
    "send",
    "--json",
    "--no-history",
    agentId,
    "--",
    text,
  ]);
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new GbotError(
      `gbot send returned non-JSON output: ${stdout.slice(0, 300)}`,
      "failed",
    );
  }
  const parsed = sendResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new GbotError("gbot send returned an unexpected shape", "failed");
  }
  if (parsed.data.exitCode !== undefined && parsed.data.exitCode !== 0) {
    const detail =
      typeof parsed.data.error === "string"
        ? parsed.data.error
        : JSON.stringify(parsed.data.error ?? parsed.data);
    throw new GbotError(`gbot send failed: ${detail.slice(0, 300)}`, "failed");
  }
  return {
    delivery: parsed.data.delivery,
    messageId: parsed.data.messageId ?? null,
  };
}

const transcriptEntrySchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    role: z.string().optional(),
    timestampMs: z.number().optional(),
    author: z
      .object({ id: z.string().optional(), name: z.string().optional() })
      .passthrough()
      .optional(),
    message: z.unknown().optional(),
  })
  .passthrough();

export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

const threadResultSchema = z
  .object({
    transcript: z
      .object({ entries: z.array(transcriptEntrySchema) })
      .passthrough(),
    cursor: z.string().optional(),
    gapReset: z.boolean().optional(),
  })
  .passthrough();

export async function readThread(
  gbot: string,
  agentId: string,
  after: string | null,
  signal?: AbortSignal,
): Promise<{ entries: TranscriptEntry[]; cursor: string | null; gapReset: boolean }> {
  const args = ["thread", agentId, "--no-history", "--limit", "200"];
  if (after) args.push("--after", after);
  const result = await gbotJson(gbot, args, threadResultSchema, signal);
  return {
    entries: result.transcript.entries,
    cursor: result.cursor ?? null,
    gapReset: result.gapReset === true,
  };
}

const doctorSchema = z
  .object({
    gatewayAuthPresent: z.boolean().optional(),
    grokBotAppSession: z
      .object({
        present: z.boolean(),
        usable: z.boolean(),
        error: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function doctor(gbot: string) {
  return gbotJson(gbot, ["doctor"], doctorSchema);
}

export async function gbotVersion(gbot: string): Promise<string | null> {
  try {
    const out = await runGbot(gbot, ["--version"]);
    return out.trim().replace(/^gbot\s+/, "") || null;
  } catch {
    return null;
  }
}

const avatarFileSchema = z.object({
  id: z.string(),
  file: z.string(),
  mimeType: z.string(),
  bytes: z.number(),
});

export function writeAvatars(
  gbot: string,
  outDir: string,
): Promise<Array<z.infer<typeof avatarFileSchema>>> {
  return gbotJson(
    gbot,
    ["bots", "avatars", "--out-dir", outDir],
    z.array(avatarFileSchema),
  );
}
