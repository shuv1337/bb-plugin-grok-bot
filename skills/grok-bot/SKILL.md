---
name: grok-bot
description: Use the Grok Bot BB provider, which talks to the user's Grok Bot bots and groups through grok-bot-cli (gbot). Use when a thread runs on the Grok Bot provider, or when setting it up, picking a bot, or diagnosing missing replies.
---

# Grok Bot provider

The `grok-bot` provider turns a BB thread into a conversation with one of the
user's Grok Bot bots or groups. It drives the `gbot` CLI (grok-bot-cli), which
reads the signed-in Grok Bot desktop app's session.

## How it works

- The model picker lists every bot and group (`gbot bots list`, `gbot groups list`).
  The selected "model" is the bot. Groups show as `Name (group)`.
- A turn sends the message with `gbot send <botId> -- <text>`, then polls the
  bot status and `gbot thread <botId> --after <cursor>` until the bot stops
  running. Each bot message becomes one BB message. Group messages are
  prefixed with the bot's name. Attachments show as a filename only; open them
  in the Grok Bot app.
- A BB thread shares the bot's single Grok Bot conversation. Messages sent
  from the Grok Bot app or another BB thread on the same bot are part of that
  same conversation.
- Grok Bots can keep working after a turn ends. Anything they send later is
  shown at the start of the next turn.
- Steering is not supported; send a new message after the turn ends. Stopping
  a turn stops BB waiting, not the bot itself.

## Grok Bots as BB threads

Each Grok Bot has one persistent BB thread in the **Grok Bots** project. That
thread is the bot's identity in BB.

- Find bots and their threads: `bb grok-bot list` (`--json` for ids).
- Message a bot, report finished work, or ask it something: `bb thread tell <bot-thread-id> "…"`.
  The bot receives it with BB's `[bb message from thread:<your-thread>]` prefix,
  so it knows who to answer. Do not use `gbot send` to reach a bot from BB.
- When a bot spawns you as a worker, your parent thread is the bot's thread, so
  BB's normal completion notices reach the bot.
- A bot acts as its own thread on this machine with
  `eval "$(bb grok-bot env <bot-or-thread>)"`, which exports `BB_THREAD_ID` and
  `BB_PROJECT_ID`. After that, `bb thread tell`, `bb thread spawn --parent-self`,
  and the rest of `bb thread` run as the bot's thread, not as the user.
- `bb grok-bot tell <bot-or-thread> --as <bot> "…"` (or `--message-stdin`) sends
  as a bot by name without changing the environment.
- `bb grok-bot env <bot>` creates the bot's thread if it has none. Creating it
  never messages the bot.

## Requirements

- `gbot` on PATH, or the `gbotPath` setting pointing at it.
- The Grok Bot desktop app running and signed in. gbot needs its
  `gateway-descriptor.json` session file.

## Settings

```
bb plugin config grok-bot set gbotPath /absolute/path/to/gbot
bb plugin config grok-bot set pollIntervalSeconds 3
bb plugin config grok-bot set startGraceSeconds 45
bb plugin config grok-bot set turnTimeoutMinutes 30
```

## Troubleshooting

- `gbot doctor --json` shows whether the app session is usable.
- "Unsupported Grok Bot gateway descriptor version 3": gbot is older than the
  app. Use a gbot build with descriptor v3 support.
- "Gateway response too large": the bot list includes large custom avatars.
  Use a gbot build with a raised listAgents response cap.
- No replies: confirm the Grok Bot app is running (`gbot bots get <bot> --json`
  shows a `status` block on a supported gbot build).
