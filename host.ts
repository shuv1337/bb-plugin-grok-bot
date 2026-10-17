import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type RosterAgent } from "./contract.js";
import { listAgents, resolveGbot, writeAvatars } from "./src/gbot.js";

export { experimental_providerBridge } from "./src/provider-bridge.js";

const THUMBNAIL_SIZE = 128;

function thumbnail(source: string, target: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "magick",
      [
        source,
        "-resize", `${THUMBNAIL_SIZE}x${THUMBNAIL_SIZE}^`,
        "-gravity", "center",
        "-extent", `${THUMBNAIL_SIZE}x${THUMBNAIL_SIZE}`,
        "-alpha", "set",
        "(", "+clone", "-alpha", "transparent", "-fill", "white",
        "-draw", `circle ${THUMBNAIL_SIZE / 2 - 0.5},${THUMBNAIL_SIZE / 2 - 0.5} ${THUMBNAIL_SIZE / 2 - 0.5},0`, ")",
        "-compose", "DstIn", "-composite",
        "-define", "webp:alpha-quality=100",
        "-quality", "82",
        target,
      ],
      { timeout: 20_000 },
      (error) => resolve(error === null && existsSync(target)),
    );
  });
}

function bridgeDataDir(hostDataDir: string): string {
  return join(hostDataDir, "..", "bridge-data");
}

function dataUrl(path: string, mimeType: string): string {
  return `data:${mimeType};base64,${readFileSync(path).toString("base64")}`;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    roster: async ({ gbotPath }) => {
      const gbot = resolveGbot(gbotPath);
      const agents = await listAgents(gbot);
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
    avatars: async ({ gbotPath }, context) => {
      const gbot = resolveGbot(gbotPath);
      const root = context.experimental_paths.dataDir;
      const rawDir = join(context.experimental_paths.tempDir, "avatars-raw");
      const thumbDir = join(root, "avatar-thumbs");
      mkdirSync(thumbDir, { recursive: true });
      const files = await writeAvatars(gbot, rawDir);
      const avatars: Record<string, string> = {};
      for (const file of files) {
        const digest = createHash("sha1")
          .update(readFileSync(file.file))
          .digest("hex")
          .slice(0, 16);
        const thumb = join(thumbDir, `${file.id}-${digest}-circle.webp`);
        if (existsSync(thumb) || (await thumbnail(file.file, thumb))) {
          avatars[file.id] = dataUrl(thumb, "image/webp");
        } else if (file.bytes <= 2 * 1024 * 1024) {
          avatars[file.id] = dataUrl(file.file, file.mimeType);
        }
      }
      return { avatars };
    },
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
