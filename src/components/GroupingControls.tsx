import { useState, useCallback, useRef } from 'react'
import type { GroupingDimension } from '../domain/types'
import { ALL_DIMENSIONS } from '../domain/types'

interface GroupingControlsProps {
  activeDimensions: GroupingDimension[]
  onDimensionsChange: (dims: GroupingDimension[]) => void
}

const LABELS: Record<GroupingDimension, string> = {
  initiative: 'Initiative',
  epic: 'Epic',
  task: 'Task',
  worktree: 'Worktree',
}

export function GroupingControls({ activeDimensions, onDimensionsChange }: GroupingControlsProps) {
  const inactive = ALL_DIMENSIONS.filter(d => !activeDimensions.includes(d))

  // Drag-to-reorder state
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const pillRefs = useRef<(HTMLDivElement | null)[]>([])
  const orderRef = useRef<GroupingDimension[]>(activeDimensions)

  const onPointerDown = useCallback((e: React.PointerEvent, idx: number) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDragIdx(idx)
    orderRef.current = [...activeDimensions]
  }, [activeDimensions])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragIdx === null) return
    const order = orderRef.current
    const pills = pillRefs.current

    // Check if cursor crossed a neighbor's midpoint
    for (let i = 0; i < pills.length; i++) {
      if (i === dragIdx) continue
      const pill = pills[i]
      if (!pill) continue
      const rect = pill.getBoundingClientRect()
      const mid = rect.left + rect.width / 2

      if (i < dragIdx && e.clientX < mid) {
        // Swap left
        const item = order.splice(dragIdx, 1)[0]
        order.splice(i, 0, item)
        orderRef.current = order
        setDragIdx(i)
        onDimensionsChange([...order])
        return
      }
      if (i > dragIdx && e.clientX > mid) {
        // Swap right
        const item = order.splice(dragIdx, 1)[0]
        order.splice(i, 0, item)
        orderRef.current = order
        setDragIdx(i)
        onDimensionsChange([...order])
        return
      }
    }
  }, [dragIdx, onDimensionsChange])

  const onPointerUp = useCallback(() => {
    setDragIdx(null)
  }, [])

  const remove = useCallback((dim: GroupingDimension) => {
    if (activeDimensions.length <= 1) return
    onDimensionsChange(activeDimensions.filter(d => d !== dim))
  }, [activeDimensions, onDimensionsChange])

  const add = useCallback((dim: GroupingDimension) => {
    if (activeDimensions.length >= 4) return
    onDimensionsChange([...activeDimensions, dim])
  }, [activeDimensions, onDimensionsChange])

  return (
    <div
      className="flex items-center gap-2 flex-wrap"
      data-testid="grouping-controls"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      {/* Active dimension pills */}
      {activeDimensions.map((dim, i) => (
        <div
          key={dim}
          ref={el => { pillRefs.current[i] = el }}
          className={[
            'flex items-center gap-1 px-2 py-1 rounded-full text-xs',
            'bg-primary/20 text-primary border border-primary/40',
            dragIdx === i ? 'opacity-70 cursor-grabbing' : 'cursor-grab',
          ].join(' ')}
          data-testid={`pill-${dim}`}
          onPointerDown={e => onPointerDown(e, i)}
        >
          <span className="select-none">{LABELS[dim]}</span>
          {activeDimensions.length > 1 && (
            <button
              className="text-primary/60 hover:text-red-400 ml-0.5"
              onClick={e => { e.stopPropagation(); remove(dim) }}
              onPointerDown={e => e.stopPropagation()}
              data-testid={`remove-${dim}`}
              aria-label={`Remove ${dim}`}
            >
              ×
            </button>
          )}
        </div>
      ))}

      {/* Inactive dimension buttons */}
      {inactive.map(dim => (
        <button
          key={dim}
          className="px-2 py-1 rounded-full text-xs bg-surface-raised text-slate-500 border border-white/10 hover:text-slate-300 hover:border-white/20"
          onClick={() => add(dim)}
          data-testid={`add-${dim}`}
          aria-label={`Add ${dim}`}
        >
          + {LABELS[dim]}
        </button>
      ))}
    </div>
  )
}
