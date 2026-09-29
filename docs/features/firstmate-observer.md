# First mate observer

Shows the workers of a [first mate](https://github.com/kunchenguid/firstmate) home in the Tinstar cockpit, built entirely on the Tinstar side. The first mate owns its workers' creation, dispatch, supervision and lifecycle; Tinstar only reads its state, relays messages through its inbox script, and opens terminal views. Tinstar never starts, stops or steers a worker. Displayed state is the snapshot's `current_state`. When that state is unknown, the latest status line supplies it if the line starts with working, paused, blocked, needs-decision, done, or failed, and the detail marks the report age; a dead endpoint stays unknown. A persistent second mate whose latest status line is a child outcome shows working or idle instead of that child's result. `src/server/fleet/workerState.ts` owns both rules. The same snapshot `kind` is shown as a Second mate badge on the overview card and in the detail rail when it is `secondmate`. Ship, scout, and other kinds get no role badge.

The cockpit (`src/server/fleet/cockpit.ts`) reads each configured home through `<home>/bin/fm-fleet-snapshot.sh --json` (re-run on ledger changes and every 20 s) and serves `GET /api/fleet` and `GET /api/fleet/:key/terminal`. The fleet response also carries the Needs You cards derived from each snapshot's open decisions, captain-held backlog rows, blocked and failed states (a second mate's child-outcome line raises none) and task PR URLs; a PR's merge state is checked with `gh api` (cached, off the snapshot path), and merged or closed PRs get no review card. `GET/POST /api/fleet/messages` (`inbox.ts`) sends Decision-card answers, "Tell First Mate about this" messages, and decision dismissals as one `<home>/bin/fm-inbox.sh note --request-id` each; the request id is reused on retry, so a resubmit creates no second note. A dismissal is sent as an answer that names the task id and decision key. Message state comes from `fm-inbox.sh receipts` and `ready`, and an answer is done once its call leaves the snapshot. Tin Star keeps each message in `fleet-outbox.json` under the config root until it is done, gets a reply, or is 24 hours old. `POST /api/fleet/:key/direct` stores a direct or managed mark in `worker-marks.json` under that same root, keyed by home and worker id, and sends one inbox note when the mark changes. Its terminals use the view described below (`views.ts`, `bin/tinstar-fm-view`), proxied at `/s/<key>/`. The first mate's opt-in **fleet activity ledger** (`<home>/state/fleet-ledger.jsonl`; contract: the first mate's `docs/fleet-ledger.md`) is watched only as a change signal for re-reading the snapshot.

## Turn it on

1. In the first mate home, enable the ledger: `touch <home>/config/fleet-ledger`.
2. In `~/.config/tinstar/config.json` (via `getConfigRoot()`), list the home(s) by absolute path:

   ```json
   { "firstmate": { "homes": ["/Users/me/repo/firstmate"] } }
   ```

3. For the live terminal, install [`ttyd`](https://github.com/tsl0922/ttyd). Without it the cockpit still lists workers, but worker terminals are unavailable.
4. Restart Tinstar. With no homes configured — the default — the cockpit shows no workers.

## How it works

`src/server/firstmate/`:

| File | Role |
| --- | --- |
| `ledger-watcher.ts` | Byte-offset tail of `<home>/state/fleet-ledger.jsonl`: directory-level `fs.watch` plus a 3 s poll floor; only whole lines are delivered; a shrunk or replaced file signals a rebuild. |
| `views.ts` | The terminal view: one ttyd per worker, its own port window (`firstmate.ports`, default 8781–8830), reached through the `/s/<key>/` proxy. The window comes from the snapshot's `endpoint.target`. Boot sweep of orphaned ttyds and abandoned view sessions. |

The snapshot read, Needs You cards and inbox live in `src/server/fleet/` (`cockpit.ts`, `attention.ts`, `inbox.ts`).

### How the terminal view is safe

`bin/tinstar-fm-view <fm-session> <window-id> <window-name>` is what each ttyd runs, once per browser connection. It checks the window is still that worker's, creates a private `tsview-<task>-<nonce>` tmux session holding only a **link** to the worker's window (not a session group), and attaches to it. So each viewer has its own current window, cannot reach any other first mate window, and nothing created in the view leaks into the first mate's session.

- **Closing or deleting a view can never kill the worker.** tmux closes only the windows linked to a killed session *and no other session*, and the worker's window is still linked into the first mate's session. `unlink-window` without `-k` refuses to remove a last link. When the worker's window is closed, it leaves the view and the view dies with it. No bookkeeping is needed: the browser disconnecting detaches the client and `destroy-unattached` removes the view.
- **Names.** View sessions never start with `tinstar-` or with the first mate's session name (the first mate runs a bare `tmux has-session -t firstmate`, which prefix-matches).
- **The view never resizes the worker.** The view session is created at the worker window's size (`new-session -x -y`) and attached with `-f ignore-size`. ttyd resizes its PTY whenever a browser connects or resizes, so the view script re-execs itself under `bin/tinstar-fm-fixed-pty` (requires `python3`): tmux runs on a private inner PTY that follows the worker window's size (read with `display-message` every 0.5 s), and browser resizes only reach the outer PTY. The relay reports the worker size to the browser as an OSC 7337 sequence, sent only at an output boundary, and `public/terminal-wrapper.html` (`?cols=&rows=`) pins xterm to that size at its normal font size; when the grid is larger than the cockpit stage, the wrapper scrolls both ways and anchors to the bottom-left so the prompt stays visible, re-anchoring whenever the cockpit switches back to that worker (`terminal-reveal-prompt` message).
- **Keyboard.** `prefix None` plus an empty key table passes every key to the pane, so `C-b` and `C-h` reach the worker and tmux commands (`prefix &`) are unreachable from the card. Mouse is off on purpose: wheel-scrolling would put the worker's *pane* into copy-mode, shared by every viewer, and the first mate's `send-keys` has no copy-mode escape.
- **You are typing into the real composer.** As with attaching a terminal yourself, text you type can interleave with a steering message the first mate sends at the same moment.
- **What Tinstar runs in tmux.** Only `list-windows` and `list-sessions` (read-only) and `kill-session` on abandoned `tsview-…` sessions. `views.test.ts` asserts this against the recorded calls.
- **Boot.** ttyds orphaned by a previous process (parent pid 1, running the view script) are ended, and view sessions nobody holds are killed — that only ends views.
- **The proof.** `views.tmux.test.ts` runs on a private tmux server (`-L` socket, `$TMUX` removed, a `tmux` shim on `PATH`; it never touches your default server) and shows: killing the view leaves the window; attaching a view leaves an automatically sized worker window at its own size, even when that differs from the fleet session's; killing the window destroys the view; `unlink-window` refuses the last link; `C-b`/`C-h` reach the pane under a hostile server config; and the first mate's own `fm_backend_tmux_kill` / `agent_state` (read from `$FIRSTMATE_HOME` only; with it unset the test is skipped visibly, with a warning and `[SKIPPED]` in its name) return unchanged results while a view is attached.

## Invariant: workers are not Tinstar's

- **No worker window is ever created or addressed destructively.** The only tmux objects Tinstar makes are the private `tsview-*` view sessions described above.
- **Tinstar never writes to the first mate home.** It reads the snapshot and ledger, and sends messages only by running the home's own `fm-inbox.sh`. Its fleet code writes `fleet-outbox.json` and `worker-marks.json`, under its own config root.
