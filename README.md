# bb-plugin-grok-bot

A BB agent provider for [Grok Bot](https://x.ai/bot). Each BB thread talks to
one **allowlisted** Grok Bot bot or group, calling the Grok Bot backend directly
over HTTPS (Connect-JSON, the same approach botdeck uses).

This fork (`linux-auth`) removes the dependency on a patched `gbot`, the macOS
Keychain and the desktop app's local storage. It works on Linux.

## Linux setup

Requirements: Node.js 22+, npm, and BB.

```sh
git clone https://github.com/shuv1337/bb-plugin-grok-bot
cd bb-plugin-grok-bot
npm ci
npm test
bb plugin install . --yes
```

### Token

The plugin never reads the Grok Bot desktop app's storage, a keyring or cookies,
and it never logs the token or passes it to another process. You supply a Grok Bot
account access token in one of two ways:

1. **File (preferred).** `$XDG_CONFIG_HOME/bb-grok-bot/token` (default
   `~/.config/bb-grok-bot/token`):

   ```sh
   install -d -m 700 ~/.config/bb-grok-bot
   ( umask 077; cat > ~/.config/bb-grok-bot/token )   # paste, then Ctrl-D
   ```

   The plugin refuses to run if the directory is not `0700` and owned by you, if the
   file is a symlink or not owned by you, or if the file is readable by anyone but you.
2. **Environment.** `GROK_BOT_ACCESS_TOKEN`. Other processes running as you can read
   it, so prefer the file.

Optional: `GROK_BOT_TEAM_ID` (team-scoped bots).

The token is sent only to `https://api2.cursor.sh`. `GROK_BOT_API_BASE_URL` can't
point anywhere else: any host outside the built-in allowlist, a non-https URL, a
port, a path or userinfo is rejected, and redirects aren't followed.

### Bot allowlist (required)

Nothing is listed, mirrored or messaged until you allowlist it.
`~/.config/bb-grok-bot/config.json` (not group or world writable):

```json
{ "allowedBots": ["11111111-2222-4333-8444-555555555555"] }
```

- Entries are bot ids (preferred) or exact names. A name only matches a bot you own
  whose name is unique on the account. Groups must be listed by id, and a group's
  transcript includes its members' messages.
- `GROK_BOT_ALLOWED_BOTS=id1,id2` overrides the file.
- An empty or missing list fails closed.

### Local agent bridge (opt-in)

By default the bot isn't told how to run `bb` commands on your machine. To enable
it, set `"localAgentBridge": true` in `config.json` and install the skill in
`optional-grok-skills/bb-thread-identity` on the bot yourself. That lets the bot
spawn and message BB threads, and so run local agents, on this machine.

## What you get

- **A Grok Bots project** with one persistent thread per allowlisted bot and group.
- **Threads that mirror Grok.** Recent history on creation, then everything live.
- `bb grok-bot list`, `bb grok-bot env <bot>`, `bb grok-bot tell <to> --as <bot>`,
  and `bb grok-bot remirror <bot|all>`, all limited to allowlisted bots.

Avatars aren't fetched by this fork.

## Test

```sh
npm ci && npm test && npm run typecheck
```

Tests run against an in-process fake backend (`test/fake-backend.ts`) and never
touch the network or your real bots.

## Uninstall

```sh
bb plugin list                    # confirm the plugin name
bb plugin uninstall grok-bot
rm -rf ~/.config/bb-grok-bot      # token and allowlist
```

Then archive or delete the **Grok Bots** project in BB. It holds mirrored
transcripts. Removing the plugin does not revoke the token: sign out of that
Grok Bot session, or revoke it from your account, to invalidate it. If you
installed the bb-thread-identity skill on a bot, remove it in the Grok Bot app.
