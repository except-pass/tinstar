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
}
