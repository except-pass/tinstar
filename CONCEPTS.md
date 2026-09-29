# Concepts

Current product terms for the First Mate cockpit. The [requirements](docs/brainstorms/2026-09-24-tinstar-v6-requirements.md) define the broader product contract.

## First Mate home

A configured First Mate installation in `firstmate.homes`. Each home supplies a fleet snapshot and an inbox command. Tinstar does not own its worker records or lifecycle. See [fleet config](src/server/fleet/config.ts).

## Worker

A task in First Mate's fleet snapshot. Its id is the stable identity used for the rail, face and color. The worker's state and detail come from the snapshot, while the objective comes from the brief's captain intent and falls back to the backlog title. A persistent second mate's child-outcome status line never becomes its own displayed state. A worker whose snapshot kind is `secondmate` shows a Second mate badge on its overview card and in the detail rail; ship, scout, and other kinds do not. Unknown values remain visible. The overview groups that fleet on two levels, chosen from status, project, and direct or managed work, and the browser remembers the choice. A filter above it fuzzy-matches name and objective. A direct mark is stored in `worker-marks.json` under the config root, keyed by the worker's home and id, and First Mate is notified when it changes. See [worker state](src/server/fleet/workerState.ts), [cockpit fleet](src/server/fleet/cockpit.ts), [worker marks](src/server/fleet/marks.ts), [overview grouping](src/cockpit/groupWorkers.ts), and [overview filter](src/cockpit/overviewQuery.ts).

## Worker view

The main pane for one worker: identity, state, objective, project, worktree, branch, pull request and a live terminal view. The terminal uses a private `tsview-*` tmux session linked to the worker window; the view does not own that window. A worker link opens it by task id; the [README](README.md#worker-links) lists the URL shapes. See [terminal views](src/server/firstmate/views.ts).

## Needs You

The rail's attention list. Decision, Blocked, Failure and Review Ready are derived from the snapshot; opening a card never resolves it. A decision card can slide to dismiss, which sends one inbox answer asking First Mate to dismiss that task and decision key; the [README](README.md) describes when the card reads dismissing. A decision is done when First Mate's state no longer reports it. See [attention derivation](src/server/fleet/attention.ts).

## Message

An answer or note sent with First Mate's `fm-inbox.sh note`. A request id is reused on retry. The local outbox remembers unfinished submissions, while First Mate's receipts and the next fleet snapshot determine acknowledged and resolved state. See [inbox integration](src/server/fleet/inbox.ts).

## Provider quota

Observed account quota, separate from a worker's context window. The rail labels stale or unavailable sources rather than displaying an invented zero. See [provider observations](src/hooks/providerObservationsStore.ts).

## Config root

The server's directory for settings, outbox and runtime files. `TINSTAR_CONFIG_HOME` overrides `~/.config/tinstar`; server code uses [`getConfigRoot()`](src/server/configRoot.ts).

## Reach

Opt-in tailnet access to the local server. Worker terminal ttyd processes stay on loopback and are accessed through the server proxy. See [reach](src/server/reach/).
