// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md),
// except type-only imports of host domain types (they erase at build time and
// don't breach the runtime boundary — sibling plugins do the same).
//
// The Roundup: a live, read-only board of every agent's standing notices, grouped
// by the run that posted them. Two kinds, visually distinct at a glance (R4):
// `needs-you` (the agent is waiting on you) and `fyi` (a call it made on its own).
// Notices are agent-authored over /api/notices; this widget only reads and
// re-reads on the `notice.updated` delta. A notice's body is an A2UI v0_9
// component description, rendered host-themed by A2uiRenderer, degrading to a
// readable fallback when malformed (R14–R16).
//
// This slice makes needs-you notices answerable (R10/R11/R22): the agent
// declares Choice/TextInput/Submit controls in the notice content, the widget
// renders them with host-owned form state and submits the answer to
// POST /api/notices/:id/answer — showing "answered" optimistically (R23) and
// reverting on failure. FYI notices gain a dissent affordance (R13). Each run
// section gets a jump-to-canvas link (R12).
//
// This slice adds ONE user-attention bit (R24): the user can dismiss a notice
// they're done with. A dismissed notice dims, collapses, and sorts below the live
// ones — but stays on the board with an undo, so the board keeps a short memory
// and nothing is destroyed. Staleness rides alongside it and is purely derived
// from `amendedAt` (see ./age), so old cards recede with nobody acting. Neither
// is a status workflow: there is no enum, no lane, and no state machine here.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import type { Notice } from '../../../domain/types'
import type { Reply } from '../../../domain/pinSet'
import { A2uiRenderer } from './a2ui/A2uiRenderer'
import { isAnswerable } from './a2ui/controls'
import { followUpsFor } from './a2ui/followUps'
import { FollowUpChip, type NoticeFormState } from './a2ui/controlComponents'
import { relativeAge, isStale } from './age'

interface DeltaMsg { eventType?: string }

/** Stable empty set so `selectedFor` returns a referentially-constant value for
 *  choice groups with no selection yet (avoids needless control re-renders). */
const EMPTY_SET: ReadonlySet<string> = new Set()

/** A run's display attribution: its friendly name, falling back to its id (the
 *  session handle) when it has none — mirrors how the host labels a nameless run. */
interface RunLabel { id: string; name?: string }

function runHeader(label: RunLabel | undefined, runId: string): string {
  return label?.name?.trim() || runId
}

/** The canvas node id for a run's session card. A notice carries the posting run
 *  id (= the session name); the host registers that run's canvas widget under
 *  `run-<id>`, so this is what `api.canvas.fitWidget` pans to (R12/U5). */
export function runNodeId(runId: string): string {
  return `run-${runId}`
}

function shortWhen(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const iso = d.toISOString()
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso
}

/** Whether the user has dismissed this notice (the one attention bit). */
export function isDismissed(n: Notice): boolean {
  return n.dismissedAt !== undefined && n.dismissedAt !== null
}

/** Group notices by their posting run, preserving each run's first-seen order.
 *  Within a run: dismissed notices sink below every live one, then `needs-you`
 *  sorts ahead of `fyi`, then most-recently-amended first — the thing most likely
 *  to want you is at the top. Pure, so it's cheap to recompute on every delta. */
export function groupByRun(notices: Notice[]): Array<{ runId: string; notices: Notice[] }> {
  const order: string[] = []
  const byRun = new Map<string, Notice[]>()
  for (const n of notices) {
    if (!byRun.has(n.runId)) { byRun.set(n.runId, []); order.push(n.runId) }
    byRun.get(n.runId)!.push(n)
  }
  const kindRank = (k: Notice['kind']) => (k === 'needs-you' ? 0 : 1)
  const dismissRank = (n: Notice) => (isDismissed(n) ? 1 : 0)
  return order.map(runId => ({
    runId,
    notices: [...byRun.get(runId)!].sort((a, b) =>
      dismissRank(a) - dismissRank(b) || kindRank(a.kind) - kindRank(b.kind) || b.amendedAt - a.amendedAt),
  }))
}

/** The follow-up thread for rendering: the persisted messages plus any question the
 *  user just asked that the server hasn't echoed back yet (optimistic, R23-style). */
export function askThread(notice: Notice, pending: Reply[]): Reply[] {
  return [...(notice.followUps ?? []), ...pending]
}

/** How long the "agent is replying…" shimmer keeps pulsing before it gives up.
 *
 *  A shimmer is a claim that an answer is ON ITS WAY. Left unbounded it becomes a
 *  lie the moment an agent ignores a question, silently drops it, or dies — and it
 *  would pulse forever on a board the user is meant to trust at a glance. After the
 *  window the thread just sits there showing the unanswered question, which is the
 *  honest rendering of "nobody replied". */
export const SHIMMER_MAX_MS = 10 * 60_000

/** True when the board should shimmer "agent is replying…" — the last word was the
 *  user's, so an answer is outstanding. Mirrors PinBubble's `awaiting` rule, plus a
 *  time bound: pass `now` to stop claiming a reply is coming long after it wasn't.
 *  Omitting `now` keeps the pure last-author reading (used by the unit tests). */
export function isAwaitingReply(thread: Reply[], now?: number): boolean {
  const last = thread[thread.length - 1]
  if (last?.author !== 'user') return false
  if (now === undefined) return true
  return now - last.createdAt <= SHIMMER_MAX_MS
}

export function makeRoundupWidget(api: TinstarPluginAPI) {
  /** The ask panel (U6): a notice's follow-up thread and the three ways to ask —
   *  the universal presets, whatever this notice's agent declared, and freeform text.
   *
   *  This is deliberately a compact SECONDARY surface hanging off the card, not part
   *  of the notice body, and it is collapsed by default. A follow-up thread is
   *  persistent and unbounded; putting it inline would mean a card that grows every
   *  time someone asks a question, and the Roundup's whole value is that the board
   *  stays glanceable. The thread scrolls inside its own fixed max height, so even an
   *  open panel has a ceiling and the card's footprint never depends on thread length. */
  function AskPanel({ notice, onChanged, now }: {
    notice: Notice
    onChanged: () => Promise<void>
    /** The parent's ticking clock, so the shimmer can time out on its own. */
    now: number
  }) {
    const [open, setOpen] = useState(false)
    const [freeform, setFreeform] = useState('')
    const [asking, setAsking] = useState(false)
    const [askError, setAskError] = useState<string | null>(null)
    // The last ask persisted but reached nobody. Tracked SEPARATELY from askError
    // because it has to suppress the shimmer: otherwise the panel says "that session
    // isn't reachable" and pulses "agent is replying…" directly beneath it — two
    // contradictory claims at once, the second of which will never come true.
    const [undelivered, setUndelivered] = useState(false)
    // The optimistic question(s): shown on the thread the instant the user asks, and
    // dropped only once a reload has the server's copy in hand — cleared in the
    // success path rather than by watching `notice.followUps`, which a reload racing
    // an SSE delta can return unchanged (leaving the panel stuck showing a ghost).
    const [pending, setPending] = useState<Reply[]>([])

    const presets = useMemo(() => followUpsFor(notice.content), [notice.content])
    const thread = askThread(notice, pending)
    // Two independent reasons not to promise a reply: nobody received the question,
    // or it's been outstanding long enough that nobody is going to answer it.
    const awaiting = isAwaitingReply(thread, now) && !undelivered

    const ask = useCallback(async (payload: { presetId?: string; text?: string }, shown: string) => {
      if (asking) return
      setAskError(null)
      setUndelivered(false) // a fresh ask is optimistic again until told otherwise
      setAsking(true)
      const optimistic: Reply = {
        id: `pending-${Date.now()}`, author: 'user', text: shown, createdAt: Date.now(),
      }
      setPending(prev => [...prev, optimistic])
      try {
        const res = await api.http.fetch(`/api/notices/${notice.id}/replies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, author: 'user' }),
        })
        const body = await res.json().catch(() => null) as
          { ok?: boolean; data?: { delivered?: boolean }; error?: { message?: string } } | null
        if (!res.ok || !body?.ok) throw new Error(body?.error?.message || `ask failed (${res.status})`)
        await onChanged()
        setPending(prev => prev.filter(p => p.id !== optimistic.id))
        setFreeform('')
        // Delivery is best-effort: the question is on the thread either way, so a
        // sleeping session is a note, not an error. Saying so beats a silent wait
        // for a reply that isn't coming until the agent wakes up.
        if (body.data?.delivered === false) {
          setUndelivered(true)
          setAskError("Asked — but that session isn't reachable right now. It'll see this when it's back.")
        }
      } catch (err) {
        api.logger.error('roundup: follow-up failed', err)
        setPending(prev => prev.filter(p => p.id !== optimistic.id)) // revert cleanly
        setAskError('Could not send your question. Try again.')
      } finally {
        setAsking(false)
      }
    }, [notice.id, onChanged, asking])

    const askFreeform = useCallback(() => {
      const trimmed = freeform.trim()
      if (!trimmed) { setAskError('Type a question first.'); return }
      void ask({ text: trimmed }, trimmed)
    }, [freeform, ask])

    const count = notice.followUps?.length ?? 0

    return (
      <div className="mx-3 mb-2 rounded border-l-2 border-neutral-600 bg-neutral-800/40 px-2 py-1">
        <button
          data-testid={`ask-toggle-${notice.id}`}
          onClick={() => setOpen(o => !o)}
          className="flex w-full items-center gap-1.5 text-left text-[11px] text-neutral-400 hover:text-neutral-200"
        >
          <span>{open ? '▾' : '▸'}</span>
          <span className="font-medium">Ask a follow-up</span>
          {count > 0 && <span className="text-neutral-500">· {count}</span>}
          {/* The shimmer is visible while COLLAPSED too — a pending answer is the
              one thing worth knowing without opening the panel. */}
          {!open && awaiting && (
            <span data-testid={`ask-awaiting-${notice.id}`} className="animate-pulse text-neutral-500">
              agent is replying…
            </span>
          )}
        </button>

        {open && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {thread.length > 0 && (
              // Fixed ceiling + internal scroll: this is what keeps a 40-message
              // thread from turning the card into a wall.
              <div data-scrollable className="max-h-40 overflow-y-auto flex flex-col gap-1 pr-1">
                {thread.map(m => (
                  <div key={m.id} className="text-xs leading-snug">
                    <span className={m.author === 'user' ? 'text-neutral-400' : 'text-amber-300'}>
                      {m.author === 'user' ? 'you' : 'agent'}
                    </span>
                    <span className="text-neutral-500"> · </span>
                    <span className="text-neutral-200 whitespace-pre-wrap">{m.text}</span>
                  </div>
                ))}
                {awaiting && (
                  <div data-testid={`ask-awaiting-open-${notice.id}`} className="text-xs text-neutral-500 animate-pulse">
                    agent is replying…
                  </div>
                )}
              </div>
            )}

            {/* Universal presets first (same position on every notice, so they
                become muscle memory), then this notice's agent-declared ones. */}
            <div className="flex flex-wrap gap-1">
              {presets.map(p => (
                <FollowUpChip key={p.id} preset={p} disabled={asking} onAsk={() => void ask({ presetId: p.id }, p.question)} />
              ))}
            </div>

            <div className="flex items-center gap-1">
              <input
                data-testid={`ask-input-${notice.id}`}
                value={freeform}
                placeholder="…or ask something else"
                disabled={asking}
                onChange={e => setFreeform(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); askFreeform() } }}
                className="flex-1 rounded border border-neutral-600 bg-neutral-800 px-2 py-0.5 text-xs text-neutral-100 placeholder:text-neutral-500 focus:border-amber-500 focus:outline-none disabled:opacity-70"
              />
              <button
                onClick={askFreeform}
                disabled={asking}
                className="rounded bg-neutral-700 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-600 disabled:opacity-50"
              >
                {asking ? '…' : 'Ask'}
              </button>
            </div>

            {askError && <div className="text-[11px] text-amber-300/90">{askError}</div>}
          </div>
        )}
      </div>
    )
  }

  /** One notice row: header + (when expanded) its A2UI body, plus the answer /
   *  dissent affordances. Holds the per-notice form state (U3) so a submit is
   *  optimistic (R23) and reverts cleanly on failure. Defined here (not inside
   *  Roundup's render) so its identity is stable across the parent's re-renders. */
  function NoticeCard({ notice, isOpen, onToggle, onChanged, now }: {
    notice: Notice
    isOpen: boolean
    onToggle: () => void
    /** Reloads the board. Returns the load promise so the dismiss path can clear
     *  its optimistic override only once the server's truth is actually in hand. */
    onChanged: () => Promise<void>
    /** The parent's ticking clock, so derived age/staleness recompute over time
     *  instead of freezing at first render. */
    now: number
  }) {
    // Selection keyed by choice-component id, so multiple choice groups on one
    // notice are independent (a single-select in one group doesn't wipe another).
    const [selected, setSelected] = useState<Map<string, Set<string>>>(new Map())
    const [text, setText] = useState('')
    const [dissentText, setDissentText] = useState('')
    const [dissentOpen, setDissentOpen] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [optimisticAnswered, setOptimisticAnswered] = useState(false)
    const [submitError, setSubmitError] = useState<string | null>(null)
    // Optimistic override for the dismiss bit (null = trust the server value), so
    // the card dims on click instead of after a round trip. Cleared in the success
    // path once the reload has landed — NOT by watching `notice.dismissedAt`. A
    // reload that races an in-flight delta can return the pre-write snapshot, so
    // that value may never change and the card would sit optimistic forever.
    const [pendingDismiss, setPendingDismiss] = useState<boolean | null>(null)
    // Guards the dismiss request the way `submitting` guards the answer path:
    // without it, a rapid double-click fires POST then DELETE and the responses
    // can land out of order, leaving the stored bit disagreeing with the last click.
    const [dismissing, setDismissing] = useState(false)

    const dismissed = pendingDismiss ?? isDismissed(notice)
    const isNeedsYou = notice.kind === 'needs-you'
    // Answered from the server (persisted answer) OR optimistically (just submitted).
    const answered = optimisticAnswered || !!notice.answer
    const hasBody = !!notice.content && Array.isArray(notice.content.components) && notice.content.components.length > 0
    // A needs-you notice is interactive when it declares controls (a Choice, text
    // field, or Submit). Its form is wired only then; otherwise it renders read-only.
    const interactive = isNeedsYou && isAnswerable(notice.content)

    const toggleOption = useCallback((choiceId: string, optionId: string, mode: 'single' | 'multi') => {
      setSelected(prev => {
        const next = new Map(prev)
        const group = new Set(prev.get(choiceId) ?? [])
        if (mode === 'single') {
          next.set(choiceId, new Set([optionId])) // clears only THIS group
        } else {
          if (group.has(optionId)) group.delete(optionId); else group.add(optionId)
          next.set(choiceId, group)
        }
        return next
      })
    }, [])

    const selectedFor = useCallback(
      (choiceId: string): ReadonlySet<string> => selected.get(choiceId) ?? EMPTY_SET,
      [selected],
    )

    // The one submit path (KTD1): POST the answer, optimistically flip to answered,
    // and revert on failure. Guards double-submit via submitting/answered.
    const submitAnswer = useCallback(async (payload: { choices?: string[]; text?: string; dissent?: boolean }) => {
      if (submitting || answered) return
      setSubmitError(null)
      setSubmitting(true)
      setOptimisticAnswered(true) // R23: immediate feedback, before the server responds
      try {
        const res = await api.http.fetch(`/api/notices/${notice.id}/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const body = await res.json().catch(() => null) as { ok?: boolean; error?: { message?: string } } | null
        if (!res.ok || !body?.ok) throw new Error(body?.error?.message || `answer failed (${res.status})`)
        // Success: the notice.updated delta reloads and carries the persisted
        // answer, so the answered state survives — keep the optimistic flag until then.
      } catch (err) {
        api.logger.error('roundup: answer submit failed', err)
        setOptimisticAnswered(false) // R23: revert cleanly so the controls re-enable
        setSubmitError('Could not deliver your answer. Try again.')
      } finally {
        setSubmitting(false)
      }
    }, [notice.id, submitting, answered])

    const submitNeedsYou = useCallback(() => {
      // Flatten selections across every choice group into one id list (the server
      // validates each id against the notice's declared options).
      const choices = [...new Set([...selected.values()].flatMap(g => [...g]))]
      const trimmed = text.trim()
      if (choices.length === 0 && !trimmed) {
        setSubmitError('Pick an option or add a note before submitting.')
        return
      }
      void submitAnswer({ ...(choices.length ? { choices } : {}), ...(trimmed ? { text: trimmed } : {}) })
    }, [selected, text, submitAnswer])

    // Dismiss / undo. Flips the user's attention bit and nothing else — the
    // posting agent is NOT prompted (that would cost it a turn for a view-level
    // act) and the notice is not deleted, so undo is always one click away.
    const setDismiss = useCallback(async (next: boolean) => {
      if (dismissing) return // one dismiss request in flight at a time
      setSubmitError(null)
      setDismissing(true)
      setPendingDismiss(next)
      try {
        const res = await api.http.fetch(`/api/notices/${notice.id}/dismiss`, { method: next ? 'POST' : 'DELETE' })
        const body = await res.json().catch(() => null) as { ok?: boolean; error?: { message?: string } } | null
        if (!res.ok || !body?.ok) throw new Error(body?.error?.message || `dismiss failed (${res.status})`)
        // Reload first, THEN drop the override — so the card never flickers back
        // to the old value in the gap, and never gets stuck if the reloaded
        // snapshot happens to carry an unchanged `dismissedAt`.
        await onChanged()
        setPendingDismiss(null)
      } catch (err) {
        api.logger.error('roundup: dismiss failed', err)
        setPendingDismiss(null) // revert — the card snaps back to the server truth
        setSubmitError(next ? 'Could not dismiss this notice.' : 'Could not bring this notice back.')
      } finally {
        setDismissing(false)
      }
    }, [notice.id, onChanged, dismissing])

    const submitDissent = useCallback(() => {
      const trimmed = dissentText.trim()
      if (!trimmed) { setSubmitError('Add your objection before sending.'); return }
      void submitAnswer({ dissent: true, text: trimmed })
    }, [dissentText, submitAnswer])

    const form: NoticeFormState = {
      interactive: true,
      answered,
      submitting,
      selectedFor,
      text,
      toggleOption,
      setText,
      submit: submitNeedsYou,
    }

    // Derived staleness (no schema): a notice the agent hasn't tended in a while
    // recedes on its own. Reads the parent's ticking `now`, so an open board dims
    // a card as it crosses the threshold instead of waiting for a delta.
    // A dismissed card is already de-emphasized, so it doesn't double up.
    const stale = !dismissed && isStale(notice.amendedAt, now)
    const age = relativeAge(notice.amendedAt, now)

    // One ternary chain: exactly one opacity/border/background class is emitted,
    // so a later branch can never stack a second opacity on an earlier one.
    const cardTone = dismissed
      ? 'border-neutral-700 bg-neutral-800/40 opacity-50'
      : stale
        ? (isNeedsYou ? 'border-amber-500/30 bg-amber-500/5 opacity-60' : 'border-sky-500/25 bg-sky-500/5 opacity-60')
        : (isNeedsYou ? 'border-amber-500/50 bg-amber-500/5' : 'border-sky-500/40 bg-sky-500/5')

    return (
      <div
        data-testid={`notice-${notice.id}`}
        data-dismissed={dismissed ? 'true' : undefined}
        data-stale={stale ? 'true' : undefined}
        className={`rounded-md border transition-opacity ${cardTone}`}
      >
        <div className="flex items-start gap-2 px-3 py-2">
          <button
            onClick={onToggle}
            disabled={dismissed}
            className="flex-1 flex items-start gap-2 text-left disabled:cursor-default"
          >
            <span
              className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
                dismissed ? 'bg-neutral-600 text-neutral-200'
                  : isNeedsYou ? 'bg-amber-500 text-neutral-900' : 'bg-sky-500 text-neutral-900'
              }`}
            >
              {isNeedsYou ? 'Needs you' : 'FYI'}
            </span>
            <span className={`flex-1 text-sm font-medium leading-snug ${dismissed ? 'line-through text-neutral-400' : ''}`}>
              {notice.headline}
            </span>
            {answered && <span className="shrink-0 mt-0.5 text-emerald-400 text-xs" title="Answered">✓</span>}
            {age && (
              <span className="shrink-0 mt-0.5 text-[10px] text-neutral-500" title={`last amended ${shortWhen(notice.amendedAt)}`}>
                {age}
              </span>
            )}
            {hasBody && !dismissed && (
              <span className="shrink-0 text-neutral-500 text-xs mt-0.5">{isOpen ? '▾' : '▸'}</span>
            )}
          </button>
          {/* The one attention bit. Non-destructive both ways, and it never
              prompts the posting agent. */}
          <button
            onClick={() => void setDismiss(!dismissed)}
            disabled={dismissing}
            title={dismissed ? 'Put this notice back on the board' : "Dismiss — I'm done with this one"}
            className="shrink-0 mt-0.5 rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-700 hover:text-neutral-200 disabled:opacity-50"
          >
            {dismissed ? '↺ Undo' : '✕ Dismiss'}
          </button>
        </div>
        {!dismissed && isOpen && hasBody && (
          <div className="px-3 pt-0 pb-1 text-sm text-neutral-200">
            {/* A2uiRenderer carries its own per-notice error boundary, so a
                malformed body degrades this card alone — never the board (R16).
                Passing `form` makes declared controls interactive (U3); read-only
                notices pass no form and any controls render disabled. */}
            <A2uiRenderer content={notice.content} form={interactive ? form : undefined} />
          </div>
        )}
        {/* FYI dissent affordance (R13/U4). Shown for headline-only FYIs always and
            for bodied FYIs once expanded — silence stays consent (no interaction =
            nothing delivered). Never shown on needs-you notices. */}
        {!dismissed && !isNeedsYou && (!hasBody || isOpen) && (
          <div className="px-3 pb-1">
            {answered ? (
              <div className="text-sm font-medium text-emerald-300">✓ Objection sent</div>
            ) : !dissentOpen ? (
              <button
                onClick={() => setDissentOpen(true)}
                className="text-xs text-sky-300 underline hover:text-sky-200"
              >
                Disagree
              </button>
            ) : (
              <div className="flex flex-col gap-1.5">
                <textarea
                  rows={2}
                  value={dissentText}
                  placeholder="What do you disagree with?"
                  disabled={submitting}
                  onChange={e => setDissentText(e.target.value)}
                  className="w-full rounded border border-neutral-600 bg-neutral-800 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-sky-500 focus:outline-none disabled:opacity-70"
                />
                <div className="flex gap-2">
                  <button
                    onClick={submitDissent}
                    disabled={submitting}
                    className="self-start rounded bg-sky-500 px-3 py-1 text-sm font-medium text-neutral-900 hover:bg-sky-400 disabled:opacity-50"
                  >
                    {submitting ? 'Sending…' : 'Send objection'}
                  </button>
                  <button
                    onClick={() => { setDissentOpen(false); setSubmitError(null) }}
                    disabled={submitting}
                    className="self-start rounded px-3 py-1 text-sm text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {submitError && <div className="px-3 pb-1 text-xs text-red-300">{submitError}</div>}
        {/* The ask panel — a secondary surface, never inline in the body. Hidden on a
            dismissed card (it's off the user's plate; asking about it isn't). */}
        {!dismissed && <AskPanel notice={notice} onChanged={onChanged} now={now} />}
        {/* Footer shows for headline-only notices always, and for notices with a
            body once expanded — so arrival/amend time is never hidden. */}
        {!dismissed && (!hasBody || isOpen) && (
          <div className="px-3 pb-2 text-[10px] text-neutral-500">
            posted {shortWhen(notice.createdAt)}
            {notice.amendedAt > notice.createdAt && ` · amended ${shortWhen(notice.amendedAt)}`}
          </div>
        )}
      </div>
    )
  }

  return function Roundup(_props: WidgetProps) {
    const [notices, setNotices] = useState<Notice[] | null>(null)
    const [runLabels, setRunLabels] = useState<Record<string, RunLabel>>({})
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [loadError, setLoadError] = useState(false)

    const load = useCallback(async () => {
      try {
        const res = await api.http.fetch('/api/notices')
        const body = await res.json() as { ok: boolean; data?: Notice[] }
        if (!body.ok || !body.data) { setLoadError(true); return }
        setLoadError(false)
        setNotices(body.data)
      } catch (err) {
        // Distinct from an empty board — a backend outage must not read as
        // "nothing needs you".
        api.logger.error('roundup: load failed', err)
        setLoadError(true)
      }
    }, [])

    // Attribution: map runId → friendly name from the state snapshot. Best-effort
    // — if it fails, sections fall back to the runId as their header.
    const loadRuns = useCallback(async () => {
      try {
        const res = await api.http.fetch('/api/state')
        const snap = await res.json() as { runs?: RunLabel[] }
        const map: Record<string, RunLabel> = {}
        for (const r of snap.runs ?? []) map[r.id] = { id: r.id, name: r.name }
        setRunLabels(map)
      } catch {
        // Non-fatal — headers just show the runId.
      }
    }, [])

    useEffect(() => { void load(); void loadRuns() }, [load, loadRuns])

    // Staleness is derived from a clock, so without a tick it only recomputes when
    // something else re-renders the board — an open Roundup would never dim a card
    // as it aged past the threshold, and every age label would freeze at load time.
    // One minute is well under the coarsest thing we display (minutes) and costs
    // nothing. The helpers stay pure: only this caller reads the clock.
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
      const t = setInterval(() => setNow(Date.now()), 60_000)
      return () => clearInterval(t)
    }, [])

    // Live-refresh: the host forwards docstore notice changes as `notice.updated`
    // deltas (post, amend, pull, and run-end cascade all land here).
    useEffect(() => {
      const sub = api.events.subscribe<DeltaMsg>('delta', msg => {
        if (msg?.eventType === 'notice.updated') { void load(); void loadRuns() }
      })
      return () => sub.dispose()
    }, [load, loadRuns])

    const groups = useMemo(() => groupByRun(notices ?? []), [notices])

    const toggle = useCallback((id: string) => {
      setExpanded(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id); else next.add(id)
        return next
      })
    }, [])

    // The header count is the "does anything need me" signal, so dismissed cards
    // are counted separately rather than padding the headline number.
    const dismissedCount = (notices ?? []).filter(isDismissed).length
    const total = (notices?.length ?? 0) - dismissedCount
    // "0 notices" alongside visible dismissed cards reads as a contradiction, so
    // the zero-live case says what it means instead of counting to zero.
    const countLabel = `${total === 0 ? 'nothing needs you' : `${total} notice${total === 1 ? '' : 's'}`}${
      dismissedCount ? ` · ${dismissedCount} dismissed` : ''}`

    return (
      <div className="w-full h-full flex flex-col rounded-lg overflow-hidden bg-neutral-900 text-neutral-100">
        <div className="widget-drag-handle flex items-center gap-2 px-3 py-2 border-b border-neutral-700 bg-neutral-800 cursor-grab">
          <span className="text-sm font-bold tracking-wide">📋 Roundup</span>
          <span className="text-xs text-neutral-400">
            {loadError
              ? "couldn't reach the board"
              : notices === null
                ? 'gathering…'
                : countLabel}
          </span>
        </div>

        {/* data-scrollable: the canvas wheel handler pans/zooms unless a hovered
            child claims the wheel via this marker (see useCanvasCamera handleWheel). */}
        <div data-scrollable className="flex-1 overflow-y-auto p-3 flex flex-col gap-4">
          {loadError && (notices === null || notices.length === 0) && (
            <div className="text-sm text-red-300/80 italic">
              Couldn&apos;t reach the notice board.{' '}
              <button onClick={() => void load()} className="underline hover:text-red-200">Try again</button>
            </div>
          )}

          {!loadError && notices === null && (
            <div className="text-sm text-neutral-400 italic">Gathering what needs you…</div>
          )}

          {!loadError && notices !== null && groups.length === 0 && (
            <div className="text-sm text-neutral-400 italic">
              Nothing on the board. Agents post here when they need you or want you to know a call they made.
            </div>
          )}

          {groups.map(group => (
            <section key={group.runId} className="flex flex-col gap-2">
              <div className="flex items-center gap-2 border-b border-neutral-800 pb-1">
                <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-neutral-400 truncate">
                  {runHeader(runLabels[group.runId], group.runId)}
                </span>
                {/* Jump-to-session (R12/U5): pan the canvas to this run's card.
                    No-op if the card isn't in the current layout. */}
                <button
                  onClick={() => api.canvas.fitWidget(runNodeId(group.runId))}
                  title="Jump to this session on the canvas"
                  className="shrink-0 text-[10px] text-neutral-500 hover:text-neutral-200"
                >
                  ⤢ jump
                </button>
              </div>
              {group.notices.map(n => (
                <NoticeCard
                  key={n.id}
                  notice={n}
                  isOpen={expanded.has(n.id)}
                  onToggle={() => toggle(n.id)}
                  onChanged={load}
                  now={now}
                />
              ))}
            </section>
          ))}
        </div>
      </div>
    )
  }
}
