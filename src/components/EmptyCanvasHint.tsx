export function EmptyCanvasHint() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="flex items-center gap-2 text-slate-500">
        <span className="text-sm">Press</span>
        <kbd className="px-2 py-1 bg-surface-raised border border-white/10 rounded text-xs font-mono text-slate-300">
          S
        </kbd>
        <span className="text-sm">to launch your first session</span>
      </div>
    </div>
  )
}
