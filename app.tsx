import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  definePluginApp,
  useBbContext,
  useRealtime,
  useRpc,
  type PluginMessageDirectiveProps,
  type PluginRpcClient,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { RosterAgent } from "./contract";
import type { rpcContract } from "./server";
import { SKIN_CSS } from "./skin";

const REFRESH_MS = 10 * 60_000;
const REGISTER_MARKER = "[grok-bot:register]";
const SYNC_MARKER = "[grok-bot:sync]";
const RETRY_MS = 5_000;
const REGISTERED_RE = /^Registered as .+ persistent BB thread\./;

const AVATAR_COLORS: Record<string, string> = {
  red: "oklch(0.64 0.2 25)",
  orange: "oklch(0.72 0.17 55)",
  yellow: "oklch(0.82 0.15 90)",
  green: "oklch(0.68 0.15 150)",
  cyan: "oklch(0.74 0.12 210)",
  blue: "oklch(0.62 0.17 255)",
  purple: "oklch(0.6 0.18 300)",
  pink: "oklch(0.7 0.17 350)",
  black: "oklch(0.3 0.02 260)",
  gray: "oklch(0.6 0.02 260)",
};

interface Directory {
  projectId: string | null;
  agents: Map<string, RosterAgent>;
  threads: Record<string, string>;
  avatars: Record<string, string>;
}

let directory: Directory = { projectId: null, agents: new Map(), threads: {}, avatars: {} };
let loadedAt = 0;
let loading = false;
const listeners = new Set<() => void>();

let retryTimer = 0;

// "ttl" reuses a fresh directory, "reload" re-reads the server's copy (it already
// refreshed and told us so), "refresh" makes the server ask Grok again.
function load(rpc: PluginRpcClient<typeof rpcContract>, mode: "ttl" | "reload" | "refresh" = "ttl") {
  if (loading || (mode === "ttl" && Date.now() - loadedAt < REFRESH_MS)) return;
  loading = true;
  const retry = () => {
    loadedAt = 0;
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => load(rpc), RETRY_MS);
  };
  rpc.call("directory", mode === "refresh" ? { refresh: true } : null).then(
    (result) => {
      loading = false;
      loadedAt = Date.now();
      if (result.agents.length > 0 || Object.keys(result.threads).length > 0) {
        directory = {
          projectId: result.projectId,
          agents: new Map(result.agents.map((agent) => [agent.id, agent])),
          threads: result.threads,
          avatars: result.avatars,
        };
        listeners.forEach((listener) => listener());
      }
      if (result.error !== null || result.agents.length === 0) retry();
    },
    () => {
      loading = false;
      retry();
    },
  );
}

function useDirectory(): Directory {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => load(rpc), [rpc]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => directory,
  );
}

function groupMembers(agent: RosterAgent, dir: Directory): RosterAgent[] {
  return agent.members
    .map((id) => dir.agents.get(id))
    .filter((member): member is RosterAgent => member !== undefined);
}

function cssString(value: string): string {
  return `"${value.replace(/["\\\n\r]/g, "")}"`;
}

// Faces are plain CSS keyed on ids bb renders itself, so nothing is re-tagged as rows
// mount (see skin.ts for why that matters). Each avatar is declared once as a variable.
function faceCss(dir: Directory): string {
  const rules: string[] = [];
  const vars: string[] = [];
  const face = (id: string) => (dir.avatars[id] ? `var(--gb-face-${cssIdent(id)})` : null);
  for (const [id, url] of Object.entries(dir.avatars)) {
    vars.push(`--gb-face-${cssIdent(id)}:url(${cssString(url)})`);
  }
  if (vars.length > 0) rules.push(`:root{${vars.join(";")}}`);

  const sidebarFace = (agent: RosterAgent) => {
    const color = AVATAR_COLORS[agent.avatarColor ?? ""] ?? AVATAR_COLORS.gray;
    if (agent.kind === "group") {
      const members = groupMembers(agent, dir).filter((member) => dir.avatars[member.id]).slice(0, 3);
      if (members.length > 0) {
        return `content:"";width:${16 + (members.length - 1) * 8}px;border-radius:0;background:${members.map((member) => face(member.id)).join(",")};background-size:16px 16px;background-repeat:no-repeat;background-position:${members.map((_, index) => `${index * 8}px 0`).join(",")}`;
      }
    }
    const own = face(agent.id);
    return own
      ? `content:"";background:${own} center/cover no-repeat`
      : `content:${cssString(agent.name.slice(0, 1).toUpperCase())};background:${color}`;
  };

  for (const [threadId, agentId] of Object.entries(dir.threads)) {
    const agent = dir.agents.get(agentId);
    if (!agent) continue;
    const row = `:has(> [data-sidebar-thread-id=${cssString(threadId)}]) .bb-thread-title`;
    rules.push(`${row}{display:inline-flex;align-items:center;min-width:0}`, `${row}::before{${sidebarFace(agent)}}`);
  }

  for (const agent of dir.agents.values()) {
    const color = AVATAR_COLORS[agent.avatarColor ?? ""] ?? AVATAR_COLORS.gray;
    rules.push(
      `html[data-gb-group] [data-markdown-preview]:has(> :first-child [data-gb-author=${cssString(agent.id)}]){--gb-color:${color}}`,
    );
  }

  if (dir.projectId) {
    const bots = [...dir.agents.values()]
      .filter((agent) => agent.kind === "bot" && dir.avatars[agent.id])
      .slice(0, 5);
    if (bots.length > 0) {
      rules.push(
        `[data-sidebar-project-id=${cssString(dir.projectId)}] [data-sidebar="group-label"] span[title]::before{content:"";display:inline-block;vertical-align:-3px;margin-right:6px;height:16px;width:${16 + (bots.length - 1) * 9}px;background:${bots.map((bot) => face(bot.id)).join(",")};background-size:16px 16px;background-repeat:no-repeat;background-position:${bots.map((_, index) => `${index * 9}px 0`).join(",")}}`,
      );
    }
  }
  return rules.join("\n");
}

function cssIdent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// The one thing CSS can't see at mount: register/sync plumbing messages, identified by
// their text. Only those rows are touched, and only once each.
function hideMarkers(list: Element) {
  for (const row of list.querySelectorAll<HTMLElement>("[data-timeline-row-id]:not([data-gb-seen])")) {
    row.setAttribute("data-gb-seen", "");
    const id = row.getAttribute("data-timeline-row-id") ?? "";
    const text = row.querySelector("[data-markdown-preview]")?.textContent?.trim() ?? "";
    const marker =
      (id.includes(":user") && (text.startsWith(REGISTER_MARKER) || text.startsWith(SYNC_MARKER))) ||
      (id.includes(":assistant:") && REGISTERED_RE.test(text));
    if (marker) row.setAttribute("data-gb-hide", "");
  }
}

function GrokSkin() {
  const rpc = useRpc<typeof rpcContract>();
  const dir = useDirectory();
  const { threadId } = useBbContext();
  useRealtime("directory-changed", () => load(rpc, "reload"));
  useEffect(() => {
    const timer = window.setInterval(() => load(rpc), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [rpc]);

  const css = useMemo(() => faceCss(dir), [dir]);
  useEffect(() => {
    const style = document.createElement("style");
    style.dataset.plugin = "grok-bot-faces";
    style.textContent = css;
    document.head.appendChild(style);
    return () => style.remove();
  }, [css]);

  const agentId = threadId ? dir.threads[threadId] : undefined;
  const agent = agentId ? dir.agents.get(agentId) : undefined;
  const kind = agent?.kind ?? null;

  useEffect(() => {
    if (threadId && agentId) void rpc.call("sync", { threadId }).catch(() => undefined);
  }, [rpc, threadId, agentId]);

  useEffect(() => {
    const root = document.documentElement;
    if (kind === null) return;
    root.setAttribute("data-gb-thread", "");
    if (kind === "group") root.setAttribute("data-gb-group", "");
    else root.removeAttribute("data-gb-group");
    let observed: Element | null = null;
    const listObserver = new MutationObserver(() => observed && hideMarkers(observed));
    const attach = () => {
      const list = document.querySelector('[data-timeline-row-list="top-level"]');
      if (!list || list === observed) return;
      observed = list;
      listObserver.disconnect();
      listObserver.observe(list, { childList: true });
      hideMarkers(list);
    };
    attach();
    // Only to find the list after navigation; it stops once found.
    const finder = window.setInterval(attach, 500);
    return () => {
      window.clearInterval(finder);
      listObserver.disconnect();
      root.removeAttribute("data-gb-thread");
      root.removeAttribute("data-gb-group");
    };
  }, [kind, threadId]);

  return null;
}

function Avatar({ agent, dir, size }: { agent: RosterAgent; dir: Directory; size: number }) {
  const src = dir.avatars[agent.id];
  if (src) {
    return <img src={src} alt="" style={{ width: size, height: size, borderRadius: 9999, flexShrink: 0 }} />;
  }
  if (agent.kind === "group") {
    return (
      <span style={{ display: "inline-flex", flexShrink: 0 }}>
        {groupMembers(agent, dir)
          .slice(0, 3)
          .map((member, index) => (
            <span
              key={member.id}
              style={{ marginLeft: index === 0 ? 0 : -Math.round(size * 0.35), display: "inline-flex" }}
            >
              <Avatar agent={member} dir={dir} size={size} />
            </span>
          ))}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 9999,
        background: AVATAR_COLORS[agent.avatarColor ?? ""] ?? AVATAR_COLORS.gray,
        color: "white",
        fontSize: Math.round(size * 0.55),
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {agent.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function AuthorDirective({ attributes }: PluginMessageDirectiveProps) {
  const dir = useDirectory();
  const agentId = attributes.agent ?? "";
  const known = dir.agents.get(agentId);
  const name = known?.name ?? attributes.name ?? "Grok Bot";
  const agent: RosterAgent = known ?? {
    id: agentId,
    name,
    kind: "bot",
    description: null,
    members: [],
    avatarShape: null,
    avatarColor: null,
    status: null,
  };
  return (
    <span
      data-gb-author={agentId}
      data-gb-author-name={name}
      className="not-prose flex items-center gap-2"
      style={{ marginTop: 6 }}
    >
      <span data-gb-face style={{ display: "inline-flex", width: 34, height: 34 }}>
        <Avatar agent={agent} dir={dir} size={34} />
      </span>
      <span data-gb-name className="text-sm font-semibold">
        {name}
      </span>
    </span>
  );
}

function ThreadIdentity({ threadId }: PluginThreadHeaderActionProps) {
  const dir = useDirectory();
  const agentId = dir.threads[threadId];
  const agent = agentId ? dir.agents.get(agentId) : undefined;
  if (!agent) return null;
  if (agent.kind === "group") {
    const members = groupMembers(agent, dir);
    return (
      <span
        className="flex items-center gap-1.5 text-xs"
        title={members.map((member) => member.name).join(", ")}
        aria-label={`${agent.name} group chat: ${members.map((member) => member.name).join(", ")}`}
      >
        <Avatar agent={agent} dir={dir} size={22} />
        <span className="font-medium text-muted-foreground">{members.length} bots</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs" title={agent.description ?? agent.name}>
      <Avatar agent={agent} dir={dir} size={24} />
      <span className="font-medium">{agent.name}</span>
    </span>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "grok-skin",
    mount() {
      const style = document.createElement("style");
      style.dataset.plugin = "grok-bot-skin";
      style.textContent = SKIN_CSS;
      document.head.appendChild(style);
      return () => style.remove();
    },
  });
  app.slots.experimental_appOverlay({ id: "grok-skin", component: GrokSkin });
  app.slots.messageDirective({ id: "grok-bot-author", component: AuthorDirective });
  app.slots.experimental_threadHeaderAction({
    id: "identity",
    title: "Grok Bot",
    component: ThreadIdentity,
  });
});
