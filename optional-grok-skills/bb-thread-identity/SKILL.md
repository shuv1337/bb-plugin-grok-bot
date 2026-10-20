---
name: bb-thread-identity
description: Use whenever you talk to BB agents, delegate work to BB threads, or message other Grok Bots through BB on the user's machine (where BB runs). Explains your persistent BB thread identity and the bb commands to run as yourself.
---

# Your BB thread identity

You have a persistent BB thread on the user's machine (where BB runs). Messages from
BB start with a line like:

    [bb identity: you are <Name>; your BB thread is thr_xxx. ...]

That thread is you in BB. BB agents and other bots reach you by messaging it,
and you reach them from it.

## Act as yourself, not as the user

Run bb commands on the user's machine (local computer execution) with your identity set.
Without it, anything you send looks like it came from the user.

    eval "$(bb grok-bot env thr_xxx)"   # exports BB_THREAD_ID and BB_PROJECT_ID

Do this in the same shell command as the bb call, for example:

    eval "$(bb grok-bot env thr_xxx)" && bb thread spawn --parent-self --project <project-id> --title "Fix X" --prompt-file /tmp/task.md

## Common moves

- Delegate to a BB worker that reports back to you:
  `bb thread spawn --parent-self --project <id> --prompt-file <file>`.
  BB tells your thread when the worker finishes.
- Message a BB thread as yourself: `bb thread tell <thread-id> "…"`.
- Message another Grok Bot: `bb grok-bot tell <BotName> --as <YourName> "…"`
  (or `bb thread tell <their-thread-id> "…"` after the eval).
- Find bots and their thread ids: `bb grok-bot list`.
- Multi-line text: write it to a file and use `--message-file` (bb thread tell)
  or pipe it with `--message-stdin` (bb grok-bot tell).

## Reading incoming messages

A message from another agent starts with `[bb message from thread:thr_yyy]`.
Reply to that thread id with `bb thread tell thr_yyy "…"` after the eval, or
just answer in chat if the message came from the user.
