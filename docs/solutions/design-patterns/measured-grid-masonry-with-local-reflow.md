---
title: Measured Grid Masonry for Dynamic Slate Cards
date: 2026-08-10
category: design-patterns
module: slate
problem_type: design_pattern
component: tooling
severity: medium
applies_when:
  - "A responsive card collection contains items with independent natural heights"
  - "Cards can grow, collapse, or wrap after their first render"
  - "Document order must remain canonical while visual placement reflows"
tags: [slate, css-grid, masonry, resize-observer, responsive-layout]
---

# Measured Grid Masonry for Dynamic Slate Cards

## Context

An ordinary CSS Grid row is as tall as its tallest card. When a tall Slate Surface sits beside a short one, the next card waits below the tall row and leaves a large empty block beneath the short card. This made a wide Slate behave like a sparse table instead of the primary working surface.

The replacement needed to support cards whose content changes after mount, full-width section breaks, and one-to-three-column responsive density. It also had to preserve the Surface lifecycle: reflow could move pixels but could not refresh a Surface, prompt an agent, replace its identity, or persist card coordinates.

## Guidance

Use an inner element to report the card's natural content height and an outer element to speak CSS Grid's placement language:

```tsx
const ROW_HEIGHT = 1
const GAP = 8

function rowSpan(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 1
  return Math.max(1, Math.ceil((height + GAP) / (ROW_HEIGHT + GAP)))
}
```

The grid uses `grid-auto-rows: 1px` and an eight-pixel row gap. A span of `n` rows occupies `n * rowHeight + (n - 1) * gap`, so adding one gap before dividing produces the smallest span that can contain the measured card. Rounding upward prevents overlap and wastes less than one grid step.

Each mounted card measures once in `useLayoutEffect`, then observes only its inner content wrapper:

```tsx
useLayoutEffect(() => {
  const content = contentRef.current
  if (!content) return

  const measure = () => {
    const next = rowSpan(content.getBoundingClientRect().height)
    setRowSpan(current => current === next ? current : next)
  }

  measure()
  if (typeof ResizeObserver === 'undefined') return
  const observer = new ResizeObserver(measure)
  observer.observe(content)
  return () => observer.disconnect()
}, [])
```

The same-span guard prevents redundant React renders, and cleanup disconnects the observer when a card leaves the view. The outer wrapper applies `grid-row-end: span <n>`. CSS Grid then places later cards into the next available column position.

Keep section breaks explicit. A full-width work object uses `grid-column: 1 / -1`, while ordinary cards have no fixed column. Keep the DOM in canonical Surface order so keyboard and assistive navigation do not inherit the temporary visual arrangement.

Most importantly, keep the observer's effect local. Its only output is derived layout state. It must not call a refresh recipe, write browser or server state, publish an event, or prompt an agent. Resizing, searching, hiding, minimizing, and live content amendments may cause remeasurement, but they remain presentation work.

## Why This Matters

This pattern gives uneven cards Keep-style packing without introducing another user-managed canvas or depending on browser-native masonry support. The Slate can become wider and denser while Surface identity, threads, freshness, and refresh authority stay stable.

The boundary also prevents a familiar failure mode: treating a visual invalidation as work invalidation. Layout can react immediately and often because its consequences are local; Surface regeneration remains deliberate and separately governed.

## When to Apply

- Use it for bounded, responsive collections of independently sized cards where normal document order must remain authoritative.
- Use it when cards change height after mount through wrapping, live content, expand/collapse, or user controls.
- Do not use it for a deliberately arranged board where exact user-controlled coordinates are part of the work.
- Revisit it when native CSS masonry is dependable across the supported browser and Electron runtime matrix.

## Examples

The Slate implementation lives in `src/components/RunWorkspaceWidget/slateMasonry.tsx`. `SlatePanel` wraps each normal card in a measured cell and marks grouped open points, the blank-state composer, and search-empty feedback as full-width cells.

The browser proof in `e2e/slate-masonry-reflow.spec.ts` creates durable file-authored Surfaces with varied heights, exercises one, two, and three columns, checks for overlap and horizontal overflow, proves that a later card packs beneath a short neighbor before a tall card ends, and verifies repacking after minimize.

## Related

- [ADR 0003: Measured masonry inside the Slate](../../adrs/0003-slate-masonry-reflow.md)
- [Slate-first live authoring](../../features/slate-first-live-authoring.md)
- [Slate Surface authoring contract](../documentation-gaps/slate-surface-authoring-contract.md)
- PR #203 (pending at the time this learning was captured)
