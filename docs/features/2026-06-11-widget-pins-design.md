# Widget Pins — generalizing contextual pins into a quality of widget-ness

- **Date:** 2026-06-11
- **Branch:** V5.2
- **Status:** Design approved (direction); spec under review

## Summary

The browser plugin's contextual-pin feature — drop a pin on a spot, write a message, send it
to the agent with context about *where* you pinned — has been a hit. This design lifts it out
of the browser plugin and makes **pins an intrinsic capability of every canvas widget**, the
same way drag, resize, select, and snap already are. It also overhauls the interactions to be
direct and "juicy": drag a pin off a hover affordance onto a widget, click a pin to toggle its
message bubble, drag a dropped pin to reposition it.

The framing that makes this small: a widget's **position** is already a universal per-node
property stored *off* the entity (in `config.ui.layouts`, keyed by node id — `useWidgetLayouts.ts`),
and **snap/membership** is already a universal per-node store (`constellationGraph`, one per
space, revision-gated, SSE-synced — `document-store.ts:571`). Pins are the same kind of thing:
canvas-native node data, not entity data. They live beside snap edges, render through the shell,
and require almost no new plugin-API surface.

## Goals

- Any registered widget gets pins automatically — browser, run, editor, image, plugin-widget.
- Three direct interactions: **drag-to-place** from a per-widget hover affordance, **click-to-toggle**
  the message bubble, **drag-to-reposition** a dropped pin.
- Submitting a pin's message sends it to **the widget's backing agent/session**, carrying which
  widget + spot was pinned (and richer context where a plugin supplies it).
- Preserve the browser's content-scroll-glue and DOM capture without special-casing the core.
- Single code path for the Pin marker, bubble, gestures, store, and submit.

## Non-goals

- Pins on non-widget canvas chrome (toolbars, empty canvas). Pins attach to widgets only.
- A global "pin tool" / mode. Affordance is per-widget hover (decided).
- Cross-widget pin threads, replies, or pin lists. A pin is a single message at a spot.
- Reworking how sessions are addressed. We reuse the existing enter-prompt endpoint.

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Submit target | The widget's **backing agent/session** | Generalizes today's behavior; resolved at runtime from constellation slots. No backing session ⇒ submit disabled. |
| Pin source affordance | **Per-widget hover icon** (beside the snap `+`) | Self-contained, discoverable, no global chrome/mode. |
| Storage model | **Per-space pin store in the docstore**, mirroring `constellationGraph` | Pins are canvas-native node data, not entity data — sidesteps Editor/Image lacking PATCH. |
| Scroll-glue | **Opt-in `rendersOwnPinMarkers`** flag | Shell owns everything uniformly; browser keeps content-glue by self-rendering markers. One small seam. |

## Architecture

### Data model

```ts
interface Pin {
  id: string            // "pin-<ts>-<rand>"
  nodeId: string        // canvas node id, e.g. "browser-xyz", "run-R-abc"
  nx: number            // normalized 0..1 within the widget's content box
  ny: number
  comment: string
  createdAt: number
  sentAt?: number       // undefined = unsent; set on submit
  context?: PinContext  // opaque, plugin-supplied enrichment
}

interface PinContext {
  // Browser fills these; other widgets leave them undefined.
  url?: string
  target?: BrowserNoteTarget   // reuse existing type (tag/selector/text/imageSrc/within)
  [k: string]: unknown
}
```

`nx/ny` are normalized within the widget's **content box** so pins scale with the widget; the
marker visual counter-scales by `zoom` to stay tappable. For widgets that opt into
`rendersOwnPinMarkers`, `nx/ny` are interpreted by that widget (browser stores
document-content–relative coords and reprojects against scroll, preserving today's behavior).

### Storage & sync (mirror `constellationGraph`)

- New docstore collection `pinSets: Map<spaceId, PinSet>` where
  `PinSet { spaceId: string; pins: Pin[]; rev?: number }`.
- Mutator `upsertPinSet(spaceId, data)` — revision-gated exactly like `upsertConstellationGraph`
  (`document-store.ts:571-582`): returns `false` on stale/equal rev to suppress duplicate SSE.
- Endpoint `PUT /api/pins/:spaceId` (revision-gated), paralleling
  `PUT /api/constellation-graph/:spaceId` (`routes.ts:2547-2568`).
- SSE: docstore change emits `{ entity: 'pinSet', id: spaceId, data }`; clients merge into a
  `pins` slice of canvas state, the same way the constellation graph delta is merged.
- **GC:** when a node's entity is deleted, drop its pins (`pins.filter(p => p.nodeId !== id)`
  in the same path that removes the node from the constellation graph).

Rationale for per-space (not per-node) granularity: matches `constellationGraph`, keeps writes
revision-gated against a single small document, and lets the canvas load all pins in one delta.

### Session resolution (generic lift)

Extract the browser's resolver (`BrowserWidget.tsx:27-32`) into a shared helper:

```ts
resolveBackingSession(nodeId, constellation): string | null
// 1. if node id is "run-<sessionId>" → that sessionId
// 2. else find a run peer in the same constellation slot → its sessionId
// 3. else null
```

The shell's pin bubble uses this. `null` ⇒ send button disabled, tooltip
*"snap into a run to send."* Submitting POSTs to the existing
`/api/sessions/:id/enter-prompt` with a formatted message and sets `sentAt`.

### Shell integration (`CanvasWidgetShell`)

The shell already receives `nodeId`, `data`, `layout`, `zoom`, `isHovered`, `isSelected`,
`isDragging`, and the move/resize/select callbacks. It gains:

- **Hover affordance:** a pin icon fading in on hover, beside the snap `+` buttons
  (`CanvasWidgetShell.tsx:305-332` is the sibling pattern).
- **PinLayer (default renderer):** an `absolute inset-0 overflow-hidden` layer that renders this
  node's pins (filtered from the `pins` slice by `nodeId`) at `nx/ny`, plus the bubble. Skipped
  when the widget's registration sets `rendersOwnPinMarkers`.
- **Gesture engine `usePinGestures`:** pointer-capture + 5px threshold + the existing
  `[data-dragging]` iframe guard (`index.css:16-18`), driving place / toggle / reposition.

Pins opt-out via registration `pinnable: false` (default `true`).

### Plugin-API surface (minimal)

Additions to `WidgetRegistration` (`packages/plugin-api/src/index.ts:33-60`):

- `pinnable?: boolean` (default `true`)
- `rendersOwnPinMarkers?: boolean` (default `false`)

New API for widgets that enrich or self-render:

- `api.pins.useNodePins(nodeId): Pin[]` — reactive read of this node's pins.
- `api.pins.update(nodeId, pins): void` — patch this node's pins (revision-gated PUT under the hood).

No upward closures — consistent with the existing one-way data flow (widgets read context / the
store and write through the API; they never hand callbacks to the shell).

### Browser plugin (enrich + self-render, no parallel system)

- Sets `rendersOwnPinMarkers: true`; renders markers inside its scroll/overlay layer so pins
  glue to page content, reprojecting `nx/ny` against `iframeScroll` (today's logic in
  `BrowserPrimitive.tsx:267-304`).
- **Enrichment:** on observing a pin on its node with no `context`, the browser computes
  `{ url, target }` via `captureTarget()` (`notes/capture.ts`) and writes it back with
  `api.pins.update`. Drives the richer submit message.
- Its `formatPrompt` becomes the browser's `formatSubmit` contribution; the generic default is
  `📍 Pinned on <widget label> — <comment>`.

### Interactions

All gestures are shell-owned and uniform (browser only overrides marker *position*):

1. **Place:** hover widget → pin icon appears → `pointerdown` on icon starts a drag; a ghost pin
   follows the cursor (iframe guard active so iframe widgets don't swallow it) → `pointerup` over
   the widget body creates a pin at the local `nx/ny`, bubble opens for typing.
2. **Toggle:** `pointerup` on a pin under the 5px threshold = a click → show/hide its bubble.
3. **Reposition:** `pointerdown` + move past 5px on a pin → drag it; on release, update `nx/ny`.
   For widgets with a `capture`/enrichment hook (browser), re-run enrichment since the underlying
   element changed.
4. **Submit:** bubble send → `resolveBackingSession` → POST formatted message → set `sentAt`
   (marker switches to the "sent" checkmark state). No backing session ⇒ disabled.

Pins `stopPropagation` on `pointerdown` so they never trigger the shell's widget-drag handle.

## Migration

One-time, on canvas load: for each `browserWidget` with `notes[]`, convert each `BrowserNote`
to a `Pin` (`nx/ny` from the note; `context = { url, target }`; carry `comment`, `createdAt`,
`sentAt`) and write into the space's `PinSet` if not already migrated. Guard with a per-space
`pinsMigratedFrom: 'browser-notes'` marker (or check for existing pins on those nodes) so it runs
once. Leave `browserWidget.notes` in place for one release as a rollback safety net; remove later.

## Edge cases & error handling

- **Widget deleted with pins** → GC pins for that node (above).
- **No backing session** → submit disabled with explanatory tooltip; pin persists as unsent.
- **Concurrent edits / SSE race** → revision-gated `upsertPinSet` drops stale writes; client
  re-merges on the next delta (same guarantees as `constellationGraph`).
- **Cross-origin browser page** → `captureTarget` degrades to coords-only (no `target`); pin
  still works, message just omits element context (today's behavior).
- **Reposition off-widget** → clamp `nx/ny` to `[0,1]`; a drop outside the widget box is treated
  as a cancel of placement (no pin created) but a no-op-clamp for reposition.
- **Zoomed canvas** → marker counter-scales by `zoom`; hit target stays constant-size.

## Testing

- **Unit:** `resolveBackingSession` (run-id node, slot-peer node, orphan → null);
  note→pin migration mapping; revision-gating of `upsertPinSet`.
- **Component:** PinLayer renders/filters by `nodeId`; gesture thresholds (click vs. reposition);
  submit disabled when no session.
- **E2E (Playwright, `TINSTAR_FAST_SIM=1`):** drag-place a pin on a non-browser widget; toggle
  bubble; reposition; submit reaches the backing session; browser pins still glue on scroll.
- Type-check `-p tsconfig.app.json`; vitest with `--exclude='e2e/**'` (per docs/testing.md).

## Deferred: widget-entity unification (intentional)

Building pins surfaced a real smell: **backend persistence is heterogeneous** while the frontend
is not. Recorded here so the deferral is a decision, not an oversight.

- **Already unified (frontend):** one `WidgetRegistration`, one `CanvasWidgetShell`, one
  `WidgetProps`. This is why pins-in-the-shell work uniformly across all widget types.
- **Not unified (backend):** five separate docstore Maps (`runs`, `browserWidgets`,
  `editorWidgets`, `imageWidgets`, `pluginWidgets`) with uneven CRUD — browser/run/plugin expose
  PATCH; editor/image are POST/DELETE-only. The generic target already exists as
  `pluginWidgets` (the v5 unified widget); browser/editor/image are legacy bespoke types that
  predate it.
- **Why pins don't wait for it:** pins are stored *off* the entity — a universal per-space store
  keyed by node id, exactly like `config.ui.layouts` (position) and `constellationGraph`
  (snap/membership). They land on the unified side of the line, add nothing to the per-entity
  debt, and survive a future unification unchanged. The only contact points with entity
  heterogeneity are GC-on-delete (one hook per delete path) and `resolveBackingSession` — both
  small, both survivable.
- **What a future unification would do (its own spec, V6-scale):** collapse the legacy entity
  stores toward the `pluginWidgets` model — a single `Widget` base (id, type, type-specific data
  blob), uniform PATCH, one delete path, with a one-time migration of already-persisted docstore
  data. Pins are a reference implementation of the universal-property pattern that effort would
  generalize. It must not ride on this feature: high blast radius (every store/endpoint/SSE
  channel + persisted-data migration, against the ADR-0002 plugin boundary) and no place in a
  point release.

## Future (out of scope)

- Pin lists / jump-to-pin navigation.
- Pins on plugin widgets supplying their own `capture` (e.g. editor line/selection context).
- Per-pin color/category.
