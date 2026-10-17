import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const agentStatusSchema = z.object({
  running: z.boolean(),
  runningTurn: z.boolean(),
  awaitingUserResponse: z.boolean(),
  newestEntryId: z.string().nullable(),
  lastMessagePreview: z.string().nullable().optional(),
  lastActivityAt: z.number().nullable().optional(),
  unreadCount: z.number().optional(),
});

export const rosterAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["bot", "group"]),
  description: z.string().nullable(),
  members: z.array(z.string()),
  avatarShape: z.string().nullable(),
  avatarColor: z.string().nullable(),
  status: agentStatusSchema.nullable(),
});

export type RosterAgent = z.infer<typeof rosterAgentSchema>;

const gbotInput = z.object({ gbotPath: z.string().optional() }).strict();

export const hostContract = defineRpcContract({
  roster: {
    input: gbotInput,
    output: z.object({ agents: z.array(rosterAgentSchema) }).strict(),
  },
  avatars: {
    input: gbotInput,
    output: z
      .object({ avatars: z.record(z.string(), z.string()) })
      .strict(),
  },
  liveThreads: {
    input: z.object({}).strict(),
    output: z.object({ threads: z.record(z.string(), z.number()) }).strict(),
  },
  retireThread: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({}).strict(),
  },
  workspace: {
    input: z.object({}).strict(),
    output: z.object({ path: z.string() }).strict(),
  },
});
