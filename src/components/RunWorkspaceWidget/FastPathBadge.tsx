// A quiet ⚡ marking a surface that carries a self-refresh RECIPE. Such a surface
// re-authors deterministically from its own recipe — a code-spawned author runs it
// off the main agent's critical path, so refreshing it (or a whole refresh-all
// fan-out) doesn't wait on a single session. It's the visible answer to "which of
// these refresh on their own vs. cost the agent a turn?".
//
// Rendered in low ink, NOT cyan: cyan is reserved for the live edge (an in-flight
// refresh already lights the card). This is a resting capability marker, not a
// liveness signal.
export function FastPathBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="fast-path-badge"
      title="Self-refreshing — re-runs from its own recipe, off the main agent's path"
      aria-label="self-refreshing"
      className={`shrink-0 leading-none text-ink-low ${className ?? ''}`}
    >
      ⚡
    </span>
  )
}
