// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md),
// except type-only imports of host domain types (they erase at build time and
// don't breach the runtime boundary — sibling plugins do the same).
//
// The Roundup: a live, read-only board of every agent's standing notices, grouped
// by the run that posted them. Two kinds, visually distinct at a glance (R4):
// `needs-you` (the agent is waiting on you) and `fyi` (a call it made on its own).
// Notices are agent-authored over /api/notices; this widget only reads and
// re-reads on the `notice.updated` delta. Interactive answer-back and A2UI
// rendering are deferred — see the feature plan's Scope Boundaries.
import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import type { Notice } from '../../../domain/types'

interface DeltaMsg { eventType?: string }

/** A run's display attribution: its friendly name, falling back to its id (the
 *  session handle) when it has none — mirrors how the host labels a nameless run. */
interface RunLabel { id: string; name?: string }

function runHeader(label: RunLabel | undefined, runId: string): string {
  return label?.name?.trim() || runId
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
              <div className="text-xs font-semibold uppercase tracking-wider text-neutral-400 border-b border-neutral-800 pb-1">
                {runHeader(runLabels[group.runId], group.runId)}
              </div>
              {group.notices.map(n => {
                const isOpen = expanded.has(n.id)
                const isNeedsYou = n.kind === 'needs-you'
                return (
                  <div
                    key={n.id}
                    className={`rounded-md border ${isNeedsYou ? 'border-amber-500/50 bg-amber-500/5' : 'border-sky-500/40 bg-sky-500/5'}`}
                  >
                    <button
                      onClick={() => toggle(n.id)}
                      className="w-full flex items-start gap-2 px-3 py-2 text-left"
                    >
                      <span
                        className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
                          isNeedsYou ? 'bg-amber-500 text-neutral-900' : 'bg-sky-500 text-neutral-900'
                        }`}
                      >
                        {isNeedsYou ? 'Needs you' : 'FYI'}
                      </span>
                      <span className="flex-1 text-sm font-medium leading-snug">{n.headline}</span>
                      {n.background.trim() && (
                        <span className="shrink-0 text-neutral-500 text-xs mt-0.5">{isOpen ? '▾' : '▸'}</span>
                      )}
                    </button>
                    {isOpen && n.background.trim() && (
                      <div className="px-3 pb-3 pt-0 text-sm text-neutral-200 [&_a]:text-sky-300 [&_a]:underline [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:bg-neutral-800 [&_code]:px-1 [&_code]:rounded [&_pre]:bg-neutral-800 [&_pre]:p-2 [&_pre]:rounded [&_pre]:overflow-x-auto">
                        <ReactMarkdown>{n.background}</ReactMarkdown>
                        <div className="mt-2 text-[10px] text-neutral-500">
                          posted {shortWhen(n.createdAt)}
                          {n.amendedAt > n.createdAt && ` · amended ${shortWhen(n.amendedAt)}`}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          ))}
        </div>
      </div>
    )
  }
}
