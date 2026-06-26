// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
// Exceptions: `import type` from src/domain/types for widget data shapes, and the
// shared pin primitives (src/pins/* + FileEditorPinLayer, which itself wraps them)
// so self-rendered editor pins are visually identical to host-rendered pins on
// every other widget. These are intentionally shared UI, not host internals;
// src/pins is not ESLint-fenced (the browser plugin does exactly this).
import { useRef, useEffect, useCallback, useState, useLayoutEffect } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { FileEditorPinLayer } from './FileEditorPinLayer'
import { replyInstructions, threadSoFar } from '../../../pins/replyPrompt'
import type { editor as MonacoEditor } from 'monaco-editor'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import type { EditorWidget } from '../../../domain/types'

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go',
    rs: 'rust', java: 'java', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', html: 'html', css: 'css',
    sh: 'shell', bash: 'shell',
    sql: 'sql', xml: 'xml', toml: 'toml',
  }
  return map[ext] ?? 'plaintext'
}

function isBinaryOrLarge(content: string): boolean {
  if (content.length > 500 * 1024) return true
  const sample = content.slice(0, 8192)
  return sample.includes('\x00')
}

export function makeFileEditorWidget(api: TinstarPluginAPI) {
  const ConstellationBadge = api.constellations.Badge

  return function FileEditorWidget({ data }: WidgetProps<EditorWidget>) {
  const widget = data
  const { content, connected, lastUpdatedAt } = api.watch.file(widget.sessionId, widget.filePath)
  // Canonical node id — `widget.id` already carries the `editor-` prefix, so
  // `editor-${widget.id}` would double it and resolve to no slot.
  const myNodeId = api.constellations.useMyNodeId()
  const { slotsForNode } = api.constellations.useContext()
  const publishCapability = api.constellations.usePublishCapability()

  // Publish file.path so peers (e.g. a future "open in editor" widget) can
  // discover what file I'm showing without snooping at data props.
  useEffect(() => {
    return publishCapability('file.path', async () => widget.filePath).dispose
  }, [widget.filePath, publishCapability])
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  // Ref so handleEditorMount always reads the latest content, avoiding stale closure
  const contentRef = useRef<string | null>(null)
  contentRef.current = content

  const filename = widget.filePath.split('/').pop() ?? widget.filePath

  // Diff mode state
  const [diffMode, setDiffMode] = useState(false)
  const [baseContent, setBaseContent] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  // Track whether we've ever fetched for this widget (to know new-file vs not-fetched)
  const baseFetchedRef = useRef(false)

  const fetchBaseContent = useCallback(() => {
    setDiffLoading(true)
    baseFetchedRef.current = true
    api.http.fetch('/api/file-content/git-base', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: widget.sessionId, filePath: widget.filePath }),
    })
      .then(r => r.json())
      .then((body: { ok?: boolean; data?: { content?: string | null } }) => {
        // null content means new file (not in HEAD) — use empty string so diff still works
        setBaseContent(body.data?.content ?? '')
        setDiffLoading(false)
      })
      .catch(() => {
        setBaseContent('')
        setDiffLoading(false)
      })
  }, [widget.sessionId, widget.filePath])

  const toggleDiff = useCallback(() => {
    setDiffMode(prev => {
      const next = !prev
      if (next && !baseFetchedRef.current) fetchBaseContent()
      return next
    })
  }, [fetchBaseContent])

  // When content updates after Monaco is already mounted, update the editor value
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || content === null) return
    const scrollTop = ed.getScrollTop()
    const scrollLeft = ed.getScrollLeft()
    ed.setValue(content)
    // Restore scroll after Monaco processes the change
    const disposable = ed.onDidChangeModelContent(() => {
      ed.setScrollTop(scrollTop)
      ed.setScrollLeft(scrollLeft)
      disposable.dispose()
    })
  }, [content])

  // onMount fires once when Monaco initializes; read contentRef to avoid stale closure
  const handleEditorMount = useCallback((ed: MonacoEditor.IStandaloneCodeEditor) => {
    editorRef.current = ed
    if (contentRef.current !== null) ed.setValue(contentRef.current)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenInEditor = useCallback(() => {
    api.http.fetch('/api/editor/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: widget.filePath, sessionId: widget.sessionId }),
    }).catch(() => {})
  }, [widget.filePath, widget.sessionId])

  const handleClose = useCallback(() => {
    api.http.fetch(`/api/editor-widgets/${widget.id}`, { method: 'DELETE' }).catch(() => {})
  }, [widget.id])

  const [wordWrap, setWordWrap] = useState(false)

  const toggleWordWrap = useCallback(() => {
    setWordWrap(prev => {
      const next = !prev
      editorRef.current?.updateOptions({ wordWrap: next ? 'on' : 'off' })
      return next
    })
  }, [])

  const language = getLanguage(widget.filePath)
  const isMarkdown = language === 'markdown'
  const [rendered, setRendered] = useState(isMarkdown)
  const toggleRendered = useCallback(() => setRendered(prev => !prev), [])

  // Register hotkey action handlers for when this widget is the focused context
  useEffect(() => {
    const d = api.hotkeys.onAction(widget.id, (action) => {
      if (action === 'open-in-editor') handleOpenInEditor()
      if (action === 'toggle-word-wrap') toggleWordWrap()
      if (action === 'toggle-diff') toggleDiff()
      if (action === 'fit-viewport') api.canvas.fitWidget(widget.id)
      if (action === 'toggle-rendered' && isMarkdown) toggleRendered()
    })
    return () => d.dispose()
  }, [widget.id, handleOpenInEditor, toggleWordWrap, toggleDiff, toggleRendered, isMarkdown])

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!lastUpdatedAt) return
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [lastUpdatedAt])
  const secondsAgo = lastUpdatedAt ? Math.max(0, Math.floor((now - lastUpdatedAt.getTime()) / 1000)) : null

  const showBinaryMessage = content !== null && isBinaryOrLarge(content)

  // ── Pins ────────────────────────────────────────────────────────────────
  // The file-editor sets rendersOwnPinMarkers, so the host shell no longer draws
  // the generic frame-anchored PinLayer for this widget — we render our own over
  // the body. In rendered-markdown mode the markers track the scroll container's
  // offset so they stay glued to the text (the reported bug). In Monaco code/diff
  // modes scroll is pinned to {0,0} (markers stay frame-anchored, matching today's
  // behavior — Monaco-mode scroll-tracking is a known follow-up, out of scope here).
  const pins = api.pins.useNodePins(widget.id)
  const pinsRef = useRef(pins)
  pinsRef.current = pins
  const scrollElRef = useRef<HTMLDivElement>(null)  // markdown scroll container (rendered mode only)
  const bodyRef = useRef<HTMLDivElement>(null)      // body wrapper — the box the pin overlay covers
  const [scroll, setScroll] = useState({ x: 0, y: 0 })
  const [bodySize, setBodySize] = useState({ width: 0, height: 0 })

  // rAF-throttle scroll updates (one setState per frame) like the browser primitive.
  const scrollRafRef = useRef(0)
  const pendingScrollRef = useRef({ x: 0, y: 0 })
  const handleScrollChange = useCallback((o: { x: number; y: number }) => {
    pendingScrollRef.current = o
    if (!scrollRafRef.current) {
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = 0
        setScroll(pendingScrollRef.current)
      })
    }
  }, [])
  useEffect(() => () => { if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current) }, [])

  // Track the body box so fresh (un-enriched) pins fall back to nx*width / ny*height.
  // ResizeObserver keeps it correct when the widget is resized on the canvas.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => setBodySize({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Leaving rendered mode resets the offset so Monaco-mode markers render at {0,0}.
  useEffect(() => { if (!rendered) setScroll({ x: 0, y: 0 }) }, [rendered])

  // Pin context capture FRONT DOOR — the host shell invokes this at the drop point
  // to enrich the new pin. Turn the viewport point into a content-glued pin: body-
  // relative pixel + the scroll container's scroll, so the marker tracks the text.
  // Returns undefined (pin stays at the nx/ny fallback) when the body isn't laid out.
  api.pins.useProvideCapture(({ clientX, clientY }) => {
    const scroller = scrollElRef.current
    const rectEl = scroller ?? bodyRef.current
    if (!rectEl) return undefined
    const rect = rectEl.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return undefined
    const sx = scroller ? scroller.scrollLeft : 0
    const sy = scroller ? scroller.scrollTop : 0
    return { docX: clientX - rect.left + sx, docY: clientY - rect.top + sy }
  })

  const submitPin = useCallback(async (id: string, comment: string) => {
    const pin = pinsRef.current.find(p => p.id === id)
    if (!pin || !widget.sessionId) return
    // Use the FRESH comment from the bubble draft, not pin.comment — the store
    // update is async and pin.comment still holds the pre-edit value this tick.
    const prompt = `📍 New note on ${filename} — ${comment || '(no comment)'}\n\n${replyInstructions(id, window.location.origin)}`
    try {
      const res = await api.http.fetch(`/api/sessions/${encodeURIComponent(widget.sessionId)}/enter-prompt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
      })
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: { message?: string } } | null
      if (!res.ok || body?.ok === false) throw new Error(body?.error?.message || `HTTP ${res.status}`)
      api.pins.update(widget.id, id, p => ({ ...p, comment, sentAt: Date.now() }))
    } catch (err) {
      api.logger?.warn?.('[file-editor-pins] submit failed:', (err as Error).message)
    }
  }, [widget.sessionId, widget.id, filename])

  const replyToPin = useCallback(async (id: string, text: string) => {
    if (!widget.sessionId) return
    const pin = pinsRef.current.find(p => p.id === id)
    try {
      await api.http.fetch(`/api/notes/${encodeURIComponent(id)}/replies`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, author: 'user' }),
      })
    } catch (err) { api.logger?.warn?.('[file-editor-pins] reply failed:', (err as Error).message); return }
    const history = pin ? `${threadSoFar(pin)}\n[user] ${text}` : `[user] ${text}`
    const prompt = `📍 Follow-up on the note:\n\n${history}\n\n${replyInstructions(id, window.location.origin)}`
    try {
      await api.http.fetch(`/api/sessions/${encodeURIComponent(widget.sessionId)}/enter-prompt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
      })
    } catch (err) { api.logger?.warn?.('[file-editor-pins] re-prompt failed:', (err as Error).message) }
  }, [widget.sessionId])

  return (
    <div className="flex flex-col h-full bg-surface-base text-slate-300 overflow-hidden">
      {/* Header */}
      <div
        className="widget-drag-handle flex items-center gap-2 px-3 py-1.5 bg-surface-panel border-b border-white/10 flex-shrink-0 cursor-grab"
      >
        <span className="text-primary text-xs">⬡</span>
        <span className="text-2xs font-mono text-slate-400 truncate flex-1">
          {[widget.task, widget.worktree, filename].filter(Boolean).join(' · ')}
        </span>
        {!rendered && (
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={toggleDiff}
            className={`text-2xs font-mono px-2 py-0.5 rounded border flex-shrink-0 ${diffMode ? 'border-primary/60 text-primary' : 'border-primary/30 text-slate-400 hover:text-slate-200 hover:border-primary/60'}`}
            title="Toggle diff view (vs HEAD)"
          >
            diff
          </button>
        )}
        {!rendered && (
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={toggleWordWrap}
            className={`text-2xs font-mono px-2 py-0.5 rounded border flex-shrink-0 ${wordWrap ? 'border-primary/60 text-primary' : 'border-primary/30 text-slate-400 hover:text-slate-200 hover:border-primary/60'}`}
            title="Toggle word wrap"
          >
            wrap
          </button>
        )}
        {isMarkdown && (
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={toggleRendered}
            className={`text-2xs font-mono px-2 py-0.5 rounded border flex-shrink-0 ${rendered ? 'border-primary/60 text-primary' : 'border-primary/30 text-slate-400 hover:text-slate-200 hover:border-primary/60'}`}
            title="Toggle rendered markdown view"
          >
            rendered
          </button>
        )}
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={handleOpenInEditor}
          className="text-2xs font-mono px-2 py-0.5 rounded border border-primary/30 text-slate-400 hover:text-slate-200 hover:border-primary/60 flex-shrink-0"
        >
          ↗ Open in Editor
        </button>
        <ConstellationBadge slots={slotsForNode(myNodeId)} />
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
      <div ref={bodyRef} className="flex-1 min-h-0 relative">
        {content !== null && rendered ? (
          <MarkdownRenderer
            content={content}
            filePath={widget.filePath}
            sessionId={widget.sessionId}
            widgetId={widget.id}
            scrollRef={scrollElRef}
            onScrollChange={handleScrollChange}
          />
        ) : content === null ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-mono">
            Loading…
          </div>
        ) : showBinaryMessage ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-mono px-4 text-center">
            Binary or large file — open in external editor
          </div>
        ) : diffMode && diffLoading ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-mono">
            Loading base…
          </div>
        ) : diffMode && baseContent !== null ? (
          <DiffEditor
            original={baseContent}
            modified={content}
            language={language}
            theme="vs-dark"
            options={{
              readOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 11,
              lineNumbers: 'on',
              renderSideBySide: true,
              wordWrap: wordWrap ? 'on' : 'off',
            }}
          />
        ) : (
          <Editor
            language={language}
            theme="vs-dark"
            options={{
              readOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 11,
              lineNumbers: 'on',
              wordWrap: wordWrap ? 'on' : 'off',
            }}
            onMount={handleEditorMount}
          />
        )}

        {/* Self-rendered pins (rendersOwnPinMarkers). Skipped while loading or for
            binary files — there's no content to anchor a note to. In rendered mode
            they glue to the scrolling markdown; in Monaco modes scroll is {0,0}. */}
        {content !== null && !showBinaryMessage && (
          <FileEditorPinLayer
            pins={pins}
            scroll={rendered ? scroll : { x: 0, y: 0 }}
            contentWidth={bodySize.width}
            contentHeight={bodySize.height}
            accent="#00f0ff"
            canSubmit={!!widget.sessionId}
            onCommentChange={(id, comment) => api.pins.update(widget.id, id, p => ({ ...p, comment }))}
            onDelete={(id) => api.pins.remove(widget.id, id)}
            onSubmit={submitPin}
            onReply={replyToPin}
            onResolve={(id) => api.pins.update(widget.id, id, p => ({ ...p, resolvedAt: Date.now() }))}
            onReopen={(id) => api.pins.update(widget.id, id, p => { const { resolvedAt: _d, ...rest } = p; return rest })}
            onReposition={(id, docX, docY) => api.pins.update(widget.id, id, p => ({ ...p, context: { ...(p.context ?? {}), docX, docY } }))}
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
          {diffMode && ' · diff vs HEAD'}
        </span>
      </div>
    </div>
  )
  }
}
