---
name: grok-bot
description: Use the Grok Bot BB provider, which talks to the user's allowlisted Grok Bot bots and groups over HTTPS. Use when a thread runs on the Grok Bot provider, or when setting it up, picking a bot, or diagnosing missing replies.
---

# Grok Bot provider

The `grok-bot` provider turns a BB thread into a conversation with one of the
user's allowlisted Grok Bot bots or groups. It calls the Grok Bot backend
directly with a token from `~/.config/bb-grok-bot/token`.

## How it works

- The model picker lists only allowlisted bots and groups (`allowedBots` in
  `~/.config/bb-grok-bot/config.json`).
  The selected "model" is the bot. Groups show as `Name (group)`.
- A turn sends the message, then polls the bot status and transcript until the
  bot stops running. Each bot message becomes one BB message. Group messages are
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
  so it knows who to answer.
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

- A Grok Bot account access token in `~/.config/bb-grok-bot/token` (mode 600,
  directory 700) or `GROK_BOT_ACCESS_TOKEN`.
- At least one bot id in `allowedBots`; an empty list allows nothing.

## Troubleshooting

- "No Grok Bots are allowlisted": add bot ids to `allowedBots`.
- "... has mode ...": fix permissions as the message says.
- "failed: 401": the token expired or was revoked; replace it.
- `GROK_BOT_API_BASE_URL` rejected: only the built-in Grok Bot API host is allowed.
