// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
import { useCallback, useEffect, useMemo, useState } from 'react'
import Fuse from 'fuse.js'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import type { Tombstone, ReviveResult } from './types'

interface DeltaMsg { eventType?: string }

/** Never render a missing value as empty/0 — show a dash. */
function orDash(v: string | undefined | null): string {
  return v && v.trim() ? v : '—'
}

function shortWhen(iso: string | undefined): string {
  if (!iso) return '—'
  // Keep it deterministic and locale-light: YYYY-MM-DD HH:MM.
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso
}

export function makeGraveyardWidget(api: TinstarPluginAPI) {
  return function Graveyard(_props: WidgetProps) {
    const [graves, setGraves] = useState<Tombstone[] | null>(null)
    const [query, setQuery] = useState('')
    const [selected, setSelected] = useState<string | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)

    const load = useCallback(async () => {
      try {
        const res = await api.http.fetch('/api/graveyard')
        const body = await res.json() as { ok: boolean; data?: Tombstone[] }
        setGraves(body.ok && body.data ? body.data : [])
      } catch (err) {
        api.logger.error('graveyard: load failed', err)
        setGraves([])
      }
    }, [])

    useEffect(() => { void load() }, [load])

    // Live-refresh when a session is retired or a grave is purged/revived —
    // the host forwards docstore tombstone changes as `tombstone.updated` deltas.
    useEffect(() => {
      const sub = api.events.subscribe<DeltaMsg>('delta', msg => {
        if (msg?.eventType === 'tombstone.updated') void load()
      })
      return () => sub.dispose()
    }, [load])

    const fuse = useMemo(
      () => new Fuse(graves ?? [], {
        keys: ['coversSummary', 'sessionName', 'task', 'epic', 'initiative'],
        threshold: 0.4,
        ignoreLocation: true,
      }),
      [graves],
    )

    const shown = useMemo(() => {
      const q = query.trim()
      if (!q) return graves ?? []
      return fuse.search(q).map(r => r.item)
    }, [query, fuse, graves])

    const active = shown.find(g => g.convId === selected) ?? null

    const necro = useCallback(async (convId: string) => {
      setBusy(convId); setNotice(null)
      try {
        const res = await api.http.fetch(`/api/graveyard/${encodeURIComponent(convId)}/revive`, { method: 'POST' })
        const body = await res.json() as { ok: boolean; data?: ReviveResult; error?: { message?: string } }
        if (!body.ok) { setNotice(body.error?.message ?? 'Revive failed.'); return }
        const r = body.data
        if (!r?.revivable) {
          setNotice('The transcript is no longer available — this grave is summary-only.')
          return
        }
        setNotice(
          r.workspaceMissing
            ? `Revived as “${r.sessionName}” — its worktree is gone, so it remembers the conversation but not the files.`
            : `Revived as “${r.sessionName}”. Steer it from its canvas card.`,
        )
      } catch (err) {
        api.logger.error('graveyard: revive failed', err)
        setNotice('Revive failed.')
      } finally {
        setBusy(null)
      }
    }, [])

    const purge = useCallback(async (convId: string) => {
      if (!window.confirm('Forget this session forever? This cannot be undone.')) return
      setBusy(convId); setNotice(null)
      try {
        await api.http.fetch(`/api/graveyard/${encodeURIComponent(convId)}/purge`, { method: 'POST' })
        if (selected === convId) setSelected(null)
        await load()
      } catch (err) {
        api.logger.error('graveyard: purge failed', err)
        setNotice('Purge failed.')
      } finally {
        setBusy(null)
      }
    }, [selected, load])

    return (
      <div className="w-full h-full flex flex-col bg-slate-900 text-slate-200 rounded-lg overflow-hidden">
        <div className="widget-drag-handle flex items-center gap-2 px-3 py-2 bg-slate-800 border-b border-slate-700 cursor-grab">
          <span className="text-sm font-semibold tracking-wide">⚰️ Graveyard</span>
          <span className="text-xs text-slate-400">
            {graves === null ? 'loading…' : `${graves.length} retired`}
          </span>
        </div>

        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search what past sessions covered…"
          className="m-2 px-2 py-1 text-sm bg-slate-800 border border-slate-700 rounded outline-none focus:border-slate-500"
        />

        <div className="flex-1 flex min-h-0">
          <ul className="w-1/2 overflow-y-auto border-r border-slate-800 text-sm">
            {graves === null && <li className="px-3 py-2 text-slate-500">Loading…</li>}
            {graves !== null && shown.length === 0 && (
              <li className="px-3 py-4 text-slate-500">
                {graves.length === 0 ? 'No retired sessions yet.' : 'No graves match.'}
              </li>
            )}
            {shown.map(g => (
              <li
                key={g.convId}
                onClick={() => setSelected(g.convId)}
                className={`px-3 py-2 cursor-pointer border-b border-slate-800/60 hover:bg-slate-800/60 ${
                  selected === g.convId ? 'bg-slate-800' : ''
                }`}
              >
                <div className="font-medium truncate">{orDash(g.sessionName)}</div>
                <div className="text-xs text-slate-400 truncate">{orDash(g.coversSummary)}</div>
                <div className="text-[10px] text-slate-500">{shortWhen(g.retiredAt)}</div>
              </li>
            ))}
          </ul>

          <div className="w-1/2 overflow-y-auto p-3 text-sm">
            {!active && <div className="text-slate-500">Select a grave to inspect or revive.</div>}
            {active && (
              <div className="flex flex-col gap-2">
                <div className="text-base font-semibold">{orDash(active.sessionName)}</div>
                <div className="text-slate-300 whitespace-pre-wrap">{orDash(active.coversSummary)}</div>
                <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs text-slate-400 mt-1">
                  <dt>Task</dt><dd className="text-slate-300">{orDash(active.task)}</dd>
                  <dt>Retired</dt><dd className="text-slate-300">{shortWhen(active.retiredAt)}</dd>
                  <dt>Workspace</dt><dd className="text-slate-300 break-all">{orDash(active.workspacePath)}</dd>
                  <dt>Model</dt><dd className="text-slate-300">{orDash(active.model)}</dd>
                </dl>

                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => necro(active.convId)}
                    disabled={busy === active.convId}
                    className="px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs"
                  >
                    {busy === active.convId ? 'Necro…' : 'Necro'}
                  </button>
                  <button
                    onClick={() => purge(active.convId)}
                    disabled={busy === active.convId}
                    className="px-3 py-1 rounded bg-slate-700 hover:bg-red-800 disabled:opacity-50 text-slate-200 text-xs"
                  >
                    Purge
                  </button>
                </div>

                {notice && <div className="mt-2 text-xs text-amber-300">{notice}</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }
}
