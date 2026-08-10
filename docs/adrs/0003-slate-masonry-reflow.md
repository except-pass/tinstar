# ADR 0003 — Measured masonry inside the Slate

**Status:** Implemented (2026-08-10)
**Date:** 2026-08-10
**Supersedes in part:** [The Slate v2 plan](../plans/2026-07-21-002-feat-the-slate-v2-plan.md), KTD5 and its two-column limit

---

## Context

The Slate v2 grid reflowed from one to two columns as its user-resizable panel widened.
Because ordinary CSS grid items shared rows, a tall Surface left an empty block beneath
every shorter neighbor. The panel also stopped at two columns even though its persisted
width can reach 900 pixels. The result behaved like a table of cards rather than a board
of independently sized work objects.

This reflow is inside one Run's Slate. It does not change the surrounding infinite
canvas, where user-positioned widgets remain stable and never auto-pack.

## Decision

Render the Slate body as a measured CSS grid masonry:

- one column below 420 pixels, two from 420 through 699 pixels, and three at 700 pixels
  or wider;
- one `ResizeObserver` per visible masonry cell measures its natural content height;
- the cell converts that height into a span over one-pixel implicit grid rows;
- CSS grid auto-placement packs the next Surface into the earliest available column;
- full-width work objects, including the grouped open-points Surface, span every column
  and form a section break;
- canonical Surface order remains DOM order and continues to drive keyboard traversal;
- width is still the only persisted layout preference. Card coordinates and row spans
  are derived locally and are never written to the server or browser storage.

Reflow caused by resize, search, hide, minimize, or live content amendments is presentation
work only. It never invokes a refresh recipe, prompts an agent, or changes Surface identity.

## Alternatives rejected

- **Browser-native CSS masonry:** `grid-template-rows: masonry` is not sufficiently
  portable across Tinstar's supported browser/Electron targets.
- **CSS multi-column layout:** it fills down columns and complicates full-width section
  breaks, making canonical reading order harder to understand.
- **Persisted or draggable card coordinates:** this would turn a quick working Slate into
  another canvas, add conflict-prone layout state, and make resizing cease to be automatic.
- **Keep the row grid:** simplest, but retains the dead space and fails the primary-surface
  goal at wide Slate ratios.

## Consequences

Cards pack tightly and can reflow through three columns while preserving the existing
Surface lifecycle and interaction model. Dynamic content requires a measured layout and
therefore a `ResizeObserver`, but each observer is scoped to one mounted cell, ignores
same-span measurements, and disconnects on unmount.

Revisit this decision if native CSS masonry becomes reliable across the supported runtime
matrix or if users need deliberately arranged boards rather than an automatically packed
reading and interaction surface.
