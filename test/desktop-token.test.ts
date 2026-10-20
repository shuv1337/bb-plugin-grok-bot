import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrokAuthError, loadCredentials, tokenSource } from "../src/auth.js";
import { DesktopTokenError, decryptSafeStorageValue, readDesktopToken } from "../src/desktop-token.js";
import { FAKE_BOT, writeConfig } from "./fake-backend.js";

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwt = (exp: number) => `${b64u({ alg: "none" })}.${b64u({ sub: "user|1", exp })}.c2ln`;
const LIVE = jwt(Math.floor(Date.now() / 1000) + 3600);
const v10 = (text: string) => {
  const key = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
  const c = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), c.update(text, "utf8"), c.final()]).toString("base64");
};
const plain = (text: string) => `plaintext:v1:${Buffer.from(text).toString("base64")}`;
const SCOPE_A = "a".repeat(64);
const SCOPE_B = "b".repeat(64);

let work: string;
let profile: string;
function writeStore(accounts: Record<string, unknown>, active: string | undefined, mode = 0o600) {
  const file = join(profile, "sand-secrets.json");
  rmSync(file, { force: true });
  writeFileSync(file, JSON.stringify({ "cursor-accounts": JSON.stringify({ active, accounts }) }), { mode });
  chmodSync(file, mode);
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "bb-grok-desktop-"));
  writeConfig(work, [FAKE_BOT]);
  profile = join(work, "xdg", "Grok Bot");
  mkdirSync(profile, { mode: 0o700 });
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("desktop-app token source", () => {
  it("decrypts v10 and plaintext:v1 values", () => {
    expect(decryptSafeStorageValue(v10("hello"))).toBe("hello");
    expect(decryptSafeStorageValue(plain("hi"))).toBe("hi");
    const v11 = Buffer.concat([Buffer.from("v11"), Buffer.alloc(16)]).toString("base64");
    expect(() => decryptSafeStorageValue(v11)).toThrow(/unsupported-v11/);
  });

  it("reads the active account's token and team, in memory only", () => {
    writeStore(
      {
        [SCOPE_A]: { "cursor-access-token": v10(jwt(Math.floor(Date.now() / 1000) + 3600) + "x") },
        [SCOPE_B]: { "cursor-access-token": v10(LIVE), "cursor-selected-team-id": v10("team_1") },
      },
      SCOPE_B,
    );
    const t = readDesktopToken();
    expect(t.accessToken).toBe(LIVE);
    expect(t.teamId).toBe("team_1");
    expect(JSON.stringify(t)).not.toContain(LIVE);
  });

  it("is opt-in: default stays the token file", () => {
    writeStore({ [SCOPE_A]: { "cursor-access-token": plain(LIVE) } }, SCOPE_A);
    expect(tokenSource()).toBe("token");
    expect(loadCredentials().accessToken).not.toBe(LIVE);
  });

  it("is selected by env or config, and env team id wins", () => {
    writeStore({ [SCOPE_A]: { "cursor-access-token": plain(LIVE), "cursor-selected-team-id": plain("t2") } }, undefined);
    process.env.GROK_BOT_TOKEN_SOURCE = "desktop-app";
    expect(loadCredentials().accessToken).toBe(LIVE);
    expect(loadCredentials().teamId).toBe("t2");
    process.env.GROK_BOT_TEAM_ID = "t9";
    expect(loadCredentials().teamId).toBe("t9");
    delete process.env.GROK_BOT_TOKEN_SOURCE;
    writeConfig(work, [FAKE_BOT], { tokenSource: "desktop-app" });
    expect(loadCredentials().accessToken).toBe(LIVE);
    process.env.GROK_BOT_TOKEN_SOURCE = "bogus";
    expect(() => loadCredentials()).toThrow(GrokAuthError);
  });

  it("fails closed without leaking the token", () => {
    process.env.GROK_BOT_TOKEN_SOURCE = "desktop-app";
    const cases: Array<() => void> = [
      () => writeStore({ [SCOPE_A]: { "cursor-access-token": plain(LIVE) } }, SCOPE_A, 0o644),
      () => writeStore({ [SCOPE_A]: { "cursor-access-token": plain(jwt(1)) } }, SCOPE_A),
      () => writeStore({ [SCOPE_A]: { "cursor-access-token": plain(LIVE) }, [SCOPE_B]: { "cursor-access-token": plain(LIVE) } }, undefined),
      () => writeStore({ [SCOPE_A]: { "cursor-access-token": plain(LIVE + " ") } }, SCOPE_A),
      () => writeStore({ [SCOPE_A]: { "cursor-access-token": plain(LIVE), "cursor-selected-team-id": plain("bad team") } }, SCOPE_A),
      () => {
        rmSync(join(profile, "sand-secrets.json"), { force: true });
        writeFileSync(join(work, "real.json"), "{}", { mode: 0o600 });
        symlinkSync(join(work, "real.json"), join(profile, "sand-secrets.json"));
      },
      () => rmSync(join(profile, "sand-secrets.json"), { force: true }),
    ];
    for (const setup of cases) {
      setup();
      let err: unknown;
      try {
        loadCredentials();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(GrokAuthError);
      expect(String((err as Error).message)).not.toContain(LIVE.split(".")[1]);
    }
    expect(() => readDesktopToken()).toThrow(DesktopTokenError);
  });
});
