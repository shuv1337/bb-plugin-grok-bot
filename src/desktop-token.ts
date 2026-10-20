// Opt-in token source: the signed-in Grok Bot desktop app's own access token, read
// the way botdeck reads it (server/desktop-credentials.mjs + desktop-crypto.mjs).
// Read-only and in memory only: the store is never written, the refresh token is
// never touched, and the decrypted token is never persisted, logged or put in errors.
//
// Store: $XDG_CONFIG_HOME/Grok Bot/sand-secrets.json (mode 600, owned by us).
// store["cursor-accounts"] is JSON { active, accounts: { <64-hex scope>: record } }.
// record["cursor-access-token"] is an Electron safeStorage value: "plaintext:v1:<b64>"
// or base64("v10" + AES-128-CBC ciphertext) with Chromium's fixed Linux v10 key.
// v11 (keyring) is unsupported on purpose.
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

type Env = Record<string, string | undefined>;

export class DesktopTokenError extends Error {
  constructor(readonly reason: string) {
    super(`Grok Bot desktop app token unavailable (${reason})`);
    this.name = "DesktopTokenError";
  }
}

const V10 = Buffer.from("v10", "latin1");
const V11 = Buffer.from("v11", "latin1");
const IV = Buffer.alloc(16, 0x20);
let v10Key: Buffer | null = null;
const PLAINTEXT_PREFIX = "plaintext:v1:";
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const SCOPE = /^[0-9a-f]{64}$/;
const TEAM = /^[A-Za-z0-9_-]{1,64}$/;

export function desktopProfileDir(env: Env = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"), "Grok Bot");
}

export function decryptSafeStorageValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new DesktopTokenError("absent");
  if (value.startsWith(PLAINTEXT_PREFIX)) {
    return Buffer.from(value.slice(PLAINTEXT_PREFIX.length), "base64").toString("utf8");
  }
  const raw = Buffer.from(value, "base64");
  if (raw.length > MAX_CIPHERTEXT_BYTES) throw new DesktopTokenError("too-large");
  if (raw.length >= 3 && raw.subarray(0, 3).equals(V11)) throw new DesktopTokenError("unsupported-v11-keyring");
  if (raw.length < 3 || !raw.subarray(0, 3).equals(V10)) throw new DesktopTokenError("unknown-format");
  const body = raw.subarray(3);
  if (body.length === 0 || body.length % 16 !== 0) throw new DesktopTokenError("bad-length");
  v10Key ??= pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
  try {
    const d = createDecipheriv("aes-128-cbc", v10Key, IV);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    throw new DesktopTokenError("bad-padding");
  }
}

const plainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function readStore(dir: string): Record<string, unknown> {
  let fd: number;
  try {
    fd = openSync(join(dir, "sand-secrets.json"), constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new DesktopTokenError(code === "ENOENT" ? "desktop app not signed in on this machine" : `cannot open store (${code ?? "error"})`);
  }
  try {
    const st = fstatSync(fd);
    const me = typeof process.getuid === "function" ? process.getuid() : null;
    if (!st.isFile() || (me !== null && st.uid !== me) || (st.mode & 0o077) !== 0) throw new DesktopTokenError("unsafe-store");
    if (st.size > MAX_STORE_BYTES) throw new DesktopTokenError("store-too-large");
    let accounts: unknown;
    try {
      const store = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown>;
      accounts = JSON.parse(String(store["cursor-accounts"]));
    } catch {
      throw new DesktopTokenError("invalid-store");
    }
    if (!plainObject(accounts) || !plainObject(accounts.accounts)) throw new DesktopTokenError("invalid-store");
    return accounts;
  } finally {
    closeSync(fd);
  }
}

export interface DesktopToken {
  readonly accessToken: string;
  readonly teamId: string | null;
  readonly expiresAt: number;
}

/**
 * Returns the active desktop account's access token (or the only account's, when no
 * account is marked active). Throws DesktopTokenError with a token-free reason.
 */
export function readDesktopToken(env: Env = process.env, now: number = Date.now()): DesktopToken {
  const store = readStore(desktopProfileDir(env));
  const accounts = store.accounts as Record<string, unknown>;
  const scopes = Object.keys(accounts).filter((k) => SCOPE.test(k) && plainObject(accounts[k]));
  const active = typeof store.active === "string" && scopes.includes(store.active) ? store.active : null;
  const scope = active ?? (scopes.length === 1 ? scopes[0] : null);
  if (!scope) throw new DesktopTokenError(scopes.length ? "no active account" : "no signed-in account");
  const record = accounts[scope] as Record<string, unknown>;
  const token = decryptSafeStorageValue(record["cursor-access-token"]);
  if (/\s/.test(token) || token.length > 32_768) throw new DesktopTokenError("invalid-token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new DesktopTokenError("invalid-token");
  let exp: unknown;
  try {
    exp = (JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: unknown }).exp;
  } catch {
    throw new DesktopTokenError("invalid-token");
  }
  if (typeof exp !== "number" || !Number.isFinite(exp)) throw new DesktopTokenError("invalid-token");
  if (exp * 1000 <= now + 30_000) throw new DesktopTokenError("token expired; open the desktop app to refresh it");
  let teamId: string | null = null;
  if (record["cursor-selected-team-id"]) {
    const t = decryptSafeStorageValue(record["cursor-selected-team-id"]);
    if (t && !TEAM.test(t)) throw new DesktopTokenError("invalid-team");
    teamId = t || null;
  }
  const out = { teamId, expiresAt: exp * 1000 } as DesktopToken;
  Object.defineProperty(out, "accessToken", { value: token, enumerable: false });
  return Object.freeze(out);
}
