// Slate v2 U4 — the surface composer.
//
// A small popover behind the header's "+ Add surface" button. It doesn't build a
// surface itself: it composes an AUTHORING PROMPT and hands it to the run's agent
// (POST …/slate/compose), which writes the actual .tinstar/slate/<slug>.json. The new
// surface then arrives over the SSE `run` delta like any other.
//
// Two ways to say what you want, and they compose:
//   · pick a TEMPLATE — a fuzzy search over SURFACE_CATALOG fills the reusable
//     authoring `prompt` (PR review, Dataflow, Checklist, …), and
//   · add FREEFORM — a textarea for anything the template doesn't cover (or the whole
//     ask, template-free).
// Submit needs at least one of the two. delivered:false (an unreachable run) is a note,
// not an error — the compose reached the store either way; it lands when the run wakes.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../../apiClient'
import { searchSurfaceCatalog, type SurfaceTemplate } from './surfaceCatalog'

interface Props {
  runId: string
  onClose: () => void
  /** Render as a PERMANENT part of the page rather than a popover (S6 U5 — the
   *  inviting blank Slate). An inline composer has nothing to close back to, so
   *  the self-close effects (Esc, outside-click) and the Cancel button are all
   *  suppressed; without that it would vanish on the first stray click and leave
   *  the empty Slate emptier than before. */
  inline?: boolean
  /** Fires whenever the composer starts or stops holding an unsent draft. The blank
   *  Slate uses it to withhold its ✕ (which would collapse the column and destroy
   *  the draft) while there is something to lose. */
  onDraftChange?: (dirty: boolean) => void
}

export function SlateComposer({ runId, onClose, inline = false, onDraftChange }: Props) {
  const labelId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SurfaceTemplate | null>(null)
  const [freeform, setFreeform] = useState('')
  // Create-time refresh recipe (feat: multi-agent Slate). Captured now so the new
  // surface is born handoff-able — it's the self-contained instruction a one-shot
  // author re-runs to keep the surface fresh.
  const [recipe, setRecipe] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  // Inline only: the popover's confirmation IS the popover vanishing, but an inline
  // composer stays put, so a successful submit needs its own acknowledgement.
  const [sent, setSent] = useState(false)

  const matches = useMemo(() => searchSurfaceCatalog(query), [query])
  // Submit needs at least a template or some freeform text (mirrors the server's
  // INVALID_PARAMS guard for an all-blank body).
  const canSubmit = !!selected || freeform.trim().length > 0

  // An unsent draft — anything the user would lose if the composer went away.
  const dirty = canSubmit || recipe.trim().length > 0
  const onDraftChangeRef = useRef(onDraftChange)
  useEffect(() => { onDraftChangeRef.current = onDraftChange }, [onDraftChange])
  useEffect(() => {
    onDraftChangeRef.current?.(dirty)
    return () => onDraftChangeRef.current?.(false)
  }, [dirty])

  // Esc closes (capture, to win over anything focused inside). Not when inline —
  // there is nothing behind it to reveal.
  useEffect(() => {
    if (inline) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [inline])

  // Outside-click closes. Also suppressed inline.
  useEffect(() => {
    if (inline) return
    function onPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onCloseRef.current()
    }
    document.addEventListener('pointerdown', onPointer, true)
    return () => document.removeEventListener('pointerdown', onPointer, true)
  }, [inline])

  const submit = useCallback(async () => {
    if (submitting) return
    const trimmed = freeform.trim()
    if (!selected && !trimmed) {
      setError('Pick a template or add a description first.')
      return
    }
    setError(null)
    setUnreachable(false)
    setSent(false)
    setSubmitting(true)
    try {
      const res = await apiFetch(`/api/runs/${runId}/slate/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(selected ? { prompt: selected.prompt } : {}),
          ...(trimmed ? { freeform: trimmed } : {}),
          ...(recipe.trim() ? { recipe: recipe.trim() } : {}),
        }),
      })
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { delivered?: boolean }; error?: { message?: string } }
        | null
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message || `compose failed (${res.status})`)
      // Delivered:false — the run is asleep. The compose reached the store; it lands
      // when the run wakes. Say so instead of closing silently on a promise unkept.
      if (body.data?.delivered === false) {
        setUnreachable(true)
        return
      }
      // Inline: there is no popover to vanish, so clear the form and SAY it went.
      // Without this a successful submit looks like a dead button for the seconds
      // it takes the author to write the file, and the obvious recovery (click it
      // again) composes the same surface twice.
      if (inline) {
        setSelected(null)
        setFreeform('')
        setRecipe('')
        setQuery('')
        setSent(true)
        return
      }
      onClose() // delivered — the surface will arrive over the SSE run delta.
    } catch {
      setError('Could not send your request. Try again.')
    } finally {
      setSubmitting(false)
    }
  }, [submitting, selected, freeform, recipe, runId, onClose, inline])

  return (
    <div
      ref={rootRef}
      data-testid="slate-composer"
      data-inline={inline ? 'true' : undefined}
      className={`flex flex-col gap-2 rounded border border-hairline bg-surface-raised p-3 ${inline ? '' : 'shadow-lg'}`}
    >
      <div id={labelId} className="text-2xs font-mono uppercase tracking-[0.12em] text-ink-low">
        Add a surface
      </div>

      {/* Template search — fuzzy over the catalog. */}
      <input
        data-testid="composer-search"
        value={query}
        placeholder="Search templates…"
        onChange={(e) => setQuery(e.target.value)}
        className="rounded border border-hairline bg-surface-panel px-2 py-1 text-xs text-ink-high placeholder:text-ink-low focus:border-primary/60 focus:outline-none"
      />

      {/* Matches — data-scrollable so the canvas wheel handler yields to this list. */}
      <ul
        data-testid="composer-templates"
        data-scrollable
        className="max-h-40 overflow-y-auto scrollbar-thin flex flex-col gap-1"
        aria-labelledby={labelId}
      >
        {matches.length === 0 && (
          <li className="px-1 py-2 text-2xs text-ink-low text-center">No matching templates</li>
        )}
        {matches.map((t) => {
          const isSel = selected?.id === t.id
          return (
            <li key={t.id}>
              <button
                data-testid={`composer-template-${t.id}`}
                aria-selected={isSel}
                onClick={() => setSelected(isSel ? null : t)}
                className={`w-full rounded-sm border px-2 py-1 text-left ${
                  isSel
                    ? 'border-primary/50 bg-primary/10'
                    : 'border-hairline bg-surface-hover hover:border-ink-ctrl'
                }`}
              >
                <div className="text-xs font-medium text-ink-high">{t.name}</div>
                <div className="text-2xs text-ink-low leading-snug">{t.description}</div>
              </button>
            </li>
          )
        })}
      </ul>

      {/* Freeform — anything the template doesn't cover, or the whole ask template-free. */}
      <textarea
        data-testid="composer-freeform"
        rows={2}
        value={freeform}
        placeholder={selected ? 'Add anything else… (optional)' : '…or describe the surface you want'}
        onChange={(e) => setFreeform(e.target.value)}
        className="rounded border border-hairline bg-surface-panel px-2 py-1 text-xs text-ink-high placeholder:text-ink-low focus:border-primary/60 focus:outline-none"
      />

      {/* Create-time recipe — how this surface stays fresh. A good recipe names its
          source, derivation, and output so a one-shot author can re-run it in a vacuum. */}
      <label className="flex flex-col gap-0.5">
        <span className="text-2xs font-mono uppercase tracking-[0.12em] text-ink-low">Stays fresh by… (optional)</span>
        <textarea
          data-testid="composer-recipe"
          rows={2}
          value={recipe}
          placeholder="e.g. re-run the blind eval of PR #7 and rewrite the two columns"
          onChange={(e) => setRecipe(e.target.value)}
          className="rounded border border-hairline bg-surface-panel px-2 py-1 text-xs text-ink-high placeholder:text-ink-low focus:border-primary/60 focus:outline-none"
        />
      </label>

      <div className="flex items-center gap-2">
        <button
          data-testid="composer-submit"
          onClick={() => void submit()}
          disabled={!canSubmit || submitting}
          // The primary Create — a generative move, so it carries the cyan (P4).
          className="rounded bg-primary px-3 py-1 text-xs font-semibold text-surface-base hover:bg-primary/85 disabled:opacity-40"
        >
          {submitting ? 'Sending…' : 'Add surface'}
        </button>
        {!inline && (
          <button
            data-testid="composer-cancel"
            onClick={onClose}
            disabled={submitting}
            className="rounded px-2 py-1 text-xs text-ink-low hover:text-ink-high disabled:opacity-50"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Drops away the moment a NEW draft starts — it acknowledges the last send,
          it isn't a standing status line. */}
      {sent && !dirty && (
        <div data-testid="composer-sent" className="text-2xs text-ink-low">
          Sent — the agent is authoring it. It’ll appear here in a moment.
        </div>
      )}
      {unreachable && (
        <div data-testid="composer-unreachable" className="text-2xs text-ink-low">
          Sent — but that session isn’t reachable right now. It’ll pick this up when it’s back.
        </div>
      )}
      {error && <div className="text-2xs text-hue-error">{error}</div>}
    </div>
  )
}
