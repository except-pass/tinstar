import { askElement } from '../ask/element'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { AskCardAction } from '../ask/Ask'
import { AskSurface } from '../ask/AskSurface'
import { useOriginFocus } from '../ask/useOriginFocus'
import { useViewSnapshot } from '../ask/workspaceHistory'
import { pullSource, type AskView } from '../shared/ask'
import { apiFetch } from '../apiClient'
import type { PullDetail, PullSummary } from '../shared/pulls'
import { useDeskWorkspace } from '../ask/DeskWorkspace'
import { ageLabel } from '../reconciliation/recordFields'
import { usePulls } from './usePulls'
import { pullContext, visiblePulls, type PullSort } from './model'
import './pulls.css'
import { Footprint } from './Footprint'
import { ActionControls } from '../actions/ActionControls'
import type { PullFootprint } from '../shared/pullFootprint'

const columns: Array<[PullSort, string]> = [['repository', 'Repository'], ['title', 'PR'], ['author', 'Author'], ['changes', 'Changes / files'], ['checks', 'CI'], ['review', 'Review'], ['updated', 'Updated / age'], ['initiative', 'Initiative'], ['epic', 'Epic'], ['manager', 'Manager'], ['worker', 'Worker']]
export function Pulls() {
  const { data, error, refresh } = usePulls(), { scene, now, openDesk, origin, clearOrigin, views } = useDeskWorkspace()
  const [query, setQuery] = useState(origin?.view?.query ?? ''), [sort, setSort] = useState<PullSort>(() => columns.some(([key]) => key === origin?.view?.sort) ? origin!.view!.sort as PullSort : 'repository'), [descending, setDescending] = useState(origin?.view?.descending ?? false)
  const [selected, setSelected] = useState<Set<string>>(new Set()), [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [details, setDetails] = useState<Record<string, PullDetail>>({}), [failures, setFailures] = useState<Record<string, string>>({}), [busy, setBusy] = useState<Set<string>>(new Set())
  const [footprints, setFootprints] = useState<Record<string, PullFootprint>>({}), [fileErrors, setFileErrors] = useState<Record<string, string>>({}), [fileBusy, setFileBusy] = useState<Set<string>>(new Set())
  const filePending = useRef(new Set<string>())
  const pending = useRef(new Set<string>()), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const destination = origin?.section === 'pulls' ? origin : undefined
  const originId = destination?.target.id
  const missingOrigin = !!data && !!originId && !data.pulls.some(pull => pull.id === originId)
  const [originRead, setOriginRead] = useState(0)
  const [resolvedOrigin, setResolvedOrigin] = useState<PullSummary | null>(null), [originError, setOriginError] = useState<string | null>(null)
  useEffect(() => {
    setResolvedOrigin(null); setOriginError(null)
    if (!missingOrigin || !originId) return
    const source = pullSource(originId)
    if (!source) return
    let active = true
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 30_000)
    void (async () => {
      try {
        const response = await apiFetch(`/api/pulls/origin?${new URLSearchParams({ url: source.url })}`, { signal: controller.signal }), body = await response.json()
        if (!response.ok || !body.ok || body.data?.id !== originId) throw new Error(body.error?.message ?? 'Originating PR unavailable.')
        if (!controller.signal.aborted) setResolvedOrigin(body.data)
      } catch (error) { if (!active) return; if (!controller.signal.aborted) setOriginError((error as Error).message); else if (controller.signal.reason?.name === 'TimeoutError') setOriginError('Originating PR read timed out.') }
      finally { clearTimeout(deadline) }
    })()
    return () => { active = false; clearTimeout(deadline); controller.abort() }
  }, [originId, missingOrigin, originRead])
  const inventory = useMemo(() => missingOrigin && resolvedOrigin?.id === originId ? [...data!.pulls, resolvedOrigin] : data?.pulls ?? [], [data, missingOrigin, resolvedOrigin, originId])
  // A refreshed head must never display changes/checks captured at the old head.
  const currentDetails = useMemo(() => Object.fromEntries(Object.entries(details).filter(([id, detail]) => inventory.some(pull => pull.id === id && pull.head === detail.head))), [inventory, details])
  const focusRef = useOriginFocus(destination)
  useViewSnapshot(views, 'pulls', () => ({ query, sort: `${descending ? '-' : ''}${sort}` }), saved => {
    setQuery(saved.query)
    const key = saved.sort.replace(/^-/, '')
    if (columns.some(([column]) => column === key)) setSort(key as PullSort)
    setDescending(saved.sort.startsWith('-'))
  }, !!data)
  const view: AskView = { scene: 'pulls', query, sort, descending }
  const rows = useMemo(() => visiblePulls(destination ? inventory.filter(pull => pull.id === destination.target.id) : inventory, destination ? '' : query, sort, descending, scene, currentDetails), [inventory, query, sort, descending, scene, currentDetails, destination])
  const actualSelection = [...selected].filter(id => data?.pulls.some(pull => pull.id === id))
  const allSelected = rows.length > 0 && rows.every(pull => selected.has(pull.id))
  const toggleSelection = (id: string) => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const load = async (pull: PullSummary) => {
    if (pending.current.has(pull.id)) return
    const detail = currentDetails[pull.id]
    if (detail?.freshness === 'fresh' && now - Date.parse(detail.observedAt) < 120_000) return
    pending.current.add(pull.id); setBusy(previous => new Set(previous).add(pull.id))
    setFailures(previous => { const next = { ...previous }; delete next[pull.id]; return next })
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await apiFetch(`/api/pulls/detail?${new URLSearchParams({ url: pull.url, head: pull.head })}`, { signal: controller.signal }), body = await response.json()
      if (!response.ok || !body.ok) throw new Error(body.error?.message ?? 'PR detail unavailable.')
      if (mounted.current) setDetails(previous => ({ ...previous, [pull.id]: body.data }))
    } catch (error) { if (mounted.current) setFailures(previous => ({ ...previous, [pull.id]: (error as Error).name === 'AbortError' ? 'PR detail timed out. Retry or open GitHub.' : (error as Error).message })) }
    finally { clearTimeout(deadline); pending.current.delete(pull.id); if (mounted.current) setBusy(previous => { const next = new Set(previous); next.delete(pull.id); return next }) }
  }
  const loadFiles = async (pull: PullSummary) => {
    if (filePending.current.has(pull.id)) return
    const existing = footprints[pull.id]
    if (existing?.head === pull.head && existing.complete && existing.freshness === 'fresh' && now - Date.parse(existing.observedAt) < 120_000) return
    filePending.current.add(pull.id); setFileBusy(previous => new Set(previous).add(pull.id))
    setFileErrors(previous => { const next = { ...previous }; delete next[pull.id]; return next })
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 120_000)
    try {
      const response = await apiFetch(`/api/pulls/files?${new URLSearchParams({ url: pull.url, head: pull.head })}`, { signal: controller.signal }), body = await response.json()
      if (!response.ok || !body.ok || !Array.isArray(body.data?.files)) throw new Error(body.error?.message ?? 'PR files unavailable.')
      if (mounted.current) setFootprints(previous => ({ ...previous, [pull.id]: body.data }))
    } catch (error) { if (mounted.current) setFileErrors(previous => ({ ...previous, [pull.id]: (error as Error).name === 'AbortError' ? 'PR files timed out. Retry or open GitHub.' : (error as Error).message })) }
    finally { clearTimeout(deadline); filePending.current.delete(pull.id); if (mounted.current) setFileBusy(previous => { const next = new Set(previous); next.delete(pull.id); return next }) }
  }
  const originPull = originId ? inventory.find(pull => pull.id === originId) : undefined
  useEffect(() => {
    if (originPull) { void load(originPull); void loadFiles(originPull) }
    // Read once per revealed identity/head; explicit Refresh detail remains available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originPull?.id, originPull?.head])
  const inspect = (pull: PullSummary) => {
    setExpanded(previous => { const next = new Set(previous); if (next.has(pull.id)) next.delete(pull.id); else next.add(pull.id); return next })
    if (!expanded.has(pull.id)) { void load(pull); void loadFiles(pull); requestAnimationFrame(() => document.getElementById(`detail-${pull.id}`)?.scrollIntoView?.({ block: 'nearest', inline: 'start' })) }
  }
  return <section ref={focusRef} className="pr-page" aria-label="Pull requests">
    <header className="pr-header"><h1>Pull requests</h1><span>{data ? `${data.pulls.length} observed open` : 'Reading GitHub…'}</span><button type="button" onClick={() => { refresh(); setOriginRead(value => value + 1) }}>Refresh</button><button type="button" onClick={openDesk}>Your desk</button></header>
    {destination && <p role="status" className="pr-notice">{originPull ? `Showing originating PR ${originPull.id}${originPull.state ? ` (${originPull.state})` : ''}.${destination.target.kind === 'pull' && destination.target.head && originPull.head !== destination.target.head ? ' The PR head changed since this question.' : ''}` : originError ? `The originating PR ${destination.target.id} is missing or inaccessible. ${originError}` : 'Resolving originating PR…'}{' '}<a href={pullSource(destination.target.id)?.url} target="_blank" rel="noreferrer">Open originating PR in GitHub ↗</a></p>}
    {destination && <button type="button" onClick={clearOrigin}>Show all PRs in this view</button>}
    <div className="pr-toolbar"><label><span className="sr-only">Find PRs</span><input aria-label="Find PRs" placeholder="Find PR, repo, author, work…" value={query} onChange={event => { setQuery(event.target.value); clearOrigin?.() }} /></label><small>{rows.length} shown · Read-only</small></div>
    {error && <p role="alert" className="pr-notice">{error} {data && 'Retained rows are last known.'}</p>}
    {data?.warnings.map(warning => <p className="pr-notice" role="status" key={warning}>{warning}</p>)}
    {data && <details className="pr-coverage"><summary>{data.repositories.length} repositories · {data.repositories.every(repo => repo.complete) ? 'Open PR inventory complete in this scope' : 'Inventory incomplete'}</summary>{data.repositories.map(repo => <p key={repo.repository}>{repo.repository} · {repo.scope === 'authored-or-associated' ? 'Authored or explicitly associated' : 'All open PRs'} · {repo.status} · {repo.observedAt ? new Date(repo.observedAt).toLocaleString() : 'No successful observation'}{repo.error && ` · ${repo.error}`}</p>)}<p>Repositories come from explicit PR sources or configuration. All open PRs in the authenticated account’s repositories and organizations; elsewhere, only PRs authored by {data.account ?? 'the authenticated account'} or explicitly associated with a card or worker. Counts, CI and reviews load when you inspect a row.</p></details>}
    {data?.repositories.filter(repo => repo.error).map(repo => <p role="alert" className="pr-notice" key={repo.repository}>{repo.repository}: {repo.error}</p>)}
    {actualSelection.length > 0 && <div className="pr-selection" role="status">{actualSelection.length} selected <button type="button" onClick={() => setSelected(new Set())}>Clear selection</button></div>}
    <ActionControls targets={inventory.filter(pull => actualSelection.includes(pull.id))} view={view} />
    <div className="pr-scroll" tabIndex={0} role="region" aria-label="PR table, scroll horizontally for all columns"><table className="pr-table"><thead><tr><th><input type="checkbox" aria-label="Select all visible PRs" checked={allSelected} onChange={() => setSelected(previous => { const next = new Set(previous); for (const row of rows) { if (allSelected) next.delete(row.id); else next.add(row.id) } return next })} /></th>
      {columns.map(([key, label]) => <th key={key} aria-sort={sort === key ? descending ? 'descending' : 'ascending' : 'none'}><button type="button" onClick={() => { setSort(key); setDescending(sort === key ? !descending : false) }}>{label}{sort === key ? descending ? ' ↓' : ' ↑' : ''}</button></th>)}<th>Inspect</th></tr></thead><tbody>
      {rows.map(pull => {
        const context = pullContext(scene, pull, now), detail = currentDetails[pull.id], open = expanded.has(pull.id) || destination?.target.id === pull.id
        const stale = !!error || pull.freshness === 'stale' || detail?.freshness === 'stale' || !!detail && now - Date.parse(detail.observedAt) >= 120_000
        const footprint = footprints[pull.id]?.head === pull.head ? footprints[pull.id] : null
        const linked = context.links.length > 0, associationLabel = linked ? !error && data?.associationsComplete ? 'Confirmed' : 'Last known' : !error && data?.associationsComplete ? 'Unlinked in operational work' : 'Link unknown'
        const subject = { target: { kind: 'pull' as const, id: pull.id, head: pull.head }, label: `${pull.id} · ${pull.title}`, view }
        return <Fragment key={pull.id}><AskSurface subject={subject} data-ask-origin={pull.id} tabIndex={-1} className={`pr-row${open ? ' is-expanded' : ''}${destination?.target.id === pull.id ? ' ask-origin' : ''}`} onClick={event => { if (!(event.target as Element).closest('a,button,input')) inspect(pull) }}>
          <td><input type="checkbox" aria-label={`Select ${pull.id}`} checked={selected.has(pull.id)} onChange={() => toggleSelection(pull.id)} /></td>
          <td {...askElement('repository')} title={pull.repository}>{pull.repository}</td><td className="pr-title"><a {...askElement('title', 'PR title')} href={pull.url} target="_blank" rel="noreferrer">#{pull.number} {pull.title}</a>{pull.state && pull.state !== 'open' && <small {...askElement('status', 'GitHub state')}> {pull.state}</small>}{pull.draft && <small {...askElement('status', 'Draft')}> Draft</small>}{stale && <small> · stale</small>}</td><td {...askElement('author')}>{pull.author}</td>
          <td {...askElement('changes')}>{detail ? <><span className="pr-add">+{detail.additions}</span> <span className="pr-delete">−{detail.deletions}</span> · {detail.files}f</> : <span className="pr-unknown">Unknown</span>}</td><td {...askElement('ci')}>{detail?.checks ?? 'Unknown'}</td><td {...askElement('review')}>{detail?.review ?? 'Unknown'}</td>
          <td {...askElement('updated')} title={`Updated ${pull.updatedAt}; created ${pull.createdAt}`}>{ageLabel(Date.parse(pull.updatedAt), now)} / {ageLabel(Date.parse(pull.createdAt), now)}</td>
          <td {...askElement('relationship')} title={associationLabel}>{context.initiatives.join(', ') || 'Unknown'}</td><td {...askElement('relationship')} title={associationLabel}>{context.epics.join(', ') || 'Unknown'}</td><td {...askElement('worker')}>{context.managers.join(', ') || 'Unknown'}</td><td {...askElement('worker')} title="First Mate PR registration evidence">{context.workerNames.join(', ') || 'Unlinked / unknown'}</td>
          <td className="pr-actions"><AskCardAction subject={subject} icon /><button type="button" className="pr-inspect" aria-label={`Inspect ${pull.id}`} aria-expanded={open} aria-controls={`detail-${pull.id}`} title="Inspect PR" onClick={() => inspect(pull)}><span className="material-symbols-outlined" aria-hidden="true">view_sidebar</span></button></td>
        </AskSurface>{open && <tr><td colSpan={13}><AskSurface as="section" subject={subject} className="pr-detail" id={`detail-${pull.id}`} aria-label={`Details ${pull.id}`}>
          <header><strong {...askElement('title', 'PR title')}>{pull.title}</strong> <a href={pull.url} target="_blank" rel="noreferrer">Open in GitHub ↗</a><button type="button" onClick={() => { void load(pull); void loadFiles(pull) }} disabled={busy.has(pull.id) || fileBusy.has(pull.id)}>Read current detail</button></header>
          <p><span {...askElement('head', 'Head commit')}>{pull.head.slice(0, 12)}</span> → <span {...askElement('base', 'Base branch')}>{pull.base}</span> · <span {...askElement('last_edited', 'Observed')}>observed {ageLabel(Date.parse(pull.observedAt), now)}{stale ? ' · Last known / stale' : ''}</span></p>
          {busy.has(pull.id) && <p role="status">Reading PR description, changes, checks and reviews…</p>}{failures[pull.id] && <p role="alert">{failures[pull.id]}</p>}
          {detail && <><p><span {...askElement('status', 'GitHub state')}>GitHub state: {detail.state}</span> · <span {...askElement('ci')}>CI: {detail.checks}</span> · <span {...askElement('review')}>Review: {detail.review}</span> · <span {...askElement('last_edited', 'Observed')}>observed {ageLabel(Date.parse(detail.observedAt), now)}</span></p>{detail.error && <p role="status">{detail.error}</p>}<pre {...askElement('description')} className="pr-description">{detail.body || 'No PR description.'}</pre>{detail.bodyTruncated && <p>Description shortened. Read the full description on GitHub.</p>}<p><span {...askElement('changes')}>Changes: +{detail.additions} / −{detail.deletions} in {detail.files} files.</span> <a href={`${pull.url}/files`} target="_blank" rel="noreferrer">Read changed files ↗</a></p><details><summary {...askElement('review', 'Observed reviews')}>Observed reviews ({detail.reviews.length}{detail.reviewsComplete ? '' : ', partial'})</summary>{detail.reviews.map((review, index) => <p key={index}><a {...askElement('review', 'Observed review')} href={review.url} target="_blank" rel="noreferrer">{review.author} · {review.state}</a></p>)}<p>Review observations do not establish merge permission or satisfaction of branch policy.</p></details></>}
          {fileBusy.has(pull.id) && <p role="status">Reading GitHub changed files…</p>}{fileErrors[pull.id] && fileErrors[pull.id] !== failures[pull.id] && <p role="alert">{fileErrors[pull.id]} {footprint && 'Retained footprint is last known.'}</p>}
          {footprint && <div {...askElement('changes')}><Footprint key={`${pull.id}@${footprint.head}`} data={fileErrors[pull.id] || now - Date.parse(footprint.observedAt) >= 120_000 ? { ...footprint, freshness: 'stale' } : footprint} /></div>}
          <h2>Linked work · {associationLabel}</h2>{context.links.map(link => { const card = context.cards.find(card => card.id === link.cardId); return <p key={link.cardId}><a {...askElement('relationship')} href={`?card=${link.cardId}`}>{card ? String(card.source.properties.Name?.value ?? card.id) : link.cardId}</a> · {link.sources.join(', ')}{!card && ' · Card context unavailable / unknown'}</p> })}{!linked && <p>No verified operational card association available.</p>}
          <h2>Contributor evidence</h2>{context.contributors.map(contributor => <article {...askElement('worker')} className="pr-contributor" key={contributor.id}>
            <p><strong>{contributor.state}</strong> · worker {contributor.task} · home {contributor.home} · attempt {contributor.attempt ?? 'Unknown'}</p>
            <p>Manager home {contributor.manager || 'Unknown'} ({contributor.managerBasis}) · machine {contributor.machine ?? 'Unknown'} ({contributor.machineBasis})</p>
            <p>Source {contributor.source} · {contributor.freshness} · observed {contributor.observedAt ?? 'Unknown'} · registered head {contributor.registeredHead ? `${contributor.registeredHead.slice(0, 12)} (${contributor.registeredHead === pull.head ? 'matches GitHub' : 'earlier/different from GitHub'})` : 'Unknown'}</p>
            {contributor.claims.map(claim => <p key={claim.id}>{claim.state === 'historical' ? 'Historical' : claim.state === 'last-known' ? 'Last known' : claim.verification === 'confirmed' ? 'Confirmed' : claim.verification === 'conflicting' ? 'Conflicting / unknown' : 'Suggested / unverified'} work: <a {...askElement('relationship')} href={`?card=${claim.cardId}`}>{String(scene?.cards.find(card => card.id === claim.cardId)?.source.properties.Name?.value ?? claim.cardId)}</a> · {claim.sources.join(', ')} · observed {claim.observedAt ?? 'Unknown'}</p>)}
          </article>)}{!context.contributors.length && <p>Worker / manager unknown. No explicit PR registration observed in current or retained backlog sources.</p>}
          <p>Retained backlog registrations can identify retired tasks, but omit attempt, historical manager and machine. Coverage is not a permanent complete contributor index. {scene?.historyScope ?? 'Relationship history unavailable.'}</p>
          <ActionControls targets={[pull]} view={view} compact focusReceipt={destination?.target.kind === 'pull' ? destination.target.action_receipt_id : undefined} />
        </AskSurface></td></tr>}</Fragment>
      })}
    </tbody></table></div>{data && !rows.length && <p className="pr-notice">{data.pulls.length ? 'No matching PRs.' : data.repositories.every(repo => repo.complete) && data.repositories.length ? 'No open PRs in this repository scope.' : 'No PRs observed. Check repository coverage above.'}</p>}
  </section>
}
