// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
//
// Theming: Boot Hill — a dusty frontier cemetery. Warm parchment + weathered
// wood, tombstone cards, and western copy ("Here lies…", "Raise", "Bury forever"),
// matching the Saloon's old-west vibe.
import { useCallback, useEffect, useMemo, useState } from 'react'
import Fuse from 'fuse.js'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import type { Tombstone, ReviveResult } from './types'

interface DeltaMsg { eventType?: string }

/** Never render a missing value as empty/0 — show a dash. */
function orDash(v: string | undefined | null): string {
  return v && v.trim() ? v : '—'
}

/** A tombstone's headline: the run's friendly name snapshotted at retire-time,
 *  falling back to sessionName (the identity handle) when it had none. Local to
 *  the plugin — ADR-0002 forbids importing the runtime helper from the host. */
function graveLabel(t: { displayName?: string; sessionName: string }): string {
  return t.displayName || t.sessionName
}

function shortWhen(iso: string | undefined): string {
  if (!iso) return '—'
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso
}

/** A grave's worktree, as its workspace directory name. Unlike `project` (which
 *  is recorded at retire-time and absent on older graves), this is derived, so
 *  it works on every grave ever buried. */
function worktreeOf(t: Tombstone): string | undefined {
  const p = t.workspacePath?.replace(/\/+$/, '')
  return p ? p.slice(p.lastIndexOf('/') + 1) || undefined : undefined
}

/** Distinct facet values present in the graveyard, alphabetical. Graves missing
 *  the facet contribute nothing — an absent value is unknown, not a category. */
function facetValues(graves: Tombstone[], of: (t: Tombstone) => string | undefined): string[] {
  return [...new Set(graves.map(of).filter((v): v is string => !!v))].sort()
}

/** One facet's chip row. Renders nothing when the graveyard has no values for
 *  the facet — a row offering only "all" is noise, not a filter. */
function FilterRow({ testId, label, values, active, onPick }: {
  testId: string
  label: string
  values: string[]
  active: string | null
  onPick: (v: string | null) => void
}) {
  if (values.length === 0) return null
  const chip = (on: boolean) =>
    `px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
      on ? 'bg-amber-600 border-amber-400 text-amber-50 font-bold'
         : 'bg-amber-950/40 border-amber-900/50 text-amber-200/70 hover:bg-amber-900/50'
    }`
  return (
    <div data-testid={testId} className="flex items-center gap-1 flex-wrap px-2 pb-1">
      <span className="text-[10px] uppercase tracking-wider text-amber-400/60 w-14 shrink-0">{label}</span>
      <button data-chip="all" onClick={() => onPick(null)} className={chip(active === null)}>all</button>
      {values.map(v => (
        // Clicking the active chip clears it — a second click is the way out.
        <button key={v} onClick={() => onPick(active === v ? null : v)} className={chip(active === v)}>{v}</button>
      ))}
    </div>
  )
}

export function makeGraveyardWidget(api: TinstarPluginAPI) {
  return function Graveyard(_props: WidgetProps) {
    const [graves, setGraves] = useState<Tombstone[] | null>(null)
    const [query, setQuery] = useState('')
    const [project, setProject] = useState<string | null>(null)
    const [worktree, setWorktree] = useState<string | null>(null)
    const [selected, setSelected] = useState<string | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [loadError, setLoadError] = useState(false)

    const load = useCallback(async () => {
      try {
        const res = await api.http.fetch('/api/graveyard')
        const body = await res.json() as { ok: boolean; data?: Tombstone[] }
        if (!body.ok || !body.data) { setLoadError(true); return }
        setLoadError(false)
        setGraves(body.data)
      } catch (err) {
        // Distinct from an empty graveyard — a backend outage must not read as
        // "nothing retired".
        api.logger.error('graveyard: load failed', err)
        setLoadError(true)
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

    const projects = useMemo(() => facetValues(graves ?? [], g => g.project), [graves])
    const worktrees = useMemo(() => facetValues(graves ?? [], worktreeOf), [graves])

    // Chips narrow first, then the text search runs over what's left — so a
    // query and a chip compose instead of competing.
    const scoped = useMemo(
      () => (graves ?? []).filter(g =>
        (!project || g.project === project) && (!worktree || worktreeOf(g) === worktree)),
      [graves, project, worktree],
    )

    const fuse = useMemo(
      () => new Fuse(scoped, {
        // project + workspacePath are indexed too, so typing a project or branch
        // name finds graves even with every chip cleared.
        keys: ['coversSummary', 'displayName', 'sessionName', 'task', 'epic', 'initiative', 'project', 'workspacePath'],
        threshold: 0.4,
        ignoreLocation: true,
      }),
      [scoped],
    )

    const shown = useMemo(() => {
      const q = query.trim()
      if (!q) return scoped
      return fuse.search(q).map(r => r.item)
    }, [query, fuse, scoped])

    const active = shown.find(g => g.convId === selected) ?? null

    const necro = useCallback(async (convId: string) => {
      setBusy(convId); setNotice(null)
      try {
        const res = await api.http.fetch(`/api/graveyard/${encodeURIComponent(convId)}/revive`, { method: 'POST' })
        const body = await res.json() as { ok: boolean; data?: ReviveResult; error?: { message?: string } }
        if (!body.ok) { setNotice(body.error?.message ?? 'The séance failed.'); return }
        const r = body.data
        if (!r?.revivable) {
          setNotice('This soul has passed beyond reach — the transcript is gone, so only its epitaph (summary) remains.')
          return
        }
        setNotice(
          r.workspaceMissing
            ? `Raised as “${orDash(r.sessionName)}” — its old workshop is dust, so it recalls the conversation but not the files.`
            : `Raised as “${orDash(r.sessionName)}”. Find it walkin' the canvas.`,
        )
      } catch (err) {
        api.logger.error('graveyard: revive failed', err)
        setNotice('The séance failed.')
      } finally {
        setBusy(null)
      }
    }, [])

    const purge = useCallback(async (convId: string) => {
      if (!window.confirm('Bury this soul forever? There is no digging it back up.')) return
      setBusy(convId); setNotice(null)
      try {
        await api.http.fetch(`/api/graveyard/${encodeURIComponent(convId)}/purge`, { method: 'POST' })
        if (selected === convId) setSelected(null)
        await load()
      } catch (err) {
        api.logger.error('graveyard: purge failed', err)
        setNotice('Could not bury it.')
      } finally {
        setBusy(null)
      }
    }, [selected, load])

    return (
      <div className="w-full h-full flex flex-col rounded-lg overflow-hidden font-serif text-amber-100"
           style={{ background: 'linear-gradient(180deg, #3a2b1a 0%, #241a10 100%)' }}>
        <div className="widget-drag-handle flex items-center gap-2 px-3 py-2 border-b-2 border-amber-900/70 cursor-grab"
             style={{ background: 'linear-gradient(180deg, #5b3f24 0%, #4a3319 100%)' }}>
          <span className="text-sm font-bold tracking-widest uppercase">🪦 Boot Hill</span>
          <span className="text-xs text-amber-300/80 italic">
            {loadError ? 'couldn’t reach the graveyard' : graves === null ? 'countin’ the graves…' : `${graves.length} buried here`}
          </span>
        </div>

        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search the dearly departed…"
          className="m-2 px-2 py-1 text-sm rounded outline-none bg-amber-50/90 text-stone-800 placeholder-stone-500 border border-amber-900/40 focus:border-amber-700"
        />

        <FilterRow testId="project-filter" label="Project" values={projects} active={project} onPick={setProject} />
        <FilterRow testId="worktree-filter" label="Worktree" values={worktrees} active={worktree} onPick={setWorktree} />

        <div className="flex-1 flex min-h-0">
          <ul className="w-1/2 overflow-y-auto border-r-2 border-amber-900/50 text-sm">
            {/* Prominent error only when there's no data to fall back on. On a
                refresh failure with stale rows, keep the rows and let the header
                pill signal the outage — the error li and rows never co-render. */}
            {loadError && (graves === null || graves.length === 0) && (
              <li className="px-3 py-4 text-red-300/80 italic">
                Couldn’t reach the graveyard.{' '}
                <button onClick={() => void load()} className="underline hover:text-red-200">Try again</button>
              </li>
            )}
            {!loadError && graves === null && <li className="px-3 py-2 text-amber-300/70 italic">Countin’ the graves…</li>}
            {!loadError && graves !== null && shown.length === 0 && (
              <li className="px-3 py-4 text-amber-300/70 italic">
                {graves.length === 0 ? 'Boot Hill stands empty — no souls buried yet.' : 'No graves match that name.'}
              </li>
            )}
            {shown.map(g => (
              <li
                key={g.convId}
                onClick={() => setSelected(g.convId)}
                className={`px-3 py-2 cursor-pointer border-b border-amber-900/30 hover:bg-amber-900/30 ${
                  selected === g.convId ? 'bg-amber-900/40' : ''
                }`}
              >
                <div className="font-bold truncate flex items-center gap-1">
                  <span>Here lies {orDash(graveLabel(g))}</span>
                  {g.snapshotted && <span title="Embalmed — revivable even after Claude Code forgets">⚱️</span>}
                </div>
                <div className="text-xs text-amber-200/70 truncate italic">{orDash(g.coversSummary)}</div>
                <div className="text-[10px] text-amber-400/60">buried {shortWhen(g.retiredAt)}</div>
              </li>
            ))}
          </ul>

          <div className="w-1/2 overflow-y-auto p-3 text-sm">
            {!active && <div className="text-amber-300/60 italic">Pick a grave to read its epitaph — or raise the dead.</div>}
            {active && (
              <div className="flex flex-col gap-2">
                <div className="text-base font-bold border-b border-amber-900/40 pb-1">⚰️ Here lies {orDash(graveLabel(active))}</div>
                <div className="text-amber-100/90 italic whitespace-pre-wrap">“{orDash(active.coversSummary)}”</div>
                <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs text-amber-300/70 mt-1">
                  <dt>Task</dt><dd className="text-amber-100/90">{orDash(active.task)}</dd>
                  <dt>Project</dt><dd className="text-amber-100/90">{orDash(active.project)}</dd>
                  <dt>Worktree</dt><dd className="text-amber-100/90">{orDash(worktreeOf(active))}</dd>
                  <dt>Buried</dt><dd className="text-amber-100/90">{shortWhen(active.retiredAt)}</dd>
                  <dt>Last workshop</dt><dd className="text-amber-100/90 break-all">{orDash(active.workspacePath)}</dd>
                  <dt>Model</dt><dd className="text-amber-100/90">{orDash(active.model)}</dd>
                </dl>

                <div className={`text-xs mt-1 ${active.snapshotted ? 'text-emerald-300/90' : 'text-amber-400/80'}`}>
                  {active.snapshotted
                    ? '⚱️ Embalmed — raises even after Claude Code forgets the transcript.'
                    : '⚠️ Best-effort — may be summary-only if the transcript is gone.'}
                </div>

                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => necro(active.convId)}
                    disabled={busy === active.convId}
                    className="px-3 py-1 rounded border border-amber-500/40 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-amber-50 text-xs font-bold tracking-wide"
                  >
                    {busy === active.convId ? 'Raising…' : '🔮 Raise'}
                  </button>
                  <button
                    onClick={() => purge(active.convId)}
                    disabled={busy === active.convId}
                    className="px-3 py-1 rounded border border-stone-600 bg-stone-800 hover:bg-red-900 disabled:opacity-50 text-amber-100 text-xs"
                  >
                    ⚰️ Bury forever
                  </button>
                </div>

                {notice && <div className="mt-2 text-xs text-amber-200 bg-amber-900/40 rounded px-2 py-1">{notice}</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }
}
