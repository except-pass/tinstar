// src/canvas/snapConstants.ts
// Shared snap/adjacency constants. Lives in its own leaf module so the snap
// resolver, the cohesion geometry, and the resize-reflow can all agree on the
// numbers without importing one another (which would create a cycle).

/**
 * Gap (in canvas px) left between two widgets when they snap into a
 * constellation — a small gutter so the constellation link (the stars + the
 * line drawn between them) has room to breathe. Was 0 (flush) historically.
 */
export const SNAP_GAP = 24

/**
 * Tolerance for "are these two widgets adjacent / linked" seam + contact tests.
 * Must comfortably exceed SNAP_GAP so a gapped-but-snapped pair still registers
 * as adjacent (break chips, add-widget edge occupancy, resize reflow).
 */
export const ADJACENCY_TOL = SNAP_GAP + 16
