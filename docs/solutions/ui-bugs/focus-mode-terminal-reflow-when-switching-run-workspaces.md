---
title: Focus Mode terminal reflow when switching Run Workspaces
date: 2026-08-03
category: ui-bugs
module: Focus Mode Run Workspace presentation
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Switching Run Workspaces in Focus Mode flashes ttyd's terminal-dimensions badge even though the browser viewport did not change."
  - "Terminal lines rewrap and jump on every focused-session change."
  - "Canvas Mode does not show the same behavior because selecting another workspace does not change its rendered geometry."
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [focus-mode, run-workspace, ttyd, terminal-resize, iframe, canvas-layout, responsive-layout, e2e]
---

# Focus Mode terminal reflow when switching Run Workspaces

## Problem

Focus Mode resized the embedded ttyd terminal every time the user cycled to another Run Workspace. The outgoing workspace collapsed from the transient viewport-sized Focus layout to its saved Canvas layout while the incoming workspace expanded in the opposite direction. In the observed ttyd session, that recomputed rows and columns, displayed the dimensions badge, and reflowed the terminal buffer.

The terminal iframe fills its parent in both dimensions, so a parent geometry change reaches the real iframe rather than remaining a visual-only canvas transform (`src/components/PromptComposer/PromptComposer.tsx:282-287`). `CanvasWidgetShell` likewise applies the supplied layout as real CSS width and height (`src/widgets/CanvasWidgetShell.tsx:441-445`).

## Symptoms

- Pressing `Ctrl+Shift+]` or the corresponding previous-workspace shortcut briefly showed a dimensions badge such as `196×81`.
- Terminal text wrapped differently and jumped around on every Run Workspace change, even though the browser viewport itself had not changed.
- Canvas Mode did not exhibit the same behavior because selecting another window did not exchange viewport-sized and saved widget geometry.

## What Didn't Work

### Suppressing ttyd's resize badge

Disabling or hiding the badge would remove only the visible notification. The iframe would still change size—the condition that produced terminal-dimension recomputation and text reflow in the observed ttyd session. The disruptive text movement—not merely the badge—was the defect.

### Persisting viewport-sized Canvas layouts

Saving the resized workspace dimensions back into Canvas state could reduce the outer size difference on some monitors, but it would not eliminate the second geometry transition: the workspace's internal presentation. `RunWorkspaceWidget` derives responsive Focus behavior from the presentation context (`src/components/RunWorkspaceWidget/index.tsx:63-64`), observes its width only during Focus presentation (`src/components/RunWorkspaceWidget/index.tsx:120-142`), and changes panel composition when constrained. For example, Files can become an overlay drawer (`src/components/RunWorkspaceWidget/index.tsx:410-425`) and Telemetry can move behind a rail (`src/components/RunWorkspaceWidget/index.tsx:600-627`).

Toggling one workspace from Canvas to Focus while toggling another from Focus to Canvas can therefore change the terminal pane width even when the outer saved dimensions happen to match. Persisting the larger dimensions also needlessly destroys the user's Canvas arrangement.

### Applying Focus geometry only to the active target

The target-only render shape was equivalent to:

```ts
const isFocusTarget = focusReady && node.id === focusedNodeId
const layout = isFocusTarget && focusLayout ? focusLayout : canonicalLayout

<CanvasWidgetShell
  hidden={focusMode && !isFocusTarget}
  presentation={isFocusTarget ? 'focus' : 'canvas'}
/>
```

Inactive shells stayed mounted, so terminals did not reconnect, but every target change still swapped both their outer geometry and internal presentation. Preserving component identity was not enough; the iframe viewport itself also had to remain stable.

## Solution

Separate the concerns that had been coupled together:

1. Once Focus is ready, presentation and geometry are shared by every mounted, built-in Run Workspace.
2. Visibility alone identifies the currently focused target.

PR #185 implements that distinction:

```ts
const isFocusTarget = focusReady && node.id === focusedNodeId
const usesFocusPresentation =
  focusReady && node.type === 'run' && isBuiltInRunWorkspace(run)
const layout = usesFocusPresentation && focusLayout
  ? focusLayout
  : canonicalLayout

<CanvasWidgetShell
  layout={layout}
  hidden={focusMode && !isFocusTarget}
  presentation={usesFocusPresentation ? 'focus' : 'canvas'}
/>
```

The transient layout comes from the current canvas container and sidebar width (`src/components/InfiniteCanvas.tsx:256-271`). Every mounted built-in Run Workspace receives that layout and Focus presentation, rather than only the visible target (`src/components/InfiniteCanvas.tsx:2020-2026`, `src/components/InfiniteCanvas.tsx:2127-2129`). Eligibility reuses `isBuiltInRunWorkspace`, which accepts the default or absent Run Workspace view and excludes custom run views (`src/focusMode/focusTarget.ts:28-30`).

Inactive workspaces remain mounted but are hidden with `visibility: hidden` and disabled pointer events (`src/widgets/CanvasWidgetShell.tsx:438-449`). The active target is still determined independently through `isFocusTarget`, so cycling changes `hidden` rather than the layout or presentation of either terminal.

Saved Canvas geometry remains intact because this path only selects a transient render-time `layout` in place of `canonicalLayout`; it does not call a layout mutation operation (`src/components/InfiniteCanvas.tsx:2020-2026`). Leaving Focus naturally renders each workspace with its canonical layout again.

## Why This Works

The terminal's effective viewport is determined by both its outer shell size and the Run Workspace's internal responsive composition. Holding every mounted eligible workspace at the same transient Focus layout and Focus presentation keeps both inputs stable while Focus remains active. Switching the target changes visibility only, so the regression observes no resize event in either terminal document and avoids the trigger associated with the observed badge and text reflow.

This still responds correctly to genuine geometry changes. `InfiniteCanvas` observes its container and recomputes the Focus layout from the new viewport (`src/components/InfiniteCanvas.tsx:256-271`, `src/components/InfiniteCanvas.tsx:289-300`), while each Run Workspace observes its Focus width for constrained panel composition (`src/components/RunWorkspaceWidget/index.tsx:120-142`). Entering or leaving Focus, or resizing the browser, may resize mounted terminals as intended; cycling sessions at a stable viewport does not.

The approach also preserves component identity. The normal shell is wrapped in a fragment keyed by the stable node ID (`src/components/InfiniteCanvas.tsx:2077-2085`), and the terminal iframe is keyed only by its explicit refresh tick (`src/components/PromptComposer/PromptComposer.tsx:282-285`). The fix changes render props rather than remounting or reconnecting the terminal.

## Prevention

Treat iframe viewport stability as an explicit Focus-cycling invariant:

> At a stable browser viewport, changing the focused Run Workspace must not resize either the outgoing or incoming terminal iframe.

The Playwright regression instruments each mounted terminal document with a `resize` event counter (`e2e/focus-mode.spec.ts:35-42`, `e2e/focus-mode.spec.ts:173-182`). It records counts for mounted terminal workspaces, cycles with `Ctrl+Shift+]`, and asserts that both the old and new targets retain their original counts (`e2e/focus-mode.spec.ts:201-222`). This tests the causal behavior directly instead of checking whether a ttyd badge happens to be visible.

For future Focus changes:

- Keep target selection and visibility independent from geometry and presentation.
- Apply responsive presentation consistently to inactive mounted peers when switching among them must be geometry-neutral.
- Exclude custom run views unless they explicitly support the built-in Run Workspace Focus contract.
- Preserve saved Canvas layouts as canonical state and derive viewport-sized Focus layouts transiently.
- Test iframe-level resize events whenever changing side panels, responsive breakpoints, hiding strategy, or workspace cycling. A badge assertion is not an adequate substitute for proving that the iframe viewport remained stable.
- Prefer condition-based counter stability over a fixed settling delay. The first regression used 300 ms waits around Focus entry and cycling (`e2e/focus-mode.spec.ts:197-217`); a prior review noted that a slow runner could capture the baseline before the intentional entry resize burst settled, or assert before a delayed bad resize arrived (session history). A follow-up can make the guard more durable by waiting for counters to stabilize before taking the baseline and after switching.

## Related Issues

- Shipped in [PR #185](https://github.com/except-pass/tinstar/pull/185).
- [Hidden-runs ghosting — reused session name born hidden from a stale localStorage entry](../integration-issues/hidden-runs-ghosting-stale-localstorage-on-run-removal.md) is an adjacent but distinct Canvas visibility failure: it reconciles stale persisted visibility state on run removal, while this fix preserves transient geometry during visibility-only switching.
