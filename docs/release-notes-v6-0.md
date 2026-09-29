# Tinstar 6.0.0 — First Mate cockpit

Tinstar now opens on a worker cockpit backed by First Mate's fleet snapshot. The [requirements](brainstorms/2026-09-24-tinstar-v6-requirements.md) describe the full product direction; the [release plan](plans/2026-09-28-001-feat-v6-cockpit-plan.md) records this release's scope.

## What changed

- **Worker rail and overview.** Every observed worker appears in the rail and in an overview grouped by state. Selecting one shows its objective, state, project, worktree, branch, pull request and live terminal. Faces and colors are stable across reloads. `Ctrl+[` and `Ctrl+]` cycle workers, including from a focused terminal. See [the cockpit](../src/App.tsx) and [fleet read](../src/server/fleet/cockpit.ts).
- **Needs You.** Decision, Blocked, Failure and Review Ready cards derive from First Mate's state. A pull request card links directly to GitHub; opening it does not approve or resolve it. See [attention derivation](../src/server/fleet/attention.ts).
- **Answers and messages.** A decision answer or “Tell First Mate about this” note goes through `fm-inbox.sh`. Saved, acknowledged and resolved are separate states; unfinished submissions persist in a local outbox. See [inbox integration](../src/server/fleet/inbox.ts).
- **Provider quota.** Compact meters in the rail show observed quota and reset or freshness information. Missing or stale readings are labelled. See [quota UI](../src/components/CanvasHud/ProviderQuotaCards.tsx).
- **Safe terminal views.** Private `tsview-*` sessions link worker windows without owning them. The proxy serves the view through Tinstar while ttyd stays on loopback. See [terminal views](../src/server/firstmate/views.ts).

## Upgrade notes

The V5 canvas, widgets, frontend plugin host, Tin Star-owned sessions, spawn and send APIs, NATS channels and simulator are removed. First Mate now owns worker lifecycle. Configure `firstmate.homes` to point at an installation with `bin/fm-fleet-snapshot.sh` and `bin/fm-inbox.sh`; see the [README](../README.md) for startup. Existing First Mate worker windows are observed and linked, not replaced.

`@tinstar/plugin-api` has no runtime host in this release. Deprecating the separately published npm package is a separate publish decision. Plugin author guides under [`docs/plugins/`](plugins/) describe the retired V5 system.

The first release does not include portfolio planning, worker launch, rich decision options, Context Threads, schedule drift, or objective editing. Those remain in the [V6 requirements](brainstorms/2026-09-24-tinstar-v6-requirements.md) for later work.
