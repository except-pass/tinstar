import { useCallback, useState, useEffect } from 'react'
import type { ImageWidget } from '../../domain/types'
import type { WidgetProps } from '../widgetComponentRegistry'
import { useImageWatch } from '../../hooks/useImageWatch'
import { useHotgroupContext } from '../../hotkeys/HotgroupContext'
import { registerActionHandler, deregisterActionHandler } from '../../hotkeys/actionHandlerRegistry'
import { fitWidgetToViewport } from '../../hotkeys/canvasActionsRegistry'
import { HotgroupBadge } from '../../components/HotgroupBadge'
import { apiFetch } from '../../apiClient'

export function ImageViewerWidget({ data }: WidgetProps) {
  const widget = data as ImageWidget
  const { connected, lastUpdatedAt } = useImageWatch(widget.sessionId, widget.filePath)
  const { slotsForNode } = useHotgroupContext()

  const filename = widget.filePath.split('/').pop() ?? widget.filePath

  // Cache-bust src whenever file updates
  const imgSrc = lastUpdatedAt
    ? `/api/image-file?session=${encodeURIComponent(widget.sessionId)}&path=${encodeURIComponent(widget.filePath)}&t=${lastUpdatedAt.getTime()}`
    : `/api/image-file?session=${encodeURIComponent(widget.sessionId)}&path=${encodeURIComponent(widget.filePath)}`

  const handleOpenInEditor = useCallback(() => {
    apiFetch('/api/editor/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: widget.filePath, sessionId: widget.sessionId }),
    }).catch(() => {})
  }, [widget.filePath, widget.sessionId])

  const handleClose = useCallback(() => {
    apiFetch(`/api/image-widgets/${widget.id}`, { method: 'DELETE' }).catch(() => {})
  }, [widget.id])

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!lastUpdatedAt) return
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [lastUpdatedAt])
  const secondsAgo = lastUpdatedAt ? Math.max(0, Math.floor((now - lastUpdatedAt.getTime()) / 1000)) : null

  const [imgError, setImgError] = useState(false)
  useEffect(() => { setImgError(false) }, [imgSrc])

  // Register hotkey action handler for this widget
  useEffect(() => {
    registerActionHandler(widget.id, (action) => {
      if (action === 'fit-viewport') fitWidgetToViewport(widget.id)
    })
    return () => deregisterActionHandler(widget.id)
  }, [widget.id])

  return (
    <div className="flex flex-col h-full bg-surface-base text-slate-300 overflow-hidden">
      {/* Header */}
      <div className="widget-drag-handle flex items-center gap-2 px-3 py-1.5 bg-surface-panel border-b border-white/10 flex-shrink-0 cursor-grab">
        <span className="text-primary text-xs">⬡</span>
        <span className="text-2xs font-mono text-slate-400 truncate flex-1">
          {[widget.task, widget.worktree, filename].filter(Boolean).join(' · ')}
        </span>
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={handleOpenInEditor}
          className="text-2xs font-mono px-2 py-0.5 rounded border border-primary/30 text-slate-400 hover:text-slate-200 hover:border-primary/60 flex-shrink-0"
        >
          ↗ Open
        </button>
        <HotgroupBadge slots={slotsForNode(`image-${widget.id}`)} />
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={handleClose}
          className="text-slate-500 hover:text-slate-300 flex-shrink-0 ml-1"
          title="Close"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex items-center justify-center bg-surface-base">
        {imgError ? (
          <div className="text-slate-500 text-xs font-mono px-4 text-center">
            File not found or unsupported format
          </div>
        ) : (
          <img
            key={imgSrc}
            src={imgSrc}
            alt={filename}
            className="max-w-full max-h-full object-contain"
            onError={() => setImgError(true)}
            onLoad={() => setImgError(false)}
          />
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 py-1 bg-surface-panel border-t border-white/10 flex-shrink-0">
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: connected ? '#22c55e' : '#64748b' }}
        />
        <span className="text-2xs font-mono text-slate-500">
          {connected
            ? `watching · last updated ${secondsAgo === null ? '…' : secondsAgo + 's ago'}`
            : 'disconnected'}
        </span>
      </div>
    </div>
  )
}
