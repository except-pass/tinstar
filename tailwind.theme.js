// Single source of truth for Tinstar's custom Tailwind color palette.
//
// Imported by BOTH tailwind.config.ts (to build the theme) AND
// eslint-rules/valid-theme-classnames.js (to lint className strings against
// the real palette). Keeping it in one place means the linter can never drift
// from the config — a `bg-surface-2` typo is caught because `2` isn't a key
// here. See docs/adrs (plugin boundary) and CLAUDE.md UI conventions.

/** @type {Record<string, string | Record<string, string>>} */
export const colors = {
  primary: {
    DEFAULT: '#00f0ff',
    dim: '#00a5b0',
    glow: 'rgba(0, 240, 255, 0.15)',
  },
  surface: {
    base: '#06080a',
    panel: '#0a0e12',
    raised: '#0f1419',
    hover: '#141c24',
  },
  accent: {
    red: '#ff3366',
    green: '#00ff88',
    amber: '#ffaa00',
  },
  // Slate Surface Design Language (docs/slate-design-language.md).
  // Ink: three contrast steps for text; controls sit one step below low.
  ink: {
    high: '#eaf1f5', // headlines
    mid: '#9fb0bd',  // body
    low: '#5c6b74',  // meta / labels
    ctrl: '#4f5e67', // edge controls (⟳ ✕) — brighten on hover
  },
  // One hue per meaning — status semantics (used at ~14% fill / ~22% border / bright text).
  hue: {
    open: '#818cf8',       // indigo — a live question
    discussing: '#ffc266', // amber — agent / in progress / stale
    waiting: '#6fcff6',    // sky — blocked on someone
    resolved: '#4fe0a6',   // emerald — settled
    dismissed: '#7c8b95',  // slate — off-track, dimmed
    error: '#ff6b8a',      // red — failed action only
  },
  // Depth = a single hairline + a lightness step (not shadows).
  hairline: 'rgba(130, 175, 195, 0.10)',
}
