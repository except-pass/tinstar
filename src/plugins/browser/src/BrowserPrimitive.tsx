// Built-in plugin — consumes @tinstar/plugin-api only. Host imports forbidden (ADR-0002).
// Exceptions: `import type` from src/domain/types for widget data shapes, and the
// shared pin primitives (src/pins/PinMarker, PinBubble) so self-rendered browser
// pins are visually identical to host-rendered pins on every other widget. These
// are intentionally shared UI, not host internals; src/pins is not ESLint-fenced.
import { useState, useCallback, useRef, useEffect } from 'react'
import type { TinstarPluginAPI } from '@tinstar/plugin-api'
import { unproxyPath } from './proxyPaths'
import { BrowserPinLayer } from './notes/BrowserPinLayer'
import { formatBrowserPin } from './notes/formatBrowserPin'
import { captureTarget } from './notes/capture'

// Re-export: external importers/tests treat BrowserPrimitive as unproxyPath's home.
export { unproxyPath }

export interface BrowserPrimitiveProps {
  /** Host node id — used for the proxy path (`/api/proxy/:nodeId`). */
  nodeId: string
  /** Current target URL (empty string ⇒ show the "enter a URL" placeholder). */
  url: string
  /** Custom request headers injected by the proxy. */
  headers?: Record<string, string>
  /** Accent hex (already resolved by the caller). */
  accent: string
  /** Called when the user navigates; the caller persists it. */
  onNavigate: (url: string) => void
  /** Called when the user edits headers; caller persists. Omit to hide the headers affordance. */
  onHeadersChange?: (headers: Record<string, string>) => void
  /** Called when the user clicks close. Omit to hide the close button. */
  onClose?: () => void
  /** Slot keys for the constellation badge. */
  slots: string[]
  /** Hotkey-action id namespace (usually the host node id). */
  hotkeyId: string
  /** Iframe document title (falls back to the URL, as the original widget did). */
  title?: string
  /** Canvas chrome state for border styling (defaults to false). */
  isSelected?: boolean
  isDragging?: boolean
  isHovered?: boolean
  /** Bump this number to force an iframe reload from the host/accessory. */
  reloadSignal?: number
  /** Attached session id — enables submitting a pin to the backing session. */
  sessionId?: string
}

interface ConsoleEntry {
  id: number
  level: 'log' | 'warn' | 'error'
  args: string[]
  ts: number
}

export function makeBrowserPrimitive(api: TinstarPluginAPI) {
  const ConstellationBadge = api.constellations.Badge
  const hexToRgba = (c: string, a: number) => api.theme.accent.hexToRgba(c, a)

  function proxyUrl(nodeId: string, targetUrl: string): string {
    try {
      const parsed = new URL(targetUrl)
      return `/api/proxy/${nodeId}${parsed.pathname}${parsed.search}`
    } catch {
      return `/api/proxy/${nodeId}/`
    }
  }

  function BrowserPrimitive(props: BrowserPrimitiveProps) {
    const {
      nodeId,
      url: urlProp,
      headers,
      accent,
      onNavigate,
      onHeadersChange,
      onClose,
      slots,
      hotkeyId,
      title,
      isSelected,
      isDragging,
      isHovered,
      reloadSignal,
      sessionId,
    } = props

    const hasHeaders = headers && Object.keys(headers).length > 0

    const [url, setUrl] = useState(urlProp)
    const [inputValue, setInputValue] = useState(urlProp)
    const [editing, setEditing] = useState(!urlProp)
    const [headersOpen, setHeadersOpen] = useState(false)
    const [consoleOpen, setConsoleOpen] = useState(false)
    const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
    const nextIdRef = useRef(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const iframeRef = useRef<HTMLIFrameElement>(null)

    // Pins are host-owned (one PinSet per space); the browser reads its node's
    // pins reactively and self-renders them so they glue to scrolling content.
    const pins = api.pins.useNodePins(nodeId)
    const [iframeScroll, setIframeScroll] = useState({ x: 0, y: 0 })
    const [iframeSize, setIframeSize] = useState({ width: 0, height: 0 })
    // True while a pin marker is being dragged to reposition. The markers sit OVER
    // the iframe and setPointerCapture does NOT hold over iframes (repo memory
    // canvas_iframe_drag_guard), so we disable the iframe's pointer-events during
    // the drag locally — the plugin owns its iframe, no host coupling needed.
    const [markerDragging, setMarkerDragging] = useState(false)
    // The currently-bound scroll listener. The iframe's inner Window is replaced
    // on every cross-document navigation (the WindowProxy identity is stable), so
    // we re-bind on each load rather than dedupe by identity — see handleIframeLoad.
    const scrollBindRef = useRef<{ win: Window; handler: () => void; raf: number } | null>(null)

    // Tear down the iframe scroll listener (and any pending rAF) on unmount.
    useEffect(() => () => {
      const b = scrollBindRef.current
      if (b) { try { b.win.removeEventListener('scroll', b.handler); if (b.raf) b.win.cancelAnimationFrame(b.raf) } catch { /* gone */ } }
    }, [])

    // Pin context capture FRONT DOOR. The host shell invokes this at the drop
    // point (handlePinPlaceUp) — capture happens AT placement, not reactively.
    // We turn the viewport drop point into a content-glued pin: DOM context at
    // the point plus absolute document coords (docX/docY = iframe-body-relative
    // pixel + scroll) so the marker tracks content as the page scrolls.
    //
    // The host passes real clientX/clientY; the iframe sits below the URL toolbar,
    // so we offset by the iframe's live bounding box (ifr.left/top) to get
    // iframe-body-relative viewport pixels, then add the current scroll. The fn
    // closes over the latest `url`/`iframeScroll` — createApi keeps it fresh via a
    // ref, so registration stays stable while the closure always sees live state.
    //
    // Returns undefined (pin stays context-less, BrowserPinLayer renders it at the
    // nx fallback) when the iframe isn't laid out yet. Cross-origin documents yield
    // no `target` but still carry `url` + docX/docY.
    api.pins.useProvideCapture(({ clientX, clientY }) => {
      const ifr = iframeRef.current?.getBoundingClientRect()
      if (!ifr || ifr.width === 0 || ifr.height === 0) return undefined
      const vx = clientX - ifr.left
      const vy = clientY - ifr.top
      let doc: Document | undefined
      try { doc = iframeRef.current?.contentDocument ?? undefined } catch { /* opaque */ }
      let target: ReturnType<typeof captureTarget>
      try { if (doc) target = captureTarget(doc, vx, vy, nodeId, url) } catch { /* cross-origin */ }
      const docX = vx + iframeScroll.x
      const docY = vy + iframeScroll.y
      return { url, ...(target ? { target } : {}), docX, docY }
    })

    const submitPin = useCallback(async (id: string, comment: string) => {
      const pin = pins.find(p => p.id === id)
      if (!pin || !sessionId) return
      try {
        // Use the FRESH comment from the bubble draft, not pin.comment — the store
        // update is async and pin.comment still holds the pre-edit value this tick.
        const res = await api.http.fetch(`/api/sessions/${encodeURIComponent(sessionId)}/enter-prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: formatBrowserPin({ ...pin, comment }) }),
        })
        const body = await res.json().catch(() => null) as { ok?: boolean; error?: { message?: string } } | null
        if (!res.ok || body?.ok === false) throw new Error(body?.error?.message || `HTTP ${res.status}`)
        api.pins.update(nodeId, id, p => ({ ...p, comment, sentAt: Date.now() }))
      } catch (err) {
        api.logger?.warn?.('[browser-pins] submit failed:', (err as Error).message)
      }
    }, [pins, sessionId, nodeId])

    // Listen for console messages from the proxied iframe
    useEffect(() => {
      function handler(e: MessageEvent) {
        if (e.data?.type === 'bw-console' && e.data.wid === nodeId) {
          setConsoleEntries(prev => {
            const next = [...prev, { id: nextIdRef.current++, level: e.data.lvl, args: e.data.args, ts: e.data.ts }]
            return next.length > 200 ? next.slice(-200) : next
          })
        }
      }
      window.addEventListener('message', handler)
      return () => window.removeEventListener('message', handler)
    }, [nodeId])

    const errorCount = consoleEntries.filter(e => e.level === 'error').length
    const warnCount = consoleEntries.filter(e => e.level === 'warn').length

    // Sync when agent pushes a new URL via SSE
    useEffect(() => {
      setUrl(urlProp)
      setInputValue(urlProp)
    }, [urlProp])

    // Focus input when entering edit mode
    useEffect(() => {
      if (editing) inputRef.current?.focus()
    }, [editing])

    // Register hotkey action handler for this widget
    useEffect(() => {
      const d = api.hotkeys.onAction(hotkeyId, (action) => {
        if (action === 'fit-viewport') api.canvas.fitWidget(hotkeyId)
        else if (action === 'reload') reloadRef.current()
      })
      return () => d.dispose()
    }, [hotkeyId])

    const navigate = useCallback((target: string) => {
      const trimmed = target.trim()
      const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : trimmed ? `http://${trimmed}` : ''
      setUrl(normalized)
      setInputValue(normalized)
      setEditing(false)
      if (normalized) {
        onNavigate(normalized)
      }
    }, [onNavigate])

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') navigate(inputValue)
      if (e.key === 'Escape') {
        setInputValue(url)
        setEditing(false)
      }
    }, [inputValue, url, navigate])

    // Track navigations that happen INSIDE the iframe (link clicks / full-page
    // loads the proxied app drives itself). The primitive otherwise only learns
    // its URL from the address bar or an agent push, so an app that navigates on
    // its own — e.g. the stretchplan plan picker hitting /p/<slug> — would leave
    // _browser.url, and any plugin reading useBrowser().url, frozen on the spawn
    // URL. The proxied page is served from Tinstar's own origin so
    // contentWindow.location is readable (allow-same-origin); a genuinely
    // cross-origin document throws on access and is skipped. We un-proxy the path
    // (/api/proxy/<nodeId>/p/x → <origin>/p/x) so the persisted URL stays a real
    // target the proxy can resolve, and round-trips through proxyUrl() unchanged
    // (same iframeSrc key ⇒ no remount ⇒ no reload loop).
    const handleIframeLoad = useCallback((e: React.SyntheticEvent<HTMLIFrameElement>) => {
      // Track the proxied document's scroll so pins stay glued to content.
      // Same-origin via the proxy ⇒ direct listener; opaque docs are skipped.
      try {
        const win = e.currentTarget.contentWindow
        if (win) {
          // Re-bind every load: a cross-document navigation (e.g. the stretchplan
          // picker hitting /p/<slug>) replaces the inner Window, discarding its
          // listener, while the WindowProxy identity stays the same — so a
          // dedupe-by-identity skip would leave the new document untracked and
          // pins would drift on scroll. Tear down the prior binding, bind the new.
          const prev = scrollBindRef.current
          if (prev) { try { prev.win.removeEventListener('scroll', prev.handler); if (prev.raf) prev.win.cancelAnimationFrame(prev.raf) } catch { /* gone */ } }
          const binding = { win, handler: () => {}, raf: 0 }
          binding.handler = () => {
            if (!binding.raf) binding.raf = win.requestAnimationFrame(() => {
              binding.raf = 0
              setIframeScroll({ x: win.scrollX, y: win.scrollY })
            })
          }
          win.addEventListener('scroll', binding.handler, { passive: true })
          scrollBindRef.current = binding
          setIframeScroll({ x: win.scrollX, y: win.scrollY })
        }
      } catch { /* cross-origin */ }
      // Record the visible iframe box so the pin layer can place not-yet-enriched
      // pins (whose only coords are nx/ny normalized to that box).
      setIframeSize({ width: e.currentTarget.clientWidth, height: e.currentTarget.clientHeight })
      let real: string | null
      try {
        const loc = e.currentTarget.contentWindow?.location
        if (!loc) return
        real = unproxyPath(loc.pathname, loc.search, nodeId, url)
      } catch {
        return // cross-origin document — location is opaque, nothing to track
      }
      if (real && real !== url) {
        setUrl(real)
        onNavigate(real)
      }
    }, [nodeId, url, onNavigate])

    const reload = useCallback(() => {
      const current = url
      setUrl('')
      requestAnimationFrame(() => setUrl(current))
    }, [url])

    const reloadRef = useRef(reload)
    reloadRef.current = reload

    // Force a reload when the host/accessory bumps reloadSignal (skip initial mount).
    const firstReloadRef = useRef(true)
    useEffect(() => {
      if (firstReloadRef.current) { firstReloadRef.current = false; return }
      reloadRef.current()
    }, [reloadSignal])

    // Always proxy so the iframe works when Tinstar is accessed via a remote hostname
    // (e.g. Tailscale) — without proxying, localhost URLs would resolve on the user's
    // browser machine instead of the server.
    const iframeSrc = url ? proxyUrl(nodeId, url) : ''

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
          {onHeadersChange && (
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={() => setHeadersOpen(h => !h)}
              className={`flex-shrink-0 transition-colors ${hasHeaders ? 'text-primary' : headersOpen ? 'text-slate-300' : 'text-slate-500 hover:text-slate-300'}`}
              title="Custom headers"
            >
              <span className="material-symbols-outlined text-sm">tune</span>
            </button>
          )}
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
          <ConstellationBadge slots={slots} />
          {onClose && (
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={onClose}
              className="text-slate-500 hover:text-slate-300 flex-shrink-0 ml-0.5"
              title="Close"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          )}
        </div>

        {/* Headers editor */}
        {headersOpen && onHeadersChange && (
          <HeadersEditor
            headers={headers ?? {}}
            onClose={() => setHeadersOpen(false)}
            onSave={onHeadersChange}
          />
        )}

        {/* Body */}
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 relative">
            {iframeSrc ? (
              <>
                <iframe
                  ref={iframeRef}
                  key={iframeSrc}
                  src={iframeSrc}
                  onLoad={handleIframeLoad}
                  className="w-full h-full border-0 bg-white"
                  style={{ pointerEvents: markerDragging ? 'none' : undefined }}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                  title={title ?? url}
                />
                <BrowserPinLayer
                  pins={pins}
                  url={url}
                  scroll={iframeScroll}
                  iframeWidth={iframeSize.width}
                  iframeHeight={iframeSize.height}
                  accent={accent}
                  canSubmit={!!sessionId}
                  onCommentChange={(id, comment) => api.pins.update(nodeId, id, p => ({ ...p, comment }))}
                  onDelete={(id) => api.pins.remove(nodeId, id)}
                  onSubmit={submitPin}
                  onReposition={(id, docX, docY) => api.pins.update(nodeId, id, p => ({ ...p, context: { ...(p.context ?? {}), docX, docY } }))}
                  onDragActiveChange={setMarkerDragging}
                />
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3" style={{ color: hexToRgba(accent, 0.3) }}>
                <span className="material-symbols-outlined text-5xl">language</span>
                <span className="text-xs font-mono text-slate-600">enter a URL above or wait for an agent to push one</span>
              </div>
            )}
          </div>
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

  function HeadersEditor({ headers, onClose, onSave }: { headers: Record<string, string>; onClose: () => void; onSave: (h: Record<string, string>) => void }) {
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
      onSave(hdrs)
    }, [onSave])

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

  return BrowserPrimitive
}
