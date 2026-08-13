// A quiet ⚡ marking a surface that carries a refresh RECIPE. The recipe makes the
// surface rebuildable from declared sources; it does not decide when rebuilding is
// authorized. Agent recipes run only from the explicit per-surface refresh control,
// while host recipes may participate in the cheap Check-all path.
//
// Rendered in low ink, NOT cyan: cyan is reserved for the live edge (an in-flight
// refresh already lights the card). This is a resting capability marker, not a
// liveness signal.
export function FastPathBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="fast-path-badge"
      title="Recipe-backed — use the surface refresh control to rebuild it from its declared sources"
      aria-label="refresh recipe available"
      className={`shrink-0 leading-none text-ink-low ${className ?? ''}`}
    >
      ⚡
    </span>
  )
}
