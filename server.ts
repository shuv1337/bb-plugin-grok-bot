import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, rosterAgentSchema, type RosterAgent } from "./contract.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_START_GRACE_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  GROK_BOT_PROVIDER_ID,
  REGISTER_MARKER,
  SYNC_MARKER,
  type GrokBotProviderOptions,
} from "./src/vocabulary.js";

const PROJECT_NAME = "Grok Bots";
const PROJECT_KEY = "project-id";
const THREAD_KEY_PREFIX = "thread:";
const SNAPSHOT_KEY = "directory-snapshot";
const LIVE_WITHIN_MS = 30_000;
const SYNC_DEBOUNCE_MS = 60_000;

export const rpcContract = defineRpcContract({
  directory: {
    input: z.object({ refresh: z.boolean().optional() }).strict().nullable(),
    output: z
      .object({
        projectId: z.string().nullable(),
        agents: z.array(rosterAgentSchema),
        threads: z.record(z.string(), z.string()),
        avatars: z.record(z.string(), z.string()),
        error: z.string().nullable(),
      })
      .strict(),
  },
  sync: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ woke: z.boolean() }).strict(),
  },
});

const snapshotSchema = z.object({
  at: z.number(),
  agents: z.array(rosterAgentSchema),
  avatars: z.record(z.string(), z.string()),
});

const settingsDescriptors = {
  pollIntervalSeconds: {
    type: "number",
    label: "Poll interval (seconds)",
    description: "How often to check Grok Bot for new messages during a turn.",
    default: DEFAULT_POLL_INTERVAL_MS / 1000,
  },
  startGraceSeconds: {
    type: "number",
    label: "Start grace (seconds)",
    description:
      "How long to wait for a bot to start working before ending the turn.",
    default: DEFAULT_START_GRACE_MS / 1000,
  },
  turnTimeoutMinutes: {
    type: "number",
    label: "Turn timeout (minutes)",
    description:
      "Stop waiting after this long. Later bot messages appear on the next turn.",
    default: DEFAULT_TURN_TIMEOUT_MS / 60_000,
  },
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(settingsDescriptors);
  const host = bb.hosts.experimental_client({ contract: hostContract });

  const primaryHostId = async (): Promise<string> => {
    const hostId = (await bb.sdk.system.config()).primaryHostId;
    if (!hostId) throw new Error("This BB server has no local machine.");
    return hostId;
  };

  const existingProjectId = async (): Promise<string | null> => {
    const stored = await bb.storage.kv.get<string>(PROJECT_KEY);
    if (typeof stored !== "string") return null;
    try {
      await bb.sdk.projects.get({ projectId: stored });
      return stored;
    } catch {
      await bb.storage.kv.delete(PROJECT_KEY);
      return null;
    }
  };

  const ensureProject = async (): Promise<string> => {
    const existing = await existingProjectId();
    if (existing) return existing;
    const hostId = await primaryHostId();
    const { path } = await host.call("workspace", {}, { hostId });
    const project = await bb.sdk.projects.create({
      name: PROJECT_NAME,
      source: { type: "local_path", hostId, path },
    });
    await bb.storage.kv.set(PROJECT_KEY, project.id);
    return project.id;
  };

  const linkedThreads = async (): Promise<Record<string, string>> => {
    const keys = await bb.storage.kv.list(THREAD_KEY_PREFIX);
    const threads: Record<string, string> = {};
    await Promise.all(
      keys.map(async (key) => {
        const agentId = key.slice(THREAD_KEY_PREFIX.length);
        const threadId = await bb.storage.kv.get<string>(key);
        if (typeof threadId !== "string") return;
        try {
          await bb.sdk.threads.get({ threadId });
          threads[agentId] = threadId;
        } catch {
          await bb.storage.kv.delete(key);
        }
      }),
    );
    return threads;
  };

  const liveRoster = async (): Promise<RosterAgent[]> => {
    const hostId = await primaryHostId();
    return (await host.call("roster", {}, { hostId })).agents;
  };

  // Falls back to the last saved roster so bot names still resolve while Grok is unreachable.
  const roster = async (): Promise<RosterAgent[]> => {
    try {
      return await liveRoster();
    } catch (error) {
      const saved = snapshotSchema.safeParse(await bb.storage.kv.get(SNAPSHOT_KEY));
      if (saved.success && saved.data.agents.length > 0) return saved.data.agents;
      throw error;
    }
  };

  const resolveAgent = async (
    ref: string,
  ): Promise<{ agent: RosterAgent; threadId: string | null }> => {
    const [agents, threads] = await Promise.all([roster(), linkedThreads()]);
    const needle = ref.trim().toLowerCase();
    const byThread = Object.entries(threads).find(([, threadId]) => threadId === ref.trim());
    const matches = byThread
      ? agents.filter((agent) => agent.id === byThread[0])
      : agents.filter(
          (agent) =>
            agent.id === needle ||
            agent.name.toLowerCase() === needle ||
            agent.name.toLowerCase().split(" ")[0] === needle,
        );
    if (matches.length === 0) {
      throw new PluginCliError(`No Grok Bot named "${ref}"`, {
        code: "bot_not_found",
        hint: "Run `bb grok-bot list` to see bot names and thread ids.",
      });
    }
    if (matches.length > 1) {
      throw new PluginCliError(`"${ref}" matches several bots`, {
        code: "bot_ambiguous",
        hint: "Pass the bot id from `bb grok-bot list`.",
      });
    }
    const agent = matches[0]!;
    return { agent, threadId: threads[agent.id] ?? null };
  };

  const ensureBotThread = async (agent: RosterAgent): Promise<string> => {
    const existing = await bb.storage.kv.get<string>(`${THREAD_KEY_PREFIX}${agent.id}`);
    if (typeof existing === "string") {
      try {
        await bb.sdk.threads.get({ threadId: existing });
        return existing;
      } catch {
        await bb.storage.kv.delete(`${THREAD_KEY_PREFIX}${agent.id}`);
      }
    }
    const projectId = await ensureProject();
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      providerId: GROK_BOT_PROVIDER_ID,
      model: agent.id,
      permissionMode: "full",
      executionInputSources: { providerId: "explicit", model: "explicit", permissionMode: "explicit" },
      prompt: `${REGISTER_MARKER} ${agent.name}`,
      title: agent.kind === "group" ? `${agent.name} (group)` : agent.name,
      pluginMetadata: { agentId: agent.id },
    });
    await bb.storage.kv.set(`${THREAD_KEY_PREFIX}${agent.id}`, thread.id);
    bb.realtime.publish("directory-changed", { agentId: agent.id });
    return thread.id;
  };

  const readMessage = async (
    positional: readonly string[],
    option: string | undefined,
  ): Promise<string> => {
    const text = (option ?? positional.join(" ")).trim();
    if (!text) {
      throw new PluginCliError("Message is empty", {
        code: "missing_message",
        hint: 'Pass the message as an argument, or pipe it: echo "…" | bb grok-bot tell <to> --as <bot> --message-stdin',
      });
    }
    return text;
  };

  bb.cli.register(
    defineCli({
      name: "grok-bot",
      summary:
        "Grok Bot identities in BB: list bots and their persistent threads, act as a bot's thread, message as a bot",
      commands: {
        list: cliCommand({
          summary: "List Grok Bots with their persistent BB thread ids",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run(input) {
            const [agents, threads] = await Promise.all([roster(), linkedThreads()]);
            const rows = agents.map((agent) => ({
              id: agent.id,
              name: agent.name,
              kind: agent.kind,
              threadId: threads[agent.id] ?? null,
              working: agent.status ? agent.status.running || agent.status.runningTurn : null,
            }));
            if (input.options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify(rows, null, 2)}\n` };
            }
            const lines = rows.map(
              (row) =>
                `${row.name}${row.kind === "group" ? " (group)" : ""}\t${row.threadId ?? "(no thread yet: bb grok-bot env " + JSON.stringify(row.name) + ")"}\t${row.working ? "working" : "idle"}`,
            );
            return {
              exitCode: 0,
              stdout: `${lines.join("\n")}\n\nMessage a bot: bb thread tell <thread-id> "…"\n`,
            };
          },
        }),
        env: cliCommand({
          summary:
            "Print BB_THREAD_ID/BB_PROJECT_ID exports so bb commands run as this bot's thread (creates the thread if missing)",
          positionals: [
            { name: "bot", description: "Bot name, bot id, or the bot's BB thread id", required: true },
          ],
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run(input) {
            const { agent } = await resolveAgent(input.positionals.bot);
            const threadId = await ensureBotThread(agent);
            const projectId = await ensureProject();
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: `${JSON.stringify({ name: agent.name, agentId: agent.id, threadId, projectId })}\n`,
              };
            }
            return {
              exitCode: 0,
              stdout: `export BB_THREAD_ID=${threadId}\nexport BB_PROJECT_ID=${projectId}\n`,
            };
          },
        }),
        remirror: cliCommand({
          summary:
            "Replace a bot's BB thread with a fresh mirror of its Grok transcript (the old thread is archived, not deleted)",
          positionals: [
            { name: "bot", description: "Bot name, bot id, thread id, or \"all\"", required: true },
          ],
          async run(input) {
            const ref = input.positionals.bot.trim();
            const targets =
              ref.toLowerCase() === "all"
                ? await roster()
                : [(await resolveAgent(ref)).agent];
            const lines: string[] = [];
            for (const agent of targets) {
              const key = `${THREAD_KEY_PREFIX}${agent.id}`;
              const old = await bb.storage.kv.get<string>(key);
              await bb.storage.kv.delete(key);
              if (typeof old === "string") {
                const hostId = await primaryHostId();
                await host.call("retireThread", { threadId: old }, { hostId });
                await bb.sdk.threads.archive({ threadId: old }).catch(() => undefined);
              }
              const threadId = await ensureBotThread(agent);
              lines.push(`${agent.name}: ${typeof old === "string" ? `${old} archived, ` : ""}mirror ${threadId}`);
            }
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
        tell: cliCommand({
          summary: "Send a message to a bot or any BB thread, attributed to a bot's thread",
          positionals: [
            { name: "to", description: "Bot name/id, or any BB thread id", required: true },
            { name: "message", description: "Message text (or use --message / --message-stdin)", variadic: true },
          ],
          options: {
            as: {
              type: "string",
              required: true,
              description: "The bot sending the message (name, id, or its thread id)",
              aliases: ["from"],
            },
            message: {
              type: "string",
              stdin: true,
              description: "Message text; --message-stdin reads it from stdin",
            },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run(input) {
            const text = await readMessage(input.positionals.message ?? [], input.options.message);
            const sender = await resolveAgent(input.options.as);
            const senderThreadId = await ensureBotThread(sender.agent);
            const to = input.positionals.to.trim();
            let targetThreadId = to;
            if (!/^thr_/.test(to)) {
              const target = await resolveAgent(to);
              targetThreadId = await ensureBotThread(target.agent);
            }
            if (targetThreadId === senderThreadId) {
              throw new PluginCliError("A bot can't message its own thread", { code: "self_message" });
            }
            await bb.sdk.threads.send({
              threadId: targetThreadId,
              input: [{ type: "text", text, mentions: [] }],
              senderThreadId,
              mode: "queue-if-active",
            });
            const result = { from: senderThreadId, to: targetThreadId };
            return {
              exitCode: 0,
              stdout: input.options.json
                ? `${JSON.stringify(result)}\n`
                : `Sent from ${sender.agent.name} (${senderThreadId}) to ${targetThreadId}\n`,
            };
          },
        }),
      },
    }),
  );

  // The directory survives restarts: the last good roster and avatars are kept in kv
  // and served at once, while a refresh runs behind them. The thread map lives in kv
  // already and never depends on Grok Bot being reachable.
  const ROSTER_TTL_MS = 10 * 60_000;
  const AVATAR_TTL_MS = 30 * 60_000;
  let snapshot: z.infer<typeof snapshotSchema> | null = null;
  let avatarsAt = 0;
  let refreshInFlight: Promise<void> | null = null;
  let lastError: string | null = null;

  const loadSnapshot = async () => {
    if (snapshot) return snapshot;
    const parsed = snapshotSchema.safeParse(await bb.storage.kv.get(SNAPSHOT_KEY));
    if (parsed.success) snapshot = parsed.data;
    return snapshot;
  };

  const refreshDirectory = (withAvatars: boolean): Promise<void> => {
    refreshInFlight ??= (async () => {
      try {
        const agents = await liveRoster();
        const byAgent = await linkedThreads();
        for (const agent of agents) {
          if (!byAgent[agent.id]) await ensureBotThread(agent);
        }
        let avatars = snapshot?.avatars ?? {};
        if (withAvatars || Object.keys(avatars).length === 0) {
          const hostId = await primaryHostId();
          avatars = (await host.call("avatars", {}, { hostId })).avatars;
          avatarsAt = Date.now();
        }
        snapshot = { at: Date.now(), agents, avatars };
        lastError = null;
        await bb.storage.kv.set(SNAPSHOT_KEY, snapshot);
        bb.realtime.publish("directory-changed", { at: snapshot.at });
      } catch (error) {
        lastError = errorMessage(error);
      }
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  };

  const threadMap = async () => {
    const byAgent = await linkedThreads();
    return Object.fromEntries(
      Object.entries(byAgent).map(([agentId, threadId]) => [threadId, agentId]),
    );
  };

  const lastSync = new Map<string, number>();

  bb.rpc.register(rpcContract, {
    async directory(input) {
      const refresh = input?.refresh === true;
      const cached = await loadSnapshot();
      const stale = !cached || Date.now() - cached.at > ROSTER_TTL_MS;
      const avatarsStale = Date.now() - avatarsAt > AVATAR_TTL_MS;
      if (!cached || refresh) await refreshDirectory(refresh || avatarsStale);
      else if (stale || avatarsStale) void refreshDirectory(avatarsStale);
      return {
        projectId: await existingProjectId(),
        agents: snapshot?.agents ?? [],
        threads: await threadMap(),
        avatars: snapshot?.avatars ?? {},
        error: snapshot ? null : lastError,
      };
    },

    // Opening a bot thread wakes its mirror if nothing is following it (after a bb
    // restart): a hidden sync message makes bb resume the session, which catches up
    // on Grok and keeps following.
    async sync({ threadId }) {
      const threads = await threadMap();
      if (!threads[threadId]) return { woke: false };
      const hostId = await primaryHostId();
      const { threads: live } = await host.call("liveThreads", {}, { hostId });
      if (Date.now() - (live[threadId] ?? 0) < LIVE_WITHIN_MS) return { woke: false };
      if (Date.now() - (lastSync.get(threadId) ?? 0) < SYNC_DEBOUNCE_MS) return { woke: false };
      lastSync.set(threadId, Date.now());
      await bb.sdk.threads.send({
        threadId,
        input: [{ type: "text", text: SYNC_MARKER, mentions: [] }],
        mode: "queue-if-active",
      });
      return { woke: true };
    },
  });

  bb.providers.register({
    id: GROK_BOT_PROVIDER_ID,
    displayName: "Grok Bot",
    icon: "Bot",
    strings: {
      signInHint:
        "Put a Grok Bot token in ~/.config/bb-grok-bot/token (mode 600) and allowlist bots in config.json.",
      expiredHint:
        "The Grok Bot token was rejected. Replace ~/.config/bb-grok-bot/token.",
      installUrl: "https://github.com/shuv1337/bb-plugin-grok-bot#linux-setup",
    },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["medium"],
    },
    composerActions: [],
    completedTurnDisplay: "flat",
    models: { fallback: [], scope: "host" },
    deriveProviderOptions(context): GrokBotProviderOptions {
      const values = context.settings;
      const number = (value: unknown, fallback: number) =>
        typeof value === "number" && Number.isFinite(value) ? value : fallback;
      return {
        pollIntervalMs: Math.round(
          number(values.pollIntervalSeconds, DEFAULT_POLL_INTERVAL_MS / 1000) * 1000,
        ),
        startGraceMs: Math.round(
          number(values.startGraceSeconds, DEFAULT_START_GRACE_MS / 1000) * 1000,
        ),
        turnTimeoutMs: Math.round(
          number(values.turnTimeoutMinutes, DEFAULT_TURN_TIMEOUT_MS / 60_000) * 60_000,
        ),
      };
    },
  });
}
