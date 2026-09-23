# First mate observer

Shows the workers of a [first mate](https://github.com/kunchenguid/firstmate) home on the Tinstar canvas, built entirely on the Tinstar side. The first mate is unchanged and unaware of Tinstar.

Tinstar follows the first mate's documented, opt-in **fleet activity ledger** (`<home>/state/fleet-ledger.jsonl`; contract: the first mate's `docs/fleet-ledger.md`) and shows one card per worker as an **[Observed run](../../CONCEPTS.md#observed-run)**.

**Status: cards (M1) and the Claude conversation link / status light / timeline (M3).** Not built yet: the live terminal view (M2), the prompt composer, starting or stopping workers from Tinstar, and cost/token telemetry.

## Turn it on

1. In the first mate home, enable the ledger: `touch <home>/config/fleet-ledger`.
2. In `~/.config/tinstar/config.json` (via `getConfigRoot()`), list the home(s) by absolute path:

   ```json
   { "firstmate": { "homes": ["/Users/me/repo/firstmate"] } }
   ```

3. Restart Tinstar. With no homes configured — the default — the observer never starts. It also never starts under `TINSTAR_FAST_SIM=1`.

## What you get

- **One card per live worker**, placed under **Project → Worktree** in the hierarchy (project from the ledger; the worktree level is the task id). It shows task, kind, project, harness, model, the latest status line, open decisions ("as reported by the ledger"), and the PR link with its merge state.
- **Inbox:** a `needs-decision`, `blocked` or `failed` status line becomes an urgent Inbox row.
- **Dismiss:** deleting the card removes it and remembers that (`<configRoot>/firstmate/dismissed.json`), so the worker's next ledger line does not bring it back. A genuinely newer `task.dispatched` for the same task id shows it again.
- `task.cleaned_up` removes the card. Truncating the ledger (`: >` — the documented way) rebuilds from what remains.

| Ledger status | Run status |
| --- | --- |
| `working` (also `resolved`, unknown, or no status yet) | `running` |
| `needs-decision`, `blocked`, `failed` | `needs_attention` (+ Inbox) |
| `paused`, `done`, or the task merged | `idle` |

## How it works

`src/server/firstmate/`:

| File | Role |
| --- | --- |
| `ledger-watcher.ts` | Byte-offset tail of `<home>/state/fleet-ledger.jsonl`: directory-level `fs.watch` plus a 3 s poll floor; only whole lines are delivered; a shrunk or replaced file signals a rebuild. |
| `reducer.ts` | Pure fold of ledger records into one worker per task. Ignores unknown events/members, tolerates duplicates and a status that precedes its `dispatched`, refuses unsafe task ids. |
| `meta.ts` | Interim join: reads `<home>/state/<task>.meta` for `worktree=`, `window=` (for M2), `project=` (fallback when the ledger names no project) and `spawn_gen=` (spawn time for the conversation link). That format is the first mate's **undocumented internal** state, so it is best-effort — absent file, missing keys and unknown keys are all tolerated. |
| `observer.ts` | Projects workers onto docstore-only Runs, derives attention, handles dismiss and the conversation override, refreshes the linked transcript's activity. Started from `src/server/index.ts`. |
| `transcript-link.ts` | Heuristic link from a worker to its Claude Code conversation (see below). |

The card is the bundled `firstmate` plugin (`src/plugins/firstmate/`): a widget registered as `firstmate-worker`, selected by `run.view`. It only renders `viewData.firstmate`, which the server owns and the card never writes back. Status text is verbatim from the first mate's `state/`, so it is rendered as plain text and only `https:` PR links are clickable.

## Conversation link (status light and timeline)

`transcript-link.ts` links each worker to its Claude Code conversation so the card gets a running/idle light, recap entries, and the timeline. The first mate records no conversation id, so the link is a heuristic: among top-level `*.jsonl` in the worktree's Claude project dir, take the most recently appended one whose first user/assistant record has `cwd == worktree`, `isSidechain == false`, a non-`sdk*` `entrypoint`, and a timestamp no more than 120 s before the spawn time (meta `spawn_gen`, else the ledger dispatch ts) and, when a later worker was spawned into the same worktree, before that later spawn. A wrong link can only mislabel one card; nothing acts on it. The card shows the conversation id, and `PUT /api/firstmate/runs/:id/conversation` (`{conversationId}`; `null` clears) sets a manual override, stored in `<configRoot>/firstmate/conversation-overrides.json`. `GET /api/sessions/:name/timeline` falls back to the observer's linked transcript when no session record exists; the status watcher's no-orphan-adoption rule is untouched. Transcripts are only read.

## Invariant: observed workers are not Tinstar sessions

An observed worker must never be reachable by anything that manages Tinstar-owned sessions:

- **No session record** is created under `~/.config/tinstar/sessions/`. Reconcile, the status watcher, `/stop`, `/start`, `/spawn`, `/send-keys` and friends are all keyed on session records, so they cannot find these Runs. The Run has `backend: null`, no ttyd `port`, and an `fm-…` id.
- **No tmux** name, window or ttyd is created or touched (`tinstar-*` names are never used).
- **Deleting a card** takes the docstore-only branch of `DELETE /api/sessions/:name`, which removes the projection and never reaches a backend.
- **Guards:** a task is skipped if a real Tinstar session with the same name exists, or if a non-observed run already holds the id.
- **Tinstar never writes to the first mate home.** The modules only read; the only files Tinstar writes are the dismissal list and the conversation overrides, both under its own config root. Claude transcripts are only read.

`src/server/firstmate/observer.test.ts` proves this by running the observer against a real ledger and asserting that no session record or session store is created, the first mate home is unchanged, and nothing but `firstmate/` is written under the config root. If a later milestone adds terminal views, they must live under their own `tsview-` tmux namespace and keep these tests green.
