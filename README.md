# bb-plugin-grok-bot

A BB agent provider for [Grok Bot](https://x.ai/bot). Each BB thread talks to
one of your Grok Bot bots or groups through
[grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli) (`gbot`).

## Requirements

- The Grok Bot desktop app, running and signed in.
- A `gbot` build that supports gateway descriptor v3, large bot lists, and the
  bot `status` field. Upstream 0.12.4 has none of these yet; see
  `skills/grok-bot/SKILL.md`.

## Install

```
npm install
bb plugin install . --yes
```

Pick **Grok Bot** in the provider picker, then choose a bot as the model.

## What you get

- **A Grok Bots project** with one persistent thread per bot and group, faces in
  the sidebar and on every message.
- **Threads that mirror Grok.** Each thread shows the bot's Grok transcript:
  recent history on creation, then everything live, including messages you type
  in the Grok Bot app (shown as yours) and bot-to-bot messages.
- **Bots as BB citizens.** `bb grok-bot list`, `bb grok-bot env <bot>` (run bb
  commands as a bot's thread) and `bb grok-bot tell <to> --as <bot>`.
- `bb grok-bot remirror <bot|all>` archives a bot's thread and rebuilds it as a
  fresh mirror.

## Test

```
npm test
```

The tests drive the bridge against `test/fake-gbot.mjs`, never your real bots.
