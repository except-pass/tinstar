// src/components/HotkeysSidebar.tsx
import { useState, useCallback, useRef, useEffect } from 'react'
import { useHotkeyContext } from '../hotkeys/FocusPathContext'
import { onBindingFired } from '../hotkeys/bindingFiredBus'
import type { Binding } from '../hotkeys/widgetTypes'

// Tier-1 always-available bindings shown in the bottom section
const ALWAYS_AVAILABLE: Array<{ key: string; label: string }> = [
  { key: '`',         label: 'Canvas root' },
  { key: ']',         label: 'Next session' },
  { key: '[',         label: 'Prev session' },
  { key: 'Shift+]',   label: 'Next (all)' },
  { key: 'Shift+[',   label: 'Prev (all)' },
  { key: '?',         label: 'Hotkeys' },
  { key: 'Ctrl+↵',    label: 'New session' },
  { key: 'S',         label: 'Quick session' },
  { key: 'Ctrl+G',    label: 'Arrange grid' },
  { key: '1–9',       label: 'Hotgroup select' },
  { key: 'Ctrl+1–9',  label: 'Hotgroup assign' },
]

const LS_WIDTH = 'tinstar-sidebar-hotkeys-width'
const LS_COLLAPSED = 'tinstar-sidebar-hotkeys-collapsed'
const MIN_W = 140
const MAX_W = 320
const DEFAULT_W = 180

function KeyBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-1 py-0 bg-surface-raised border border-white/20 rounded text-2xs font-mono text-slate-300">
      {label}
    </span>
  )
}

function BindingRow({ binding, fireCount }: { binding: Binding | { key: string; label: string }; fireCount: number }) {
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = rowRef.current
    if (!el || fireCount === 0) return

    const scan = el.querySelector('.flourish-scan-line') as HTMLElement | null
    const ripple = el.querySelector('.flourish-ripple-ring') as HTMLElement | null

    // Force reflow so re-trigger works
    el.classList.remove('flourish-ignite')
    scan?.classList.remove('flourish-scan-active')
    ripple?.classList.remove('flourish-ripple-active')
    void el.offsetWidth

    el.classList.add('flourish-ignite')
    scan?.classList.add('flourish-scan-active')
    ripple?.classList.add('flourish-ripple-active')

    const onEnd = (ev: AnimationEvent) => {
      if (ev.animationName !== 'ignite') return
      el.classList.remove('flourish-ignite')
      scan?.classList.remove('flourish-scan-active')
      ripple?.classList.remove('flourish-ripple-active')
      el.removeEventListener('animationend', onEnd)
    }
    el.addEventListener('animationend', onEnd)
    return () => el.removeEventListener('animationend', onEnd)
  }, [fireCount])

  return (
    <div
      ref={rowRef}
      className="relative flex items-center justify-between gap-2 py-0.5 overflow-hidden rounded-sm"
    >
      <div className="flourish-scan-line" />
      <div className="flourish-ripple-ring" style={{ borderRadius: '2px' }} />
      <span className="text-2xs text-slate-400 truncate">{binding.label}</span>
      <KeyBadge label={binding.key} />
    </div>
  )
}

export function HotkeysSidebar() {
  const { path, chordState, activeDefinition } = useHotkeyContext()
  const [firedCounts, setFiredCounts] = useState<Record<string, number>>({})

  // Subscribe to binding-fired events from the context router
  useEffect(() => {
    return onBindingFired((key) => {
      setFiredCounts(c => ({ ...c, [key]: (c[key] ?? 0) + 1 }))
    })
  }, [])

  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(LS_WIDTH)
    return saved ? Math.max(MIN_W, Math.min(MAX_W, parseInt(saved))) : DEFAULT_W
  })
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(LS_COLLAPSED) === 'true'
  })

  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: width }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [width])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const newW = Math.max(MIN_W, Math.min(MAX_W, dragRef.current.startW - (e.clientX - dragRef.current.startX)))
    setWidth(newW)
    localStorage.setItem(LS_WIDTH, String(newW))
  }, [])

  const onPointerUp = useCallback(() => { dragRef.current = null }, [])

  const toggleCollapse = useCallback(() => {
    setCollapsed(c => {
      const next = !c
      localStorage.setItem(LS_COLLAPSED, String(next))
      return next
    })
  }, [])

  // Breadcrumb labels
  const breadcrumb = ['Canvas', ...path.map(n => n.label)]
  const contextLabel = activeDefinition?.displayName ?? 'Canvas'

  // Active bindings — if chord is active, show chord-only bindings; else show regular
  const activeBindings: Binding[] = activeDefinition
    ? (chordState
        ? activeDefinition.bindings.filter(b => b.chord)
        : activeDefinition.bindings.filter(b => !b.chord))
    : []

  if (collapsed) {
    return (
      <div
        className="w-6 flex-shrink-0 flex flex-col items-center justify-start pt-2 bg-surface-panel border-l border-white/10 cursor-pointer hover:bg-surface-hover"
        onClick={toggleCollapse}
        data-testid="hotkeys-sidebar-collapsed"
      >
        <span className="text-2xs font-mono text-slate-500 [writing-mode:vertical-lr] rotate-180 mt-1">KEYS</span>
      </div>
    )
  }

  return (
    <div
      className="flex-shrink-0 bg-surface-panel border-l border-white/10 relative flex flex-col overflow-hidden"
      style={{ width }}
      data-testid="hotkeys-sidebar"
    >
      {/* Drag handle on left edge */}
      <div
        className="absolute top-0 left-0 w-1.5 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors z-10"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        data-testid="hotkeys-sidebar-resize-handle"
      />

      {/* Header: breadcrumb + collapse button */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-white/10 min-w-0">
        <div className="flex items-center gap-0.5 text-2xs text-slate-500 truncate font-mono min-w-0">
          {breadcrumb.map((label, i) => (
            <span key={i} className="flex items-center gap-0.5 truncate">
              {i > 0 && <span className="text-slate-600 flex-shrink-0">›</span>}
              <span className={i === breadcrumb.length - 1 ? 'text-slate-300' : ''}>
                {label}
              </span>
            </span>
          ))}
        </div>
        <button
          className="flex-shrink-0 ml-1 text-slate-500 hover:text-primary text-xs"
          onClick={toggleCollapse}
          title="Collapse hotkeys panel"
        >
          »
        </button>
      </div>

      {/* Current context bindings */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 py-1.5 min-h-0">
        <div className={`text-2xs font-mono font-bold text-slate-500 uppercase tracking-widest mb-1.5 ${chordState ? 'text-primary' : ''}`}>
          {chordState ? '⌨ CHORD' : contextLabel}
        </div>
        {activeBindings.length === 0 ? (
          <div className="text-2xs text-slate-600 italic">no bindings</div>
        ) : (
          <div>
            {activeBindings.map(b => (
              <BindingRow key={b.key} binding={b} fireCount={firedCounts[b.key] ?? 0} />
            ))}
          </div>
        )}
        {/* Backtick always escapes to canvas root — show when inside a widget context */}
        {path.length > 0 && (
          <BindingRow binding={{ key: '`', label: 'Canvas root' }} fireCount={firedCounts['`'] ?? 0} />
        )}
      </div>

      {/* Divider */}
      <div className="border-t border-white/10 mx-2" />

      {/* Always-available tier-1 section */}
      <div className="px-2 py-1.5 flex-shrink-0">
        <div className="text-2xs font-mono font-bold text-slate-600 uppercase tracking-widest mb-1">
          Always
        </div>
        <div>
          {ALWAYS_AVAILABLE.map(b => (
            <BindingRow key={b.key} binding={b} fireCount={firedCounts[b.key] ?? 0} />
          ))}
        </div>
      </div>
    </div>
  )
}
