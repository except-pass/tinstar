import { useEffect, useRef, useState } from 'react'
import type { MoveTarget } from '../domain/moveTargets'
import { AgentIcon } from './agentIcon'

interface Props {
  anchor: { x: number; y: number }   // screen px
  targets: MoveTarget[]
  onPick: (id: string) => void
  onClose: () => void
}

/** Canvas right-click menu. One item ("Move widget here") that expands to a
 *  scrollable list of open widgets (label + constellation slot chip). */
export function CanvasContextMenu({ anchor, targets, onPick, onClose }: Props) {
  const [showList, setShowList] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    // Keep wheel scrolling inside the menu from bubbling to the canvas's native,
    // non-passive wheel handler (which zooms/pans). stopPropagation only — the
    // browser still scrolls the overflow list. A native listener is required:
    // the canvas handler sits on the container element, so it would fire before
    // React's delegated onWheel and a synthetic stopPropagation would be too late.
    const onWheel = (e: WheelEvent) => { e.stopPropagation() }
    const el = ref.current
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    el?.addEventListener('wheel', onWheel)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
      el?.removeEventListener('wheel', onWheel)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="fixed z-[9999] bg-surface-panel border border-primary/20 rounded-lg shadow-xl p-1 min-w-[200px] text-xs text-slate-200"
      style={{ left: anchor.x, top: anchor.y }}
    >
      <button
        className="flex items-center justify-between w-full px-2 py-1.5 text-left rounded hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition-colors"
        onClick={() => setShowList((s) => !s)}
      >
        <span>Move widget here</span> <span aria-hidden>▸</span>
      </button>
      {showList && (
        <div className="max-h-[280px] overflow-y-auto border-t border-white/10 mt-1">
          {targets.length === 0 && <div className="px-2 py-1.5 text-slate-500">No widgets</div>}
          {targets.map((t) => (
            <button
              key={t.id}
              className="flex items-center justify-between gap-2 w-full px-2 py-1.5 text-left rounded hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition-colors"
              onClick={() => onPick(t.id)}
            >
              <span className="flex items-center gap-2 overflow-hidden">
                <AgentIcon
                  icon={t.icon?.icon}
                  seed={t.icon?.seed}
                  color={t.icon?.color}
                  className="h-4 w-4 shrink-0"
                  fallback={<span className="inline-flex h-4 w-4 shrink-0 items-center justify-center font-mono text-[10px] text-slate-400">{t.label[0]}</span>}
                />
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{t.label}</span>
              </span>
              {t.slots.length > 0 && (
                <span className="shrink-0 text-[10px] text-slate-400 border border-white/15 rounded px-1">
                  {t.slots.join(' ')}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
