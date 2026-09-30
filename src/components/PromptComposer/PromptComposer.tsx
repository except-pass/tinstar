/**
 * ComposerInput — the prompt composer docked under a cockpit worker terminal.
 *
 * Owns: prompt text, history, stash slots, quick keys, and screenshot/file
 * attachments (paste or drop) that upload and insert an @path reference.
 */
import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { hexToRgba } from '../runAccent'
import { usePromptHistory } from '../../hooks/usePromptHistory'
import { usePromptStash, STASH_SLOTS } from '../../hooks/usePromptStash'
import { PromptHistoryPopover } from '../RunWorkspaceWidget/PromptHistoryPopover'
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

function draggedFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  if (dt.files?.length) return true
  return Array.from(dt.types ?? []).includes('Files')
}

/** Collapsible prompt input for sending text to the terminal */
export const ComposerInput = memo(function ComposerInput({ sessionId, accent, status, expanded, onToggle }: { sessionId?: string; accent: string; status: string; expanded?: boolean; onToggle?: () => void }) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const isExpanded = expanded ?? internalExpanded
  const toggleExpanded = onToggle ?? (() => setInternalExpanded(e => !e))
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [justSent, setJustSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flashedKey, setFlashedKey] = useState<QuickKey | null>(null)
  const [fileDrag, setFileDrag] = useState(false)

  const fireQuickKey = useCallback(async (key: QuickKey) => {
    if (!sessionId) return
    setFlashedKey(key)
    setTimeout(() => {
      setFlashedKey(prev => (prev === key ? null : prev))
    }, 250)
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/send-keys`, {
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

  const { tiles, pendingCount, startUpload, removeTile, clearAll } = useScreenshotUpload()

  const insertReference = useCallback((path: string) => {
    const ta = textareaRef.current
    if (!ta) {
      setText(prev => `${prev}${prev.length > 0 && !/\s$/.test(prev) ? ' ' : ''}@${path} `)
      return
    }
    const before = ta.value.slice(0, ta.selectionStart)
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
    const insert = `${needsLeadingSpace ? ' ' : ''}@${path} `
    ta.focus({ preventScroll: true })
    ta.setRangeText(insert, ta.selectionStart, ta.selectionEnd, 'end')
    // Force the React onChange to fire so controlled state stays in sync
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }, [])

  const uploadFiles = useCallback((files: File[]) => {
    let chain = Promise.resolve()
    for (const file of files) {
      chain = chain.then(() => startUpload(file).then(({ path }) => insertReference(path)).catch(() => { /* tile already marked error */ }))
    }
  }, [startUpload, insertReference])

  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageItems = items.filter(it => it.type.startsWith('image/'))
    if (imageItems.length === 0) return // let default text-paste proceed
    e.preventDefault()
    const blobs = imageItems
      .map(it => it.getAsFile())
      .filter((f): f is File => f !== null)
    uploadFiles(blobs)
  }, [uploadFiles])

  const onDropFiles = useCallback((e: React.DragEvent) => {
    if (!draggedFiles(e.dataTransfer)) return
    e.preventDefault()
    setFileDrag(false)
    if (!isExpanded) toggleExpanded()
    uploadFiles(Array.from(e.dataTransfer.files))
  }, [uploadFiles, isExpanded, toggleExpanded])

  useEffect(() => {
    const enter = (e: DragEvent) => { if (draggedFiles(e.dataTransfer)) setFileDrag(true) }
    const over = (e: DragEvent) => { if (draggedFiles(e.dataTransfer)) e.preventDefault() }
    const drop = (e: DragEvent) => {
      if (draggedFiles(e.dataTransfer)) e.preventDefault()
      setFileDrag(false)
    }
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setFileDrag(false) }
    const done = () => setFileDrag(false)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('dragend', done)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('dragend', done)
    }
  }, [])

  const handleRemoveTile = useCallback((clientId: string) => {
    const tile = tiles.find(t => t.clientId === clientId)
    removeTile(clientId)
    if (!tile?.path) return
    const escaped = tile.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Strip the @path reference plus one adjacent whitespace. Trailing
    // whitespace cleanup only; don't collapse internal newlines (user-authored
    // layout must survive).
    const refPattern = new RegExp(`\\s?@${escaped}\\s?`, 'g')
    setText(prev => prev.replace(refPattern, ' ').trimEnd())
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
    })
  }, [text, stashSlots, setStashSlot])

  const clearStash = useCallback((index: number) => {
    setStashSlot(index, null)
  }, [setStashSlot])
  const canSend = sessionId && text.trim().length > 0

  const handleSend = useCallback(async () => {
    if (!canSend || sending || pendingCount > 0) return
    setError(null)
    setSending(true)
    try {
      const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
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
  }, [sessionId, text, canSend, sending, pendingCount, pushHistory, clearAll])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (historyOpen) setHistoryOpen(false)
      handleSend()
      return
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const match = e.code.match(/^Digit([1-5])$/) ?? e.code.match(/^Key([YN])$/)
      const key = match?.[1]
      if (key) {
        e.preventDefault()
        fireQuickKey(key.toLowerCase() as QuickKey)
        return
      }
    }
    if ((e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Escape') && sessionId) {
      e.preventDefault()
      apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/send-keys`, {
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
  }, [handleSend, text, historyOpen, sessionId, fireQuickKey])

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
    <div
      data-testid="prompt-composer"
      data-file-drag={fileDrag ? 'true' : 'false'}
      className="border-t"
      style={{
        borderColor: fileDrag ? accent : hexToRgba(accent, 0.2),
        boxShadow: fileDrag ? `inset 0 0 0 2px ${accent}` : undefined,
        background: fileDrag ? hexToRgba(accent, 0.08) : undefined,
      }}
      onDragOver={e => { if (draggedFiles(e.dataTransfer)) { e.preventDefault(); setFileDrag(true) } }}
      onDrop={onDropFiles}
    >
      {fileDrag && (
        <div data-testid="prompt-composer-drop-target" className="px-3 py-1 text-2xs font-mono uppercase tracking-wider" style={{ color: accent }}>
          Drop files to attach
        </div>
      )}
      {!isExpanded && (
        <button
          onClick={toggleExpanded}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-2xs font-mono uppercase tracking-wider transition-colors hover:bg-primary/5"
          style={{ color: hexToRgba(accent, 0.6) }}
        >
          <span className="material-symbols-outlined text-sm">expand_less</span>
          Prompt Composer
          {status !== 'idle' && (
            <span className="ml-auto text-slate-500 normal-case tracking-normal">
              (worker {status})
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
                onChange={e => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={onPaste}
                placeholder="Enter prompt text... (Ctrl+Enter to send)"
                className="w-full h-24 px-2 py-1.5 bg-surface-base border rounded text-xs font-mono text-slate-200 placeholder:text-slate-600 resize-y outline-none focus:border-primary/50 relative z-10"
                style={{ borderColor: hexToRgba(accent, 0.2), background: 'transparent' }}
              />
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
                {status === 'idle' ? 'Ready' : status}
              </span>
              <StashSlots
                accent={accent}
                slots={stashSlots}
                onActivate={activateStash}
                onClear={clearStash}
                disabled={!sessionId}
              />
              {text.trim() === '' && (
                <QuickSendButtons
                  accent={accent}
                  flashedKey={flashedKey}
                  onFire={fireQuickKey}
                  disabled={!sessionId}
                />
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="prompt-history-button"
                onClick={() => setHistoryOpen(o => !o)}
                title="Recent prompts"
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
})
