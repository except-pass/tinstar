# Canvas Minimap — Design Spec

## Overview

A StarCraft-style minimap overlay for Tinstar's infinite canvas. Provides a bird's-eye view of all work widgets, a viewport indicator that tracks the current view, and click/drag-to-pan navigation.

## Layout & Appearance

- **Position:** Bottom-right corner of the canvas viewport, stacked above the existing zoom indicator.
- **Size:** 200×140px (roughly 16:9).
- **Background:** Semi-transparent dark panel (`rgba(15, 23, 42, 0.85)`) with a 1px `rgba(255, 255, 255, 0.1)` border. Matches `surface-panel` aesthetic.
- **Z-order:** Above canvas content, below modals/menus/context menus.
- **Collapse behavior:** A small close button (top-right, visible on hover) collapses the minimap to an icon. Clicking the icon re-expands. `M` hotkey toggles between expanded and collapsed. State persisted in `localStorage` key `tinstar-minimap-visible`.

## Widget Rendering

- **Scope:** Only non-container ("work") widgets are rendered: `run-workspace`, `file-editor`, `browser-widget`, `image-viewer`, `nats-traffic`. Containers (initiative, epic, task, worktree) are excluded.
- **Representation:** Proportional filled rectangles. Each widget's world-space bounding box (from `useWidgetLayouts`) is scaled uniformly to fit the minimap, preserving relative positions and sizes.
- **Colors:** Each rectangle uses the widget's own accent color:
  - `run-workspace` — `run.color` (default `#00f0ff`)
  - `browser-widget` — `widget.color` (default `#00f0ff`)
  - `file-editor` — `#00f0ff` (fixed primary)
  - `image-viewer` — `#00f0ff` (fixed primary)
  - `nats-traffic` — `#00f0ff` (fixed primary)
- **Opacity:** Rectangles drawn at ~60% opacity.
- **Scaling math:** Compute the bounding box of all visible work widgets in world space, add 10% padding on each side, then map that rectangle to the minimap's 200×140 pixel area. If no widgets exist, show an empty minimap with no widget rectangles.

## Viewport Indicator (Viewfinder)

- **Shape:** Hollow rectangle, 1.5px white border at ~40% opacity.
- **Represents:** The portion of world space currently visible in the browser window, derived from `camera.x`, `camera.y`, `camera.zoom`, and the viewport's pixel dimensions (`window.innerWidth`, `window.innerHeight`).
- **Conversion:** The visible world rect is:
  - `worldX = -camera.x / camera.zoom`
  - `worldY = -camera.y / camera.zoom`
  - `worldW = viewportWidth / camera.zoom`
  - `worldH = viewportHeight / camera.zoom`
  
  This world rect is then mapped to minimap coordinates using the same scale/offset as the widget rectangles.

## Interaction

- **Click to pan:** Clicking anywhere on the minimap computes the corresponding world-space point and sets the camera so the viewport centers on that point. Zoom is unchanged. Instant — no animation.
- **Drag to pan:** Mouse-down + drag on the minimap continuously updates the camera center. Same feel as StarCraft minimap dragging.
- **Event isolation:** The minimap captures all pointer events (`pointerdown`, `pointermove`, `pointerup`) and stops propagation. Canvas panning/selection beneath is unaffected.
- **No zoom control:** The minimap only controls pan, not zoom.

## Implementation Approach

- **Rendering:** HTML `<canvas>` element, drawn via `CanvasRenderingContext2D`. No React DOM nodes for individual widget dots — pure imperative drawing.
- **Redraw trigger:** Redraw when `camera` or `layouts` change. Use a `useEffect` that calls the draw function. No continuous `requestAnimationFrame` loop.
- **Component:** New `CanvasMinimap` component, rendered inside `InfiniteCanvas.tsx` as a sibling to the zoom indicator (both positioned absolutely in the viewport, outside the transformed canvas layer).
- **Props/context:** Receives `camera`, `setCamera`, `layouts` (the layout map), `tree` (to identify work widget nodes), and widget data maps (to extract accent colors).

## Hotkey Registration

- **Key:** `M` (unmodified, only when no editable element is focused).
- **Registered in:** `useCanvasHotkeys` or directly in `InfiniteCanvas`.
- **Behavior:** Toggles `localStorage` flag and re-renders.

## Files Touched

- `src/components/CanvasMinimap.tsx` — new component (canvas drawing, interaction, toggle state)
- `src/components/InfiniteCanvas.tsx` — render `<CanvasMinimap>` in the bottom-right overlay area, pass required props, register `M` hotkey
