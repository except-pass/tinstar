import { useState, useCallback, useRef, useEffect } from 'react'
import type { BrowserWidget } from '../../../domain/types'
import type { WidgetProps } from '../../../widgets/widgetComponentRegistry'
import { hexToRgba, resolveRunAccent } from '../../../components/runAccent'
import { useHotgroupContext } from '../../../hotkeys/HotgroupContext'
import { registerActionHandler, deregisterActionHandler } from '../../../hotkeys/actionHandlerRegistry'
import { fitWidgetToViewport } from '../../../hotkeys/canvasActionsRegistry'
import { HotgroupBadge } from '../../../components/HotgroupBadge'
import { apiFetch } from '../../../apiClient'

function proxyUrl(widgetId: string, targetUrl: string): string {
  try {
    const parsed = new URL(targetUrl)
    return `/api/proxy/${widgetId}${parsed.pathname}${parsed.search}`
  } catch {
    return `/api/proxy/${widgetId}/`
  }
}

interface ConsoleEntry {
  id: number
  level: 'log' | 'warn' | 'error'
  args: string[]
  ts: number
}

export function BrowserWidget({ data, isSelected, isDragging, isHovered }: WidgetProps) {
  const widget = data as BrowserWidget
  const accent = resolveRunAccent(widget.color)
  const { slotsForNode } = useHotgroupContext()
  const hasHeaders = widget.headers && Object.keys(widget.headers).length > 0

  const [url, setUrl] = useState(widget.url)
  const [inputValue, setInputValue] = useState(widget.url)
  const [editing, setEditing] = useState(!widget.url)
  const [headersOpen, setHeadersOpen] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
  const nextIdRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Listen for console messages from the proxied iframe
  useEffect(() => {
    function handler(e: MessageEvent) {
      if (e.data?.type === 'bw-console' && e.data.wid === widget.id) {
        setConsoleEntries(prev => {
          const next = [...prev, { id: nextIdRef.current++, level: e.data.lvl, args: e.data.args, ts: e.data.ts }]
          return next.length > 200 ? next.slice(-200) : next
        })
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [widget.id])

  const errorCount = consoleEntries.filter(e => e.level === 'error').length
  const warnCount = consoleEntries.filter(e => e.level === 'warn').length

  // Sync when agent pushes a new URL via SSE
  useEffect(() => {
    setUrl(widget.url)
    setInputValue(widget.url)
  }, [widget.url])

  // Focus input when entering edit mode
  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  // Register hotkey action handler for this widget
  useEffect(() => {
    registerActionHandler(widget.id, (action) => {
      if (action === 'fit-viewport') fitWidgetToViewport(widget.id)
      else if (action === 'reload') reloadRef.current()
    })
    return () => deregisterActionHandler(widget.id)
  }, [widget.id])

  const navigate = useCallback((target: string) => {
    const trimmed = target.trim()
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : trimmed ? `http://${trimmed}` : ''
    setUrl(normalized)
    setInputValue(normalized)
    setEditing(false)
    if (normalized) {
      apiFetch(`/api/browser-widgets/${widget.id}`, {
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
    apiFetch(`/api/browser-widgets/${widget.id}`, { method: 'DELETE' }).catch(() => {})
  }, [widget.id])

  const reload = useCallback(() => {
    const current = url
    setUrl('')
    requestAnimationFrame(() => setUrl(current))
  }, [url])

  const reloadRef = useRef(reload)
  reloadRef.current = reload

  // Always proxy so the iframe works when Tinstar is accessed via a remote hostname
  // (e.g. Tailscale) — without proxying, localhost URLs would resolve on the user's
  // browser machine instead of the server.
  const iframeSrc = url ? proxyUrl(widget.id, url) : ''

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
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={() => setHeadersOpen(h => !h)}
          className={`flex-shrink-0 transition-colors ${hasHeaders ? 'text-primary' : headersOpen ? 'text-slate-300' : 'text-slate-500 hover:text-slate-300'}`}
          title="Custom headers"
        >
          <span className="material-symbols-outlined text-sm">tune</span>
        </button>
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={() => setConsoleOpen(c => !c)}
          className={`flex-shrink-0 relative transition-colors ${
            errorCount > 0 ? 'text-red-400' : warnCount > 0 ? 'text-yellow-400'
            : consoleOpen ? 'text-slate-300' : 'text-slate-500 hover:text-slate-300'
          }`}
          title={`Console${errorCount ? ` (${errorCount} error${errorCount > 1 ? 's' : ''})` : ''}`}
        >
          <span className="material-symbols-outlined text-sm">terminal</span>
          {errorCount > 0 && (
            <span className="absolute -top-1 -right-1.5 min-w-[14px] h-[14px] bg-red-500 rounded-full text-[8px] text-white flex items-center justify-center px-0.5 font-mono leading-none">
              {errorCount > 99 ? '!' : errorCount}
            </span>
          )}
        </button>
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

      {/* Headers editor */}
      {headersOpen && (
        <HeadersEditor
          widgetId={widget.id}
          headers={widget.headers ?? {}}
          onClose={() => setHeadersOpen(false)}
        />
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 relative">
        {iframeSrc ? (
          <iframe
            key={iframeSrc}
            src={iframeSrc}
            className="w-full h-full border-0 bg-white"
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

      {/* Console panel */}
      {consoleOpen && (
        <ConsolePanel
          entries={consoleEntries}
          onClear={() => setConsoleEntries([])}
        />
      )}
    </div>
  )
}

function ConsolePanel({ entries, onClear }: { entries: ConsoleEntry[]; onClear: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length])

  return (
    <div className="flex flex-col border-t border-white/10 bg-[#08080c] flex-shrink-0" style={{ height: 160 }}>
      <div className="flex items-center justify-between px-2 py-1 border-b border-white/5 flex-shrink-0">
        <span className="text-2xs font-mono text-slate-500 uppercase tracking-widest">Console</span>
        <div className="flex items-center gap-2">
          <span className="text-2xs font-mono text-slate-600">{entries.length}</span>
          <button onClick={onClear} className="text-slate-600 hover:text-slate-400">
            <span className="material-symbols-outlined text-xs">delete</span>
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden font-mono text-2xs select-text">
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-700">no console output</div>
        ) : entries.map(e => (
          <div
            key={e.id}
            className={`flex gap-2 px-2 py-[3px] border-b border-white/[0.02] ${
              e.level === 'error' ? 'text-red-400 bg-red-500/[0.04]' :
              e.level === 'warn' ? 'text-yellow-400 bg-yellow-500/[0.04]' :
              'text-slate-500'
            }`}
          >
            <span className="text-slate-600 flex-shrink-0 tabular-nums">
              {new Date(e.ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
            <span className="break-all whitespace-pre-wrap">{e.args.join(' ')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function HeadersEditor({ widgetId, headers, onClose }: { widgetId: string; headers: Record<string, string>; onClose: () => void }) {
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>(() => {
    const entries = Object.entries(headers)
    return entries.length > 0 ? entries.map(([key, value]) => ({ key, value })) : [{ key: '', value: '' }]
  })

  const save = useCallback((newRows: Array<{ key: string; value: string }>) => {
    const hdrs: Record<string, string> = {}
    for (const { key, value } of newRows) {
      const k = key.trim()
      if (k) hdrs[k] = value
    }
    apiFetch(`/api/browser-widgets/${widgetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headers: hdrs }),
    }).catch(() => {})
  }, [widgetId])

  const updateRow = (i: number, field: 'key' | 'value', val: string) => {
    const next = rows.map((r, j) => j === i ? { ...r, [field]: val } : r)
    setRows(next)
  }

  const addRow = () => setRows(r => [...r, { key: '', value: '' }])

  const removeRow = (i: number) => {
    const next = rows.filter((_, j) => j !== i)
    const final = next.length === 0 ? [{ key: '', value: '' }] : next
    setRows(final)
    save(final)
  }

  const handleBlur = () => save(rows)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { save(rows); onClose() }
    if (e.key === 'Escape') onClose()
  }

  return (
    <div
      className="bg-surface-base border-b border-white/10 px-3 py-2 flex flex-col gap-1.5"
      onPointerDown={e => e.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <span className="text-2xs font-mono text-slate-500 uppercase tracking-widest">Headers</span>
        <button onClick={addRow} className="text-slate-600 hover:text-primary text-xs" title="Add header">
          <span className="material-symbols-outlined text-sm">add</span>
        </button>
      </div>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            value={row.key}
            onChange={e => updateRow(i, 'key', e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="Header-Name"
            className="w-[35%] bg-surface-panel text-2xs font-mono text-slate-300 px-1.5 py-0.5 rounded border border-white/10 outline-none focus:border-primary/50"
            spellCheck={false}
          />
          <input
            value={row.value}
            onChange={e => updateRow(i, 'value', e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="value"
            className="flex-1 bg-surface-panel text-2xs font-mono text-slate-300 px-1.5 py-0.5 rounded border border-white/10 outline-none focus:border-primary/50"
            spellCheck={false}
          />
          <button onClick={() => removeRow(i)} className="text-slate-600 hover:text-accent-red flex-shrink-0">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        </div>
      ))}
    </div>
  )
}
