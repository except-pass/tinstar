# Concepts

Current product terms for the First Mate cockpit. The [requirements](docs/brainstorms/2026-09-24-tinstar-v6-requirements.md) define the broader product contract.

## First Mate home

A configured First Mate installation in `firstmate.homes`. Each home supplies a fleet snapshot and an inbox command. Tinstar does not own its worker records or lifecycle. See [fleet config](src/server/fleet/config.ts).

## Worker

A task in First Mate's fleet snapshot. Its id is the stable identity used for the worker switcher, face and color. The worker's state and detail come from the snapshot, while the objective comes from the brief's captain intent and falls back to the backlog title. When First Mate can read a live pane but not its state, the worker shows the verb from First Mate's parse of its latest status line (`paths.status_log.last_event`), with needs-decision shown as parked and the note and report age in the detail; a dead endpoint or any other unknown stays unknown. A persistent second mate's child-outcome status line never becomes its own displayed state, even when its snapshot state is unknown. A worker whose snapshot kind is `secondmate` shows a Second mate badge on its overview card and in the detail rail; ship, scout, and other kinds do not. Unknown values remain visible. The overview groups that fleet on two levels, chosen from status, project, and direct or managed work, and the browser remembers the choice. A filter above it fuzzy-matches name and objective. A direct mark is stored in `worker-marks.json` under the config root, keyed by the worker's home and id, and First Mate is notified when it changes. See [worker state](src/server/fleet/workerState.ts), [cockpit fleet](src/server/fleet/cockpit.ts), [worker marks](src/server/fleet/marks.ts), [overview grouping](src/cockpit/groupWorkers.ts), and [overview filter](src/cockpit/overviewQuery.ts).

## Worker view

The main pane for one worker: identity, state, objective, project, worktree, branch, pull request and a live terminal view. The terminal uses a private `tsview-*` tmux session linked to the worker window; the view does not own that window. The mouse wheel on that view scrolls the pane's tmux history. A key or Escape returns to the live prompt, and so do closing the view and switching to another worker. A prompt composer docked under the terminal pastes a prompt into the worker's pane and presses Enter; pasted screenshots and dropped files are uploaded and inserted as `@path`. A worker link opens it by task id; the [README](README.md#worker-links) lists the URL shapes. See [terminal views](src/server/firstmate/views.ts), [prompt delivery](src/server/fleet/promptInput.ts), and [composer](src/components/PromptComposer/PromptComposer.tsx).

## Needs You

The Needs You side panel shows Decision, Blocked, Failure, and Review Ready cards, one panel at a time, beside the overview or the worker. Below 1100px the panel starts closed and opens over the canvas. They are derived from the snapshot; opening a card never resolves it. A decision card can slide to dismiss; a blocked card cannot. A captain-held backlog task is answered with `fm-captain-hold.sh`, with `--release` when the hold is on a live worker's own task so that work resumes, and a keyed needs-decision line is closed with `fm-send.sh --resolve-key`. The card reads dismissing while that script runs and dismissed when it exits 0. A decision the snapshot cannot classify still sends one inbox answer; the [README](README.md) describes when that card reads dismissing. A decision is done when First Mate's state no longer reports it. See [attention derivation](src/server/fleet/attention.ts) and [direct dismiss](src/server/fleet/dismiss.ts).

## Message

An answer or note sent with First Mate's `fm-inbox.sh note`. A request id is reused on retry. The local outbox remembers unfinished submissions, while First Mate's receipts and the next fleet snapshot determine acknowledged and resolved state. See [inbox integration](src/server/fleet/inbox.ts).

## Provider quota

Account quota for each provider that is set up locally, plus Cursor while it waits for sign-in. The server runs `quota-axi --json --full --no-credential-refresh` about every two minutes, one read at a time, and caches it. Meters sit at the bottom of the side panel in every panel, and the activity strip shows a short summary when that column has room. The [README](README.md#provider-quota) describes what each meter shows. See [quota poller](src/server/quota/poller.ts) and [rail](src/cockpit/QuotaRail.tsx).

## Config root

The server's directory for settings, outbox and runtime files. `TINSTAR_CONFIG_HOME` overrides `~/.config/tinstar`; server code uses [`getConfigRoot()`](src/server/configRoot.ts).

## Reach

Opt-in tailnet access to the local server. Worker terminal ttyd processes stay on loopback and are accessed through the server proxy. See [reach](src/server/reach/).
