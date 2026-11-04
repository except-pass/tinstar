import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Execution, SceneCard } from '../server/reconciliation/scene'
import type { Draft, OutboxMessage, SubmitResult, Worker } from '../cockpit/shell/types'
import { homeName, findLinkedWorker } from '../cockpit/overviewQuery'
import { apiFetch } from '../apiClient'
import { AgentIcon } from '../components/agentIcon'
import { semanticId, ancestorHomes, isPlanned, type FloorScene, type PresentationAction, type PresentationState, type Target } from './presentation'
import { cardTitle, cardStatus, workerTitle, workerState, workerActivity, observedAt, historyRecord, managerName, stale, entityTone, gapTargets, overviewGroups } from './overviewModel'
import { useFloorScene } from './useFloorScene'
import { useDeskQueue } from './useDeskQueue'
import { usePresentation } from './usePresentation'
import { QueuePanel } from './QueuePanel'
import { FloorToolbar } from './FloorToolbar'
import { decisionItems } from '../shared/reconciliationQueue'
import { resolveFloorGroup } from '../shared/floorOrganization'
import { ageLabel, checkIn, taskFields, workBreadcrumb } from './recordFields'
import './overview.css'

type Dispatch = (action: PresentationAction) => void
interface View { scene: FloorScene; state: PresentationState; send: Dispatch; now: number; readFailed: boolean; actionableCardIds: Set<string> }
const target = (kind: Target['kind'], id: string): Target => ({ kind, id })
const same = (a: Target | null, b: Target) => !!a && semanticId(a) === semanticId(b)
const safeUrl = (value: string | null | undefined) => { try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null } }
function workerCount(scene: FloorScene, now: number, readFailed: boolean, workers: Execution[], visible = workers.length, home?: string) {
  const homes = home ? scene.coverage.homes.filter(h => h.source.home === home) : scene.coverage.homes
  const unavailable = readFailed || !homes.length || homes.some(h => stale(h.observation, now) || h.observation.coverage !== 'complete')
  if (unavailable) return workers.length ? `${workers.length} last known workers` : 'Workers unavailable'
  return `${workers.length} workers${visible < workers.length ? ` · ${workers.length - visible} hidden` : ''}`
}
function related(view: View, focus: Target | null, item: Target) {
  const { scene, state, now } = view
  if (!focus) return false
  if (same(focus, item)) return true
  if (focus.kind === 'manager') return item.kind === 'execution' ? scene.executions.some(e => e.id === item.id && ancestorHomes(scene, e.home).includes(focus.id)) :
    scene.claims.some(c => c.cardId === item.id && ancestorHomes(scene, c.accountability.home).includes(focus.id))
  if (focus.kind === 'group') { const group = resolveFloorGroup(scene, state, focus.id, now); return !!group && (item.kind === 'card' ? group.cardIds : group.executionIds).includes(item.id) }
  return scene.claims.some(c => (focus.kind === 'claim' ? c.id === focus.id : focus.kind === 'card' ? c.cardId === focus.id : c.executionId === focus.id) && (item.kind === 'card' ? c.cardId === item.id : c.executionId === item.id))
}
function flashRelated(view: View, item: Target) {
  const { scene, state, now } = view
  if (!state.flash || state.flash.until <= now) return false
  const ids = state.flash.ids
  return ids.includes(semanticId(item)) || scene.claims.some(c => c.verification === 'confirmed' && c.state === 'current' && ids.includes(semanticId(target('claim', c.id))) &&
    (item.kind === 'execution' ? c.executionId === item.id : item.kind === 'card' && c.cardId === item.id)) ||
    ids.filter(id => id.startsWith('group:')).some(id => {
      const group = resolveFloorGroup(scene, state, id.slice('group:'.length), now)
      return !!group && (item.kind === 'execution' ? group.executionIds : item.kind === 'card' ? group.cardIds : []).includes(item.id)
    }) ||
    scene.coverage.homes.some(h => ids.includes(semanticId(target('manager', h.source.home))) && related(view, target('manager', h.source.home), item))
}
function Entity({ view, entity, kind, hover, focus, references }: { view: View; entity: Execution | SceneCard; kind: 'execution' | 'card'; hover: (target: Target | null) => void; focus: Target | null; references: string[] }) {
  const { scene, state, send, now, readFailed } = view, item = target(kind, entity.id)
  const tone = entityTone(scene, kind, entity.id, now, readFailed)
  const worker = kind === 'execution' ? entity as Execution : null, card = kind === 'card' ? entity as SceneCard : null
  const title = worker ? workerTitle(worker) : cardTitle(card!)
  const flashed = flashRelated(view, item)
  const status = worker ? workerState(worker) : cardStatus(card!)
  const lastKnown = worker && (readFailed || stale(worker.observation, now))
  const deskRelated = state.navigation && (card ? card.id === state.navigation.cardId : scene.claims.some(c => c.cardId === state.navigation?.cardId && c.executionId === worker?.id && c.basis === 'explicit' && c.verification === 'confirmed' && c.state === 'current'))
  return <button type="button" className={`ov-item ov-${kind} ov-${tone}${same(state.selection, item) ? ' selected' : ''}${focus && related(view, focus, item) ? ' related' : ''}${deskRelated ? ' desk-target' : ''}${flashed ? ' flashed' : ''}`}
    data-semantic-id={semanticId(item)} data-entity-id={entity.id} data-tone={tone} aria-pressed={same(state.selection, item)} aria-label={`${title}. ${status}${references.length ? `. Also in ${references.join(', ')}` : ''}`} title={title}
    onMouseEnter={() => hover(item)} onMouseLeave={() => hover(null)} onFocus={() => hover(item)} onBlur={() => hover(null)} onClick={() => send({ type: 'focus', target: item })}>
    {worker ? <>
      <span className="ov-worker-top"><span className="ov-face"><AgentIcon seed={JSON.stringify(worker.identity)} color="#00f0ff" className="ov-avatar" /></span><span className={`ov-worker-status status-${status.toLowerCase()}`}>{status}</span></span>
      <strong>{title.replace(/\s*\((?:card|Notion(?: card)?)\s+[a-f0-9-]{32,36}\)/gi, '')}</strong>
      <span className="ov-worker-meta">Machine: {worker.placement.machine ?? 'Unknown'} · Manager: {managerName(scene, worker.home)}</span>
      <span className="ov-activity">{workerActivity(worker) || 'No activity published'}</span>
      <span className="ov-record-foot"><span>Last activity {ageLabel(observedAt(worker), now)}</span>{lastKnown && <span className="ov-freshness">Last known observation</span>}</span>
    </> : <>
      <span className="ov-breadcrumb">{workBreadcrumb(scene, card!)}</span>
      <strong>{title}</strong>
      <span className="ov-task-fields">{taskFields(card!, now, view.actionableCardIds.has(card!.id)).map(([label, value]) => <span key={label} className={label === 'Next check-in' ? `ov-check check-${checkIn(card!, now).state}` : label === 'Status' ? 'ov-task-status' : ['Waiting For', 'Will action'].includes(label) ? 'ov-context-field' : undefined}><span className="ov-field-label">{label}</span> {value}</span>)}</span>
    </>}
    {references.length > 0 && <span className="ov-reference" title={`Same ${kind === 'card' ? 'card' : 'worker'} also in ${references.join(', ')}`} aria-label={`Also in ${references.join(', ')}`}>↗{references.length}</span>}
    <span className="ov-port" aria-hidden="true" />
  </button>
}
function Group({ view, group, hover, focus, allGroups }: { view: View; group: ReturnType<typeof overviewGroups>[number]; hover: (target: Target | null) => void; focus: Target | null; allGroups: ReturnType<typeof overviewGroups> }) {
  const { scene, state, send, now, readFailed } = view
  const body = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<Array<{ id: string; d: string; tone: string; worker?: string; card?: string }>>([])
  const collapsed = state.collapsed.includes(semanticId(target('group', group.id)))
  const ws = group.workers, cards = group.cards
  // Measurement updates local path state; keep its filtered input stable so
  // that update cannot retrigger measurement in a render loop.
  const cs = useMemo(() => state.roadmapExpanded ? cards : cards.filter(c => !isPlanned(scene, c)), [cards, scene, state.roadmapExpanded])
  useLayoutEffect(() => {
    const root = body.current
    if (!root || collapsed || state.linksVisible === false) return
    function draw() {
      if (!root) return
      const box = root.getBoundingClientRect()
      const left = [...root.querySelectorAll<HTMLElement>('.ov-execution')], right = [...root.querySelectorAll<HTMLElement>('.ov-card')]
      const r = new Map(right.map(el => [el.dataset.entityId, el]))
      const next: typeof paths = []
      for (const el of left) {
        const w = el.getBoundingClientRect(), x = w.right - box.left, y = w.top - box.top + w.height / 2
        const claims = scene.claims.filter(c => c.executionId === el.dataset.entityId && r.has(c.cardId))
        for (const c of claims) {
          const dest = r.get(c.cardId)!.getBoundingClientRect(), x2 = dest.left - box.left, y2 = dest.top - box.top + dest.height / 2, dx = (x2 - x) * .55
          const execution = scene.executions.find(e => e.id === c.executionId)
          const confirmed = c.verification === 'confirmed' && c.state === 'current' && !readFailed && !stale(scene.coverage.intentions, now) && execution && !stale(execution.observation, now)
          next.push({ id: c.id, d: `M${x},${y} C${x + dx},${y} ${x2 - dx},${y2} ${x2},${y2}`, tone: confirmed ? 'linked' : 'uncertain', worker: c.executionId, card: c.cardId })
        }
        if (!claims.length && el.dataset.tone === 'orphan') next.push({ id: `w:${el.dataset.entityId}`, d: `M${x},${y} h42`, tone: 'orphan', worker: el.dataset.entityId })
      }
      for (const el of right) if (el.dataset.tone === 'gap') {
        const c = el.getBoundingClientRect(), x = c.left - box.left, y = c.top - box.top + c.height / 2
        next.push({ id: `c:${el.dataset.entityId}`, d: `M${x - 42},${y} H${x}`, tone: 'gap', card: el.dataset.entityId })
      }
      setPaths(next)
    }
    draw()
    const observer = new ResizeObserver(draw); observer.observe(root)
    return () => observer.disconnect()
  }, [scene, ws, cs, collapsed, state.linksVisible, now, readFailed])
  const reference = (kind: 'card' | 'execution', id: string) => allGroups.filter(g => g.id !== group.id && (kind === 'card' ? g.cardIds : g.executionIds).includes(id)).map(g => g.label === g.outerLabel ? g.label : `${g.outerLabel} / ${g.label}`)
  const allWorkers = scene.executions.filter(e => e.kind !== 'secondmate' && !historyRecord(e) && group.executionIds.includes(e.id))
  const workersLabel = workerCount(scene, now, readFailed, allWorkers, collapsed ? 0 : ws.length)
  const gaps = ws.filter(w => entityTone(scene, 'execution', w.id, now, readFailed) === 'orphan').length + cs.filter(c => entityTone(scene, 'card', c.id, now, readFailed) === 'gap').length
  return <section className={`ov-group${flashRelated(view, target('group', group.id)) ? ' flashed' : ''}`} data-group-id={group.id}>
    <header className="ov-group-head"><button type="button" aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${group.label}`} onClick={() => send({ type: 'set-expanded', target: target('group', group.id), expanded: collapsed })}>{collapsed ? '+' : '−'}</button>
      <strong className="ov-group-name">{group.label}</strong>
      <span>{workersLabel}{!cards.length && (readFailed || stale(scene.coverage.intentions, now)) ? ' · Notion unavailable' : ` · ${cards.length}${readFailed || stale(scene.coverage.intentions, now) ? ' last known' : ''} cards`}{gaps > 0 && <em> · {gaps} gaps</em>}</span></header>
    {!collapsed && <div className="ov-group-body" ref={body}>
      <div className="ov-worker-stack">{ws.map(worker => <Entity key={worker.id} view={view} entity={worker} kind="execution" hover={hover} focus={focus} references={reference('execution', worker.id)} />)}{!ws.length && <div className="ov-empty-col">{workersLabel === '0 workers' ? 'No workers in this group' : workersLabel}</div>}</div>
      <div aria-hidden="true" />
      <div className="ov-card-stack">{cs.map(card => <Entity key={card.id} view={view} entity={card} kind="card" hover={hover} focus={focus} references={reference('card', card.id)} />)}{!cs.length && <div className="ov-empty-col">{readFailed || stale(scene.coverage.intentions, now) ? 'Notion unavailable' : cards.length ? 'Waiting & planned hidden' : 'No cards in this group'}</div>}</div>
      {state.linksVisible !== false && <svg className="ov-connections" aria-hidden="true">{paths.map(p => <path key={p.id} d={p.d} className={`ov-line ov-${p.tone}${(!state.navigation || state.navigation.cardId !== p.card || p.tone === 'linked') && state.flash && state.flash.until > now && (state.flash.ids.includes(semanticId(target('claim', p.id))) || !!p.worker && flashRelated(view, target('execution', p.worker)) || !!p.card && flashRelated(view, target('card', p.card))) ? ' flashed' : ''}${state.navigation?.cardId === p.card && p.tone === 'linked' ? ' desk-target' : ''}${focus ? (focus.kind === 'card' ? p.card === focus.id : focus.kind === 'execution' ? p.worker === focus.id : focus.kind === 'claim' ? p.id === focus.id : !!p.worker && related(view, focus, target('execution', p.worker))) ? ' hot' : ' dim' : ''}`} />)}</svg>}
    </div>}
  </section>
}
function Inspector({ view, workers }: { view: View; workers: Worker[] }) {
  const { scene, state, send, now, readFailed } = view, selection = state.selection
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (selection) close.current?.focus({ preventScroll: true }) }, [selection])
  const selectedCardId = selection?.kind === 'card' ? selection.id : null
  const [context, setContext] = useState<{ outcome?: string; blocks?: Array<{ id: string; text: string }> } | null>(null)
  useEffect(() => {
    setContext(null)
    if (!selectedCardId) return
    const controller = new AbortController()
    void apiFetch(`/api/reconciliation/card-context?id=${encodeURIComponent(selectedCardId)}`, { signal: controller.signal })
      .then(res => res.json()).then(body => { if (!controller.signal.aborted) setContext(body.ok ? body.data : { outcome: 'unavailable' }) })
      .catch(() => { if (!controller.signal.aborted) setContext({ outcome: 'unavailable' }) })
    return () => controller.abort()
  }, [selectedCardId])
  if (!selection) return null
  const claim = [...scene.claims, ...scene.claimHistory].find(c => selection.kind === 'claim' && c.id === selection.id)
  const execution = scene.executions.find(e => e.id === (claim?.executionId ?? (selection.kind === 'execution' ? selection.id : '')))
  const card = scene.cards.find(c => c.id === (claim?.cardId ?? (selection.kind === 'card' ? selection.id : '')))
  const home = scene.coverage.homes.find(h => h.source.home === (selection.kind === 'manager' ? selection.id : execution?.home))
  const group = selection.kind === 'group' ? resolveFloorGroup(scene, state, selection.id, now) : undefined
  const matches = workers.filter(w => w.home === execution?.home && w.id === execution?.identity.task_id)
  const worker = matches.length === 1 ? matches[0] : null
  const route = worker ? { worker: worker.id, home: homeName(worker.home), key: null, q: '' } : null
  const terminal = worker?.terminalAvailable && route && findLinkedWorker(workers, route)?.key === worker.key ? `?${new URLSearchParams({ worker: route.worker, home: route.home })}` : null
  const claims = [...scene.claims, ...scene.claimHistory].filter(c => card ? c.cardId === card.id : execution ? c.executionId === execution.id : c.id === claim?.id)
  const backlog = scene.backlog.filter(entry => card && entry.source.cardReferences.some(ref => ref.pageId === card.id))
  const findings = scene.findings.filter(f => card ? f.cardIds.includes(card.id) : execution ? f.executionIds.includes(execution.id) : home ? f.homeIds.includes(home.source.home) : false)
  return <section className="ov-inspector" aria-label="Inspector">
    <header><h2>Inspector</h2><button type="button" className="ov-back" ref={close} onClick={() => send({ type: 'clear-selection' })}>Close Inspector</button></header>
    <small className="ov-eyebrow">{card ? 'Notion card' : execution ? 'Worker' : home ? 'Manager' : 'Overview'}</small>
    <h3>{card ? cardTitle(card) : execution ? workerTitle(execution) : home ? managerName(scene, home.source.home) : group?.label ?? (selection.kind === 'firstMate' ? 'First Mate' : 'Selected record unavailable')}</h3>
    {execution && <><p>{execution.placement.machine ?? 'Unknown machine'} · {workerState(execution)}</p><p>Manager: {managerName(scene, execution.home)} · Last activity {ageLabel(observedAt(execution), now)}{(readFailed || stale(execution.observation, now)) && ' · Last known observation'}</p><h4>Latest activity</h4><p>{String(execution.source.last_event.note ?? execution.source.lastEventText ?? 'No report published')}</p>{terminal && <a href={terminal} target="_blank" rel="noreferrer">Open worker terminal ↗</a>}</>}
    {card && <><p className="ov-breadcrumb">{workBreadcrumb(scene, card)}</p><dl className="ov-detail-fields">{taskFields(card, now).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p>{card.nextAction ?? (backlog.some(entry => entry.source.hold_reason) ? 'Waiting on a prerequisite' : card.expectationReason)}</p>{backlog.map(entry => <p key={entry.id}>{[entry.source.hold_reason, entry.source.blocked_by && `Blocked by ${entry.source.blocked_by}`, entry.source.hold_until && `Until ${entry.source.hold_until}`].filter(Boolean).join(' · ')}</p>)}{safeUrl(card.source.url) && <a href={safeUrl(card.source.url)!} target="_blank" rel="noreferrer">Open Notion card ↗</a>}<h4>Full card</h4>{['available', 'partial'].includes(context?.outcome ?? '') ? <>{context?.blocks?.map(block => <p key={block.id}>{block.text}</p>)}{context?.outcome === 'partial' && <p>Some content omitted. Use the Notion source link for the full card.</p>}</> : <p>{context ? 'Card body unavailable. Use the Notion source link.' : 'Reading card…'}</p>}
      {card.parentIds.map(id => <button key={id} type="button" disabled={!scene.cards.some(c => c.id === id)} onClick={() => send({ type: 'focus', target: target('card', id) })}>Parent: {scene.cards.find(c => c.id === id) ? cardTitle(scene.cards.find(c => c.id === id)!) : 'Unavailable'}</button>)}</>}
    {home && <><p>{workerCount(scene, now, readFailed, scene.executions.filter(e => e.kind !== 'secondmate' && !historyRecord(e) && e.home === home.source.home), state.collapsed.includes(semanticId(target('manager', home.source.home))) ? 0 : undefined, home.source.home)} · {home.source.machine ?? 'Unknown machine'}</p><button type="button" onClick={() => send({ type: 'set-expanded', target: target('manager', home.source.home), expanded: state.collapsed.includes(semanticId(target('manager', home.source.home))) })}>{state.collapsed.includes(semanticId(target('manager', home.source.home))) ? 'Expand' : 'Collapse'} workers</button></>}
    {group && <><p>{group.cardIds.length} cards · {workerCount(scene, now, readFailed, scene.executions.filter(e => e.kind !== 'secondmate' && !historyRecord(e) && group.executionIds.includes(e.id)))}</p><details><summary>Epics & parents</summary>{scene.cards.filter(c => group.cardIds.includes(c.id) && (c.parentIds.length || scene.cards.some(child => child.parentIds.includes(c.id)))).map(c => <div key={c.id} className="ov-related"><button type="button" onClick={() => send({ type: 'focus', target: target('card', c.id) })}>{cardTitle(c)}</button>{c.parentIds.length > 0 && <small>Parent: {c.parentIds.map(id => scene.cards.find(parent => parent.id === id)).map(parent => parent ? cardTitle(parent) : 'Unavailable').join(', ')}</small>}</div>)}</details></>}
    {selection.kind === 'firstMate' && <><p>Supervising the configured managers.</p>{scene.coverage.homes.map(h => <div key={h.source.home} className="ov-related"><button type="button" onClick={() => send({ type: 'focus', target: target('manager', h.source.home) })}>{managerName(scene, h.source.home)}</button></div>)}</>}
    {claims.length > 0 && <><h4>Connections & history</h4>{claims.map(c => <div className="ov-related" key={c.id}><small>{c.state === 'historical' ? 'History' : c.verification === 'confirmed' && c.state === 'current' ? 'Linked' : 'Unverified'}</small><button type="button" disabled={!scene.cards.some(card => card.id === c.cardId)} onClick={() => send({ type: 'focus', target: target('card', c.cardId) })}>{scene.cards.find(card => card.id === c.cardId) ? cardTitle(scene.cards.find(card => card.id === c.cardId)!) : 'Card unavailable'}</button><button type="button" disabled={!scene.executions.some(e => e.id === c.executionId)} onClick={() => send({ type: 'focus', target: target('execution', c.executionId) })}>{scene.executions.find(e => e.id === c.executionId) ? workerTitle(scene.executions.find(e => e.id === c.executionId)!) : 'Worker history'}</button></div>)}</>}
    <h4>Activity history</h4>{execution && <p>{execution.source.last_event.note ?? 'No activity report published'} · {ageLabel(observedAt(execution), now)}</p>}{card && <p>Edited {ageLabel(Date.parse(card.source.last_edited_time), now)}</p>}{claims.map(c => <p key={c.id}>{c.state === 'historical' ? 'Connection ended' : 'Connection observed'} · {c.endedAt ?? c.observedAt ?? 'Time unknown'}</p>)}
    <details><summary>Evidence & diagnostics</summary><pre>{JSON.stringify({ selection, execution, card, home, group, findings, backlog, claims, historyScope: scene.historyScope }, null, 2)}</pre></details>
  </section>
}
export function Overview({ workers, submit, messages }: { messages: OutboxMessage[]; workers: Worker[]; submit: (draft: Draft) => Promise<SubmitResult> }) {
  const { scene, error, now } = useFloorScene(), { queue, error: queueError } = useDeskQueue()
  const { state, send, connection, bridgeError } = usePresentation(scene, queue, !!error)
  const [hovered, setHovered] = useState<Target | null>(null), [diagnosticsRevision, setDiagnosticsRevision] = useState<number | null>(null)
  const diagnostics = diagnosticsRevision === state.revision
  const setDiagnostics = (open: boolean) => setDiagnosticsRevision(open ? state.revision : null)
  const [deskMobile, setDeskMobile] = useState(false)
  const root = useRef<HTMLDivElement>(null), previousSelection = useRef<string | null>(null)
  const deskPanel = useRef<HTMLElement>(null), previousDeskOpen = useRef(false)
  const selectedId = state.selection ? semanticId(state.selection) : null
  useEffect(() => {
    const mobile = typeof window.matchMedia === 'function' && window.matchMedia('(max-width:850px)').matches
    if (mobile && deskMobile && !previousDeskOpen.current) deskPanel.current?.querySelector<HTMLButtonElement>('.ov-mobile-close')?.focus({ preventScroll: true })
    if (mobile && !deskMobile && previousDeskOpen.current && !selectedId && !root.current?.querySelector('.ov-card:focus')) root.current?.querySelector<HTMLButtonElement>('.ov-mobile-desk')?.focus({ preventScroll: true })
    previousDeskOpen.current = deskMobile
  }, [deskMobile, selectedId])
  useEffect(() => { setHovered(null) }, [state.revision])
  const groups = useMemo(() => scene ? overviewGroups(scene, state, now, !!error) : [], [scene, state, now, error])
  useEffect(() => {
    const id = selectedId ?? previousSelection.current
    previousSelection.current = selectedId
    if (state.queueOpen && !selectedId) setDeskMobile(true)
    if (!id) return
    const element = [...root.current?.querySelectorAll<HTMLElement>('[data-semantic-id]') ?? []].find(el => el.dataset.semanticId === id)
    element?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    if (!selectedId) element?.focus({ preventScroll: true })
  }, [selectedId, state.selection, state.arrangement, state.collapsed, state.queueOpen, state.queueItemId])
  useEffect(() => {
    if (!state.navigation) return
    const element = [...root.current?.querySelectorAll<HTMLElement>('.ov-card') ?? []].find(el => el.dataset.entityId === state.navigation?.cardId)
    if (!element) return
    setDeskMobile(false)
    // Expand and reveal have committed. Land immediately so a second input or
    // Desk focus restoration cannot interrupt an in-flight native scroll.
    element.scrollIntoView({ block: 'center', behavior: 'instant' })
    element.focus({ preventScroll: true })
  }, [state.navigation])
  if (!scene) return <section className="ov-loading"><h1>Overview</h1><p role="status">{error ? 'Sources unavailable · Retrying' : 'Reading workers and Notion cards…'}</p></section>
  const view: View = { scene, state, send, now, readFailed: !!error, actionableCardIds: new Set(queue && !queueError ? decisionItems(queue, now).flatMap(item => item.cardIds) : []) }
  const gaps = gapTargets(scene, now, !!error)
  const notionUnavailable = !!error || stale(scene.coverage.intentions, now)
  const fleetDelayed = !!error || !scene.coverage.homes.length || scene.coverage.homes.some(h => stale(h.observation, now) || h.observation.coverage !== 'complete')
  const checksSuspended = notionUnavailable || fleetDelayed || scene.coverage.absenceConclusions === 'suppressed'
  const liveWorkers = scene.executions.filter(e => e.kind !== 'secondmate' && !historyRecord(e))
  const history = scene.executions.filter(e => e.kind !== 'secondmate' && historyRecord(e))
  return <div ref={root} className="ov" data-arrangement={state.arrangement} data-outer={state.organizer?.outer} data-inner={state.organizer?.inner} data-order={state.organizer?.order} data-direction={state.organizer?.direction} data-preset={state.statusFilter?.preset} data-revision={state.revision} data-scene-id={connection?.scene_id} onKeyDown={e => { if (e.key === 'Escape') { send({ type: 'clear-selection' }); send({ type: 'close-queue' }); send({ type: 'clear-transient' }); setDeskMobile(false); setDiagnostics(false) } }}>
    <header className="ov-top"><div><b>TIN STAR</b><small>OVERVIEW</small></div><button type="button" className={checksSuspended ? 'ov-warning' : 'ov-signal'} onClick={() => { setDiagnostics(!diagnostics); setDeskMobile(true) }}>{notionUnavailable ? 'Notion unavailable' : fleetDelayed ? 'Workers need a refresh' : checksSuspended ? 'Coverage incomplete' : 'Sources connected'} · Details</button></header>
    <div className="ov-columns"><div className="ov-main">
      <div className="ov-intro"><h1>Overview</h1><span>{workerCount(scene, now, !!error, liveWorkers, new Set(groups.flatMap(g => g.workers.map(w => w.id))).size)}{!notionUnavailable && <> · {new Set(groups.flatMap(g => g.cards.map(c => c.id))).size} Notion cards</>}{gaps.length > 0 && <> · {gaps.length} gaps</>}</span></div>
      <FloorToolbar scene={scene} state={state} send={send} gaps={gaps} />
      {state.assistantChangedView && <div className="ov-cue" role="status">Assistant changed this view <button type="button" onClick={() => send({ type: 'clear-transient' })}>×</button></div>}
      <div className="ov-workspace"><div className="ov-headings"><span>Workers</span><small>LINKS</small><span>Notion cards</span></div>
        {[...new Set(groups.map(g => g.outerId))].map(outerId => {
          const children = groups.filter(g => g.outerId === outerId), first = children[0]!
          const nested = state.organizer?.inner !== 'none' && !!state.organizer
          if (!nested) return <Group key={first.id} view={view} group={first} allGroups={groups} hover={setHovered} focus={hovered ?? state.selection} />
          const collapsed = state.collapsed.includes(semanticId(target('group', outerId)))
          return <section className="ov-outer" key={outerId} data-outer={first.outerLabel}><header className="ov-group-head"><button type="button" aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${first.outerLabel}`} onClick={() => send({ type: 'set-expanded', target: target('group', outerId), expanded: collapsed })}>{collapsed ? '+' : '−'}</button><strong>{first.outerLabel}</strong><span>{new Set(children.flatMap(g => g.workers.map(w => w.id))).size} workers · {new Set(children.flatMap(g => g.cards.map(c => c.id))).size} cards</span></header>
            {!collapsed && <div className="ov-inner">{children.map(group => <Group key={group.id} view={view} group={group} allGroups={groups} hover={setHovered} focus={hovered ?? state.selection} />)}</div>}
          </section>
        })}
        {!groups.length && <p className="ov-empty">{state.exceptionsOnly ? checksSuspended ? 'Gap checks suspended until observations are complete.' : 'No confirmed gaps in this scope.' : fleetDelayed ? 'Workers unavailable' : 'No current records observed in this scope.'}</p>}
        {history.length > 0 && <details className="ov-history"><summary>Worker history · {history.length}</summary>{history.map(e => <button type="button" key={e.id} onClick={() => send({ type: 'focus', target: target('execution', e.id) })}>{workerTitle(e)} · {workerState(e)}</button>)}</details>}
      </div>
    </div><aside ref={deskPanel} className={`ov-desk${deskMobile ? ' mobile-open' : ''}`} aria-label="Your desk"><header><small className="ov-eyebrow">YOU / ONE INBOX</small><h2>Your desk</h2><button type="button" className="ov-mobile-close" onClick={() => { send({ type: 'clear-selection' }); send({ type: 'close-queue' }); setDiagnostics(false); setDeskMobile(false) }}>Close</button></header>
      {diagnostics ? <section className="ov-inspector"><button type="button" className="ov-back" onClick={() => setDiagnostics(false)}>← Your desk</button><h3>Source health</h3><p>{notionUnavailable ? 'Notion unavailable. Last known cards remain visible; absence checks are suspended.' : 'Notion connected.'}</p>{fleetDelayed && <p>Some worker observations are unavailable or incomplete. Last known workers remain visible.</p>}{checksSuspended && <p>Gap checks are suspended until the required observations can be verified.</p>}<p>{bridgeError ? 'Assistant connection unavailable.' : 'Assistant connected.'}</p><pre>{JSON.stringify({ coverage: scene.coverage, warnings: scene.warnings, error }, null, 2)}</pre></section> : null}<div><QueuePanel scene={scene} messages={messages} submit={submit} workers={workers} state={state} send={send} queue={queue} error={queueError} now={now} /></div>
    </aside></div>{state.selection && <Inspector view={view} workers={workers} />}<button type="button" className="ov-mobile-desk" onClick={() => { setDiagnostics(false); send({ type: 'open-queue' }); setDeskMobile(true) }}>Your desk</button>
  </div>
}
