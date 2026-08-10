import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export const SLATE_TWO_COLUMN_MIN = 420
export const SLATE_THREE_COLUMN_MIN = 700
export const SLATE_MASONRY_ROW_HEIGHT = 1
export const SLATE_MASONRY_GAP = 8
export const SLATE_MASONRY_GRID_STYLE: CSSProperties = {
  gridAutoRows: `${SLATE_MASONRY_ROW_HEIGHT}px`,
  rowGap: `${SLATE_MASONRY_GAP}px`,
}

/** Responsive Slate density. Card identity and order never depend on this value. */
export function slateColumnCount(width?: number): 1 | 2 | 3 {
  if (!width || width < SLATE_TWO_COLUMN_MIN) return 1
  if (width < SLATE_THREE_COLUMN_MIN) return 2
  return 3
}

/** Convert a measured card height into the tiny implicit rows used by CSS grid. */
export function masonryRowSpan(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 1
  return Math.max(1, Math.ceil(
    (height + SLATE_MASONRY_GAP) / (SLATE_MASONRY_ROW_HEIGHT + SLATE_MASONRY_GAP),
  ))
}

interface SlateMasonryCellProps {
  children: ReactNode
  fullWidth?: boolean
}

/**
 * One measured grid item. The inner element keeps its natural content height while
 * the outer element reserves the matching number of implicit grid rows. A card can
 * therefore grow, collapse, or wrap after a resize without leaving a row-sized hole.
 */
export function SlateMasonryCell({ children, fullWidth = false }: SlateMasonryCellProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [rowSpan, setRowSpan] = useState(1)

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return

    const measure = () => {
      const next = masonryRowSpan(content.getBoundingClientRect().height)
      setRowSpan(current => current === next ? current : next)
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      data-slate-masonry-cell
      data-full-width={fullWidth ? 'true' : undefined}
      className="min-w-0 self-start"
      style={{
        gridColumn: fullWidth ? '1 / -1' : undefined,
        gridRowEnd: `span ${rowSpan}`,
      }}
    >
      <div ref={contentRef} className="min-w-0">
        {children}
      </div>
    </div>
  )
}
