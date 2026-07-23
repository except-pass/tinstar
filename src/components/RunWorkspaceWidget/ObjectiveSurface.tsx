// The Objective surface (S2) — the user's standing statement of what this session
// is for, pinned at the top of the run's Slate.
//
// It is a Slate surface kind like any other (`kind:'objective'`, projected from the
// reserved user point), so it wears the same card shell: hairline border, raised
// surface, 14px padding. What makes it different is who owns it and how it reaches
// the agent.
//
// THE ONE RULE THIS COMPONENT EXISTS TO ENFORCE (a product ruling, not a nicety):
//   TYPING NEVER NUDGES THE AGENT. Edits live in local state — no debounce, no
//   save-on-blur, no save-on-keystroke. Nothing leaves the browser until the user
//   presses Apply. Re-nudging a working agent mid-sentence is disruptive, so the
//   moment of alignment has to be a deliberate press. `PUT …/slate/objective` is the
//   only call that both persists and delivers, and only Apply calls it.
//
// Cyan is spent on Apply alone: committing an objective is a generative move (the
// same reason the composer's Create carries it), while edit/cancel/clear stay at
// control ink. The prose pins `font-sans` — the run card defaults to mono, so an
// unpinned objective would render as terminal text instead of something a person wrote.
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../apiClient'
import type { SlateSurface } from '../../types'
import { OBJECTIVE_MAX } from '../../types'

interface Props {
  /** The run whose objective this is — mutations are run-scoped. */
  runId: string
  /** The projected objective surface, or undefined when the run has none yet
   *  (the card collapses to a single "set an objective" affordance). */
  surface?: SlateSurface
}

export function ObjectiveSurface({ runId, surface }: Props) {
  const text = surface?.headline ?? ''

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The objective text an Apply couldn't deliver, or null for "nothing to report". Set
  // only when an Apply that ACTUALLY changed the objective couldn't reach the session —
  // a no-op Apply doesn't deliver, so it must not claim unreachability.
  //
  // It holds the TEXT rather than a bare flag so the note can expire on its own: it
  // describes one past Apply, and once the objective moves on to something else (a
  // later Apply, another viewer, another tab) the note is no longer known to be true.
  // Anchoring on the text is what lets the projection echo of *this* Apply land without
  // instantly erasing the note it just earned.
  const [unreachableFor, setUnreachableFor] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // The server projection is the source of truth while not editing: an objective
  // changed elsewhere (another tab, a second viewer) flows in over SSE. While
  // editing, the user's draft wins — a re-render must never eat what they typed.
  useEffect(() => {
    if (!editing) setDraft(text)
  }, [text, editing])

  // Expire the note once the projection shows an objective the note isn't about. A
  // stale "isn't reachable" that sits on the card through the session coming back is
  // worse than silence; the ✕ covers the rest (there is no reachability poll here).
  useEffect(() => {
    setUnreachableFor(prev => (prev !== null && text !== prev ? null : prev))
  }, [text])

  const startEditing = useCallback(() => {
    setError(null)
    setUnreachableFor(null)
    setEditing(true)
    // The textarea mounts on the next frame.
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [])

  const cancel = useCallback(() => {
    setDraft(text)
    setError(null)
    setEditing(false)
  }, [text])

  /** The ONLY path that reaches the agent. */
  const apply = useCallback(async () => {
    if (submitting) return
    const trimmed = draft.trim()
    if (!trimmed) {
      setError('An objective needs some words.')
      return
    }
    if (trimmed.length > OBJECTIVE_MAX) {
      setError(`Keep it under ${OBJECTIVE_MAX} characters.`)
      return
    }
    setError(null)
    setUnreachableFor(null)
    setSubmitting(true)
    try {
      const res = await apiFetch(`/api/runs/${runId}/slate/objective`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      })
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { delivered?: boolean; changed?: boolean }; error?: { message?: string } }
        | null
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message || `apply failed (${res.status})`)
      // Persisted either way; an asleep run just reads it later. Say so quietly
      // rather than pretending the nudge landed.
      if (body.data?.changed && body.data.delivered === false) setUnreachableFor(trimmed)
      setEditing(false)
    } catch {
      setError('Could not save the objective. Try again.')
    } finally {
      setSubmitting(false)
    }
  }, [submitting, draft, runId])

  const clear = useCallback(async () => {
    if (submitting) return
    setError(null)
    setUnreachableFor(null)
    setSubmitting(true)
    try {
      const res = await apiFetch(`/api/runs/${runId}/slate/objective`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`clear failed (${res.status})`)
      setDraft('')
      setEditing(false)
    } catch {
      setError('Could not clear the objective. Try again.')
    } finally {
      setSubmitting(false)
    }
  }, [submitting, runId])

  // No objective yet: one quiet mono line, not an empty card. The Slate's chrome
  // stays quiet until there is something to read (P1).
  if (!surface && !editing) {
    return (
      <button
        data-testid="objective-set"
        onClick={startEditing}
        className="w-full rounded border border-dashed border-hairline px-3 py-1.5 text-left font-mono text-2xs uppercase tracking-[0.12em] text-ink-ctrl hover:border-ink-ctrl hover:text-ink-mid"
      >
        + Set an objective
      </button>
    )
  }

  const dirty = editing && draft.trim() !== text.trim()

  return (
    <div
      data-testid="objective-surface"
      data-editing={editing ? 'true' : undefined}
      className="relative rounded border border-hairline bg-surface-raised p-[14px] min-w-0"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-2xs uppercase tracking-[0.12em] text-ink-low">Objective</span>
        <div className="flex items-center gap-2">
          {/* The unapplied marker — the visible half of "typing never nudges". */}
          {dirty && (
            <span data-testid="objective-dirty" className="font-mono text-2xs text-ink-ctrl">
              unapplied
            </span>
          )}
          {!editing && (
            <button
              data-testid="objective-edit"
              onClick={startEditing}
              title="Edit the objective (nothing reaches the agent until you Apply)"
              className="font-mono text-2xs text-ink-ctrl hover:text-ink-high"
            >
              edit
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <>
          <textarea
            ref={textareaRef}
            data-testid="objective-input"
            rows={3}
            value={draft}
            maxLength={OBJECTIVE_MAX}
            placeholder="What is this session for?"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Escape cancels; ⌘/Ctrl+Enter applies. A bare Enter inserts a newline —
              // an objective is prose, and an accidental Enter must not nudge.
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void apply() }
            }}
            className="mt-2 w-full rounded border border-hairline bg-surface-panel px-2 py-1 font-sans text-[13px] leading-[1.5] text-ink-high placeholder:text-ink-ctrl focus:border-primary/60 focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              data-testid="objective-apply"
              onClick={() => void apply()}
              disabled={submitting || !draft.trim()}
              title="Save the objective and nudge the agent to re-align to it"
              // The one committing move on this card — so it carries the cyan (P4).
              className="rounded bg-primary px-3 py-1 text-xs font-semibold text-surface-base hover:bg-primary/85 disabled:opacity-40"
            >
              {submitting ? 'Applying…' : 'Apply'}
            </button>
            <button
              data-testid="objective-cancel"
              onClick={cancel}
              disabled={submitting}
              className="rounded px-2 py-1 text-xs text-ink-low hover:text-ink-high disabled:opacity-50"
            >
              Cancel
            </button>
            {surface && (
              <button
                data-testid="objective-clear"
                onClick={() => void clear()}
                disabled={submitting}
                title="Remove the objective (the agent is not nudged)"
                className="ml-auto rounded px-2 py-1 font-mono text-2xs text-ink-ctrl hover:text-ink-high disabled:opacity-50"
              >
                clear
              </button>
            )}
          </div>
          <div className="mt-1 font-mono text-2xs text-ink-ctrl">
            Nothing reaches the agent until you Apply.
          </div>
        </>
      ) : (
        // Author prose: sans, mid ink, comfortable measure — the same body treatment
        // the A2UI catalog gives authored text.
        <p
          data-testid="objective-text"
          className="mt-1.5 max-h-40 overflow-y-auto scrollbar-thin font-sans text-[14px] leading-[1.6] text-ink-mid"
          data-scrollable
        >
          {text}
        </p>
      )}

      {unreachableFor !== null && (
        <div data-testid="objective-unreachable" className="mt-2 flex items-start gap-2 font-sans text-[11px] leading-snug text-ink-low">
          <span className="min-w-0">
            Saved — but that session isn’t reachable right now. It’ll pick this up when it’s back.
          </span>
          {/* Dismissable: the note is a snapshot of one Apply, and nothing here re-checks
              reachability, so the user gets to decide when it has said its piece. */}
          <button
            data-testid="objective-unreachable-dismiss"
            onClick={() => setUnreachableFor(null)}
            title="Dismiss"
            className="ml-auto shrink-0 font-mono text-2xs leading-none text-ink-ctrl hover:text-ink-high"
          >
            ✕
          </button>
        </div>
      )}
      {error && <div data-testid="objective-error" className="mt-2 text-2xs text-hue-error">{error}</div>}
    </div>
  )
}
