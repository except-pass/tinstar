import { useState, useRef, useEffect, useCallback } from 'react'
import type { RecapEntry, DiffBlock, SessionStatus } from '../../types'
import { resolveRunAccent, hexToRgba } from '../runAccent'
import { usePromptHistory } from '../../hooks/usePromptHistory'
import { PromptHistoryPopover } from './PromptHistoryPopover'

function MarkdownText({ content }: { content: string }) {
  return (
    <div className="whitespace-pre-wrap break-words">{content}</div>
  )
}

function DiffView({ diff }: { diff: DiffBlock }) {
  return (
    <div className="border border-primary/15 bg-surface-base rounded-sm overflow-hidden mt-2">
      <div className="flex items-center gap-2 px-2 py-1 bg-primary/[0.06] border-b border-primary/15 text-2xs text-primary/60 font-mono">
        <span className="material-symbols-outlined text-xs">difference</span>
        {diff.filename}
        <span className="text-slate-600 ml-auto">{diff.header}</span>
      </div>
      <pre className="px-2 py-1.5 text-2xs leading-relaxed font-mono overflow-x-auto">
        {diff.lines.map((line, i) => (
          <div
            key={i}
            className={
              line.type === 'addition'
                ? 'text-accent-green bg-accent-green/[0.06]'
                : line.type === 'deletion'
                  ? 'text-accent-red bg-accent-red/[0.06]'
                  : line.type === 'header'
                    ? 'text-slate-500'
                    : 'text-slate-400'
            }
          >
            <span className="select-none text-slate-600 inline-block w-3">
              {line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' '}
            </span>
            {line.content}
          </div>
        ))}
      </pre>
    </div>
  )
}

function AgentMessage({ entry }: { entry: RecapEntry }) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-6 h-6 border border-primary/40 flex items-center justify-center bg-primary/10">
        <span className="material-symbols-outlined text-primary text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>
          smart_toy
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-2xs font-mono text-primary/50 tracking-wide">AGENT</span>
          {entry.timestamp && (
            <span className="text-2xs font-mono text-slate-600">{entry.timestamp}</span>
          )}
        </div>
        <div className="text-xs font-mono leading-relaxed text-slate-300 prose prose-invert prose-xs max-w-none
          prose-headings:text-primary prose-headings:text-xs prose-headings:font-display prose-headings:mt-3 prose-headings:mb-1
          prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0
          prose-strong:text-primary prose-code:text-primary/80 prose-code:bg-primary/10 prose-code:px-1 prose-code:rounded
          prose-pre:bg-surface-panel prose-pre:border prose-pre:border-primary/15">
          <MarkdownText content={entry.content} />
        </div>
        {entry.diff && <DiffView diff={entry.diff} />}
      </div>
    </div>
  )
}

function UserMessage({ entry }: { entry: RecapEntry }) {
  return (
    <div className="flex gap-3 flex-row-reverse">
      <div className="shrink-0 w-6 h-6 border border-slate-600 flex items-center justify-center bg-surface-raised">
        <span className="material-symbols-outlined text-slate-400 text-sm">person</span>
      </div>
      <div className="flex-1 min-w-0 text-right">
        <div className="flex items-center gap-2 justify-end mb-1">
          {entry.timestamp && (
            <span className="text-2xs font-mono text-slate-600">{entry.timestamp}</span>
          )}
          <span className="text-2xs font-mono text-slate-500 tracking-wide">YOU</span>
        </div>
        <div className="text-xs font-mono leading-relaxed text-primary/70 bg-primary/[0.04] p-2.5 border-r-2 border-primary/40 text-left prose prose-invert prose-xs max-w-none
          prose-p:my-1 prose-strong:text-primary/80 prose-code:text-primary/70 prose-code:bg-primary/10 prose-code:px-1 prose-code:rounded">
          <MarkdownText content={entry.content} />
        </div>
      </div>
    </div>
  )
}

function StatusMessage({ entry }: { entry: RecapEntry }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent to-primary/15" />
      <div className="flex items-center gap-2 text-2xs font-mono text-primary/50 tracking-wide uppercase">
        <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse-glow shadow-[0_0_4px_#00f0ff]" />
        {entry.content}
      </div>
      <div className="h-px flex-1 bg-gradient-to-l from-transparent to-primary/15" />
    </div>
  )
}

/** Iframe wrapper keyed by tick to force remount on refresh.
 *
 * When zoomed in (zoom > 1): counter-scale the iframe so it renders at screen
 * pixel resolution — canvas scale(zoom) × iframe scale(1/zoom) = 1×, crisp.
 *
 * When zoomed out (zoom ≤ 1): no scaling. The terminal fills the container at
 * its natural size so ttyd maintains a full row/column count. The canvas zoom
 * makes text smaller naturally, which is fine and preserves readability.
 */
function TerminalFrame({ src, tick, focused, accent, zoom = 1, onPointerFocus }: { src: string; tick: number; focused?: boolean; accent: string; zoom?: number; onPointerFocus?: () => void }) {
  // Only counter-scale when zoomed in; zooming out lets text shrink naturally.
  const needsScale = zoom > 1
  return (
    <div
      className="flex-1 relative overflow-hidden"
      style={focused ? { outline: `2px solid ${accent}`, outlineOffset: '-2px', boxShadow: `inset 0 0 12px ${hexToRgba(accent, 0.15)}` } : undefined}
      onPointerDown={e => { if (e.button === 0) { e.stopPropagation(); onPointerFocus?.() } }}
    >
      <div
        style={needsScale ? {
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${zoom * 100}%`,
          height: `${zoom * 100}%`,
          transformOrigin: '0 0',
          transform: `scale(${1 / zoom})`,
        } : {
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
        }}
      >
        <iframe
          key={tick}
          src={src}
          style={{ display: 'block', width: '100%', height: '100%', border: 0, background: 'black' }}
          title="Session terminal"
          allow="clipboard-read; clipboard-write"
        />
      </div>
      {focused && (
        <div
          data-testid="terminal-focus-badge"
          className="absolute top-1.5 right-2 text-2xs font-mono uppercase tracking-widest pointer-events-none select-none px-1.5 py-0.5 rounded"
          style={{ color: accent, background: hexToRgba(accent, 0.12), border: `1px solid ${hexToRgba(accent, 0.3)}` }}
        >
          terminal
        </div>
      )}
    </div>
  )
}

/** Collapsible prompt composer for sending text to the terminal */
function PromptComposer({ sessionId, accent, status, expanded, onToggle, focusTrigger }: { sessionId?: string; accent: string; status?: SessionStatus; expanded?: boolean; onToggle?: () => void; focusTrigger?: number }) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const isExpanded = expanded ?? internalExpanded
  const toggleExpanded = onToggle ?? (() => setInternalExpanded(e => !e))
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [justSent, setJustSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const { history, push: pushHistory } = usePromptHistory(sessionId)
  const [historyOpen, setHistoryOpen] = useState(false)

  // Focus when trigger changes (from parent selecting widget)
  useEffect(() => {
    if (focusTrigger && isExpanded) textareaRef.current?.focus({ preventScroll: true })
  }, [focusTrigger, isExpanded])

  const canSend = sessionId && text.trim().length > 0

  const handleSend = useCallback(async () => {
    if (!canSend || sending) return
    setError(null)
    setSending(true)
    try {
      const res = await fetch(`/api/sessions/${sessionId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), force: status !== 'idle' }),
      })
      const data = await res.json()
      if (data.ok) {
        pushHistory(text)
        setText('')
        // Trigger success flash
        setJustSent(true)
        setTimeout(() => setJustSent(false), 400)
      } else {
        setError(data.error?.message ?? data.error ?? 'Failed to send')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSending(false)
    }
  }, [sessionId, text, canSend, sending, status, pushHistory])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (historyOpen) setHistoryOpen(false)
      handleSend()
      return
    }
    if (e.key === 'ArrowUp' && text.length === 0 && !historyOpen) {
      e.preventDefault()
      setHistoryOpen(true)
    }
  }, [handleSend, text, historyOpen])

  // Focus textarea when expanded
  useEffect(() => {
    if (isExpanded) textareaRef.current?.focus({ preventScroll: true })
  }, [isExpanded])

  const selectFromHistory = useCallback((item: string) => {
    setText(item)
    setHistoryOpen(false)
    // Focus textarea and place caret at end after the state flush.
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus({ preventScroll: true })
      ta.setSelectionRange(item.length, item.length)
    })
  }, [])

  return (
    <div className="border-t" style={{ borderColor: hexToRgba(accent, 0.2) }}>
      <button
        onClick={toggleExpanded}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-2xs font-mono uppercase tracking-wider transition-colors hover:bg-primary/5"
        style={{ color: hexToRgba(accent, 0.6) }}
      >
        <span
          className="material-symbols-outlined text-sm transition-transform"
          style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          expand_less
        </span>
        Prompt Composer
        <span className="text-slate-600 text-2xs normal-case tracking-normal ml-1">(P)</span>
        {status !== 'idle' && (
          <span className="ml-auto text-slate-500 normal-case tracking-normal">
            (session {status === 'running' ? 'busy' : status})
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 space-y-2">
          {historyOpen && (
            <PromptHistoryPopover
              history={history}
              accent={accent}
              onSelect={selectFromHistory}
              onClose={() => setHistoryOpen(false)}
            />
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter prompt text... (Ctrl+Enter to send)"
            className="w-full h-24 px-2 py-1.5 bg-surface-base border rounded text-xs font-mono text-slate-200 placeholder:text-slate-600 resize-y outline-none focus:border-primary/50"
            style={{ borderColor: hexToRgba(accent, 0.2) }}
          />
          {error && (
            <p className="text-2xs font-mono text-accent-red">{error}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs text-slate-600 font-mono">
              {status === 'idle' ? 'Ready' : status === 'running' ? 'Wait for idle...' : status ?? 'Unknown'}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="prompt-history-button"
                onClick={() => setHistoryOpen(o => !o)}
                title="Recent prompts (↑)"
                className="flex items-center gap-1 px-2 py-1.5 text-2xs font-mono uppercase tracking-wider rounded transition-all duration-150 ease-out disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:scale-105 enabled:active:scale-95"
                style={{
                  background: hexToRgba(accent, 0.1),
                  color: hexToRgba(accent, 0.7),
                  border: `1px solid ${hexToRgba(accent, 0.25)}`,
                }}
              >
                <span className="material-symbols-outlined text-sm">history</span>
              </button>
              <button
                ref={buttonRef}
                onClick={handleSend}
                disabled={!canSend || sending}
                className={`
                  group relative flex items-center gap-1.5 px-3 py-1.5 text-2xs font-mono uppercase tracking-wider rounded
                  transition-all duration-150 ease-out
                  disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100
                  enabled:hover:scale-105 enabled:active:scale-95
                  ${justSent ? 'animate-[send-success_0.4s_ease-out]' : ''}
                `}
                style={{
                  background: justSent
                    ? hexToRgba(accent, 0.4)
                    : sending
                      ? hexToRgba(accent, 0.25)
                      : hexToRgba(accent, 0.15),
                  color: accent,
                  border: `1px solid ${hexToRgba(accent, justSent ? 0.7 : 0.3)}`,
                  boxShadow: canSend && !sending
                    ? `0 0 0 0 ${hexToRgba(accent, 0)}`
                    : justSent
                      ? `0 0 20px ${hexToRgba(accent, 0.5)}, 0 0 40px ${hexToRgba(accent, 0.2)}`
                      : 'none',
                }}
                onMouseEnter={(e) => {
                  if (canSend && !sending) {
                    e.currentTarget.style.boxShadow = `0 0 12px ${hexToRgba(accent, 0.4)}, 0 0 24px ${hexToRgba(accent, 0.15)}`
                    e.currentTarget.style.background = hexToRgba(accent, 0.25)
                    e.currentTarget.style.borderColor = hexToRgba(accent, 0.5)
                  }
                }}
                onMouseLeave={(e) => {
                  if (!justSent) {
                    e.currentTarget.style.boxShadow = 'none'
                    e.currentTarget.style.background = hexToRgba(accent, 0.15)
                    e.currentTarget.style.borderColor = hexToRgba(accent, 0.3)
                  }
                }}
              >
                <span
                  className={`material-symbols-outlined text-sm transition-transform duration-200 ${
                    sending ? 'animate-[send-fly_0.6s_ease-in-out_infinite]' : ''
                  } ${justSent ? 'animate-[send-pop_0.3s_ease-out]' : ''}`}
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  {sending ? 'rocket_launch' : 'send'}
                </span>
                {sending ? 'Sending...' : 'Send'}
                {/* Glow ring on hover */}
                <span
                  className="absolute inset-0 rounded opacity-0 group-enabled:group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
                  style={{
                    background: `radial-gradient(ellipse at center, ${hexToRgba(accent, 0.1)} 0%, transparent 70%)`,
                  }}
                />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface Props {
  recapEntries?: RecapEntry[]
  rawLogs?: string
  port?: number | null
  sessionId?: string
  status?: SessionStatus
  color?: string
  termTick?: number
  terminalFocused?: boolean
  zoom?: number
  onTerminalToggle?: () => void
  onTerminalPointerFocus?: () => void
  /** Controlled active tab (0=recap, 1=terminal/logs) for keyboard navigation */
  activeTabIndex?: number
  onActiveTabChange?: (tab: 'recap' | 'terminal') => void
  /** When provided, the tab toggle is hidden (rendered in the header instead) */
  controlledTab?: 'recap' | 'terminal'
  onControlledTabChange?: (tab: 'recap' | 'terminal') => void
  /** Controlled prompt composer state */
  promptComposerExpanded?: boolean
  onPromptComposerToggle?: () => void
  /** Increment to focus the prompt composer textarea */
  composerFocusTrigger?: number
}

export function RunSessionPanel({ recapEntries = [], rawLogs = '', port, sessionId, status, color, termTick = 0, terminalFocused, zoom, onTerminalToggle, onTerminalPointerFocus, activeTabIndex, onActiveTabChange, controlledTab, onControlledTabChange, promptComposerExpanded, onPromptComposerToggle, composerFocusTrigger }: Props) {
  const accent = resolveRunAccent(color)
  const TABS = ['recap', 'terminal'] as const
  const [internalActiveTab, setInternalActiveTab] = useState<'recap' | 'terminal'>(port ? 'terminal' : 'recap')
  // Priority: controlled tab from header > keyboard nav > internal state
  const activeTab = controlledTab ?? (activeTabIndex !== undefined ? (TABS[activeTabIndex % TABS.length] ?? 'recap') : internalActiveTab)
  const setActiveTab = (tab: 'recap' | 'terminal') => {
    setInternalActiveTab(tab)
    onActiveTabChange?.(tab)
    onControlledTabChange?.(tab)
  }
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)

  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [activeTab])

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === 'terminal-focus-toggle' && e.data?.sessionName === sessionId) {
        onTerminalToggle?.()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [sessionId, onTerminalToggle])

  const isTerminated = status === 'stopped'

  const handleResume = useCallback(async () => {
    if (!sessionId) return
    setActionError(null)
    setActionLoading(true)
    try {
      const res = await fetch(`/api/sessions/${sessionId}/start`, { method: 'POST' })
      const data = await res.json()
      if (!data.ok) {
        const msg = data.error?.message ?? data.error?.code ?? 'Resume failed'
        setActionError(msg)
      }
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setActionLoading(false)
    }
  }, [sessionId])

  const handleDelete = useCallback(async () => {
    if (!sessionId) return
    setActionError(null)
    setActionLoading(true)
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' })
      const data = await res.json()
      if (!data.ok) {
        const msg = data.error?.message ?? data.error?.code ?? 'Delete failed'
        setActionError(msg)
      }
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setActionLoading(false)
    }
  }, [sessionId])

  return (
    <section className="flex-1 flex flex-col min-w-0 min-h-0 border-x border-primary/20 bg-surface-base">
      {/* Tab toggle — hidden when controlled from header */}
      {!controlledTab && (
        <div className="flex items-center justify-center border-b py-2 bg-surface-panel relative" style={{ borderColor: hexToRgba(accent, 0.2) }}>
          <div className="flex rounded-sm overflow-hidden border" style={{ borderColor: hexToRgba(accent, 0.25) }}>
            {([
              { key: 'recap' as const, label: 'Recap' },
              { key: 'terminal' as const, label: port ? 'Terminal' : 'Logs' },
            ]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                aria-selected={activeTab === key}
                className="px-5 py-1 text-2xs font-bold font-display tracking-[0.15em] uppercase transition-all"
                style={activeTab === key
                  ? { background: accent, color: 'var(--surface-base)' }
                  : { color: hexToRgba(accent, 0.5) }
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      {isTerminated && sessionId ? (
        <div className="flex-1 flex flex-col items-center justify-center bg-black/50 gap-4 p-6">
          <span className="material-symbols-outlined text-4xl text-slate-500">terminal</span>
          <p className="text-sm font-mono text-slate-400 uppercase tracking-wider">
            Session {status}
          </p>
          {actionError && (
            <p className="text-xs font-mono text-accent-red bg-accent-red/10 border border-accent-red/30 px-3 py-2 rounded max-w-sm text-center">
              {actionError}
            </p>
          )}
          <div className="flex gap-3">
            <button
              onClick={handleResume}
              disabled={actionLoading}
              className="flex items-center gap-2 px-4 py-2 bg-primary/20 border border-primary/40 text-primary text-xs font-mono uppercase tracking-wider hover:bg-primary/30 transition-colors disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">play_arrow</span>
              Resume
            </button>
            <button
              onClick={handleDelete}
              disabled={actionLoading}
              className="flex items-center gap-2 px-4 py-2 bg-accent-red/10 border border-accent-red/30 text-accent-red text-xs font-mono uppercase tracking-wider hover:bg-accent-red/20 transition-colors disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">delete</span>
              Delete
            </button>
          </div>
        </div>
      ) : activeTab === 'terminal' && port ? (
        <TerminalFrame
          src={`/terminal-wrapper.html?session=${encodeURIComponent(sessionId ?? '')}&port=${port}`}
          tick={termTick}
          focused={terminalFocused}
          accent={accent}
          zoom={zoom}
          onPointerFocus={onTerminalPointerFocus}
        />
      ) : activeTab === 'recap' ? (
        <div ref={contentRef} data-scrollable className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-4">
          <div className="space-y-5">
            {recapEntries.map((entry) => {
              switch (entry.type) {
                case 'agent': return <AgentMessage key={entry.id} entry={entry} />
                case 'user': return <UserMessage key={entry.id} entry={entry} />
                case 'status': return <StatusMessage key={entry.id} entry={entry} />
              }
            })}
          </div>
        </div>
      ) : (
        <div ref={contentRef} data-scrollable className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-4">
          <pre className="text-2xs font-mono leading-relaxed text-slate-400 whitespace-pre-wrap">
            {rawLogs.split('\n').map((line, i) => (
              <div
                key={i}
                className={`py-px ${
                  line.includes('PASS') ? 'text-accent-green' :
                  line.includes('FAIL') ? 'text-accent-red' :
                  line.includes('claude-agent:') ? 'text-accent-amber/70' :
                  ''
                }`}
              >
                {line}
              </div>
            ))}
          </pre>
        </div>
      )}

      {/* Prompt composer — only show when terminal is available */}
      {port && activeTab === 'terminal' && !isTerminated && (
        <PromptComposer sessionId={sessionId} accent={accent} status={status} expanded={promptComposerExpanded} onToggle={onPromptComposerToggle} focusTrigger={composerFocusTrigger} />
      )}
    </section>
  )
}
