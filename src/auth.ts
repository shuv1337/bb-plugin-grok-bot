// Credentials and access policy for the Grok Bot backend.
//
// The token comes from GROK_BOT_ACCESS_TOKEN or from a private file
// ($XDG_CONFIG_HOME/bb-grok-bot/token, mode 0600 in a 0700 directory you own).
// It is never read from the Grok Bot desktop app's storage, the Keychain, or a
// cookie jar, and it never appears in logs, errors or a child process's argv.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const DEFAULT_BASE_URL = "https://api2.cursor.sh";
/** Hosts a token may be sent to. Exact match; no suffixes, no ports, https only. */
export const ALLOWED_API_HOSTS: ReadonlySet<string> = new Set(["api2.cursor.sh"]);

const TOKEN_PATTERN = /^[\x21-\x7e]{8,8192}$/;
const TEAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_FILE_BYTES = 16 * 1024;

export class GrokAuthError extends Error {
  constructor(
    message: string,
    readonly code: "not-configured" | "insecure" | "invalid",
  ) {
    super(message);
    this.name = "GrokAuthError";
  }
}

export interface Credentials {
  readonly baseUrl: string;
  readonly teamId: string | null;
  /** Kept off enumerable properties so JSON.stringify/inspect never print it. */
  readonly accessToken: string;
}

export interface AccessPolicy {
  /** Lowercased bot ids and names. Empty means nothing is allowed. */
  readonly allowedBots: readonly string[];
  readonly localAgentBridge: boolean;
}

type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config");
  return join(base, "bb-grok-bot");
}

export function tokenFilePath(env: Env = process.env): string {
  return join(configDir(env), "token");
}

export function configFilePath(env: Env = process.env): string {
  return join(configDir(env), "config.json");
}

function uid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** The directory must be a real directory owned by us and closed to group and others. */
function assertPrivateDir(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new GrokAuthError(`${dir} does not exist`, "not-configured");
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new GrokAuthError(`${dir} must be a real directory, not a symlink`, "insecure");
  }
  const me = uid();
  if (me !== null && st.uid !== me) throw new GrokAuthError(`${dir} is not owned by you`, "insecure");
  if ((st.mode & 0o077) !== 0) {
    throw new GrokAuthError(`${dir} is accessible to other users; run: chmod 700 ${dir}`, "insecure");
  }
}

/**
 * Reads a private file without following symlinks, checking ownership and mode on the
 * opened descriptor itself so a swap between check and read cannot slip through.
 */
export function readPrivateFile(path: string, { secret }: { secret: boolean }): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new GrokAuthError(`${path} is a symlink; refusing to read it`, "insecure");
    throw new GrokAuthError(`cannot open ${path} (${code ?? "error"})`, "insecure");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new GrokAuthError(`${path} is not a regular file`, "insecure");
    const me = uid();
    if (me !== null && st.uid !== me) throw new GrokAuthError(`${path} is not owned by you`, "insecure");
    const forbidden = secret ? 0o077 : 0o022;
    if ((st.mode & forbidden) !== 0) {
      const mode = (st.mode & 0o777).toString(8).padStart(3, "0");
      throw new GrokAuthError(
        `${path} has mode ${mode}; ${secret ? "run: chmod 600" : "run: chmod 644 or 600"} ${path}`,
        "insecure",
      );
    }
    if (st.size > MAX_FILE_BYTES) throw new GrokAuthError(`${path} is too large`, "invalid");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Accepts only a bare https origin on an allowlisted host. */
export function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GrokAuthError("GROK_BOT_API_BASE_URL is not a valid URL", "invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new GrokAuthError("GROK_BOT_API_BASE_URL must be a bare https origin", "invalid");
  }
  if (!ALLOWED_API_HOSTS.has(url.hostname.toLowerCase())) {
    throw new GrokAuthError(
      `GROK_BOT_API_BASE_URL host "${url.hostname}" is not an allowed Grok Bot API host`,
      "invalid",
    );
  }
  return url.origin;
}

export function loadCredentials(env: Env = process.env): Credentials {
  const baseUrl = parseBaseUrl(env.GROK_BOT_API_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const teamRaw = env.GROK_BOT_TEAM_ID?.trim() || null;
  if (teamRaw !== null && !TEAM_ID_PATTERN.test(teamRaw)) {
    throw new GrokAuthError("GROK_BOT_TEAM_ID is malformed", "invalid");
  }
  let token = env.GROK_BOT_ACCESS_TOKEN?.trim() || null;
  if (token === null) {
    const dir = configDir(env);
    const path = tokenFilePath(env);
    assertPrivateDir(dir);
    const raw = readPrivateFile(path, { secret: true });
    if (raw === null) {
      throw new GrokAuthError(
        `No Grok Bot token. Put it in ${path} (mode 600) or set GROK_BOT_ACCESS_TOKEN.`,
        "not-configured",
      );
    }
    token = raw.trim();
  }
  if (!TOKEN_PATTERN.test(token)) throw new GrokAuthError("Grok Bot token is malformed", "invalid");
  const credentials = { baseUrl, teamId: teamRaw } as Credentials;
  Object.defineProperty(credentials, "accessToken", { value: token, enumerable: false });
  return Object.freeze(credentials);
}

function parseList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [
    ...new Set(
      items
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0 && item.length <= 200),
    ),
  ];
}

/**
 * Bot allowlist and opt-ins. GROK_BOT_ALLOWED_BOTS (comma-separated) overrides the
 * config file's `allowedBots`. An empty list allows nothing.
 */
export function loadPolicy(env: Env = process.env): AccessPolicy {
  let file: Record<string, unknown> = {};
  const dir = configDir(env);
  let raw: string | null = null;
  let dirExists = true;
  try {
    lstatSync(dir);
  } catch {
    dirExists = false;
  }
  if (dirExists) {
    assertPrivateDir(dir);
    raw = readPrivateFile(configFilePath(env), { secret: false });
  }
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed as Record<string, unknown>;
      else throw new Error();
    } catch {
      throw new GrokAuthError(`${configFilePath(env)} is not a JSON object`, "invalid");
    }
  }
  const fromEnv = env.GROK_BOT_ALLOWED_BOTS;
  return Object.freeze({
    allowedBots: Object.freeze(parseList(fromEnv !== undefined ? fromEnv : file.allowedBots)),
    localAgentBridge: file.localAgentBridge === true,
  });
}
