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
}

export function SlateComposer({ runId, onClose }: Props) {
  const labelId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SurfaceTemplate | null>(null)
  const [freeform, setFreeform] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unreachable, setUnreachable] = useState(false)

  const matches = useMemo(() => searchSurfaceCatalog(query), [query])
  // Submit needs at least a template or some freeform text (mirrors the server's
  // INVALID_PARAMS guard for an all-blank body).
  const canSubmit = !!selected || freeform.trim().length > 0

  // Esc closes (capture, to win over anything focused inside).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  // Outside-click closes.
  useEffect(() => {
    function onPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onCloseRef.current()
    }
    document.addEventListener('pointerdown', onPointer, true)
    return () => document.removeEventListener('pointerdown', onPointer, true)
  }, [])

  const submit = useCallback(async () => {
    if (submitting) return
    const trimmed = freeform.trim()
    if (!selected && !trimmed) {
      setError('Pick a template or add a description first.')
      return
    }
    setError(null)
    setUnreachable(false)
    setSubmitting(true)
    try {
      const res = await apiFetch(`/api/runs/${runId}/slate/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(selected ? { prompt: selected.prompt } : {}),
          ...(trimmed ? { freeform: trimmed } : {}),
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
      onClose() // delivered — the surface will arrive over the SSE run delta.
    } catch {
      setError('Could not send your request. Try again.')
    } finally {
      setSubmitting(false)
    }
  }, [submitting, selected, freeform, runId, onClose])

  return (
    <div
      ref={rootRef}
      data-testid="slate-composer"
      className="flex flex-col gap-2 rounded border border-primary/20 bg-surface-panel p-2 shadow-lg"
    >
      <div id={labelId} className="text-2xs font-mono uppercase tracking-wider text-slate-500">
        Add a surface
      </div>

      {/* Template search — fuzzy over the catalog. */}
      <input
        data-testid="composer-search"
        value={query}
        placeholder="Search templates…"
        onChange={(e) => setQuery(e.target.value)}
        className="rounded border border-primary/20 bg-surface-base px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
      />

      {/* Matches — data-scrollable so the canvas wheel handler yields to this list. */}
      <ul
        data-testid="composer-templates"
        data-scrollable
        className="max-h-40 overflow-y-auto scrollbar-thin flex flex-col gap-1"
        aria-labelledby={labelId}
      >
        {matches.length === 0 && (
          <li className="px-1 py-2 text-2xs text-slate-500 text-center">No matching templates</li>
        )}
        {matches.map((t) => {
          const isSel = selected?.id === t.id
          return (
            <li key={t.id}>
              <button
                data-testid={`composer-template-${t.id}`}
                aria-selected={isSel}
                onClick={() => setSelected(isSel ? null : t)}
                className={`w-full rounded border px-2 py-1 text-left ${
                  isSel
                    ? 'border-indigo-500 bg-indigo-500/10'
                    : 'border-primary/10 bg-surface-base/40 hover:border-primary/30'
                }`}
              >
                <div className="text-xs font-medium text-slate-200">{t.name}</div>
                <div className="text-2xs text-slate-500 leading-snug">{t.description}</div>
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
        className="rounded border border-primary/20 bg-surface-base px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
      />

      <div className="flex items-center gap-2">
        <button
          data-testid="composer-submit"
          onClick={() => void submit()}
          disabled={!canSubmit || submitting}
          className="rounded bg-indigo-500 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-400 disabled:opacity-40"
        >
          {submitting ? 'Sending…' : 'Add surface'}
        </button>
        <button
          data-testid="composer-cancel"
          onClick={onClose}
          disabled={submitting}
          className="rounded px-2 py-1 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      {unreachable && (
        <div data-testid="composer-unreachable" className="text-2xs text-amber-300/90">
          Sent — but that session isn’t reachable right now. It’ll pick this up when it’s back.
        </div>
      )}
      {error && <div className="text-2xs text-red-300">{error}</div>}
    </div>
  )
}
