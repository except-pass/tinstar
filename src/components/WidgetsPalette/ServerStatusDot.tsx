import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from '../../apiClient'

export interface ServerStatusDotProps {
  pluginId: string
  displayName: string
  status: 'up' | 'down' | 'unknown'
  startable: boolean
  /** 'server' = plugin-declared server block (Start/View-log popover);
   *  'nats' = the Saloon's host NATS broker light (informational popover). */
  kind?: 'server' | 'nats'
  onStart: (pluginId: string) => void
}

const COLOR: Record<ServerStatusDotProps['status'], string> = {
  up: 'bg-emerald-400',
  down: 'bg-red-400',
  unknown: 'bg-amber-400 animate-pulse',
}

const LABEL: Record<'server' | 'nats', Record<ServerStatusDotProps['status'], string>> = {
  server: { up: 'Server up', down: 'Server down', unknown: 'Checking…' },
  nats: { up: 'NATS broker up', down: 'NATS broker down', unknown: 'Checking NATS…' },
}

const POPOVER_W = 208 // matches w-52
const GAP = 6
const MARGIN = 8

interface PopoverPos { left: number; top?: number; bottom?: number; maxHeight: number }

// Place the popover anchored to the dot, `fixed`, clamped to the viewport. The dot
// lives inside the palette's `overflow-y-auto` scroll box — and since a non-visible
// overflow on one axis forces the other to compute to `auto` too, that box ALSO clips
// horizontally. An in-flow `absolute` popover therefore gets sliced off (the Start
// button rendered into invisible space → a click that looks dead). Portaling to <body>
// with fixed coords escapes the clip entirely. Opens on whichever side (below/above)
// has more room so it always fits; exported so the popover math is unit-testable.
export function placePopover(rect: { left: number; bottom: number; top: number }): PopoverPos {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.max(MARGIN, Math.min(rect.left, vw - POPOVER_W - MARGIN))
  const roomBelow = vh - rect.bottom
  const roomAbove = rect.top
  if (roomBelow >= roomAbove) {
    return { left, top: rect.bottom + GAP, maxHeight: Math.max(120, roomBelow - GAP - MARGIN) }
  }
  return { left, bottom: vh - rect.top + GAP, maxHeight: Math.max(120, roomAbove - GAP - MARGIN) }
}

export function ServerStatusDot({ pluginId, displayName, status, startable, kind = 'server', onStart }: ServerStatusDotProps) {
  const label = LABEL[kind][status]
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState<string | null>(null)
  const [pos, setPos] = useState<PopoverPos | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Hint that a down+startable dot is actionable (the popover offers Start).
  const actionable = kind === 'server' && status === 'down' && startable
  const title = actionable ? `${label} — click to start` : label

  const reposition = useCallback(() => {
    const el = btnRef.current
    if (el) setPos(placePopover(el.getBoundingClientRect()))
  }, [])

  // Compute placement synchronously when the popover opens (before paint, so it never
  // flashes at a stale spot), and keep it pinned to the dot as the palette scrolls or
  // the window resizes.
  useLayoutEffect(() => {
    if (!open) return
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true) // capture: catch the palette's own scroll
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, reposition])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const viewLog = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const r = await apiFetch(`/api/plugin-servers/${encodeURIComponent(pluginId)}/log`)
      const j = (await r.json()) as { ok: boolean; data?: { log: string } }
      if (!r.ok || !j.ok) { setLog('(failed to read log)'); return }
      setLog(j.data?.log || '(log empty)')
    } catch { setLog('(failed to read log)') }
  }

  const popover = open && pos ? createPortal(
    <div
      ref={popRef}
      style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, zIndex: 60, maxHeight: pos.maxHeight }}
      className="w-52 overflow-y-auto scrollbar-thin rounded-md border border-white/10 bg-surface-raised p-2 text-left shadow-lg"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1 text-2xs font-medium text-slate-200">{displayName} — {label}</div>
      {kind === 'nats' ? (
        <div className="text-2xs text-slate-400">
          {status === 'up'
            ? 'Host NATS observer is connected to the broker.'
            : 'Host NATS observer is not connected. Open a Saloon to reconnect, or check the broker.'}
        </div>
      ) : (
        <>
          {status === 'down' && startable && (
            <button
              type="button"
              data-testid={`server-status-start-${pluginId}`}
              onClick={(e) => { e.stopPropagation(); onStart(pluginId); setOpen(false) }}
              className="w-full rounded bg-primary/20 px-2 py-1 text-2xs text-primary hover:bg-primary/30"
            >
              Start server
            </button>
          )}
          {status === 'down' && !startable && (
            <div className="text-2xs text-slate-400">No start command declared. Start it manually.</div>
          )}
          <button
            type="button"
            onClick={viewLog}
            className="mt-1 w-full text-left text-[10px] text-slate-400 underline hover:text-slate-200"
          >
            View log
          </button>
          {log !== null && (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-1 text-[10px] text-slate-300">{log}</pre>
          )}
        </>
      )}
    </div>,
    document.body,
  ) : null

  return (
    // draggable=false + stopPropagation so a press-drag starting on the dot never
    // bleeds into the palette tile's native HTML5 drag (which would spawn the widget).
    <div
      className="absolute top-1 left-1 z-10"
      draggable={false}
      onDragStart={(e) => e.stopPropagation()}
    >
      <button
        ref={btnRef}
        type="button"
        data-testid={`server-status-dot-${pluginId}`}
        data-status={status}
        title={title}
        aria-label={`${displayName}: ${label}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        className={`block h-2.5 w-2.5 rounded-full ring-1 ring-black/30 ${COLOR[status]}${actionable ? ' ring-red-300/60 animate-pulse' : ''}`}
      />
      {popover}
    </div>
  )
}
