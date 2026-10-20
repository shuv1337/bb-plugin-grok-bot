import { z } from "zod";

export const GROK_BOT_PROVIDER_ID = "grok-bot";
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_START_GRACE_MS = 45_000;
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
export const REGISTER_MARKER = "[grok-bot:register]";
export const SYNC_MARKER = "[grok-bot:sync]";

// The header marks bb's own messages so live mirroring does not echo them. Telling the
// bot how to run bb commands on this machine is opt-in (localAgentBridge).
export function identityHeader(name: string, threadId: string, localAgentBridge = false): string {
  const local = localAgentBridge
    ? ` Run bb thread commands as yourself after: eval "$(bb grok-bot env ${threadId})"`
    : "";
  return `[bb identity: you are ${name}; your BB thread is ${threadId}.${local}]`;
}

export const grokBotProviderOptionsSchema = z.object({
  pollIntervalMs: z.number().int().min(1_000).max(60_000).optional(),
  startGraceMs: z.number().int().min(5_000).max(10 * 60_000).optional(),
  turnTimeoutMs: z.number().int().min(60_000).max(4 * 60 * 60_000).optional(),
  identityHeader: z.boolean().optional(),
});

export type GrokBotProviderOptions = z.infer<typeof grokBotProviderOptionsSchema>;
