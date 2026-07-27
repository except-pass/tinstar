---
date: 2026-07-21
topic: mobile-mode
---

# Mobile Mode

## Summary

Give Tinstar a phone-shaped projection of the same server-authoritative state: a scrollable list/stack view — not the infinite canvas — where an on-call responder can see which agents are running, idle, or asking for them, read a run's recap, and drop a prompt or answer a notice. It is a responsive web view of the runs, sessions, and notices that already exist, entered from the same URL on a small screen. It is usable by the solo owner checking their own fleet from the couch today, and it is the surface a teammate lands on when they open a shared-room invite link from Teams once Units 1 and 2 exist.

## Problem Frame

The canvas is the wrong instrument for a phone. `src/components/InfiniteCanvas.tsx` is an infinite pan/zoom plane whose whole value is spatial: widgets live at remembered coordinates, arrangement is meaningful and never auto-managed, and interaction assumes hover, precise pointer targeting, and drag. On a 390-pixel-wide touch screen none of that survives — pinch-zoom fights the canvas camera, drag-to-arrange has no place, hover states are unreachable, and a wall of freely-positioned widgets is unreadable at phone scale. Forcing the canvas onto a phone would be desktop-hostile.

But the *reason* someone reaches for a phone is real and specific. A server is down. A responder is away from their desk and gets a link — from Serena in Teams, or just from their own pocket. They do not need to rearrange a workspace. They need four things, fast: is anything on fire (which agents need a human), what did the agent find (recap/output), the ability to unblock it (answer the prompt, or send one), and a way to work down the pile (triage the inbox). That is read-and-steer, not build-and-arrange.

Tinstar already derives exactly this state. The sidebar's `inbox` view (`src/components/HierarchySidebar.tsx`, the `view === 'inbox'` branch backed by `src/hooks/useInbox.ts`) is already a flat, triaged, sorted list of rows — sessions needing attention float to the top, each row carrying a `SessionStatus` and an optional `AttentionState`. That is the phone surface, almost verbatim. Mobile mode is largely a matter of choosing to render the projection Tinstar already computes, sized and touch-shaped for a phone, instead of the canvas.

## Key Decisions

**Mobile is a projection of the same state, not a separate app.** This follows VISION Pillar 2 directly: personas see one server-authoritative truth through different projections. The phone view subscribes to the same SSE stream (`src/hooks/useServerEvents.ts`), reads the same runs/notices, and steers through the same endpoints as the desktop. There is no mobile-only data model, no divergent state, and no second backend. When a run changes on someone's desktop, the phone reflects it, and vice versa. Building mobile as a preset/projection is what keeps it cheap and what keeps it honest — a phone user and a desktop user are looking at the same room.

**The mobile surface is the list/inbox, not the canvas.** Mobile does not attempt to render `InfiniteCanvas`, pan/zoom, or free widget positions. It presents a vertically-scrolling list driven by the existing hierarchy tree (`src/domain/grouping.ts`) and inbox model (`useInbox`). Tapping a run opens a focused single-run view (recap, output, steer controls) that fills the screen, and a back gesture returns to the list. This is the one decision that makes mobile tractable at all: it swaps a spatial, 2-D, arrangement-bearing surface for a linear, 1-D, triage-bearing one — the shape phones are built for.

**Mobile is read + steer, never arrange.** Movement — dragging, snapping into constellations, positioning widgets, resetting layout — is a desktop affordance tied to spatial memory, and the VISION is explicit that arrangement is meaningful, persistent, and never auto-managed. None of that exists on the phone. A phone user reads state and acts on runs (prompt, answer a notice). They cannot move anything, and crucially they cannot *disturb* anyone else's arrangement — because there is no arrangement on this surface to disturb. This keeps the door to full co-presence open (a phone participant is still an identified participant reading shared truth) without ever letting a small screen stomp a desktop's layout.

**Mobile ships independent of multiplayer.** The whole value — see my fleet, read a recap, unblock an agent — works for the solo owner hitting their own Tinstar URL from their own phone, with zero dependency on identity, rooms, or invite links. Units 1 (presence substrate) and 2 (shared rooms + invite links) are a *synergy*: when they land, the invite-link a teammate opens from Teams simply resolves to this same mobile projection on their phone. Mobile does not block on them, and they do not block on mobile. The anchor scenario is written to degrade gracefully — the couch-checking solo owner is the floor; the Teams responder is the bonus.

**Mobile is responsive web, not a native app.** The phone view is served by the same Vite frontend at the same origin and reached from the same URL. There is no App Store binary, no push-notification entitlement, no separate build target. Native is a different product identity with its own distribution, review, and platform-API cost; responsive web gets the anchor use case with the substrate that already exists (one HTTP server, one SSE stream, `apiFetch`).

## Requirements

**Mobile surface & navigation**

R1. On a phone-sized viewport, Tinstar renders a vertically-scrolling list/stack view of the current space's runs and notices instead of the infinite canvas. `InfiniteCanvas` and its pan/zoom camera are not mounted.
R2. The list is driven by the existing hierarchy tree and inbox model — it reuses `useInbox` / `src/domain/grouping.ts` data, not a new mobile-only query — so it stays in sync with what those already compute for the desktop.
R3. Rows requesting attention sort to the top, matching the inbox's existing ordering, so the most-urgent runs are reachable without scrolling.
R4. Tapping a row opens a focused single-run view that fills the screen: the run's identity, its status, its recap/output, and its steer controls. A back affordance returns to the list without losing scroll position.
R5. The mobile view subscribes to the same SSE event stream as the desktop; a status change, a new notice, or a recap update appears on the phone without a manual refresh.
R6. The mobile view exposes a way to switch the active space if more than one exists, since the underlying state is space-scoped and the list shows only the active space's entities.
R7. No surface in mobile mode offers drag, snap, constellation grouping, widget positioning, reset-layout, or any spatial-arrangement control. Those controls are absent, not merely disabled.

**Doneness-at-a-glance status**

R8. Every run row shows its `SessionStatus` (`creating` / `running` / `idle` / `needs_attention` / `stopped`) with a legible at-a-glance treatment — color plus a non-color cue (icon or label), sized for a glance on a phone, not a hover tooltip.
R9. A run with a pending `AttentionState` (an agent that needs a human) is visually distinct from a run that is merely `running` or `idle`, so "needs you" reads differently from "busy" and from "quiet".
R10. Status uses no-zero-defaults discipline: a run with unknown or absent telemetry renders a neutral placeholder, never a fabricated "0" or a false "idle".
R11. The list conveys aggregate doneness — a count or badge of how many runs currently need a human — so the responder knows the size of the pile before scrolling it.
R12. Status treatments do not rely on hover to disambiguate; the distinction between states must be readable from the resting rendered row.

**Steering — prompt & answer**

R13. From a focused run view, the user can submit a prompt to that run using the same prompt-submission endpoint the desktop uses — not tmux send-keys and not a mobile-only path.
R14. When a run has a pending notice with an interactive A2UI body, the mobile view renders that notice's answerable controls and submits the answer to `POST /api/notices/:id/answer`, the same endpoint the Roundup board uses.
R15. Prompt and answer inputs use touch-appropriate targets — comfortably tappable controls, a text field that plays well with the on-screen keyboard, and no reliance on precise pointer placement or hover.
R16. Steering actions give immediate optimistic feedback (the sent prompt / submitted answer appears without waiting on the round-trip), consistent with the product's snappy-feedback philosophy.
R17. If Unit 5 (A2UI in the run workspace) is present, the richer in-run A2UI panels are rendered in the focused run view through the same renderer, giving the phone more steerable surface; if absent, mobile steering degrades to prompt-and-notice-answer with no error.

**Entry & detection**

R18. Mobile mode is reachable from the same origin and URL as the desktop app — a teammate (or the owner) opening the Tinstar URL on a phone lands in the projection without a separate address or build.
R19. The projection is selected by viewport, so a phone-sized screen gets the list view by default without the user choosing it.
R20. The user is not trapped in the projection chosen for them: a phone user can request the full (desktop/canvas) experience, and that choice is remembered, so detection is a smart default rather than a hard gate.
R21. Mobile detection changes only which projection renders; it never changes, forks, or migrates the underlying server state, layouts, or config.

## Key Flows

F1. **On-call responder unblocks a stuck agent from their phone**
- **Trigger:** A run has posted a notice asking a question (or a run has gone `needs_attention`); the responder is away from their desk and opens Tinstar on their phone.
- **Actors:** The responder (solo owner today; a joined guest once Units 1/2 exist), the stuck run, the server's SSE stream.
- **Steps:**
  1. The responder opens the Tinstar URL on their phone; the viewport is phone-sized, so the list/stack view renders instead of the canvas.
  2. The list shows an aggregate badge — e.g. "2 need you" — and the two attention-requesting runs are sorted to the top with a distinct "needs you" treatment.
  3. The responder taps the top run; the focused single-run view fills the screen with the run's status, recap/output, and its steer controls.
  4. The responder reads the recap to understand what the agent found and what it is blocked on.
  5. If the block is a notice with A2UI controls, the responder answers it inline (posted to `/api/notices/:id/answer`); otherwise they type a prompt into the touch-sized field and send it.
  6. The action shows optimistic feedback immediately; the SSE stream then reflects the run resuming, and its row drops out of the "needs you" set.
- **Outcome:** The agent is unblocked from a phone, using the same state and the same endpoints as the desktop, without the responder ever touching the canvas.

## Acceptance Examples

AE1. **Covers R1, R7, R19.** A user opens Tinstar on a phone. The infinite canvas is not rendered; a vertical scrolling list is. There is no pan/zoom, no draggable widget, and no reset-layout control anywhere on the surface. The user did not have to toggle anything to get here.

AE2. **Covers R8, R9, R12.** The list contains one `running` run, one `idle` run, and one run with a pending attention state. Without hovering, tapping, or zooming, the three are visually distinguishable at rest, and the attention run reads as "needs you" rather than "busy".

AE3. **Covers R3, R11.** Two of eight runs need a human. Both sort above the six that do not, and a badge at the top of the list reads "2 need you" before the user scrolls.

AE4. **Covers R4, R13, R15, R16.** The user taps a run, lands in a full-screen focused view, types into a touch-sized field, and sends a prompt. The prompt appears immediately (optimistic) and is delivered through the same endpoint the desktop prompt uses. A back gesture returns the user to the list at the same scroll position.

AE5. **Covers R14, R15.** A run has a notice with a Choice/Submit A2UI body. On the phone, the choices render as tappable controls, and submitting posts to `/api/notices/:id/answer`. The user never needed precise pointer placement.

AE6. **Covers R5.** While the user is looking at the list, a desktop teammate's action flips a run from `running` to `needs_attention`. The phone's list reflects the new status and re-sorts without a manual refresh.

AE7. **Covers R10.** A run with no telemetry yet renders a neutral placeholder for its metrics, not a "0" and not a false "idle".

AE8. **Covers R20, R21.** A phone user taps "use full experience" and gets the canvas; the choice is remembered on that device. No server state, layout, or config was changed by either the detection or the override.

AE9. **Covers R17.** With Unit 5 present, opening a run that has an in-run A2UI panel renders that panel in the focused mobile view. With Unit 5 absent, the same run opens with recap and prompt-and-notice steering and no error.

## Scope Boundaries

**Deferred for later**
- **Native mobile app.** iOS/Android binaries, App Store distribution, and native push notifications are out of this unit. Mobile mode is responsive web served from the same origin. Native is a separate product decision, not a v5.4 step.
- **Mobile-initiated multiplayer.** Generating invite links, managing a room, or granting capabilities *from* a phone is out of scope; mobile is a projection that a link resolves *into*. The join-from-Teams flow itself belongs to Units 1/2; mobile only has to render correctly once a guest is in.
- **Rich per-widget mobile projections.** Beyond the run/notice surfaces named here, other widgets (Saloon/NATS traffic, fleet, graveyard, telemetry rails) do not get bespoke phone layouts in v1. Which of them earn a mobile projection later is an open question below.
- **Offline / background push.** No service worker, no background sync, no notification-while-closed. The phone shows state while the page is open, over SSE.

**Outside this product's identity**
- **Canvas editing on a phone.** Pan/zoom, drag-arrange, constellation snapping, widget positioning, and reset-layout are desktop affordances tied to spatial memory. They are not "not yet on mobile" — they are deliberately never on mobile, because arrangement is a desktop channel and a small screen must not be able to disturb it.
- **A divergent mobile data model.** There is no mobile-only state, cache, or backend. If it isn't derivable from the same server-authoritative state the desktop reads, it does not belong here.

## Dependencies / Assumptions

- **Reuses the existing inbox, hierarchy, recap, and notice-answer surfaces.** The list is `useInbox` / `src/domain/grouping.ts`; the recap is the run-workspace widget's terminal-recap panel; the notice answer is `POST /api/notices/:id/answer` with the read-only A2UI renderer from `src/plugins/roundup/src/a2ui/`. Mobile is a reprojection of these, not new machinery. **Assumption, to verify in planning:** these render surfaces can be composed into a phone layout without a desktop-only dependency (e.g. a canvas coordinate or hover-only control) baked into them.
- **Reuses the existing SSE stream and `apiFetch`.** `src/hooks/useServerEvents.ts` (single `EventSource`) and `src/apiClient.ts` (`apiFetch`/`apiUrl`) are the same on a phone. No new transport.
- **Independent of Units 1–4.** The solo-owner-on-their-couch use case needs no identity, room, invite, or capability model. **Synergy with Unit 2 (shared rooms + invite links):** the Teams-responder scenario lands when a guest can join a room via link; at that point the link resolves to this mobile projection with no additional mobile work beyond rendering as a guest.
- **Compounds with Unit 5 (A2UI in the run workspace).** If Unit 5's in-run A2UI is present, the focused mobile run view renders it through the same renderer for richer steering (R17). Mobile does not require Unit 5 — without it, steering is prompt + Roundup-style notice answer.
- **Assumes viewport-based detection is sufficient for v1** (see Outstanding Questions) — that a CSS/viewport signal, not server user-agent sniffing, can select the projection.

## Outstanding Questions

**Resolve before planning**
- **Detection mechanism.** Viewport-width media query, a JS viewport check at mount, user-agent sniffing, or an explicit toggle with a remembered preference — which is the smart default, and where does the override live (per-device localStorage via `src/lib/uiPrefs.ts`, or a URL param)? R19–R21 assume viewport-first with a remembered override; confirm that survives tablets and desktop-narrow windows without misfiring.
- **What counts as "phone-sized."** The exact breakpoint(s), and whether tablet gets the list, the canvas, or a third layout, needs a concrete threshold before build.

**Deferred to planning**
- **Which widgets get a mobile projection in v1** beyond run + notice. Is fleet-view worth a phone layout for at-a-glance status? Does the Saloon/NATS traffic surface matter on a phone, or is it desktop-only? Pick the v1 set during planning.
- **Recap sizing and truncation on a phone.** How much recap/output shows before a "read more", and whether long terminal output needs its own scroll container within the focused view.
- **Aggregate badge semantics.** Whether "needs you" counts notices, `needs_attention` runs, or both — and whether it is space-scoped or fleet-wide.
