# Tinstar Vision

Tinstar is the operator's visual cockpit for a [First Mate](https://github.com/kunchenguid/firstmate) fleet. It presents live worker state, attention, messages and quota without taking ownership of worker dispatch or lifecycle.

The first release focuses on an overview, direct worker navigation, safe terminal views, four Needs You card types, and answers and messages through First Mate's inbox. The [V6 requirements](brainstorms/2026-09-24-tinstar-v6-requirements.md) are the product contract; the [release plan](plans/2026-09-28-001-feat-v6-cockpit-plan.md) records which requirements are in this release and which remain for later work.

## Design principles

- Show First Mate's observed state, including unknown or stale values, without inventing certainty.
- Make a worker recognizable across the worker switcher and worker view through stable identity, face and color.
- Keep attention cards distinct by type and make their actions explicit.
- Send answers and messages through First Mate's documented inbox; show saved, acknowledged and resolved as separate states.
- Link terminal views to worker windows without changing the worker's tmux lifecycle or size.

The earlier canvas, widget and plugin vision belongs to the V5 history. It does not describe the current product.
