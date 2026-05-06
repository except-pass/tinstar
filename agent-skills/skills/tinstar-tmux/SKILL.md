---
name: tinstar-tmux
description: Use when about to run raw tmux commands (kill-session, send-keys, capture-pane, etc.) against a Tinstar-managed session. Redirects to the Tinstar API because direct tmux usage bypasses NATS, breaks parent-child hand links, and desyncs session state.
---

# Stop — use the Tinstar API instead

You're about to run a tmux command against a Tinstar-managed session. In this context, that's an antipattern.

**Rule of thumb:** reaching for raw tmux against a Tinstar session means either:

1. The Tinstar API is missing functionality, **or**
2. You forgot the API exists.

## What to do

- **Talking to a hand?** Use `reply(to=…, text=…)` over NATS. See the `tinstar-hand` skill.
- **Managing a session?** See the `tinstar` skill — stop, delete, prompt, spawn, subscribe, inspect state.
- **API genuinely missing something?** Tell the user so Tinstar can grow the capability. Don't normalize the workaround.

## Allowed exceptions

- Debugging when the API is unresponsive (e.g. `tmux capture-pane` to peek at a stuck pane).
- One-off inspection while developing Tinstar itself.

If you hit this skill often, something needs building.
