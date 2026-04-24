# The Saloon — agent NATS monitor

**Status:** Design approved, ready for implementation plan.
**Replaces:** The Procedures panel in the run-workspace right panel.

## Problem

The Procedures pane in the run-workspace right panel never produced the
workflow its author wanted. It occupies a scarce skinny vertical slot (160px
wide, above Telemetry) that is far more valuable as live visibility into the
agent's NATS activity — what it's subscribed to, whether it's connected, and
what's flowing in and out. Today, the only way to see any of that is the
global NatsTrafficWidget, which is session-agnostic and too wide for this
slot.

## Goal

Replace the Procedures panel with **The Saloon** — a session-scoped NATS
monitor that faithfully shows, in real time:

1. **Every subscription the agent is actually subscribed to**, including
   breakout rooms joined mid-session. Read from the session's authoritative
   subscription list; never derived from the task/epic/initiative hierarchy.
2. **Whether the agent is connected to the broker / channel-server.** One
   honest broker-level indicator.
3. **The message stream** for this session — inbound and outbound —
   filterable by substring and by direction.

## Non-goals

- Publishing from the Saloon. The existing NatsTrafficWidget has that; the
  Saloon is a monitor, not a console.
- Per-topic connection state. NATS has no such concept; we won't fake it.
- Cross-session aggregation. The Saloon is bound to one session = one agent.
- Persisting display state across reloads. Mute and filter state is
  ephemeral.
- Replacing or rethinking the Telemetry panel below it. Scope stays strictly
  on the Procedures slot.

## Procedures removal

Procedures is a dead feature and gets deleted, not hidden. Remove:

- `src/components/RunWorkspaceWidget/ProceduresPanel.tsx`
- `src/components/RunWorkspaceWidget/SkillPickerModal.tsx`
- `src/components/RunWorkspaceWidget/SaveSkillModal.tsx`
- `src/components/SkillsContext.tsx` (check for other consumers first)
- `src/hooks/useSkills.ts` (check for other consumers first)
- `src/domain/procedures.ts`
- Related API routes for procedure CRUD (to be enumerated during planning)
- `procedures` / `pendingSkills` / `optimisticProcedures` state and types
- The `tinstar-commit` skill-star and similar wiring only if exclusively
  consumed by Procedures; otherwise leave intact (planning step will verify)

If any of the above are consumed outside the Procedures UI (e.g. by the
hierarchy sidebar's entity settings dialog), the planning step must flag it
and decide per-consumer — delete or extract to a smaller module.

## The name

**The Saloon.** Header label renders as `SALOON` in Chakra Petch caps to
match the rest of the UI. Fits tinstar's frontier/sheriff metaphor
(wrangler, posse, tin star = badge). Reads naturally in tooltips: "join the
Saloon", "chatter in the Saloon".

## Data sources — single source of truth

The Saloon reads state that already exists; it does not compute or cache
its own truth.

| Concern | Source | Notes |
|---|---|---|
| Subscriptions list | `session.nats.subscriptions` on the server; surfaced to UI via `RunData.natsSubscriptions` | SSOT. Already mutated at session start AND on breakout-room join (`src/server/api/routes.ts:2683`). |
| Broker / control-socket health | `session.nats.enabled` + `session.natsControlOrphanedAt` | Green dot iff `enabled && !orphaned`. Red dot otherwise. Must be surfaced to the UI (see Plumbing). |
| Session identity (for outbound attribution) | `session.name` / `RunData.sessionId` | Used to match `event.sender` on the traffic bus for classifying outbound messages. |
| Message stream | `window` CustomEvent `tinstar:nats_traffic` | Same bus the NatsTrafficWidget subscribes to. Server-side origin: `src/server/nats-traffic.ts`. No new server endpoint needed for the stream itself. |

### Plumbing gaps to close

Two small data-plumbing changes, both additive:

1. **Surface `natsControlOrphanedAt`** on `RunData` (types.ts) and in the
   run projection that the UI consumes. One-line type addition + one-line
   projection field.
2. **Verify that joining a breakout room updates the run projection** so
   `RunData.natsSubscriptions` reflects the push at `routes.ts:2683`. If
   the projection is stale, wire the update through. Planning step
   investigates before assuming a fix is needed.

Neither change creates new SSOT — they just expose existing server state to
the UI.

## Layout

A 160px-wide vertical panel, two sections split by a draggable divider
(same pattern as today's Procedures/Telemetry split).

### Header row (28px)

- Broker dot (left): green = connected, red = orphaned/disabled. One
  honest signal.
- Label: `SALOON` in caps.
- Right: subscription count (`4 subs`).

### Subscriptions section (top half, resizable)

- One row per subject from `RunData.natsSubscriptions`.
- Subject display is truncated with ellipsis and full subject on
  `title`/tooltip.
- Color-coded by role:
  - **cyan** — broadcast (task channel, e.g. `tinstar.<space>.<init>.<epic>.<task>`)
  - **amber** — DM inbox (subject ends with `.<sessionName>`)
  - **purple** — breakout room (subject starts `tinstar.room.` OR
    was added via the breakout-room path; classifier lives in
    `subjectRole.ts`)
- **Click a row to toggle cosmetic mute.** Mute is display-only: messages
  from that subject are hidden from the stream in the widget. The agent
  continues to receive and act on them — this is a noise-cutting tool for
  the viewer, not a runtime subscription change.
- Muted rows dim to ~40% opacity and show a `visibility_off` material icon.
- Mute state lives in component-local `Set<string>` — resets on reload.

### Draggable divider

Reuse the pointer-down/move/up handlers from the current Procedures/
Telemetry divider; port them to a single-panel-internal divider between
Subscriptions and Stream.

### Stream section (bottom half)

- **Filter bar:** single text input. Substring match (case-insensitive,
  no regex) against both subject and message body. Matches highlighted
  inline in yellow.
- **`n hidden` pill** appears in the filter bar when any subscriptions
  are muted; click it to clear all mutes.
- **Message rows:**
  - No direction icon. See "Outbound attribution" below — v1 cannot
    reliably tell which messages this agent itself published, so we
    don't pretend to. Every row renders the same way.
  - Left-border color matches the subject's role (cyan / amber / purple),
    same palette as the Subscriptions list.
  - Timestamp (HH:MM:SS), then subject (truncated), then body (truncated,
    single line; no expand-in-place in v1 — keep scope tight).

### Outbound attribution (not in v1)

`NatsTrafficBridge.extractSender` in `src/server/nats-traffic.ts:136`
returns the last segment of the subject, which is the *task name* for
broadcasts and the *recipient session* for DMs — never the publisher.
The nats-channel MCP that backs `reply()` publishes directly to NATS
without routing through `bridge.publish()`, so no out-of-band tag is
available either.

The honest semantic for v1 is: **the Saloon shows all chatter on this
agent's subscriptions, including echoes of the agent's own broadcasts.**
Adding proper outbound attribution requires message-metadata changes
in the nats-channel MCP (tag every published message with the sender
session name in a NATS header or payload field) and is filed as a
follow-up, not part of this plan.
- Auto-scroll to bottom when new events arrive unless the user has
  scrolled up (same pattern as NatsTrafficWidget).
- Event retention: 200 most recent, dropped FIFO.
- Batching: flush setState once per animation frame to avoid storms under
  heavy traffic (port from NatsTrafficWidget).

## Components

New files, each with one clear responsibility:

```
src/components/RunWorkspaceWidget/
  SaloonPanel.tsx                      # top-level, header + split layout
  saloon/
    SubscriptionsList.tsx              # topic rows + mute toggle
    StreamView.tsx                     # filter bar + pills + message list
    useSaloonStream.ts                 # hook: tinstar:nats_traffic → scoped events
    subjectRole.ts                     # pure classifier + tests
```

Targets: each file under ~150 lines, each with a single responsibility,
testable in isolation.

`RunWorkspaceWidget/index.tsx` swaps `<ProceduresPanel>` for
`<SaloonPanel>`. The outer split between Saloon and Telemetry is unchanged.

## Interfaces

```ts
// subjectRole.ts
export type SubjectRole = 'broadcast' | 'dm' | 'breakout'
export function classifySubject(subject: string, sessionName: string): SubjectRole

// useSaloonStream.ts
export interface SaloonEvent {
  timestamp: string
  subject: string
  data: string
  direction: 'inbound' | 'outbound'
  sender?: string
}
export function useSaloonStream(sessionName: string, subscriptions: string[]): SaloonEvent[]
// - subscribes to window 'tinstar:nats_traffic'
// - keeps an event if subject is in `subscriptions` OR sender === sessionName
// - batches via requestAnimationFrame, caps at 200

// SaloonPanel props
interface Props {
  taskId: string
  sessionId: string
  sessionName: string
  subscriptions: string[]
  natsEnabled: boolean
  natsControlOrphanedAt: string | null
  onCollapse?: () => void
}
```

## Error and edge cases

- **`natsEnabled === false`** → broker dot red, header shows `NATS off`,
  Subscriptions list empty with a muted "NATS not configured for this
  session" line, stream shows nothing.
- **Orphaned control socket** (`natsControlOrphanedAt` set) → broker dot
  red, tooltip on dot explains: "Control socket orphaned — dynamic
  subscribes lost. Restart session to recover."
- **Empty subscriptions** (rare, session just started) → show
  "No subscriptions yet" placeholder in the Subscriptions list. Stream
  still functions if outbound events arrive.
- **Event storm** → rAF batching + 200-event cap keep the panel responsive.
- **Subject role classifier ambiguity** (e.g. a broadcast subject that
  happens to end in the session name) → tests cover this; the classifier
  checks breakout prefix first, then DM suffix, else broadcast.

## Testing

- **Unit:** `subjectRole.ts` — broadcast, DM (ending in session name),
  breakout (prefix match), ambiguous cases.
- **Unit:** `useSaloonStream` — filtering by subscription set, 200-event
  cap, rAF batch flush.
- **Component:** `SaloonPanel` — renders broker dot states, empty states,
  mute toggling, filter substring highlighting, `n hidden` pill
  behavior.
- **E2E:** one smoke test in `e2e/` — open a run, assert the Saloon
  header renders with expected subscription count, assert a simulated
  inbound event appears in the stream (leverages `TINSTAR_FAST_SIM=1`).

## Out of scope (for a later spec)

- Publish-from-Saloon. Use the global NatsTrafficWidget for now.
- **Outbound (Sent vs Received) distinction.** Requires adding a sender
  tag to every published NATS message via the nats-channel MCP. Filed
  as a follow-up.
- Persistent mute/filter state across reloads.
- Expand-in-place for multi-line message payloads. Current cap: single
  line, truncated, tooltip shows full body.
- Per-topic liveness pulses or traffic counters on the topic rows.
- Reworking Telemetry or the right-panel split shape.

## Traffic bridge wiring

For the Saloon to observe messages, `NatsTrafficBridge` must be
subscribed to each of this session's subjects. Today the bridge only
subscribes when a `NatsTrafficWidget` registers subjects via
`updateWidgetSubscriptions`. The Saloon has no widget on the canvas, so
we need a different path.

Approach: whenever a session's `nats.subscriptions` list changes (session
creation, breakout-room join, session stop), the server registers the
full list with the bridge under a synthetic key `saloon:<sessionName>`.
Same `updateWidgetSubscriptions` API the bridge already exposes — no new
concept, just a new caller. On session stop, `removeWidget` is called
with the same key to unsubscribe.

This adds no new SSOT: it simply keeps the bridge mirroring what the
session authoritatively wants to hear.
