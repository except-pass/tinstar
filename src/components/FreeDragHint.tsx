/**
 * Transient reminder shown while dragging an ungrouped widget: holding Alt
 * bypasses magnetic snapping ("free drag"). Snapping is great in open space but
 * fights you when repositioning an independent window in a crowded area — and
 * the Alt bypass is easy to forget, so we surface it in-context during the drag.
 *
 * Always mounted (cheap) and slid out of view when hidden, so showing/hiding is
 * a pure CSS transition with no mount-timing jank. Rendered in the canvas root
 * (NOT the transformed layer) so it stays screen-fixed, and pointer-events-none
 * so it never intercepts the drag.
 */
export function FreeDragHint({ visible, altActive }: { visible: boolean; altActive: boolean }) {
  return (
    <div
      className="pointer-events-none absolute top-0 left-1/2 z-[200] transition-all duration-200 ease-out"
      style={{
        transform: `translateX(-50%) translateY(${visible ? '12px' : '-140%'})`,
        opacity: visible ? 1 : 0,
      }}
      aria-hidden={!visible}
    >
      {altActive ? (
        <div className="flex items-center gap-2 rounded-full border border-primary/50 bg-surface-raised/95 px-3 py-1.5 text-xs text-primary shadow-lg backdrop-blur-sm">
          <span className="material-symbols-outlined text-sm">open_with</span>
          <span className="font-medium">Free drag — snapping off</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-surface-raised/95 px-3 py-1.5 text-xs text-slate-300 shadow-lg backdrop-blur-sm">
          <span>Hold</span>
          <kbd className="px-1.5 py-0.5 bg-surface-base border border-white/15 rounded text-2xs font-mono text-slate-200 leading-none">
            Alt
          </kbd>
          <span>to free-drag (ignore snapping)</span>
        </div>
      )}
    </div>
  )
}
