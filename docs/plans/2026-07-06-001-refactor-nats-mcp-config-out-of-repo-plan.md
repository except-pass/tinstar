---
title: "refactor: Move per-session NATS .mcp.json out of the git workspace"
date: 2026-07-06
type: refactor
status: ready
depth: standard
---

# refactor: Move per-session NATS `.mcp.json` out of the git workspace

## Summary

Tinstar gives each multi-agent Claude session a NATS channel by writing a `.mcp.json`
into the session's **git workspace** (`workspacePath`) and launching with
`--dangerously-load-development-channels server:nats`. That file-in-repo design was
forced by an old Claude Code constraint: the dev-channels resolver only read the
server definition from a CWD `.mcp.json` or user scope, never from `--mcp-config`.

That constraint is gone as of **Claude Code 2.1.201** (verified empirically this
session — see `reference_cc_channels_resolver_scope` memory). The dev-channels
resolver now reads the named server from a `--mcp-config <file>`, and it coexists
with a project's own CWD `.mcp.json` (non-strict). This plan moves the generated
config into the session's **own config dir** (outside any repo) and points Claude
at it with `--mcp-config`, dissolving four smells of the current design at once.

---

## Problem Frame

The current `generateNatsMcpConfig` (`src/server/sessions/backends/tmux.ts`) writes
`join(workspacePath, '.mcp.json')`. Four consequences follow, all rooted in the file
living in a shared, version-controlled location:

1. **Repo pollution** — a generated file lands in the user's working tree. Tinstar
   hides its own copy with `/.mcp.json` in `.gitignore`, but an arbitrary user
   project has no such line, so the file shows in `git status` and can be committed.
2. **Clobbering** — the writer emits the whole `{ mcpServers: { nats } }` object with
   no read-existing / merge. A project that ships its own `.mcp.json` (with its own
   MCP servers) is silently overwritten.
3. **No cleanup** — the file is never unlinked on session stop; it outlives the session.
4. **Churn-avoidance machinery** — because the file is shared across sessions in one
   repo, it is made byte-identical via `${VAR}` env tokens (`${TINSTAR_SESSION_NAME}`,
   `${TINSTAR_NATS_TOPICS_FILE}`, `${TINSTAR_NATS_CONTROL_SOCKET}`) plus `setNatsEnv`
   injection and `writeIfChanged`. This complexity exists solely to survive the shared
   location.

Moving the file to a per-session private path makes all four disappear: no repo touch
(1, 2, 3 gone), and the file can carry per-session literals directly (4 gone — no env
tokens, no `setNatsEnv`).

This also directly hardens the original bug that started this thread: a session in a
blank project could carry the dev-channels flag with no `.mcp.json` to satisfy it and
lose the user's prompt. The flag/file coupling fix already landed this session (strip
the flag when NATS isn't provisioned); this refactor removes the underlying fragility
by making the file always writable to a path that always exists.

---

## Scope Boundaries

**In scope:**
- Relocate the per-session `.mcp.json` from `workspacePath` to the session config dir.
- Bake per-session values as literals; remove the `${VAR}` / `setNatsEnv` indirection.
- Pass the file to Claude via `--mcp-config <path>` in the launch command.
- Relax the launch guard so NATS provisioning no longer requires a `workspace.path`.
- Update both launch paths (create and resume) and all affected tests.

**Preserved (do not change behavior):**
- `--topics-file` — subscriptions still written one-per-line to the per-session topics
  file (`natsTopicsFilePath`), still passed to the channel server.
- `--control-socket` — still per-session at `natsControlSocketPath`; hot subscription
  management (`POST/DELETE /api/sessions/:name/subscriptions`) and `natsReconnect`'s
  `pgrep -f <socket>` match are unaffected.
- The flag/file coupling fix in `buildAgentCommand` (strip dev-channels when NATS off).
- The dev-channel auto-accept warning handler.

### Deferred to Follow-Up Work
- **Leftover in-repo `.mcp.json` cleanup.** Sessions created under the old code left a
  `.mcp.json` in their workspace. This plan stops *writing* there but does not delete
  pre-existing files — auto-deleting a `.mcp.json` risks removing a project's real one.
  A separate, opt-in, ownership-checked cleanup can be considered later.
- Removing the now-vestigial `/.mcp.json` line from Tinstar's own `.gitignore` (harmless
  if left; not worth a behavior-adjacent edit here).

---

## Key Technical Decisions

**KTD1 — Write to the session config dir, not the workspace.** New path:
`join(sessionsDir, sessionName, 'nats-mcp.json')` — the same per-session dir that
already holds `nats-topics.txt`. It always exists (created via `mkdirSync`), is outside
any git tree, and is private to the session. Distinct filename (`nats-mcp.json`, not
`.mcp.json`) because it is now referenced by explicit path and must not be confused
with a project's real `.mcp.json`.

**KTD2 — Bake literals; drop `${VAR}` and `setNatsEnv`.** Because the file is now
per-session, the channel-server args carry real values directly: `--name <sessionName>`,
`--topics-file <topicsPath>`, `--control-socket <controlSocket>`. This removes the need
for Claude-side `${VAR}` expansion inside the config — which was **never verified to
work through `--mcp-config`** (the empirical test used literal args), so baking literals
also sidesteps that open risk. Confirmed nothing else reads `TINSTAR_NATS_TOPICS_FILE`
or `TINSTAR_NATS_CONTROL_SOCKET` (grep: only the mcp args and one test). `setNatsEnv`
and its two env injections are removed. `TINSTAR_SESSION_NAME` continues to be set
separately (`createTmuxSession`, unrelated to this file) and is untouched.

**KTD3 — Inject `--mcp-config <path>` in `buildAgentCommand`, non-strict.** The absolute
per-session path is passed into the command builder and inserted before the ` -- `
prompt separator (mirroring `--append-system-prompt` / `--model` insertion). Non-strict
(no `--strict-mcp-config`) so a project's own CWD `.mcp.json` still loads alongside —
verified coexisting this session. The `nats` command opt grows from `{ enabled }` to
`{ enabled: boolean; mcpConfigPath?: string }`.

**KTD4 — Relax the launch guard.** Both callsites currently gate on
`nats?.enabled && subscriptions.length > 0 && workspace?.path`. Drop the
`workspace?.path` clause: the file no longer needs a workspace to live in, and the
`--mcp-config` path is absolute so it resolves regardless of the tmux launch cwd. This
lets a workspace-less session that genuinely has subscriptions get its channel, instead
of silently getting none.

---

## High-Level Technical Design

Launch flow, before vs. after (both create and resume paths):

```
BEFORE
  guard: nats.enabled && subs>0 && workspace.path
    → generateNatsMcpConfig writes  <workspace>/.mcp.json   (byte-identical, ${VAR} tokens)
    → setNatsEnv injects TINSTAR_NATS_TOPICS_FILE / _CONTROL_SOCKET into tmux env
    → command: claude … --dangerously-load-development-channels server:nats … -- {prompt}
       (Claude reads CWD .mcp.json, expands ${VAR} from the shell-exported tmux env)

AFTER
  guard: nats.enabled && subs>0
    → generateNatsMcpConfig writes  <sessionsDir>/<name>/nats-mcp.json  (per-session literals)
    → (no setNatsEnv for NATS paths)
    → command: claude … --dangerously-load-development-channels server:nats \
                        --mcp-config <sessionsDir>/<name>/nats-mcp.json … -- {prompt}
       (Claude reads the named server straight from --mcp-config; project .mcp.json, if any, also loads)
```

Unchanged either way: `nats-topics.txt` (per-session, `--topics-file`), the control
socket, hot subscription updates, `natsReconnect`, and the auto-accept handler.

---

## Implementation Units

### U1. Rewrite `generateNatsMcpConfig` to write a per-session file with literal args

**Goal:** Emit the channel config to the session config dir with real per-session values
baked in, and return the new path.

**Requirements:** KTD1, KTD2. Dissolves smells 1–4.

**Dependencies:** none.

**Files:**
- `src/server/sessions/backends/tmux.ts` (`generateNatsMcpConfig` ~line 292, its header
  comment ~276-290, and the `natsTopicsFilePath`/`natsControlSocketPath` header comments
  that describe the old byte-identical rationale)

**Approach:**
- Drop the `workspacePath` parameter from the opts type.
- Compute `controlSocket = natsControlSocketPath(sessionName)` and
  `topicsPath = natsTopicsFilePath(sessionsDir, sessionName)`.
- Still write the topics file (one subject per line) — unchanged.
- Build args with literals: `['x', channelServerPackage, '--name', sessionName,
  '--topics-file', topicsPath, '--control-socket', controlSocket]`, plus `--jetstream`
  when set. No `${VAR}` tokens.
- Write to `mcpConfigPath = join(sessionsDir, sessionName, 'nats-mcp.json')` via the
  existing `writeIfChanged` helper (idempotent write is still fine and cheap; the file
  is per-session so cross-session churn is no longer a concern).
- Return `mcpConfigPath`.
- Rewrite the stale header comment: the file now lives in the per-session config dir,
  is passed via `--mcp-config`, and carries literals — explain the 2.1.201 constraint
  lift briefly and drop the "byte-identical / cannot leave the repo" narrative.

**Patterns to follow:** existing `generateNatsMcpConfig` body; `natsTopicsFilePath` /
`natsControlSocketPath` for path derivation; `writeIfChanged` for the write.

**Test scenarios** (`src/server/sessions/backends/__tests__/generateNatsMcpConfig.test.ts`):
- Writes to `<sessionsDir>/<name>/nats-mcp.json` and returns that path (assert the
  returned path and that the file exists there).
- The file is NOT written under any workspace path (pass a distinct temp workspace-like
  dir concept is gone; assert the returned path is under `sessionsDir`).
- Config contains literal per-session values: the session name, the topics-file path,
  and the control-socket path appear verbatim; no `${TINSTAR_*}` tokens remain.
- Two different sessions produce **different** bytes (per-session, no longer identical) —
  replaces the old "byte-identical across sessions" test.
- Subscriptions are still written to the topics file, one per line (keep existing test).
- `--topics-file` is present and `--subscribe` is absent (subscription list stays in the
  topics file).
- `--jetstream` is present only when `jetstream: true`.
- Idempotent: re-running with unchanged inputs does not rewrite the file (keep, adapted
  to the new path).

### U2. Inject `--mcp-config <path>` in `buildAgentCommand`

**Goal:** When NATS is provisioned, add `--mcp-config <absolute path>` to the launch
command so Claude loads the `nats` server from the per-session file.

**Requirements:** KTD3. Keeps the flag/file coupling from this session intact.

**Dependencies:** U1 (defines the path that gets passed in).

**Files:**
- `src/server/sessions/backends/tmux.ts` (`buildAgentCommand`, both the template branch
  ~line 370 and the legacy fallback branch ~line 392; the `nats` opt type ~line 360)

**Approach:**
- Widen the `nats` opt: `{ enabled: boolean; mcpConfigPath?: string | null }`.
- Template branch: after the existing coupling strip (which removes the dev-channels
  flag when `!nats?.enabled`), when `nats?.enabled && nats.mcpConfigPath`, insert
  ` --mcp-config <bashSingleQuote(path)>` before the ` -- ` prompt separator if present,
  else append — same insertion pattern used for `--append-system-prompt` and `--model`.
- Legacy fallback branch: where it already appends `--dangerously-load-development-channels
  server:nats` under `nats?.enabled`, also append `--mcp-config <path>` when a path is present.
- Do not add `--strict-mcp-config` — coexistence with a project `.mcp.json` is intended.

**Patterns to follow:** the `--append-system-prompt` and `--model` insertion blocks in
the same function (insert-before-` -- ` logic, `bashSingleQuote` for the value).

**Test scenarios** (`src/server/sessions/backends/__tests__/buildAgentCommand.test.ts`):
- Template with the dev-channels flag + `nats: { enabled: true, mcpConfigPath: '/p/nats-mcp.json' }`
  → command contains both `--dangerously-load-development-channels server:nats` and
  `--mcp-config '/p/nats-mcp.json'`, and the `--mcp-config` sits before ` -- {prompt}`.
- Same, resume command (no ` -- ` separator) → `--mcp-config` appended, prompt-less.
- `nats: { enabled: false }` → neither the dev-channels flag nor `--mcp-config` present
  (existing coupling test, extended to assert `--mcp-config` absence).
- `nats: { enabled: true }` with no `mcpConfigPath` → dev-channels flag kept, no
  `--mcp-config` emitted (defensive: path missing shouldn't inject an empty flag).
- Legacy fallback (no template) with `nats: { enabled: true, mcpConfigPath }` → command
  includes both flags.
- No double spaces introduced by insertion.

### U3. Wire both launch paths; remove `setNatsEnv`

**Goal:** Capture the path from `generateNatsMcpConfig`, pass it to `buildAgentCommand`,
relax the guard, and delete the dead env-injection machinery.

**Requirements:** KTD3, KTD4.

**Dependencies:** U1, U2.

**Files:**
- `src/server/sessions/backends/tmux.ts` — `createTmuxSession` launch path (~509-541),
  the resume path in `createOrResumeTmuxSession` (~590-616), and `setNatsEnv` (~342-351)

**Approach:**
- Both callsites: change the guard from
  `nats?.enabled && subscriptions.length > 0 && workspace?.path` to
  `nats?.enabled && subscriptions.length > 0`.
- Both callsites: `const mcpConfigPath = generateNatsMcpConfig({ … })` (drop the
  `workspacePath` argument), then set `natsOpts = { enabled: true, mcpConfigPath }`.
- Remove the `await setNatsEnv(...)` call from both callsites.
- Delete the `setNatsEnv` function (nothing else calls it; confirmed by grep). The
  TINSTAR_NATS_TOPICS_FILE / TINSTAR_NATS_CONTROL_SOCKET env vars are no longer read.
- Leave `TINSTAR_SESSION_NAME` set at `createTmuxSession` untouched (separate concern).
- Leave the auto-accept dev-channel warning handler untouched (still fires on
  `natsOpts?.enabled`).

**Patterns to follow:** the existing paired create/resume NATS blocks — keep them
mirrored.

**Test scenarios:** covered indirectly by U1/U2 unit tests plus the type-check.
`createTmuxSession` / `createOrResumeTmuxSession` are integration-heavy (spawn tmux) and
are not unit-tested here; verification is via `tsc` (signature changes line up) and the
runtime smoke in Verification below. `Test expectation: none at this unit — behavior is
exercised through U1/U2 units and the manual runtime smoke.`

### U4. Refresh stale comments / docs referencing the old design

**Goal:** No comment or doc still claims the config must live in the repo or be
byte-identical.

**Requirements:** documentation hygiene; prevents the next reader from re-deriving the
dissolved constraint.

**Dependencies:** U1–U3.

**Files:**
- `src/server/sessions/backends/tmux.ts` — `natsTopicsFilePath` header (~91-97, drops
  the "otherwise byte-identical .mcp.json so that file never churns" rationale)
- `src/server/sessions/natsReconnect.ts` — the comment "relaunches the MCP from the
  session's `.mcp.json`" is still accurate in spirit (Claude relaunches from
  `--mcp-config`); adjust wording if it implies the CWD file.
- `src/server/api/routes.ts` — the resume comment near line 4026 ("on resume we
  regenerate `.mcp.json` from session.nats.subscriptions") stays true; verify wording
  matches the new per-session path.

**Approach:** comment-only edits; no behavior change. Keep them short.

**Test scenarios:** `Test expectation: none — comment-only changes.`

---

## System-Wide Impact

- **Server-side only.** Takes effect after the user restarts their standalone server.
  Do **not** restart it for them (per project convention / `feedback_no_server_restart`).
- **No frontend change**, no API surface change. `GET /api/sessions/:name/nats-status`
  and the subscription endpoints read the control socket directly and are unaffected.
- **Behavior change (intentional):** workspace-less sessions with subscriptions now get
  a channel where before they silently got none.
- **User repos stop being touched** — the headline win. Existing in-repo `.mcp.json`
  files from old sessions remain until manually removed (see Deferred).

---

## Risks & Mitigations

- **`--mcp-config` + dev-channels regression across Claude Code versions.** The lift was
  verified on 2.1.201; an older CLI would break. *Mitigation:* this is the user's own
  pinned CLI (`claude --version` → 2.1.201); the coupling fix already degrades safely
  (no file, no flag) for the non-provisioned case. Note the version dependency in the
  header comment.
- **Flag ordering.** `--mcp-config` must be accepted alongside `--dangerously-load-
  development-channels`. *Mitigation:* verified working this session with `--mcp-config`
  preceding the dev-channels flag; the insertion keeps both before ` -- `.
- **A project's real `.mcp.json` interfering.** Non-strict load means both are read.
  *Mitigation:* verified coexistence (project server + injected nats both spawn). If a
  project ever defines its own server literally named `nats`, `--mcp-config` and CWD
  both define it — out-of-scope edge; note but do not handle.

---

## Verification

- `npx tsc --noEmit -p tsconfig.app.json` clean (signature change to `generateNatsMcpConfig`
  and the `nats` opt propagates to both callsites).
- `npx vitest run src/server/sessions/backends/__tests__/ --exclude='e2e/**'` green
  (rewritten `generateNatsMcpConfig` tests, extended `buildAgentCommand` tests).
- Runtime smoke (manual, by the user on their standalone since we don't restart it):
  create a multi-agent session in a repo that has **no** `.mcp.json`; confirm (a) no
  `.mcp.json` appears in the repo's `git status`, (b) `<sessionsDir>/<name>/nats-mcp.json`
  exists with literal args, and (c) the session's Saloon dot shows the channel connected
  (`GET /api/sessions/:name/nats-status` → connection up).
- Confirm a blank/workspace-less session with subscriptions now connects instead of
  launching channel-less.
