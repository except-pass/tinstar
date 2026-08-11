---
title: "Context meter reads \"--\" forever — onboarding never installed the Claude statusline hook"
module: bin/install-statusline.js + bin/tinstar.js + bin/doctor.js + scripts/cc-quota-statusline.sh
date: 2026-08-05
category: documentation-gaps
problem_type: documentation_gap
component: onboarding
root_cause: missing_install_step
resolution_type: tooling_fix
severity: medium
tags:
  - onboarding
  - statusline
  - cc-quota
  - context-meter
  - claude-code
  - settings-json
  - doctor
applies_when:
  - "A Claude session's context-fullness meter shows \"--\" or never fills, while the session is otherwise healthy"
  - "The quota HUD card shows no 5h/7d data"
  - "Someone just finished README onboarding and a Claude-only telemetry surface is dead"
  - "Adding a new per-machine Claude Code integration that lives in ~/.claude/settings.json"
---

# Context meter reads "--" forever — onboarding never installed the Claude statusline hook

## Problem

A user completed README onboarding (`npx tinstar`, all dependency checks green, sessions creating and running fine) and the context-fullness meter on their Claude run stayed at `--`. Nothing was broken: tmux alive, ttyd serving, status transitions correct, `tinstar doctor` all-green through every section it reached.

The meter was dark because **Claude Code reports context-window utilization through exactly one channel — the `statusLine` command — and nothing in onboarding ever registered it.**

## Root cause

`src/server/cc-quota/service.ts` parses `context_window.used_percentage` out of the session-state JSON that Claude Code pipes on stdin to whatever command is registered under `statusLine` in `~/.claude/settings.json`. `scripts/cc-quota-statusline.sh` is the shim that POSTs that to `POST /api/cc-quota/ingest`. It is the *only* source: OTel feeds the historical cost/token sparklines, not the meter, and the treemap sidecar (`src/server/sessions/context-usage.ts`) only runs on click and returns category breakdowns, not live percentage.

Registering the shim was a **manual, undocumented step**. It appeared only in the script's own header comment and in `docs/release-notes-v4-0.md`. The README never mentioned it, no CLI command performed it (`install-skills` only links `skills/` and `commands/`), and `tinstar doctor` had zero checks touching `statusLine`. `scripts/` wasn't even in the package's `files` array, so `npx tinstar` didn't ship the shim.

Net: the failure was **silent and self-consistent**. A `--` meter looks like "no data yet," which is exactly what the UI is designed to show before the first push — so there was nothing to distinguish "not installed" from "hasn't rendered yet."

Codex sessions were never affected: their context data is parsed from `~/.codex/sessions/**/rollout-*.jsonl` by the transcript watcher, which needs no user setup. That asymmetry made the gap easy to miss in testing.

## Resolution

1. **`tinstar install-statusline`** (`bin/install-statusline.js`) — copies the shim to `getConfigRoot()/cc-quota-statusline.sh` and merges a `statusLine` key into the harness `settings.json`, preserving every other key. Idempotent; refuses to clobber a foreign `statusLine` without `--force` (and backs it up when forced); atomic settings write.
2. **`npx tinstar` asks during onboarding** — a prompt between the dependency checks and project registration. Non-fatal in every branch; non-TTY/`--no-setup` prints the command instead of hanging.
3. **`tinstar doctor` has a "Claude Code integration" section** that reports `missing` / `drifted` / `foreign` state plus the exact fix command, and warns when `jq`/`curl` are absent from PATH.
4. **README** documents the hook, links it from the telemetry bullet ("a meter stuck on `--` means it isn't installed"), and lists `jq`/`curl` under Prerequisites.
5. **`scripts/cc-quota-statusline.sh` added to `package.json` `files`** so npm-installed copies actually have the shim.

## Gotchas worth keeping

- **Copy the shim, don't reference it in place.** `npx tinstar` runs from a volatile npm cache path; a `settings.json` entry pointing there breaks the next time the cache is pruned. The config root is the stable home.
- **A non-default port needs the ingest URL baked in.** The shim defaults to `:5273`; the installer prefixes `TINSTAR_INGEST_URL=...` into the command string only when `--port` differs.
- **Never blind-write `settings.json`.** It holds MCP servers, plugin registries, and permissions. Read → merge one key → atomic rename; back up before replacing someone's existing statusline.
- **The shim needs `jq` and `curl` on PATH.** Missing either, it runs, prints nothing useful, and posts nothing — another silent-failure shape. Both the installer and doctor check for them.

## Lesson

Any integration that lives in a file Tinstar doesn't own (`~/.claude/settings.json`, shell rc, a systemd unit) needs three things shipped together: **an install command, an onboarding prompt that runs it, and a doctor check that catches it when onboarding was skipped.** A README paragraph is not enough — and a header comment in a shell script definitely isn't. Prefer failure modes that name themselves; when a surface can't distinguish "not configured" from "no data yet," doctor is the only place the difference can surface.
