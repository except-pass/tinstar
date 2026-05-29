import { useEffect, useState } from 'react'

interface GhostState {
  visible: boolean
  x: number
  y: number
  width: number
  height: number
  label: string
}

const HIDDEN: GhostState = { visible: false, x: 0, y: 0, width: 0, height: 0, label: '' }

export function PaletteDragGhost() {
  const [ghost, setGhost] = useState<GhostState>(HIDDEN)

  useEffect(() => {
    function onPaletteDragStart(e: Event) {
      const detail = (e as CustomEvent).detail as { width: number; height: number; label: string } | undefined
      if (!detail) return
      setGhost(g => ({ ...g, visible: true, width: detail.width, height: detail.height, label: detail.label }))
    }
    function onDragOver(e: DragEvent) {
      // Only track when the right type is present on the dataTransfer
      const types = e.dataTransfer?.types
      if (!types) return
      if (!Array.from(types).includes('application/tinstar-plugin-widget')) return
      setGhost(g => g.visible ? { ...g, x: e.clientX, y: e.clientY } : g)
    }
    function reset() { setGhost(HIDDEN) }

    window.addEventListener('tinstar:palette-drag-start', onPaletteDragStart)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)

    return () => {
      window.removeEventListener('tinstar:palette-drag-start', onPaletteDragStart)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('drop', reset)
    }
  }, [])

  if (!ghost.visible) return null

  return (
    <div
      data-testid="palette-drag-ghost"
      style={{
        position: 'fixed', pointerEvents: 'none', zIndex: 9999,
        left: ghost.x - ghost.width / 2,
        top: ghost.y - ghost.height / 2,
        width: ghost.width,
        height: ghost.height,
        border: '2px dashed rgba(96, 165, 250, 0.7)',
        background: 'rgba(96, 165, 250, 0.08)',
        borderRadius: 4,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'rgba(96, 165, 250, 0.9)',
        fontSize: 12,
        userSelect: 'none',
      }}
    >
      {ghost.label}
    </div>
  )
}
