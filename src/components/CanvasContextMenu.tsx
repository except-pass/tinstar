import { useEffect, useRef, useState } from 'react'
import type { MoveTarget } from '../domain/moveTargets'

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
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown) }
  }, [onClose])

  return (
    <div ref={ref} style={{ position: 'fixed', left: anchor.x, top: anchor.y, zIndex: 1000, minWidth: 200,
      background: '#0b1220', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: 4,
      boxShadow: '0 6px 24px rgba(0,0,0,0.4)', fontSize: 12, color: '#e2e8f0' }}>
      <button onClick={() => setShowList((s) => !s)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
          textAlign: 'left', padding: '6px 8px', background: 'transparent',
          border: 0, color: 'inherit', cursor: 'pointer', borderRadius: 4 }}>
        <span>Move widget here</span> <span aria-hidden>▸</span>
      </button>
      {showList && (
        <div style={{ maxHeight: 280, overflowY: 'auto', borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 4 }}>
          {targets.length === 0 && <div style={{ padding: '6px 8px', color: '#64748b' }}>No widgets</div>}
          {targets.map((t) => (
            <button key={t.id} onClick={() => onPick(t.id)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%',
                textAlign: 'left', padding: '6px 8px', background: 'transparent', border: 0, color: 'inherit',
                cursor: 'pointer', borderRadius: 4 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
              {t.slots.length > 0 && (
                <span style={{ flexShrink: 0, fontSize: 10, color: '#94a3b8', border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 4, padding: '0 4px' }}>{t.slots.join(' ')}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
