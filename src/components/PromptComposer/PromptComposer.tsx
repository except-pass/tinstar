/**
 * PromptComposer — shared session-pane UI used by both RunSessionPanel
 * (canvas run sessions) and MarshalTerminal (canvas-sidebar copilot).
 *
 * Owns: the Recap | Terminal tab toggle, the recap entry renderer, the
 * ttyd terminal frame, the raw-logs fallback (when no port), and the
 * collapsible ComposerInput at the bottom.
 *
 * Does NOT own: terminated-session resume/delete UI, focus-path bookkeeping,
 * or marshal-specific lifecycle (ensure/restart). Those live in the callers.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import type { RecapEntry, DiffBlock, SessionStatus } from '../../types'
import { hexToRgba } from '../runAccent'
import { usePromptHistory } from '../../hooks/usePromptHistory'
import { usePromptStash, STASH_SLOTS } from '../../hooks/usePromptStash'
import { PromptHistoryPopover } from '../RunWorkspaceWidget/PromptHistoryPopover'
import { useFocusPath } from '../../hotkeys/FocusPathContext'
import { findSlashToken, rankCommands, type SlashCommand } from '../../lib/slashMatching'
import { useSlashCommands } from '../../hooks/useSlashCommands'
import { SlashChips } from '../RunWorkspaceWidget/SlashChips'
import { apiFetch } from '../../apiClient'
import { useScreenshotUpload } from './useScreenshotUpload'
import { ThumbnailStrip } from './ThumbnailStrip'

type QuickKey = '1' | '2' | '3' | '4' | '5' | 'y' | 'n' | 'up' | 'down' | 'left' | 'right' | 'enter'
const QUICK_KEYS: readonly QuickKey[] = ['1', '2', '3', '4', '5', 'y', 'n']
const NAV_KEYS: readonly QuickKey[] = ['up', 'down', 'left', 'right', 'enter']

// tmux key names for the keys we passthrough; ASCII chars map to themselves.
const TMUX_KEY: Record<QuickKey, string> = {
  '1': '1', '2': '2', '3': '3', '4': '4', '5': '5',
  y: 'y', n: 'n',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', enter: 'Enter',
}

const NAV_GLYPH: Record<'up' | 'down' | 'left' | 'right' | 'enter', string> = {
  up: '↑', down: '↓', left: '←', right: '→', enter: '⏎',
}

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

/** Compact row of quick-send buttons for in-terminal decision dialogs. */
function QuickSendButtons({
  accent,
  flashedKey,
  onFire,
  disabled,
}: {
  accent: string
  flashedKey: QuickKey | null
  onFire: (key: QuickKey) => void
  disabled: boolean
}) {
  return (
    <div
      className="flex items-center gap-1 shrink-0 ml-2 pl-3 border-l"
      style={{ borderColor: hexToRgba(accent, 0.2) }}
      data-testid="quick-send-cluster"
    >
      {[...QUICK_KEYS, ...NAV_KEYS].map(key => {
        const isLetter = key === 'y' || key === 'n'
        const isNav = key === 'up' || key === 'down' || key === 'left' || key === 'right' || key === 'enter'
        const isFirstLetter = key === 'y'
        const isFirstNav = key === 'up'
        const flashing = flashedKey === key
        const label = isLetter ? key.toUpperCase() : key
        const display = isNav ? NAV_GLYPH[key] : label
        const hint = isNav
          ? `Send ${TMUX_KEY[key]} to terminal (when prompt is empty)`
          : `Send "${key}" to terminal (Alt+${label})`
        return (
          <button
            key={key}
            type="button"
            data-testid={`quick-send-${key}`}
            disabled={disabled}
            onClick={() => onFire(key)}
            title={hint}
            className={`
              flex items-center justify-center w-6 h-6 rounded-sm
              text-2xs font-mono font-semibold
              transition-all duration-150 ease-out
              disabled:opacity-30 disabled:cursor-not-allowed
              enabled:hover:scale-110 enabled:active:scale-95
              ${flashing ? 'animate-[quick-pop_0.25s_ease-out]' : ''}
              ${isFirstLetter || isFirstNav ? 'ml-2' : ''}
            `}
            style={{
              color: accent,
              background: flashing ? hexToRgba(accent, 0.4) : hexToRgba(accent, 0.1),
              border: `1px solid ${hexToRgba(accent, flashing ? 0.7 : 0.25)}`,
              boxShadow: flashing
                ? `0 0 10px ${hexToRgba(accent, 0.55)}, 0 0 20px ${hexToRgba(accent, 0.25)}`
                : 'none',
            }}
            onMouseEnter={(e) => {
              if (disabled) return
              e.currentTarget.style.boxShadow = `0 0 8px ${hexToRgba(accent, 0.35)}`
              e.currentTarget.style.background = hexToRgba(accent, 0.2)
              e.currentTarget.style.borderColor = hexToRgba(accent, 0.5)
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = flashing
                ? `0 0 10px ${hexToRgba(accent, 0.55)}, 0 0 20px ${hexToRgba(accent, 0.25)}`
                : 'none'
              e.currentTarget.style.background = hexToRgba(accent, flashing ? 0.4 : 0.1)
              e.currentTarget.style.borderColor = hexToRgba(accent, flashing ? 0.7 : 0.25)
            }}
          >
            {display}
          </button>
        )
      })}
    </div>
  )
}

function previewText(s: string, max = 80): string {
  const flat = s.trim().replace(/\s+/g, ' ')
  if (flat.length <= max) return flat
  return flat.slice(0, max - 1).trimEnd() + '…'
}

/** Stash slots — click to store / swap / recall. Shift+click to clear. */
function StashSlots({
  accent,
  slots,
  onActivate,
  onClear,
  disabled,
}: {
  accent: string
  slots: readonly (string | null)[]
  onActivate: (index: number) => void
  onClear: (index: number) => void
  disabled: boolean
}) {
  return (
    <div
      className="flex items-center gap-1 shrink-0 ml-2 pl-3 border-l"
      style={{ borderColor: hexToRgba(accent, 0.2) }}
      data-testid="stash-cluster"
    >
      {Array.from({ length: STASH_SLOTS }).map((_, i) => {
        const filled = !!slots[i]
        const preview = filled ? previewText(slots[i]!) : ''
        const label = `${i + 1}`
        const baseTitle = filled
          ? `Stash ${i + 1}: "${preview}"\nClick to swap with composer · Shift+click to clear`
          : `Stash ${i + 1} (empty) — click to store current composer text`
        return (
          <button
            key={i}
            type="button"
            data-testid={`stash-slot-${i + 1}`}
            data-filled={filled || undefined}
            disabled={disabled}
            onClick={(e) => {
              if (e.shiftKey && filled) {
                onClear(i)
                return
              }
              onActivate(i)
            }}
            title={baseTitle}
            className="
              flex items-center justify-center w-6 h-6 rounded-sm
              text-2xs font-mono font-semibold
              transition-all duration-150 ease-out
              disabled:opacity-30 disabled:cursor-not-allowed
              enabled:hover:scale-110 enabled:active:scale-95
            "
            style={{
              color: accent,
              background: hexToRgba(accent, filled ? 0.25 : 0.08),
              border: `1px solid ${hexToRgba(accent, filled ? 0.55 : 0.2)}`,
            }}
            onMouseEnter={(e) => {
              if (disabled) return
              e.currentTarget.style.boxShadow = `0 0 8px ${hexToRgba(accent, 0.35)}`
              e.currentTarget.style.background = hexToRgba(accent, filled ? 0.35 : 0.18)
              e.currentTarget.style.borderColor = hexToRgba(accent, filled ? 0.7 : 0.45)
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = 'none'
              e.currentTarget.style.background = hexToRgba(accent, filled ? 0.25 : 0.08)
              e.currentTarget.style.borderColor = hexToRgba(accent, filled ? 0.55 : 0.2)
            }}
          >
            <span className="flex items-center gap-0.5 leading-none">
              <span
                className="material-symbols-outlined"
                style={{ fontSize: '11px', opacity: filled ? 0.9 : 0.5 }}
              >
                {filled ? 'inventory_2' : 'inventory'}
              </span>
              {label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Collapsible prompt input for sending text to the terminal */
function ComposerInput({ sessionId, accent, status, expanded, onToggle, focusTrigger }: { sessionId?: string; accent: string; status?: SessionStatus; expanded?: boolean; onToggle?: () => void; focusTrigger?: number }) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const isExpanded = expanded ?? internalExpanded
  const toggleExpanded = onToggle ?? (() => setInternalExpanded(e => !e))
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [justSent, setJustSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flashedKey, setFlashedKey] = useState<QuickKey | null>(null)

  const fireQuickKey = useCallback(async (key: QuickKey) => {
    if (!sessionId) return
    setFlashedKey(key)
    setTimeout(() => {
      setFlashedKey(prev => (prev === key ? null : prev))
    }, 250)
    try {
      await apiFetch(`/api/sessions/${sessionId}/send-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: [TMUX_KEY[key]] }),
      })
    } catch {
      /* fire-and-forget — matches the existing PageUp/Escape passthrough */
    }
  }, [sessionId])

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const composerRootRef = useRef<HTMLDivElement>(null)

  const { tiles, pendingCount, startUpload, removeTile, clearAll } = useScreenshotUpload()

  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageItems = items.filter(it => it.type.startsWith('image/'))
    if (imageItems.length === 0) return // let default text-paste proceed
    e.preventDefault()
    const blobs = imageItems
      .map(it => it.getAsFile())
      .filter((f): f is File => f !== null)
    for (const blob of blobs) {
      startUpload(blob)
        .then(path => {
          const ta = textareaRef.current
          if (!ta) return
          const before = ta.value.slice(0, ta.selectionStart)
          const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
          const insert = `${needsLeadingSpace ? ' ' : ''}@${path} `
          ta.focus({ preventScroll: true })
          ta.setRangeText(insert, ta.selectionStart, ta.selectionEnd, 'end')
          // Force the React onChange to fire so controlled state stays in sync
          ta.dispatchEvent(new Event('input', { bubbles: true }))
        })
        .catch(() => { /* tile already marked error in the hook */ })
    }
  }, [startUpload])

  const handleRemoveTile = useCallback((clientId: string) => {
    const tile = tiles.find(t => t.clientId === clientId)
    removeTile(clientId)
    if (!tile?.path) return
    // Remove "@<path>" plus any one adjacent whitespace on either side
    const escaped = tile.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`\\s?@${escaped}\\s?`, 'g')
    setText(prev => prev.replace(pattern, ' ').replace(/\s+/g, ' ').trimEnd())
  }, [tiles, removeTile])
  const { history, push: pushHistory } = usePromptHistory(sessionId)
  const { slots: stashSlots, setSlot: setStashSlot } = usePromptStash(sessionId)
  const [historyOpen, setHistoryOpen] = useState(false)

  const activateStash = useCallback((index: number) => {
    const current = text
    const stored = stashSlots[index] ?? null
    // Swap semantics: empty composer + filled slot = recall (slot empties);
    // filled composer + empty slot = store; filled both = swap.
    if (!current && !stored) return
    setText(stored ?? '')
    setStashSlot(index, current.length > 0 ? current : null)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus({ preventScroll: true })
      const end = stored?.length ?? 0
      ta.setSelectionRange(end, end)
      setSlashCursor(end)
    })
  }, [text, stashSlots, setStashSlot])

  const clearStash = useCallback((index: number) => {
    setStashSlot(index, null)
  }, [setStashSlot])
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
        clearAll()
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
  }, [sessionId, text, canSend, sending, status, pushHistory, clearAll])

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
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const match = e.code.match(/^Digit([1-5])$/) ?? e.code.match(/^Key([YN])$/)
      if (match) {
        e.preventDefault()
        fireQuickKey(match[1].toLowerCase() as QuickKey)
        return
      }
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
    // Empty-prompt passthrough: arrow keys + Enter go straight to terminal,
    // matching the Alt+1..5 / Alt+Y / Alt+N quick-send affordance. History is
    // still reachable via the history button.
    if (text.length === 0 && !historyOpen && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const navMap: Partial<Record<string, QuickKey>> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
        Enter: 'enter',
      }
      const navKey = navMap[e.key]
      if (navKey) {
        e.preventDefault()
        fireQuickKey(navKey)
        return
      }
    }
  }, [handleSend, text, historyOpen, sessionId, slashToken, candidates, cycleState, slashCursor, fireQuickKey])

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
          <div className="flex flex-row gap-2 items-start">
            <div className="relative bg-surface-base rounded flex-1">
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
                onPaste={onPaste}
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
            <ThumbnailStrip tiles={tiles} onRemove={handleRemoveTile} />
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
              <span className="text-2xs text-slate-600 font-mono shrink-0 inline-block w-[6.5rem] truncate">
                {status === 'idle' ? 'Ready' : status === 'running' ? 'Wait for idle...' : status ?? 'Unknown'}
              </span>
              {!slashToken && (
                <StashSlots
                  accent={accent}
                  slots={stashSlots}
                  onActivate={activateStash}
                  onClear={clearStash}
                  disabled={!sessionId}
                />
              )}
              {text.trim() === '' && (
                <QuickSendButtons
                  accent={accent}
                  flashedKey={flashedKey}
                  onFire={fireQuickKey}
                  disabled={!sessionId}
                />
              )}
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
                data-testid="composer-submit"
                onClick={handleSend}
                disabled={!canSend || sending || pendingCount > 0}
                title={pendingCount > 0 ? `Waiting for ${pendingCount} screenshot upload(s)` : undefined}
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

export interface PromptComposerProps {
  sessionId: string | undefined
  status: SessionStatus | undefined
  port: number | undefined
  recapEntries: RecapEntry[]
  rawLogs?: string
  accent: string
  defaultTab?: 'recap' | 'terminal'
  controlledTab?: 'recap' | 'terminal'
  onControlledTabChange?: (tab: 'recap' | 'terminal') => void
  activeTabIndex?: number
  onActiveTabChange?: (tab: 'recap' | 'terminal') => void
  termTick?: number
  terminalFocused?: boolean
  zoom?: number
  onTerminalPointerFocus?: () => void
  promptComposerExpanded?: boolean
  onPromptComposerToggle?: () => void
  composerFocusTrigger?: number
}

export function PromptComposer({
  sessionId,
  status,
  port,
  recapEntries,
  rawLogs = '',
  accent,
  defaultTab,
  controlledTab,
  onControlledTabChange,
  activeTabIndex,
  onActiveTabChange,
  termTick = 0,
  terminalFocused,
  zoom,
  onTerminalPointerFocus,
  promptComposerExpanded,
  onPromptComposerToggle,
  composerFocusTrigger,
}: PromptComposerProps) {
  const TABS = ['recap', 'terminal'] as const
  const fallbackTab: 'recap' | 'terminal' = defaultTab ?? (port ? 'terminal' : 'recap')
  const [internalActiveTab, setInternalActiveTab] = useState<'recap' | 'terminal'>(fallbackTab)
  const activeTab = controlledTab
    ?? (activeTabIndex !== undefined ? (TABS[activeTabIndex % TABS.length] ?? fallbackTab) : internalActiveTab)
  const setActiveTab = (tab: 'recap' | 'terminal') => {
    if (onControlledTabChange) onControlledTabChange(tab)
    else setInternalActiveTab(tab)
    onActiveTabChange?.(tab)
  }
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [activeTab])

  return (
    <section
      className="flex-1 flex flex-col min-w-0 min-h-0 border-x bg-surface-base"
      style={{ borderColor: hexToRgba(accent, 0.2) }}
    >
      {/* Tab toggle — hidden when controlled from outside (e.g. RunWorkspaceHeader). */}
      {!controlledTab && (
        <div
          className="flex items-center justify-center border-b py-2 bg-surface-panel relative"
          style={{ borderColor: hexToRgba(accent, 0.2) }}
        >
          <div className="flex rounded-sm overflow-hidden border" style={{ borderColor: hexToRgba(accent, 0.25) }}>
            {([
              { key: 'recap' as const, label: 'Recap' },
              { key: 'terminal' as const, label: port ? 'Terminal' : 'Logs' },
            ]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                aria-selected={activeTab === key}
                data-testid={`recap-tab-${key}`}
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
      {activeTab === 'terminal' && port ? (
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
        // activeTab === 'terminal' but no port: raw logs fallback.
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
      {sessionId && (activeTab === 'recap' || (activeTab === 'terminal' && port)) && (
        <ComposerInput
          sessionId={sessionId}
          accent={accent}
          status={status}
          expanded={promptComposerExpanded}
          onToggle={onPromptComposerToggle}
          focusTrigger={composerFocusTrigger}
        />
      )}
    </section>
  )
}
