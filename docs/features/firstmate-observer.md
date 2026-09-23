# First mate observer

Shows the workers of a [first mate](https://github.com/kunchenguid/firstmate) home on the Tinstar canvas, built entirely on the Tinstar side. The first mate is unchanged and unaware of Tinstar.

Tinstar follows the first mate's documented, opt-in **fleet activity ledger** (`<home>/state/fleet-ledger.jsonl`; contract: the first mate's `docs/fleet-ledger.md`) and shows one card per worker as an **[Observed run](../../CONCEPTS.md#observed-run)**.

**Status: Milestones 1 (cards) and 2 (terminal).** Not built yet: the Claude transcript link / status light / timeline (M3), the prompt composer, starting or stopping workers from Tinstar, and cost/token telemetry.

## Turn it on

1. In the first mate home, enable the ledger: `touch <home>/config/fleet-ledger`.
2. In `~/.config/tinstar/config.json` (via `getConfigRoot()`), list the home(s) by absolute path:

   ```json
   { "firstmate": { "homes": ["/Users/me/repo/firstmate"] } }
   ```

3. For the live terminal, install [`ttyd`](https://github.com/tsl0922/ttyd) (the same requirement as any Tinstar session). Without it the cards still work and say "No live terminal".
4. Restart Tinstar. With no homes configured — the default — the observer never starts. It also never starts under `TINSTAR_FAST_SIM=1`.

## What you get

- **One card per live worker**, placed under **Project → Worktree** in the hierarchy (project from the ledger; the worktree level is the task id). It shows task, kind, project, harness, model, the latest status line, open decisions ("as reported by the ledger"), and the PR link with its merge state.
- **A live, typeable terminal** on the worker's real tmux window (from the meta's `window=`), with the card as its right-hand side panel. It works for workers that were already running. Non-tmux first mate backends get the card only.
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
| `meta.ts` | Interim join: reads `<home>/state/<task>.meta` for `worktree=`, `window=` (for M2) and `project=` (fallback when the ledger names no project). That format is the first mate's **undocumented internal** state, so it is best-effort — absent file, missing keys and unknown keys are all tolerated. |
| `views.ts` | The terminal view: one ttyd per worker, its own port window (`firstmate.ports`, default 8781–8830), reached through the existing `/s/<runId>/` proxy (`Run.port`). Boot sweep of orphaned ttyds and abandoned view sessions. |
| `observer.ts` | Projects workers onto docstore-only Runs, derives attention, handles dismiss. Started from `src/server/index.ts`. |

### How the terminal view is safe

`bin/tinstar-fm-view <fm-session> <window-id> <window-name>` is what each ttyd runs, once per browser connection. It checks the window is still that worker's, creates a private `tsview-<task>-<nonce>` tmux session holding only a **link** to the worker's window (not a session group), and attaches to it. So each viewer has its own current window, cannot reach any other first mate window, and nothing created in the view leaks into the first mate's session.

- **Closing or deleting a view can never kill the worker.** tmux closes only the windows linked to a killed session *and no other session*, and the worker's window is still linked into the first mate's session. `unlink-window` without `-k` refuses to remove a last link. When the worker's window is closed, it leaves the view and the view dies with it. No bookkeeping is needed: the browser disconnecting detaches the client and `destroy-unattached` removes the view.
- **Names.** View sessions never start with `tinstar-` or with the first mate's session name (the first mate runs a bare `tmux has-session -t firstmate`, which prefix-matches).
- **Keyboard.** `prefix None` plus an empty key table passes every key to the pane, so `C-b` and `C-h` reach the worker and tmux commands (`prefix &`) are unreachable from the card. Mouse is off on purpose: wheel-scrolling would put the worker's *pane* into copy-mode, shared by every viewer, and the first mate's `send-keys` has no copy-mode escape.
- **You are typing into the real composer.** As with attaching a terminal yourself, text you type can interleave with a steering message the first mate sends at the same moment.
- **What Tinstar runs in tmux.** Only `list-windows` and `list-sessions` (read-only) and `kill-session` on abandoned `tsview-…` sessions. `views.test.ts` asserts this against the recorded calls.
- **Boot.** Persisted `Run.port`s are cleared before anything can proxy to them; ttyds orphaned by a previous process (parent pid 1, running the view script) are ended — that only ends views.
- **The proof.** `views.tmux.test.ts` runs on a private tmux server (`-L` socket, `$TMUX` removed, a `tmux` shim on `PATH`; it never touches your default server) and shows: killing the view leaves the window; killing the window destroys the view; `unlink-window` refuses the last link; `C-b`/`C-h` reach the pane under a hostile server config; and the first mate's own `fm_backend_tmux_kill` / `agent_state` (read from `$FIRSTMATE_HOME` only; with it unset the test is skipped visibly, with a warning and `[SKIPPED]` in its name) return unchanged results while a view is attached.

The card is the bundled `firstmate` plugin (`src/plugins/firstmate/`): a widget registered as `firstmate-worker`, selected by `run.view`. It only renders `viewData.firstmate`, which the server owns and the card never writes back. Status text is verbatim from the first mate's `state/`, so it is rendered as plain text and only `https:` PR links are clickable.

## Invariant: observed workers are not Tinstar sessions

An observed worker must never be reachable by anything that manages Tinstar-owned sessions:

- **No session record** is created under `~/.config/tinstar/sessions/`. Reconcile, the status watcher, `/stop`, `/start`, `/spawn`, `/send-keys` and friends are all keyed on session records, so they cannot find these Runs. The Run has `backend: null` and an `fm-…` id; its `port`, when set, is only its view ttyd's (see below).
- **No `tinstar-*` tmux name, and no worker window, is ever created or addressed destructively.** The only tmux objects Tinstar makes are the private `tsview-*` view sessions described above; `Run.port` is a view ttyd's port, never a Tinstar session's.
- **Deleting a card** takes the docstore-only branch of `DELETE /api/sessions/:name`, which removes the projection and never reaches a backend.
- **Guards:** a task is skipped if a real Tinstar session with the same name exists, or if a non-observed run already holds the id.
- **Tinstar never writes to the first mate home.** The modules only read; the one file Tinstar writes is the dismissal list under its own config root.

`src/server/firstmate/observer.test.ts` proves this by running the observer against a real ledger and asserting that no session record or session store is created, the first mate home is unchanged, and nothing but `firstmate/` is written under the config root. Terminal views live under their own `tsview-` tmux namespace and keep these tests green.
