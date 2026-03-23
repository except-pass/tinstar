import { useState, useCallback, useRef, useEffect } from 'react'
import type { BrowserWidget } from '../../domain/types'
import type { WidgetProps } from '../widgetComponentRegistry'
import { hexToRgba, resolveRunAccent } from '../../components/runAccent'
import { useHotgroupContext } from '../../hotkeys/HotgroupContext'
import { HotgroupBadge } from '../../components/HotgroupBadge'

export function BrowserWidget({ data, isSelected, isDragging, isHovered }: WidgetProps) {
  const widget = data as BrowserWidget
  const accent = resolveRunAccent(widget.color)
  const { slotsForNode } = useHotgroupContext()

  const [url, setUrl] = useState(widget.url)
  const [inputValue, setInputValue] = useState(widget.url)
  const [editing, setEditing] = useState(!widget.url)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync when agent pushes a new URL via SSE
  useEffect(() => {
    setUrl(widget.url)
    setInputValue(widget.url)
  }, [widget.url])

  // Focus input when entering edit mode
  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const navigate = useCallback((target: string) => {
    const trimmed = target.trim()
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : trimmed ? `http://${trimmed}` : ''
    setUrl(normalized)
    setInputValue(normalized)
    setEditing(false)
    if (normalized) {
      fetch(`/api/browser-widgets/${widget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: normalized }),
      }).catch(() => {})
    }
  }, [widget.id])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') navigate(inputValue)
    if (e.key === 'Escape') {
      setInputValue(url)
      setEditing(false)
    }
  }, [inputValue, url, navigate])

  const handleClose = useCallback(() => {
    fetch(`/api/browser-widgets/${widget.id}`, { method: 'DELETE' }).catch(() => {})
  }, [widget.id])

  const reload = useCallback(() => {
    const current = url
    setUrl('')
    requestAnimationFrame(() => setUrl(current))
  }, [url])

  const borderStyle = isDragging
    ? { borderColor: hexToRgba(accent, 0.9), boxShadow: `0 20px 80px ${hexToRgba(accent, 0.4)}, 0 0 0 2px ${hexToRgba(accent, 0.8)}` }
    : isSelected
      ? { borderColor: hexToRgba(accent, 0.9), boxShadow: `0 0 0 1px ${hexToRgba(accent, 0.5)}, 0 0 16px ${hexToRgba(accent, 0.25)}` }
      : isHovered
        ? { borderColor: hexToRgba(accent, 0.5), boxShadow: `0 0 6px ${hexToRgba(accent, 0.15)}` }
        : { borderColor: hexToRgba(accent, 0.2), boxShadow: 'none' }

  return (
    <div
      className="flex flex-col h-full bg-surface-base border overflow-hidden"
      style={borderStyle}
    >
      {/* Header / URL bar */}
      <div
        className="widget-drag-handle flex items-center gap-1.5 px-3 py-2.5 bg-surface-panel border-b flex-shrink-0 cursor-grab"
        style={{ borderBottomColor: hexToRgba(accent, 0.2) }}
      >
        <span
          className="material-symbols-outlined text-sm flex-shrink-0"
          style={{ color: hexToRgba(accent, 0.8) }}
        >
          language
        </span>
        {editing ? (
          <input
            ref={inputRef}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => { setInputValue(url); setEditing(false) }}
            onPointerDown={e => e.stopPropagation()}
            placeholder="localhost:3000"
            className="flex-1 min-w-0 bg-surface-base text-xs font-mono text-slate-200 px-2 py-0.5 rounded border border-primary/40 outline-none focus:border-primary/80"
            spellCheck={false}
          />
        ) : (
          <button
            className="flex-1 min-w-0 text-left text-xs font-mono text-slate-400 hover:text-slate-200 px-2 py-0.5 rounded hover:bg-white/5 truncate"
            onPointerDown={e => e.stopPropagation()}
            onClick={() => setEditing(true)}
            title={url || 'Click to enter URL'}
          >
            {url || <span className="text-slate-600 italic">enter URL…</span>}
          </button>
        )}
        {url && (
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={reload}
            className="text-slate-500 hover:text-slate-300 flex-shrink-0"
            title="Reload"
          >
            <span className="material-symbols-outlined text-sm">refresh</span>
          </button>
        )}
        <HotgroupBadge slots={slotsForNode(`browser-${widget.id}`)} />
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={handleClose}
          className="text-slate-500 hover:text-slate-300 flex-shrink-0 ml-0.5"
          title="Close"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 relative">
        {url ? (
          <iframe
            key={url}
            src={url}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            title={widget.title ?? url}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3" style={{ color: hexToRgba(accent, 0.3) }}>
            <span className="material-symbols-outlined text-5xl">language</span>
            <span className="text-xs font-mono text-slate-600">enter a URL above or wait for an agent to push one</span>
          </div>
        )}
      </div>
    </div>
  )
}
