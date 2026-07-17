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
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import type { Notice } from '../../../domain/types'
import { A2uiRenderer } from './a2ui/A2uiRenderer'
import { isAnswerable } from './a2ui/controls'
import type { NoticeFormState } from './a2ui/controlComponents'

interface DeltaMsg { eventType?: string }

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

/** Group notices by their posting run, preserving each run's first-seen order.
 *  Within a run, `needs-you` sorts ahead of `fyi`, then most-recently-amended
 *  first — the thing most likely to want you is at the top. Pure, so it's cheap
 *  to recompute on every delta. */
export function groupByRun(notices: Notice[]): Array<{ runId: string; notices: Notice[] }> {
  const order: string[] = []
  const byRun = new Map<string, Notice[]>()
  for (const n of notices) {
    if (!byRun.has(n.runId)) { byRun.set(n.runId, []); order.push(n.runId) }
    byRun.get(n.runId)!.push(n)
  }
  const kindRank = (k: Notice['kind']) => (k === 'needs-you' ? 0 : 1)
  return order.map(runId => ({
    runId,
    notices: [...byRun.get(runId)!].sort((a, b) =>
      kindRank(a.kind) - kindRank(b.kind) || b.amendedAt - a.amendedAt),
  }))
}

export function makeRoundupWidget(api: TinstarPluginAPI) {
  /** One notice row: header + (when expanded) its A2UI body, plus the answer /
   *  dissent affordances. Holds the per-notice form state (U3) so a submit is
   *  optimistic (R23) and reverts cleanly on failure. Defined here (not inside
   *  Roundup's render) so its identity is stable across the parent's re-renders. */
  function NoticeCard({ notice, isOpen, onToggle }: { notice: Notice; isOpen: boolean; onToggle: () => void }) {
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [text, setText] = useState('')
    const [dissentText, setDissentText] = useState('')
    const [dissentOpen, setDissentOpen] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [optimisticAnswered, setOptimisticAnswered] = useState(false)
    const [submitError, setSubmitError] = useState<string | null>(null)

    const isNeedsYou = notice.kind === 'needs-you'
    // Answered from the server (persisted answer) OR optimistically (just submitted).
    const answered = optimisticAnswered || !!notice.answer
    const hasBody = !!notice.content && Array.isArray(notice.content.components) && notice.content.components.length > 0
    // A needs-you notice is interactive when it declares controls (a Choice, text
    // field, or Submit). Its form is wired only then; otherwise it renders read-only.
    const interactive = isNeedsYou && isAnswerable(notice.content)

    const toggleOption = useCallback((optionId: string, mode: 'single' | 'multi') => {
      setSelected(prev => {
        if (mode === 'single') return new Set([optionId])
        const next = new Set(prev)
        if (next.has(optionId)) next.delete(optionId); else next.add(optionId)
        return next
      })
    }, [])

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
      const choices = [...selected]
      const trimmed = text.trim()
      if (choices.length === 0 && !trimmed) {
        setSubmitError('Pick an option or add a note before submitting.')
        return
      }
      void submitAnswer({ ...(choices.length ? { choices } : {}), ...(trimmed ? { text: trimmed } : {}) })
    }, [selected, text, submitAnswer])

    const submitDissent = useCallback(() => {
      const trimmed = dissentText.trim()
      if (!trimmed) { setSubmitError('Add your objection before sending.'); return }
      void submitAnswer({ dissent: true, text: trimmed })
    }, [dissentText, submitAnswer])

    const form: NoticeFormState = {
      interactive: true,
      answered,
      submitting,
      selected,
      text,
      toggleOption,
      setText,
      submit: submitNeedsYou,
    }

    return (
      <div className={`rounded-md border ${isNeedsYou ? 'border-amber-500/50 bg-amber-500/5' : 'border-sky-500/40 bg-sky-500/5'}`}>
        <button onClick={onToggle} className="w-full flex items-start gap-2 px-3 py-2 text-left">
          <span
            className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
              isNeedsYou ? 'bg-amber-500 text-neutral-900' : 'bg-sky-500 text-neutral-900'
            }`}
          >
            {isNeedsYou ? 'Needs you' : 'FYI'}
          </span>
          <span className="flex-1 text-sm font-medium leading-snug">{notice.headline}</span>
          {answered && <span className="shrink-0 mt-0.5 text-emerald-400 text-xs" title="Answered">✓</span>}
          {hasBody && (
            <span className="shrink-0 text-neutral-500 text-xs mt-0.5">{isOpen ? '▾' : '▸'}</span>
          )}
        </button>
        {isOpen && hasBody && (
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
        {!isNeedsYou && (!hasBody || isOpen) && (
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
        {/* Footer shows for headline-only notices always, and for notices with a
            body once expanded — so arrival/amend time is never hidden. */}
        {(!hasBody || isOpen) && (
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

    const total = notices?.length ?? 0

    return (
      <div className="w-full h-full flex flex-col rounded-lg overflow-hidden bg-neutral-900 text-neutral-100">
        <div className="widget-drag-handle flex items-center gap-2 px-3 py-2 border-b border-neutral-700 bg-neutral-800 cursor-grab">
          <span className="text-sm font-bold tracking-wide">📋 Roundup</span>
          <span className="text-xs text-neutral-400">
            {loadError ? "couldn't reach the board" : notices === null ? 'gathering…' : `${total} notice${total === 1 ? '' : 's'}`}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-4">
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
                <NoticeCard key={n.id} notice={n} isOpen={expanded.has(n.id)} onToggle={() => toggle(n.id)} />
              ))}
            </section>
          ))}
        </div>
      </div>
    )
  }
}
