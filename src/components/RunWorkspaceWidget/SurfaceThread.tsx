// A per-surface thread — shared by the open-points hero surface (U6) and the
// diagram surface (U8). It renders `surface.thread` (store-owned Reply[]) and a
// reply input that POSTs to the run-scoped reply endpoint.
//
// Optimistic UI (modelled on RoundupWidget's AskPanel): a typed reply appears on
// the thread the instant it's sent and reconciles when the SSE `run` delta carries
// the persisted reply on `run.slate` — the widget already re-renders on run
// updates, so run.slate IS the reconcile channel (no second subscription). The
// optimistic copy is dropped once a persisted reply with the same author+text
// arrives; a failed send reverts it and restores the draft.
import { useCallback, useEffect, useState } from 'react'
import type { Reply } from '../../domain/pinSet'
import { apiFetch } from '../../apiClient'

/** A stable empty-thread reference. A `thread = []` default parameter would mint a
 *  NEW array every render, so the reconcile effect's `[thread]` dependency would
 *  change on every render and — once `pending` is non-empty — call `setPending`
 *  forever (an infinite render loop). One shared constant keeps the reference
 *  stable when no thread is supplied. */
const EMPTY_THREAD: Reply[] = []

// Module-level monotonic sequence for optimistic-reply ids — guarantees uniqueness
// even across same-millisecond sends (see the id comment in `send`).
let pendingSeq = 0

interface Props {
  /** The run id (= the run's `.id`) — the reply endpoint is run-scoped. */
  runId: string
  /** The point/surface id the thread hangs off. */
  pointId: string
  /** The store-owned thread. Undefined/empty renders just the reply input. */
  thread?: Reply[]
  /** Optional label for the reply input placeholder. */
  placeholder?: string
}

export function SurfaceThread({ runId, pointId, thread = EMPTY_THREAD, placeholder }: Props) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState<Reply[]>([])
  const [error, setError] = useState<string | null>(null)
  const [undelivered, setUndelivered] = useState(false)

  // Reconcile: once the SSE run delta lands a persisted reply matching an
  // optimistic one (same author+text), drop the optimistic copy so the thread
  // shows exactly one. Matching on author+text (not id) because the server mints
  // its own reply id — the optimistic id never appears in the persisted thread.
  useEffect(() => {
    if (pending.length === 0) return
    setPending((prev) => {
      const next = prev.filter((p) => !thread.some((t) => t.author === p.author && t.text === p.text))
      // Return the SAME reference when nothing reconciled, so this never schedules
      // a re-render that would re-run the effect and loop.
      return next.length === prev.length ? prev : next
    })
  }, [thread]) // eslint-disable-line react-hooks/exhaustive-deps

  const messages = [...thread, ...pending]

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return
    setError(null)
    setUndelivered(false)
    setSending(true)
    const optimistic: Reply = {
      // Monotonic counter, not Date.now() — two sends in the same millisecond would
      // mint the same id, colliding React keys and making the failure-revert pull
      // the wrong pending reply off the thread.
      id: `pending-${++pendingSeq}`,
      author: 'user',
      text,
      createdAt: Date.now(),
    }
    setPending((prev) => [...prev, optimistic])
    setDraft('')
    try {
      const res = await apiFetch(`/api/runs/${runId}/slate/points/${pointId}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, author: 'user' }),
      })
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { delivered?: boolean }; error?: { message?: string } }
        | null
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message || `reply failed (${res.status})`)
      // Delivery is best-effort: the reply is on the thread either way, so a
      // sleeping session is a note, not an error.
      if (body.data?.delivered === false) setUndelivered(true)
    } catch {
      // Revert cleanly: pull the optimistic reply back off and restore the draft.
      setPending((prev) => prev.filter((p) => p.id !== optimistic.id))
      setDraft(text)
      setError('Could not send your reply. Try again.')
    } finally {
      setSending(false)
    }
  }, [draft, sending, runId, pointId])

  return (
    <div className="flex flex-col gap-1.5">
      {messages.length > 0 && (
        // Fixed ceiling + internal scroll so a long thread never bloats the card.
        // data-scrollable yields the wheel to this thread over the canvas camera.
        <div
          data-scrollable
          data-testid={`thread-${pointId}`}
          className="max-h-32 overflow-y-auto flex flex-col gap-1 pr-1"
        >
          {messages.map((m) => (
            <div key={m.id} className="text-2xs leading-snug">
              <span
                className={
                  m.author === 'user'
                    ? 'text-slate-400'
                    : m.author === 'process'
                      ? 'text-cyan-300'
                      : 'text-amber-300'
                }
              >
                {m.author === 'user' ? 'you' : m.author}
              </span>
              <span className="text-slate-500"> · </span>
              <span className="text-slate-200 whitespace-pre-wrap">{m.text}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1">
        <input
          data-testid={`reply-input-${pointId}`}
          value={draft}
          placeholder={placeholder ?? 'Reply…'}
          disabled={sending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void send()
            }
          }}
          className="flex-1 rounded border border-primary/20 bg-surface-base px-2 py-0.5 text-2xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none disabled:opacity-70"
        />
        <button
          data-testid={`reply-send-${pointId}`}
          onClick={() => void send()}
          disabled={sending}
          className="rounded bg-surface-hover px-2 py-0.5 text-2xs text-slate-200 hover:bg-primary/20 disabled:opacity-50"
        >
          {sending ? '…' : 'Reply'}
        </button>
      </div>

      {undelivered && (
        <div className="text-2xs text-amber-300/90">
          Sent — but that session isn&apos;t reachable right now. It&apos;ll see this when it&apos;s back.
        </div>
      )}
      {error && <div className="text-2xs text-red-300">{error}</div>}
    </div>
  )
}
