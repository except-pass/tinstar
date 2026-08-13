---
title: Focus Mode Thumb Button Navigation - Plan
type: feat
date: 2026-08-13
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
deepened: 2026-08-13
---

# Focus Mode Thumb Button Navigation - Plan

## Goal Capsule

Give mouse users the same ready-session navigation already available from `Ctrl+[` and `Ctrl+]`: while Focus mode is active, the Back thumb button selects the previous ready session and the Forward thumb button selects the next ready session. The binding must work over both the host UI and the nested ttyd terminal, consume browser-history navigation only when Focus owns the gesture, and leave Canvas mode unchanged.

The existing Focus queue, filtering, and selection callbacks remain authoritative. This work adds an input route; it does not create a second cycling algorithm, a configurable mouse-binding system, or an all-session mouse gesture.

## Product Contract

### Summary

Mouse side buttons become Focus-mode aliases for the ready-session cycle commands. Back maps to previous and Forward maps to next, matching the direction and semantics of `Ctrl+[` and `Ctrl+]`.

### Problem Frame

Tinstar already supports fast keyboard cycling, including a bridge for when ttyd owns keyboard focus. Many mice expose dedicated Back and Forward buttons, but the browser currently owns those gestures for history navigation. Focus mode is a single-session workspace where those buttons are more valuable as session navigation, provided Tinstar can synchronously consume the browser default and preserve ordinary browser behavior everywhere else.

### Requirements

- R1. **Focus-only mapping.** While Focus mode is active, mouse button `3` (X1/Back) invokes the existing previous-ready-session action and mouse button `4` (X2/Forward) invokes the existing next-ready-session action.
- R2. **Existing cycle authority.** Mouse navigation inherits the ready queue's current ordering, visibility, eligibility, wraparound, and selection behavior from `WorkspaceShell`; it must not calculate its own target.
- R3. **Gesture ownership.** In Focus mode, Tinstar consumes Back/Forward press, release, and auxiliary-click defaults, and invokes at most one cycle action per physical gesture. The gesture remains consumed even when the ready queue cannot select a different target, matching the no-op-but-consumed keyboard binding.
- R4. **Terminal parity.** R1-R3 hold when the pointer is over the outer application and when it is over the same-origin terminal wrapper or its nested ttyd iframe.
- R5. **Canvas preservation.** Outside Focus mode, Tinstar neither cycles sessions nor cancels Back/Forward mouse events; native browser behavior remains available.
- R6. **Input isolation.** Primary, middle, secondary, and any unrecognized mouse buttons keep their existing behavior in every presentation.
- R7. **No new preference.** The mapping follows the existing per-browser Focus-mode state and introduces no separate setting or persisted binding.

### Acceptance Examples

- AE1. **Back over host UI.** Given Focus mode is active and the ready queue has a previous target, releasing the Back thumb button over the app selects that target exactly once and does not navigate browser history. Covers R1-R3.
- AE2. **Forward over ttyd.** Given Focus mode is active and ttyd owns pointer focus, releasing the Forward thumb button over the terminal selects the next ready target exactly once and does not navigate browser history. Covers R1-R4.
- AE3. **Empty or single-item ready queue.** Given Focus mode is active but cycling cannot change the target, a Back or Forward gesture leaves the focused session unchanged and still does not navigate browser history. Covers R2-R3.
- AE4. **Canvas mode.** Given Focus mode is inactive, Back/Forward events over either the host UI or terminal do not emit session-cycle actions and are not canceled by Tinstar. Covers R5.
- AE5. **Other buttons.** Given any presentation, primary, middle, secondary, or unknown buttons do not emit session-cycle actions through this feature. Covers R6.

### Scope Boundaries

In scope:

- Back/Forward thumb buttons as aliases for ready-session previous/next in Focus mode.
- Host-window and nested-terminal input paths.
- Browser-default suppression, duplicate-event prevention, automated coverage, and a real-hardware verification pass.
- A concise update to the hotkey/input documentation.

Out of scope:

- User-configurable mouse bindings or remapping vendor-specific mouse software.
- Mouse bindings for all-session cycling, Canvas navigation, or other commands.
- Changing ready-session eligibility, queue ordering, Focus selection, or browser support policy.
- UI affordances that advertise the mouse mapping in the shortcut palette.

### Key Product Decisions

- **Back means previous; Forward means next.** (session-settled: user-directed — chosen over preserving native browser history in Focus: the user explicitly requested Back/Forward to mirror ready-session previous/next) This is the user-requested Focus-only directional mapping and mirrors browser-history direction. Governs R1 and R5.
- **Focus owns the whole recognized gesture.** Falling through to browser history when the queue is empty or has one item would make the same input nondeterministic. The binding therefore remains consumed for the entire time Focus is active. Governs R3 and R5.
- **No separate preference.** The input is a property of Focus presentation, not a new configurable mode. Governs R7.

## Planning Contract

### Context and Research

- `src/hotkeys/useGlobalHotkeys.ts` already centralizes page-level ready-session input and delegates target selection through `onCycleReadyNext` and `onCycleReadyPrev`.
- `src/components/WorkspaceShell.tsx` owns Focus state through `focusModeRef` and owns the ready-session queue and selection callbacks. It also receives terminal cycle actions through `tinstar:terminal-session-cycle`.
- `public/terminal-wrapper.html` already bridges `Ctrl+[` / `Ctrl+]` from both the wrapper and nested ttyd document to the host. DOM events inside the terminal iframe do not bubble to the app window, so terminal parity must extend this bridge rather than relying on the global listener.
- `src/components/RunWorkspaceWidget/RunSessionPanel.tsx` is the validated same-origin boundary for terminal messages and is the appropriate host-side owner for synchronizing presentation state into the wrapper.
- `e2e/focus-mode.spec.ts` already keeps the shipped wrapper in the loop while stubbing only ttyd, making it the strongest integration seam for the new nested-frame behavior.
- `docs/solutions/ui-bugs/focus-mode-terminal-reflow-when-switching-run-workspaces.md` establishes that Focus cycling must preserve mounted terminal identity and geometry; this feature must route through existing selection rather than reload or re-key terminal frames.
- The current W3C Pointer Events draft assigns X1/Back to `MouseEvent.button === 3` and X2/Forward to `button === 4`: https://www.w3.org/TR/pointerevents/
- Current Chromium handles Back/Forward navigation on an unconsumed mouse-up after renderer processing, so canceling the recognized `mouseup` is load-bearing; canceling the accompanying down/auxiliary-click events prevents partial browser defaults: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/web_contents/web_contents_impl.cc

### Key Technical Decisions

- KTD1. **Reuse actions, not synthetic keys.** The host listener calls the ready-next/ready-prev handlers directly. The terminal wrapper posts the existing `terminal-session-cycle` actions. Synthesizing `Ctrl+[` or `Ctrl+]` would add browser/platform key semantics and bypass the established action boundary. Governs R1-R2 and R4.
- KTD2. **Dispatch on `mouseup`; suppress the recognized gesture.** Capture-phase listeners identify buttons `3` and `4`. While Focus is active, `mousedown`, `mouseup`, and `auxclick` are canceled, but only `mouseup` emits a cycle action. This aligns with Chromium's history-navigation phase and prevents duplicate actions from the event family. Governs R3, R5-R6.
- KTD3. **Synchronize Focus presentation through a readiness handshake.** `RunSessionPanel` sends the current Focus presentation to its owned terminal iframe whenever presentation changes. The wrapper also announces readiness after installing its message listener, causing the validated host boundary to resend the current value; this closes the race where an early host message could be dropped and naturally repeats after a wrapper reload. The wrapper keeps only the latest boolean needed to decide synchronously whether to cancel a side-button event, treating unknown state as inactive. Query parameters are rejected because changing the iframe URL when Focus toggles could reload ttyd. Governs R4-R5 and R7.
- KTD4. **Preserve the validated terminal boundary.** Wrapper-originated cycle messages continue through `RunSessionPanel`'s source, origin, session-name, and action allowlist checks. The new presentation message targets the owned wrapper origin and does not broaden accepted terminal actions. Governs R4.

### High-Level Technical Design

The following flow is directional guidance, not implementation syntax:

```text
Host UI gesture
  -> global capture listener checks Focus + button
  -> cancel recognized gesture
  -> on mouseup call existing ready-prev / ready-next callback
  -> WorkspaceShell resolves and selects from its existing queue

Nested ttyd gesture
  -> terminal-wrapper capture listener checks synced Focus + button
  -> cancel recognized gesture
  -> on mouseup post existing ready-prev / ready-next action
  -> RunSessionPanel validates source/origin/session/action
  -> WorkspaceShell receives tinstar:terminal-session-cycle
  -> same existing queue and selection authority

Focus state synchronization
  -> RunWorkspaceWidget passes presentation to RunSessionPanel
  -> RunSessionPanel sends current state when presentation changes
  -> wrapper-ready handshake causes a validated resend after listener install/reload
  -> later Focus changes replace the wrapper's in-memory boolean
```

### System-Wide Impact

- **Input entry points:** global window mouse events and terminal-wrapper/nested-ttyd mouse events gain a Focus-aware route.
- **State flow:** Focus presentation becomes an explicit prop/message from `RunWorkspaceWidget` through `RunSessionPanel` to the wrapper. It remains derived UI state and is not persisted separately.
- **Action flow:** both input surfaces converge on the existing ready-cycle handlers; queue and selection behavior remain unchanged.
- **Failure behavior:** stale or missing wrapper state must behave as Focus-inactive—do not cancel or cycle until the wrapper knows Focus is active. A malformed or untrusted wrapper message remains ignored.
- **Browser boundary:** synthetic DOM tests can prove mapping, cancellation flags, and message counts, but cannot prove browser chrome history suppression. That final claim needs one real side-button mouse pass in the supported Chromium runtime.

### Risks and Mitigations

- **Duplicate cycles from related mouse events.** Mitigate by emitting only on `mouseup`, canceling related defaults without dispatch, and asserting one action for a full down/up/auxclick sequence.
- **Browser history escapes from the terminal.** Mitigate by attaching capture listeners to both the wrapper and nested ttyd window and by verifying default prevention at each surface.
- **Canvas mode loses native navigation.** Mitigate with negative tests for both host and terminal paths after leaving Focus.
- **Focus state races on iframe load.** Mitigate with a wrapper-ready handshake plus updates on presentation changes; validate the readiness source like existing inbound messages, target outbound state to the owned wrapper origin, and treat unknown state as inactive.
- **Hardware/browser variation.** Standard button values are stable, but OS drivers and browser shells can remap gestures. Keep the implementation standards-based and record real-hardware verification separately from synthetic coverage.

## Implementation Units

### U1. Add the Focus-gated host mouse binding

**Requirements:** R1-R3, R5-R7; AE1, AE3-AE5

**Depends on:** none

**Files:**

- `src/hotkeys/useGlobalHotkeys.ts` — extend the centralized global input hook with Focus-state access and capture listeners for the recognized mouse event family; reuse the ready-cycle callbacks.
- `src/components/WorkspaceShell.tsx` — supply the existing event-time Focus authority to the global input hook without duplicating queue logic.
- `src/hotkeys/__tests__/useGlobalHotkeys.test.tsx` — add focused unit coverage for event mapping, cancellation, single-dispatch behavior, inactive-state fallthrough, and unrelated buttons.
- `docs/features/hotkey-system.md` — document the Focus-only mouse aliases and Canvas fallback.

**Approach:** Follow the hook's stable-handler-ref pattern so continuously changing workspace state does not reinstall listeners or leave an event one render behind. Add a synchronous Focus-state predicate alongside the callbacks. Recognize buttons by `MouseEvent.button`, cancel only recognized buttons while the predicate is true, and keep cycle dispatch confined to `mouseup` per KTD1-KTD2.

**Test scenarios:**

- With Focus active, a button-3 down/up/auxclick sequence prevents all cancelable defaults, calls previous-ready exactly once, and never calls next-ready.
- With Focus active, button 4 produces the symmetric next-ready result exactly once.
- With Focus inactive, the same sequences remain uncanceled and call neither handler.
- Buttons 0, 1, 2, and an unknown value remain uncanceled and call neither handler in both modes.
- A Focus-state change is observed by the already-installed listener without listener re-registration or a stale render.

**Observable outcome:** Thumb buttons over the host UI behave as Focus-only ready-session aliases while every existing keyboard shortcut continues through the same hook unchanged.

### U2. Extend the terminal bridge with Focus-aware mouse navigation

**Requirements:** R1-R7; AE2-AE5

**Depends on:** U1

**Files:**

- `src/components/RunWorkspaceWidget/index.tsx` — pass the existing `useFocusPresentation()` result into the session panel.
- `src/components/RunWorkspaceWidget/RunSessionPanel.tsx` — synchronize Focus state to the owned wrapper and preserve the existing validated inbound cycle bridge.
- `public/terminal-wrapper.html` — track synchronized Focus state, intercept recognized side-button gestures in the wrapper and nested ttyd window, and post the existing ready-cycle actions once per release.
- `src/components/RunWorkspaceWidget/__tests__/RunSessionPanel.composer.test.tsx` — verify initial/update state messages and retain source/origin/session/action validation coverage.
- `e2e/focus-mode.spec.ts` — exercise the shipped wrapper plus nested ttyd for Focus mapping, one-action semantics, default prevention, and Canvas fallthrough.

**Approach:** Reuse the existing terminal-frame ref and message boundary. Synchronize only a boolean presentation fact; the wrapper never resolves targets. Have the wrapper announce readiness after its listener exists, validate that message at the existing host boundary, and resend current presentation state to the owned origin so initial load and reload cannot miss it. Attach the side-button listener beside the existing keyboard/wheel bridge for both wrapper and ttyd windows, reattaching through the existing terminal-load path as needed. Route actions through `terminal-session-cycle` per KTD1 and apply the same event-phase contract as U1 per KTD2-KTD4.

**Test scenarios:**

- A same-origin owned wrapper that announces readiness receives the current Focus state, receives later presentation updates, and receives the state again after reload; forged origins, unrelated sources, and wrong session names neither trigger a resend nor become trusted inbound sources.
- In Focus, a full button-3 sequence inside nested ttyd is canceled and emits one `ready-prev`; button 4 emits one `ready-next`; each changes the visible run through the existing Focus queue.
- In Focus, the same mapping works on the wrapper document around ttyd, not only inside the inner frame.
- When Canvas mode is restored, wrapper and nested-ttyd side-button events remain uncanceled and emit no cycle message.
- Repeated physical gestures emit one action each, while related events from a single gesture do not double-dispatch.
- Existing terminal keyboard cycling, focus escape, clipboard behavior, and scroll-boundary hints remain operational.

**Observable outcome:** Moving the pointer into ttyd no longer changes the thumb-button contract, and toggling back to Canvas immediately restores native behavior without reloading the terminal.

## Verification Contract

Run the smallest affected checks first, then the repository gates:

- `npx vitest run src/hotkeys/__tests__/useGlobalHotkeys.test.tsx src/components/RunWorkspaceWidget/__tests__/RunSessionPanel.composer.test.tsx` — unit mapping, synchronization, validation, and negative cases pass.
- `npx playwright test e2e/focus-mode.spec.ts e2e/hotkeys.spec.ts` — host and terminal paths cycle correctly; existing Focus and keyboard behavior remains green.
- `npm run typecheck` — application, E2E, and test projects typecheck.
- `npm run lint` — event listeners, React effects, and HTML script changes pass lint policy.
- `npm run check:case` — no case-collision regressions.

Manual hardware verification in the supported Chromium runtime:

1. Establish browser history before opening Tinstar, enter Focus, and use Back/Forward over the host UI and ttyd. Confirm one ready-session move per click and no history navigation.
2. Leave Focus without reloading, repeat over both surfaces, and confirm Tinstar does not cycle or suppress the browser's normal Back/Forward behavior.
3. Repeat once with no alternative ready target to confirm Focus still consumes the gesture without changing the selected session.

## Definition of Done

- R1-R7 and AE1-AE5 are satisfied on both host and terminal surfaces.
- Back and Forward produce exactly one previous/next ready-session action per physical release in Focus mode.
- Native browser history is suppressed for recognized Focus gestures and left untouched in Canvas mode.
- The implementation reuses `WorkspaceShell` queue/selection authority and the existing validated terminal cycle bridge.
- Existing keyboard cycling, terminal focus/clipboard/wheel behavior, Focus geometry, and Canvas behavior remain regression-tested.
- Unit tests, focused E2E tests, typecheck, lint, and case checks pass.
- Real-hardware Chromium verification is recorded, including the no-target and Canvas fallthrough cases.
- The hotkey/input documentation reflects the Focus-only aliases.
- No abandoned synthetic-key path, duplicate queue logic, iframe reload mechanism, or obsolete event listener remains.
