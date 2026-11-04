# Tinstar Vision

Tinstar is the operator's visual cockpit for a [First Mate](https://github.com/kunchenguid/firstmate) fleet. It presents live worker state, attention, messages and quota without taking ownership of worker dispatch or lifecycle.

The current product introduction and navigation live in [README](../README.md). The [Overview reference](features/overview.md) describes the approved replacement presentation; the [V6 requirements](brainstorms/2026-09-24-tinstar-v6-requirements.md) and [release plan](plans/2026-09-28-001-feat-v6-cockpit-plan.md) retain the earlier release context.

## Design principles

- Show First Mate's observed state, including unknown or stale values, without inventing certainty.
- Make a worker recognizable across the worker switcher and worker view through stable identity, face and color.
- Keep request readiness and source identity explicit; see the [queue contract](features/reconciliation-queue.md).
- Preserve First Mate's authorized interfaces and distinguish saved, acknowledged and resolved receipts.
- Link terminal views to worker windows without taking ownership of the worker's tmux lifecycle.

The earlier canvas, widget and plugin vision belongs to the V5 history. It does not describe the current product.
