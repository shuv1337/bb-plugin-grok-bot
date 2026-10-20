import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type RosterAgent } from "./contract.js";
import { listAgents, resolveApi } from "./src/grok-api.js";

export { experimental_providerBridge } from "./src/provider-bridge.js";

function bridgeDataDir(hostDataDir: string): string {
  return join(hostDataDir, "..", "bridge-data");
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    // Only allowlisted bots ever leave this function (see src/grok-api.ts).
    roster: async () => {
      const agents = await listAgents(resolveApi());
      return {
        agents: agents.map(
          (agent): RosterAgent => ({
            id: agent.id,
            name: agent.name,
            kind: agent.kind,
            description: agent.description?.trim() || null,
            members: agent.members ?? [],
            avatarShape: agent.avatarShape ?? null,
            avatarColor: agent.avatarColor ?? null,
            status: agent.status ?? null,
          }),
        ),
      };
    },
    // The direct client does not fetch avatar blobs.
    avatars: async () => ({ avatars: {} }),
    // The provider bridge keeps per-thread state in its own data dir, a sibling of this
    // one (see src/provider-bridge.ts): live/<threadId>.json is the following worker's
    // heartbeat, retired/<threadId> stops a replaced mirror.
    liveThreads: async (_input, context) => {
      const dir = join(bridgeDataDir(context.experimental_paths.dataDir), "live");
      const threads: Record<string, number> = {};
      for (const name of existsSync(dir) ? readdirSync(dir) : []) {
        if (!name.endsWith(".json")) continue;
        try {
          const raw: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
          const at = raw && typeof raw === "object" && "at" in raw ? raw.at : null;
          if (typeof at === "number") threads[name.slice(0, -".json".length)] = at;
        } catch {
          continue;
        }
      }
      return { threads };
    },
    retireThread: async ({ threadId }, context) => {
      const dir = join(bridgeDataDir(context.experimental_paths.dataDir), "retired");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, threadId.replace(/[^\w.-]/g, "_")), "");
      return {};
    },
    workspace: async (_input, context) => {
      const path = join(context.experimental_paths.dataDir, "workspace");
      mkdirSync(path, { recursive: true });
      return { path };
    },
  },
});
