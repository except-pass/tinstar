import { useState, useRef, useEffect, useCallback } from 'react'
import type { RecapEntry, DiffBlock, SessionStatus } from '../../types'
import { resolveRunAccent, hexToRgba } from '../runAccent'
import { usePromptHistory } from '../../hooks/usePromptHistory'
import { PromptHistoryPopover } from './PromptHistoryPopover'
import { useFocusPath } from '../../hotkeys/FocusPathContext'
import { findSlashToken, rankCommands, type SlashCommand } from '../../lib/slashMatching'
import { useSlashCommands } from '../../hooks/useSlashCommands'
import { SlashChips } from './SlashChips'
import { apiFetch } from '../../apiClient'

function MarkdownText({ content }: { content: string }) {
  return <div className="whitespace-pre-wrap break-words">{content}</div>
}

function DiffView({ diff, accent }: { diff: DiffBlock; accent: string }) {
  return (
    <div className="border rounded-sm overflow-hidden mt-2" style={{ borderColor: hexToRgba(accent, 0.15) }}>
      <div
        className="flex items-center gap-2 px-2 py-1 border-b text-2xs font-mono"
        style={{
          background: hexToRgba(accent, 0.06),
          borderColor: hexToRgba(accent, 0.15),
          color: hexToRgba(accent, 0.6),
        }}
      >
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

function AgentMessage({ entry, accent }: { entry: RecapEntry; accent: string }) {
  return (
    <div className="flex gap-3">
      <div
        className="shrink-0 w-6 h-6 border flex items-center justify-center"
        style={{ borderColor: hexToRgba(accent, 0.4), background: hexToRgba(accent, 0.1) }}
      >
        <span
          className="material-symbols-outlined text-sm"
          style={{ color: accent, fontVariationSettings: "'FILL' 1" }}
        >
          smart_toy
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span
            data-testid="recap-agent-label"
            className="text-2xs font-mono tracking-wide"
            style={{ color: accent }}
          >
            AGENT
          </span>
          {entry.timestamp && (
            <span className="text-2xs font-mono text-slate-600">{entry.timestamp}</span>
          )}
        </div>
        <div className="text-xs font-mono leading-relaxed text-slate-400 max-w-none">
          <MarkdownText content={entry.content} />
        </div>
        {entry.diff && <DiffView diff={entry.diff} accent={accent} />}
      </div>
    </div>
  )
}

function UserMessage({ entry, accent }: { entry: RecapEntry; accent: string }) {
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
        <div
          className="text-xs font-mono leading-relaxed p-2.5 border-r-2 text-left text-slate-300"
          style={{
            background: hexToRgba(accent, 0.05),
            borderColor: hexToRgba(accent, 0.4),
          }}
        >
          <MarkdownText content={entry.content} />
        </div>
      </div>
    </div>
  )
}

function StatusMessage({ entry, accent }: { entry: RecapEntry; accent: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div
        className="h-px flex-1"
        style={{ background: `linear-gradient(to right, transparent, ${hexToRgba(accent, 0.15)})` }}
      />
      <div
        className="flex items-center gap-2 text-2xs font-mono tracking-wide uppercase"
        style={{ color: hexToRgba(accent, 0.5) }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full animate-pulse-glow"
          style={{ background: accent, boxShadow: `0 0 4px ${accent}` }}
        />
        {entry.content}
      </div>
      <div
        className="h-px flex-1"
        style={{ background: `linear-gradient(to left, transparent, ${hexToRgba(accent, 0.15)})` }}
      />
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
  const composerRootRef = useRef<HTMLDivElement>(null)
  const { history, push: pushHistory } = usePromptHistory(sessionId)
  const [historyOpen, setHistoryOpen] = useState(false)
  const { pushFocus, popFocus, path } = useFocusPath()
  const composerFocusId = sessionId ? `${sessionId}:composer` : null
  const isOnFocusPath = useRef(false)

  const { commands, usage, refresh: refreshSlash } = useSlashCommands()
  const [slashCursor, setSlashCursor] = useState<number>(0)
  const [cycleState, setCycleState] = useState<{ candidates: SlashCommand[]; index: number } | null>(null)

  const slashToken = findSlashToken(text, slashCursor)
  const candidates: SlashCommand[] = slashToken
    ? (cycleState?.candidates ?? rankCommands(commands, slashToken.partial, usage))
    : []
  const activeIndex = cycleState?.index ?? 0

  useEffect(() => { if (isExpanded) refreshSlash() }, [isExpanded, refreshSlash])

  const enterComposerFocus = useCallback(() => {
    if (!composerFocusId || isOnFocusPath.current) return
    pushFocus({ id: composerFocusId, type: 'prompt-composer', label: 'Composer' })
    isOnFocusPath.current = true
  }, [composerFocusId, pushFocus])

  const leaveComposerFocus = useCallback(() => {
    if (!isOnFocusPath.current) return
    // Only pop if we're still the tail — don't yank something that pushed on top of us
    if (path[path.length - 1]?.id === composerFocusId) popFocus()
    isOnFocusPath.current = false
  }, [path, composerFocusId, popFocus])

  // Pop on unmount / when composer collapses (textarea won't fire blur if it unmounts)
  useEffect(() => {
    if (!isExpanded) leaveComposerFocus()
  }, [isExpanded, leaveComposerFocus])
  useEffect(() => () => leaveComposerFocus(), [leaveComposerFocus])

  const onTextareaFocus = useCallback(() => enterComposerFocus(), [enterComposerFocus])
  const onTextareaBlur = useCallback((e: React.FocusEvent<HTMLTextAreaElement>) => {
    const next = e.relatedTarget as Node | null
    if (next && composerRootRef.current?.contains(next)) return
    leaveComposerFocus()
  }, [leaveComposerFocus])

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
      const res = await apiFetch(`/api/sessions/${sessionId}/prompt`, {
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
    if (e.key !== 'Tab' && cycleState) setCycleState(null)
    if (e.key === 'Tab' && slashToken && candidates.length > 0) {
      e.preventDefault()
      const list = cycleState?.candidates ?? candidates
      const nextIndex = cycleState ? (cycleState.index + 1) % list.length : 0
      const chosen = list[nextIndex]!
      const before = text.slice(0, slashToken.start)
      const after  = text.slice(slashCursor)
      const replacement = `/${chosen.name}`
      const newText = before + replacement + after
      setText(newText)
      const newCursor = before.length + replacement.length
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (!ta) return
        ta.setSelectionRange(newCursor, newCursor)
        setSlashCursor(newCursor)
      })
      setCycleState({ candidates: list, index: nextIndex })
      return
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (historyOpen) setHistoryOpen(false)
      handleSend()
      return
    }
    if ((e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Escape') && sessionId) {
      e.preventDefault()
      apiFetch(`/api/sessions/${sessionId}/send-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: [e.key] }),
      }).catch(() => { /* swallow — passthrough keys are fire-and-forget */ })
      return
    }
    if (e.key === 'ArrowUp' && text.length === 0 && !historyOpen) {
      e.preventDefault()
      setHistoryOpen(true)
    }
  }, [handleSend, text, historyOpen, sessionId, slashToken, candidates, cycleState, slashCursor])

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
    <div ref={composerRootRef} data-testid="prompt-composer" className="border-t" style={{ borderColor: hexToRgba(accent, 0.2) }}>
      {!isExpanded && (
        <button
          onClick={toggleExpanded}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-2xs font-mono uppercase tracking-wider transition-colors hover:bg-primary/5"
          style={{ color: hexToRgba(accent, 0.6) }}
        >
          <span className="material-symbols-outlined text-sm">expand_less</span>
          Prompt Composer
          <span className="text-slate-600 text-2xs normal-case tracking-normal ml-1">(P)</span>
          {status !== 'idle' && (
            <span className="ml-auto text-slate-500 normal-case tracking-normal">
              (session {status === 'running' ? 'busy' : status})
            </span>
          )}
        </button>
      )}

      {isExpanded && (
        <div className="px-3 pt-2 pb-3 space-y-2">
          {historyOpen && (
            <PromptHistoryPopover
              history={history}
              accent={accent}
              onSelect={selectFromHistory}
              onClose={() => setHistoryOpen(false)}
            />
          )}
          <div className="relative bg-surface-base rounded">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => {
                setText(e.target.value)
                setSlashCursor(e.target.selectionStart ?? e.target.value.length)
                setCycleState(null)
              }}
              onSelect={e => setSlashCursor((e.target as HTMLTextAreaElement).selectionStart)}
              onKeyDown={handleKeyDown}
              onFocus={onTextareaFocus}
              onBlur={onTextareaBlur}
              placeholder="Enter prompt text... (Ctrl+Enter to send)"
              className="w-full h-24 px-2 py-1.5 bg-surface-base border rounded text-xs font-mono text-slate-200 placeholder:text-slate-600 resize-y outline-none focus:border-primary/50 relative z-10"
              style={{ borderColor: hexToRgba(accent, 0.2), background: 'transparent' }}
            />
            {slashToken && candidates[0] && !cycleState && candidates[0].name.startsWith(slashToken.partial) && candidates[0].name !== slashToken.partial && (
              <div
                aria-hidden
                className="absolute inset-0 px-2 py-1.5 text-xs font-mono whitespace-pre-wrap break-words text-slate-600 pointer-events-none overflow-hidden"
              >
                <span className="invisible">{text.slice(0, slashCursor)}</span>
                <span>{candidates[0].name.slice(slashToken.partial.length)}</span>
              </div>
            )}
          </div>
          {error && (
            <p className="text-2xs font-mono text-accent-red">{error}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <button
                type="button"
                onClick={toggleExpanded}
                title="Collapse composer"
                className="flex items-center shrink-0 p-0.5 rounded transition-colors hover:bg-primary/10"
                style={{ color: hexToRgba(accent, 0.6) }}
              >
                <span className="material-symbols-outlined text-sm rotate-180">expand_less</span>
              </button>
              <span className="text-2xs text-slate-600 font-mono shrink-0">
                {status === 'idle' ? 'Ready' : status === 'running' ? 'Wait for idle...' : status ?? 'Unknown'}
              </span>
              {slashToken && (
                <SlashChips
                  candidates={candidates}
                  activeIndex={activeIndex}
                  accent={accent}
                  onSelect={(i) => {
                    const list = cycleState?.candidates ?? candidates
                    const chosen = list[i]!
                    const before = text.slice(0, slashToken.start)
                    const after  = text.slice(slashCursor)
                    const replacement = `/${chosen.name}`
                    const newText = before + replacement + after
                    setText(newText)
                    const newCursor = before.length + replacement.length
                    requestAnimationFrame(() => {
                      textareaRef.current?.focus({ preventScroll: true })
                      textareaRef.current?.setSelectionRange(newCursor, newCursor)
                      setSlashCursor(newCursor)
                    })
                    setCycleState({ candidates: list, index: i })
                  }}
                />
              )}
            </div>
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
      const res = await apiFetch(`/api/sessions/${sessionId}/start`, { method: 'POST' })
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
      const res = await apiFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' })
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
        <div
          ref={contentRef}
          data-scrollable
          data-testid="recap-pane"
          className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-4 bg-black"
        >
          <div className="space-y-5">
            {recapEntries.map((entry) => {
              switch (entry.type) {
                case 'agent': return <AgentMessage key={entry.id} entry={entry} accent={accent} />
                case 'user': return <UserMessage key={entry.id} entry={entry} accent={accent} />
                case 'status': return <StatusMessage key={entry.id} entry={entry} accent={accent} />
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

      {/* Prompt composer — visible on Recap (always) and Terminal (when port). */}
      {sessionId && !isTerminated && (activeTab === 'recap' || (activeTab === 'terminal' && port)) && (
        <PromptComposer sessionId={sessionId} accent={accent} status={status} expanded={promptComposerExpanded} onToggle={onPromptComposerToggle} focusTrigger={composerFocusTrigger} />
      )}
    </section>
  )
}
