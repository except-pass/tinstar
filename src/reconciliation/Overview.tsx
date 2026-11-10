import { SessionConnection } from './SessionConnection'
import { externalWorkers, type StartWorkResult } from '../shared/workflow'
import { WorkActions } from './WorkActions'
import { StartWork } from './StartWork'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Execution, SceneCard } from '../server/reconciliation/scene'
import type { Worker } from '../cockpit/shell/types'
import { homeName, findLinkedWorker } from '../cockpit/overviewQuery'
import { apiFetch } from '../apiClient'
import { AgentIcon } from '../components/agentIcon'
import { semanticId, ancestorHomes, isPlanned, type FloorScene, type PresentationAction, type PresentationState, type Target } from './presentation'
import { cardTitle, cardStatus, workerTitle, workerState, workerActivity, activityTimestamp, reportTimestamp, historyRecord, managerName, stale, entityTone, gapTargets, overviewGroups, workerSourceCoverage, relevantWorkerHomes, workerSummary, workerAbsenceLabel, emptyWorkerScopeLabel, workerCoverageNotice, unreadableWorkerHomes, expandedRelationships, canonicalOverviewGroups, tasksByWorkerPosition } from './overviewModel'
import { workerFact as recordedWorkerFact } from '../shared/workerEvidence'
import { cardWorkerFact, patternCheckSummary, workerLinkSourceHealth } from './overviewEvidence'
import { FloorToolbar } from './FloorToolbar'
import { SmartSearch } from './SmartSearch'
import { directNeighbors, hasSearch, searchSeeds, targetKey } from '../shared/smartSearch'
import { decisionItems } from '../shared/reconciliationQueue'
import { hasDonutFilter } from '../shared/floorStatus'
import { resolveFloorGroup, floorFields } from '../shared/floorOrganization'
import { ageLabel, checkIn, taskFields, workBreadcrumb, workerBreadcrumb, propertyText, propertyDate, compactCheckIn } from './recordFields'
import { CompactConnections } from './CompactConnections'
import { saveOverviewDensity } from './overviewDensity'
import { WaitingForWork } from './WaitingForWork'
import { waitingForActive, waitingForGroups, waitingForIssue, readWaitingForExpansion, saveWaitingForExpansion, type WaitingForType } from './waitingFor'
import './overview.css'
import './waitingFor.css'
import './overviewActions.css'
import { SwipeReveal } from '../ask/SwipeReveal'
import { AskSurface } from '../ask/AskSurface'
import { askElement } from '../ask/element'
import { useElementAsk } from '../ask/useElementAsk'
import { AskContextComposer, AskCardAction, useCardAsk, useSemanticAsk, AskRelationshipHit, useAskControls } from '../ask/Ask'
import { combinedPatternResult, sceneWorkHealth, patternEmptyText, type PatternResult } from '../shared/workHealth'

import { useDeskWorkspace } from '../ask/DeskWorkspace'
import { OpenInChatGPT } from '../ask/OpenInChatGPT'
import { checkInIndicatorText } from '../shared/checkIn'

type Dispatch = (action: PresentationAction) => void
interface View { restoringSearch?: boolean; scene: FloorScene; state: PresentationState; send: Dispatch; now: number; readFailed: boolean; actionableCardIds: Set<string>; patternResults?: ReadonlyMap<string, PatternResult>; searchMatches?: ReadonlySet<string>; detailed?: { collapsed: string[]; toggle: (item: Target) => void }; compact?: { expanded: ReadonlySet<string>; toggle: (item: Target) => void; roots: readonly Target[] } }
const target = (kind: Target['kind'], id: string): Target => ({ kind, id })
const same = (a: Target | null, b: Target) => !!a && semanticId(a) === semanticId(b)
const safeUrl = (value: string | null | undefined) => { try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null } }
const copyFeedbackMs = 1600
async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch { /* clipboard can reject without permission; the selection fallback still copies */ }
  const previousFocus = document.activeElement
  const area = document.createElement('textarea')
  try {
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true })
  }
}
function CopyNotionLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => { setCopied(false) }, [url])
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), copyFeedbackMs)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault()
    event.stopPropagation()
    void copyText(url).then(ok => { if (ok) setCopied(true) })
  }
  return <button type="button" className="ov-copy-link" onClick={copy} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') copy(event) }}>
    <span className="material-symbols-outlined" aria-hidden="true">content_copy</span>
    <span aria-live="polite">{copied ? 'Copied' : 'Copy link'}</span>
  </button>
}
function homeFreshness(observation: { status: string; coverage: string; observedAt: string | null; expiresAt: string | null }, now: number) {
  const expired = !!observation.expiresAt && Date.parse(observation.expiresAt) <= now
  return `${expired ? 'stale' : observation.status}/${expired ? 'unknown' : observation.coverage} · ${ageLabel(Date.parse(observation.observedAt ?? ''), now)}`
}
function related(view: View, focus: Target | null, item: Target) {
  const { scene, state, now } = view
  if (!focus) return false
  if (same(focus, item)) return true
  if (focus.kind === 'manager') return item.kind === 'execution' ? scene.executions.some(e => e.id === item.id && ancestorHomes(scene, e.home).includes(focus.id)) :
    scene.claims.some(c => c.cardId === item.id && ancestorHomes(scene, c.accountability.home).includes(focus.id))
  if (focus.kind === 'group') { const group = resolveFloorGroup(scene, state, focus.id, now); return !!group && (item.kind === 'card' ? group.cardIds : group.executionIds).includes(item.id) }
  return scene.claims.some(c => (!view.compact || c.basis === 'explicit' && c.verification === 'confirmed' && c.state === 'current') && (focus.kind === 'claim' ? c.id === focus.id : focus.kind === 'card' ? c.cardId === focus.id : c.executionId === focus.id) && (item.kind === 'card' ? c.cardId === item.id : c.executionId === item.id))
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
  const subject = kind === 'card' ? { cardId: entity.id } : { target: { kind: 'execution' as const, id: entity.id } }
  const ask = useSemanticAsk(subject)
  const askRoot = useRef<HTMLDivElement>(null), askControls = useAskControls()
  const elementAffordance = useElementAsk(askRoot, subject, askControls?.open)
  const openInInspector = () => send({ type: 'focus', target: item })
  const askGesture = useCardAsk(subject, openInInspector)
  const tone = entityTone(scene, kind, entity.id, now, readFailed)
  const worker = kind === 'execution' ? entity as Execution : null, card = kind === 'card' ? entity as SceneCard : null
  const title = worker ? workerTitle(worker) : cardTitle(card!)
  const compact = view.compact, expanded = compact ? compact.expanded.has(semanticId(item)) : !view.detailed?.collapsed.includes(semanticId(item))
  const toggle = () => compact ? compact.toggle(item) : view.detailed?.toggle(item)
  const openRoot = compact?.roots.some(root => same(root, item))
  const links = scene.claims.filter(c => (worker ? c.executionId === worker.id : c.cardId === card!.id))
  const confirmedLinks = links.filter(c => c.basis === 'explicit' && c.verification === 'confirmed' && c.state === 'current')
  const linkLabel = card || confirmedLinks.length ? '' : links.length ? 'Link unverified' : readFailed || stale(scene.coverage.intentions, now) ? 'Notion unavailable' : 'No linked task'
  const workerFact = card ? cardWorkerFact(scene, card.id, now, readFailed) : null
  const flashed = flashRelated(view, item)
  const fact = worker ? recordedWorkerFact(worker, now, scene.coverage.homes.find(home => home.source.home === worker.home)?.observation, readFailed) : null
  const status = fact ? fact[0]!.toUpperCase() + fact.slice(1) : cardStatus(card!)
  const priority = card ? propertyText(card, 'Priority').replace(/^[^\p{L}\p{N}]+/u, '') : ''
  const nextCheckIn = card ? askElement('next_check_in', `${compactCheckIn(card, now)} · Next check-in ${checkIn(card, now).label.replace(/^Overdue · /, '')}${propertyDate(card, 'Next check-in')?.includes('T') ? ' ET' : ''}`, propertyDate(card, 'Next check-in') ?? '', checkIn(card, now).state === 'overdue' ? 'overdue' : 'check-in') : null
  const lastKnown = worker && (readFailed || stale(worker.observation, now))
  const deskRelated = state.navigation && (card ? card.id === state.navigation.cardId : scene.claims.some(c => c.cardId === state.navigation?.cardId && c.executionId === worker?.id && c.basis === 'explicit' && c.verification === 'confirmed' && c.state === 'current'))
  return <div ref={askRoot} className="ov-item-frame" onContextMenu={event => ask(event)}><SwipeReveal state={askGesture.rail}><button ref={askGesture.ref} type="button" className={`ov-item ov-${kind} ov-${tone}${view.searchMatches && !view.searchMatches.has(semanticId(item)) ? ' ov-search-context' : view.searchMatches ? ' ov-search-match' : ''}${same(state.selection, item) ? ' selected' : ''}${focus && related(view, focus, item) ? ' related' : ''}${deskRelated ? ' desk-target' : ''}${flashed ? ' flashed' : ''}${expanded ? compact ? ' ov-inline-expanded' : '' : ' ov-collapsed'}`}
    data-semantic-id={semanticId(item)} data-entity-id={entity.id} data-tone={tone} data-open-root={compact ? !!openRoot : undefined} aria-expanded={expanded} aria-label={`${title}. ${status}. ${(compact ? openRoot : expanded) ? 'Collapse' : 'Expand'} ${compact ? 'relationship' : 'card'}${workerFact ? `. ${workerFact}` : compact && linkLabel ? `. ${linkLabel}` : ''}${lastKnown ? '. Last known observation' : ''}${references.length ? `. Also in ${references.join(', ')}` : ''}`} title={title}
    onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle() } }}
    onMouseEnter={() => hover(item)} onMouseLeave={() => hover(null)} onFocus={() => hover(item)} onBlur={() => hover(null)} onClick={toggle}>
    {!expanded && <><span className="ov-tiny-glyph" aria-hidden="true">{worker ? '◇' : '▤'}</span><strong {...askElement('title', 'Title', title)}>{title}</strong><span {...(card && checkIn(card, now).state === 'overdue' ? nextCheckIn : askElement('status', 'Status', status))} className={`ov-compact-status ${worker ? `status-${workerState(worker, now).toLowerCase().replace(/ /g, '-')}` : checkIn(card!, now).state === 'overdue' ? 'check-overdue' : /waiting/i.test(status) ? 'status-waiting' : ''}`}>{card && checkIn(card, now).state === 'overdue' ? compactCheckIn(card, now) : status}{lastKnown ? ' · Last known' : ''}</span>{(workerFact || linkLabel) && <span {...askElement('relationship', 'Task link')} className={`ov-link-label${workerFact ? ' ov-worker-fact' : ''}`} title={workerFact || linkLabel}>{workerFact || linkLabel}</span>}<span className="ov-full-title">{title}</span></>}
    {expanded && (worker ? <>
      <span className="ov-face"><AgentIcon seed={JSON.stringify(worker.identity)} color="#63cfb0" className="ov-avatar" /></span>
      <span className="ov-record-top"><span {...askElement('relationship', 'Initiative / epic')} className="ov-breadcrumb">{workerBreadcrumb(scene, worker)}</span><span {...askElement('status', 'Status', status)} className={`ov-worker-status status-${workerState(worker, now).toLowerCase().replace(/ /g, '-')}`}><i />{status}</span></span>
      <strong {...askElement('title', 'Title', title)}>{title.replace(/\s*\((?:card|Notion(?: card)?)\s+[a-f0-9-]{32,36}\)/gi, '')}</strong>
      <span {...askElement('worker', 'Worker placement')} className="ov-worker-meta">▣ {worker.placement.machine ?? 'Unknown'} · <span className="ov-home-tag">{managerName(scene, worker.home)}</span></span>
      <span className="ov-record-foot"><span {...askElement('worker', 'Worker activity')} className="ov-activity" title={workerActivity(worker)}>⌁ {workerActivity(worker) || 'No activity published'}</span><span {...askElement('last_edited', 'Observed')} className="ov-age">{lastKnown && <span className="ov-freshness" title="Last known observation" aria-label="Last known observation">◌ </span>}{worker.source.codex?.last_activity_at ? 'Last activity ' : ''}{ageLabel(activityTimestamp(worker), now)}</span></span>
    </> : <>
      <span className="ov-record-top"><span {...askElement('relationship', 'Initiative / epic')} className="ov-breadcrumb">{workBreadcrumb(scene, card!)}</span><span {...askElement('priority', 'Priority', propertyText(card!, 'Priority'))} className={`ov-priority priority-${priority.replace(/[^a-z]/gi, '').toLowerCase()}`} title={`${propertyText(card!, 'Priority')}. Right-click or long-press to ask.`}>{priority}</span></span>
      <strong {...askElement('title', 'Title', title)}>{title}</strong>
      <span className="ov-task-meta"><span {...askElement('status', 'Status', status)} className={`ov-task-status task-${status.toLowerCase().replace(/[^a-z]/g, '-')}`}><i />{status}</span>{workerFact && <span className="ov-link-label ov-worker-fact" title={workerFact}>{workerFact}</span>}<span className="ov-owner" {...askElement('owner', 'Owner', propertyText(card!, 'Owner') || 'Unassigned')}>♙ {propertyText(card!, 'Owner') || 'Unassigned'}</span></span>
      <span className="ov-record-foot"><span {...nextCheckIn} className={`ov-check check-${checkIn(card!, now).state}`} title={`Next check-in: ${checkIn(card!, now).label}. Right-click or long-press to ask.`}>◷ {compactCheckIn(card!, now)}</span><span className="ov-age" {...askElement('last_edited', 'Last edited', card!.source.last_edited_time)} title={`Last touched by ${propertyText(card!, 'Last touched by') || 'Unknown'}. Right-click or long-press to ask.`}>Edited {ageLabel(Date.parse(card!.source.last_edited_time), now)}</span></span>
      {taskFields(card!, now, view.actionableCardIds.has(card!.id)).filter(([label]) => ['Due Date', 'Waiting For', 'Will action'].includes(label)).map(([label, value]) => <span key={label} {...askElement(label === 'Waiting For' ? 'waiting_for' : label === 'Due Date' ? 'due_date' : 'will_action', label, value)} className="ov-context-field" title={`${label}: ${value}. Right-click or long-press to ask.`}>{label}: {value}</span>)}
    </>)}
    {card?.checkInRequest && <span className="ov-context-field ov-check-in-request" title={`Original overdue check-in: ${card.checkInRequest.originalCheckpoint}; request ${card.checkInRequest.requestId}`}>{checkInIndicatorText(card.checkInRequest)} · Original check-in {card.checkInRequest.originalCheckpoint}</span>}
    {compact && expanded && <span {...askElement('relationship', 'Relationship view')} className="ov-expansion-hint">{openRoot ? '− Collapse this relationship' : '+ Expand this relationship'}</span>}
    {references.length > 0 && <span className="ov-reference" title={`Same ${kind === 'card' ? 'card' : 'worker'} also in ${references.join(', ')}`} aria-label={`Also in ${references.join(', ')}`}>↗{references.length}</span>}
    <span className="ov-port" aria-hidden="true" />
  </button>
    <span className="ov-header-actions"><AskCardAction subject={subject} icon />{card && <OpenInChatGPT target={{ kind: 'work', card, scene, readFailed }} />}<button type="button" className="ov-open-inspector ov-header-icon" aria-label="Open in Inspector" title="Open in Inspector" onClick={event => { event.stopPropagation(); openInInspector() }} onKeyDown={event => { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); event.stopPropagation(); openInInspector() }}>
      <svg aria-hidden="true" viewBox="0 0 20 20"><rect x="2" y="3" width="16" height="14" rx="1" /><path d="M12 3v14" /></svg>
    </button></span></SwipeReveal>{elementAffordance}
  </div>
}
export function Group({ view, group, hover, focus, allGroups, workersOnly = false }: { workersOnly?: boolean; view: View; group: ReturnType<typeof overviewGroups>[number]; hover: (target: Target | null) => void; focus: Target | null; allGroups: ReturnType<typeof overviewGroups> }) {
  const { scene, state, send, now, readFailed } = view
  const body = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<Array<{ id: string; d: string; tone: string; worker?: string; card?: string }>>([])
  const collapsed = state.collapsed.includes(semanticId(target('group', group.id)))
  const ws = group.workers, cards = group.cards
  // Measurement updates local path state; keep its filtered input stable so
  // that update cannot retrigger measurement in a render loop.
  const cs = useMemo(() => tasksByWorkerPosition(ws, state.roadmapExpanded ? cards : cards.filter(c => !isPlanned(scene, c)), scene.claims), [ws, cards, scene, state.roadmapExpanded])
  const rows = useMemo(() => {
    const workerIds = new Set(ws.map(w => w.id)), cardIds = new Set(cs.map(c => c.id))
    const links = scene.claims.filter(c => c.state !== 'historical' && workerIds.has(c.executionId) && cardIds.has(c.cardId))
    const linkedWorkers = new Set(links.map(c => c.executionId)), linkedCards = new Set(links.map(c => c.cardId))
    const result: Array<{ workers: Execution[]; cards: SceneCard[] }> = []
    let wi = 0, ci = 0
    while (wi < ws.length || ci < cs.length) {
      const worker = ws[wi], card = cs[ci]
      if (worker && !linkedWorkers.has(worker.id)) { result.push({ workers: [worker], cards: [] }); wi++ }
      else if (card && !linkedCards.has(card.id)) { result.push({ workers: [], cards: [card] }); ci++ }
      else {
        result.push({ workers: worker ? [worker] : [], cards: card ? [card] : [] })
        if (worker) wi++
        if (card) ci++
      }
    }
    return result
  }, [ws, cs, scene.claims])
  useLayoutEffect(() => {
    const root = body.current
    if (!root || collapsed || state.linksVisible === false || view.compact) return
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

      }
      setPaths(next)
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(root)
    root.querySelectorAll('.ov-item').forEach(element => observer.observe(element))
    return () => observer.disconnect()
  }, [scene, ws, cs, collapsed, state.linksVisible, now, readFailed, view.compact])
  const reference = (kind: 'card' | 'execution', id: string) => allGroups.filter(g => g.id !== group.id && (kind === 'card' ? g.cardIds : g.executionIds).includes(id)).map(g => g.label === g.outerLabel ? g.label : `${g.outerLabel} / ${g.label}`)
  const workerHomes = relevantWorkerHomes(scene, state.organizer, group)
  const workerCoverage = workerSourceCoverage(workerHomes, now, readFailed)
  const tasksUnavailable = readFailed || stale(scene.coverage.intentions, now)
  const membership = view.compact ? allGroups.find(g => g.id === group.id) ?? group : group
  const emptyLabels = (workers: Execution[], cards: SceneCard[]) => {
    const workerClaims = scene.claims.filter(c => c.state !== 'historical' && workers.some(w => w.id === c.executionId))
    const taskClaims = scene.claims.filter(c => c.state !== 'historical' && cards.some(card => card.id === c.cardId))
    const confirmed = (claim: typeof scene.claims[number]) => claim.basis === 'explicit' && claim.verification === 'confirmed' && claim.state === 'current'
    return {
      worker: taskClaims.some(confirmed) ? 'Linked worker outside this view' : taskClaims.length ? 'Worker link unverified' : workerAbsenceLabel(workerCoverage, 'column'),
      task: workerClaims.some(confirmed) ? 'Linked task outside this view' : workerClaims.length ? 'Task link unverified' : tasksUnavailable ? 'Notion unavailable' : 'No linked task',
    }
  }
  const displayLabel = group.label === 'Unassigned / Unknown' && ['initiative', 'epic', 'status'].includes(state.organizer?.inner === 'none' ? state.organizer.outer : state.organizer?.inner ?? '') ? 'Unassigned' : group.label
  return <section className={`ov-group${flashRelated(view, target('group', group.id)) ? ' flashed' : ''}`} data-group-id={group.id}>
    <header className="ov-group-head"><button type="button" aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${group.label}`} onClick={() => send({ type: 'set-expanded', target: target('group', group.id), expanded: collapsed })}>{collapsed ? '+' : '−'}</button>
      <strong className="ov-group-name">{displayLabel}</strong><span>{workerSummary(workerHomes, now, readFailed, membership.workers.length, ws.length, true)}{!workersOnly && <> · {view.compact ? membership.cards.length : cs.length} T</>}</span></header>
    {!collapsed && <div className={`ov-group-body${view.compact ? ' ov-compact-columns' : ''}`} ref={body}>
      {view.compact || workersOnly ? <>
        <div className="ov-worker-stack">{ws.map(worker => <Entity key={worker.id} view={view} entity={worker} kind="execution" hover={hover} focus={focus} references={reference('execution', worker.id)} />)}{!ws.length && <div className="ov-empty-col">{group.executionIds.length ? 'Workers referenced in another group' : emptyLabels(ws, cs).worker}</div>}</div>
        <div className="ov-gutter" />
        {!workersOnly && <div className="ov-card-stack">{cs.map(card => <Entity key={card.id} view={view} entity={card} kind="card" hover={hover} focus={focus} references={reference('card', card.id)} />)}{!cs.length && <div className="ov-empty-col">{group.cardIds.length ? 'Tasks referenced in another group' : emptyLabels(ws, cs).task}</div>}</div>}
      </> : rows.map((row, index) => {
        const workerClaims = scene.claims.filter(c => c.state !== 'historical' && row.workers.some(w => w.id === c.executionId))
        const taskClaims = scene.claims.filter(c => c.state !== 'historical' && row.cards.some(card => card.id === c.cardId))
        const confirmed = (claim: typeof scene.claims[number]) => claim.basis === 'explicit' && claim.verification === 'confirmed' && claim.state === 'current'
        const hasVisibleTask = workerClaims.some(c => cs.some(card => card.id === c.cardId))
        const hasVisibleWorker = taskClaims.some(c => ws.some(worker => worker.id === c.executionId))
        const hiddenTask = !row.cards.length && workerClaims.some(confirmed)
        const outsideWorker = !row.workers.length && taskClaims.some(confirmed)
        const workerCandidate = !row.workers.length && taskClaims.length > 0 && !outsideWorker
        const taskCandidate = !row.cards.length && workerClaims.length > 0 && !hiddenTask
        const { worker: leftEmpty, task: rightEmpty } = emptyLabels(row.workers, row.cards)
        return <div className="ov-pair" key={row.cards[0]?.id ?? row.workers[0]?.id ?? index}>
          <div className="ov-worker-stack">{row.workers.map(worker => <Entity key={worker.id} view={view} entity={worker} kind="execution" hover={hover} focus={focus} references={reference('execution', worker.id)} />)}{!row.workers.length && !hasVisibleWorker && <div className="ov-empty-col">{leftEmpty}</div>}</div>
          <div className="ov-gutter">{state.linksVisible !== false && (!row.workers.length && !hasVisibleWorker || !row.cards.length && !hasVisibleTask) && <span>{!row.workers.length ? outsideWorker ? 'outside view' : workerCandidate ? 'unverified' : workerAbsenceLabel(workerCoverage, 'gutter') : hiddenTask ? 'outside view' : taskCandidate ? 'unverified' : tasksUnavailable ? 'unknown task' : 'no task'}</span>}</div>
          <div className="ov-card-stack">{row.cards.map(card => <Entity key={card.id} view={view} entity={card} kind="card" hover={hover} focus={focus} references={reference('card', card.id)} />)}{!row.cards.length && !hasVisibleTask && <div className="ov-empty-col">{rightEmpty}</div>}</div>
        </div>
      })}
      {!view.compact && state.linksVisible !== false && <svg className="ov-connections">{paths.map(p => <g key={p.id}><path d={p.d} className={`ov-line ov-${p.tone}${(!state.navigation || state.navigation.cardId !== p.card || p.tone === 'linked') && state.flash && state.flash.until > now && (state.searchReveal?.kind === 'claim' ? state.flash.ids.includes(semanticId(target('claim', p.id))) : state.flash.ids.includes(semanticId(target('claim', p.id))) || !!p.worker && flashRelated(view, target('execution', p.worker)) || !!p.card && flashRelated(view, target('card', p.card))) ? ' flashed' : ''}${state.navigation?.cardId === p.card && p.tone === 'linked' ? ' desk-target' : ''}${focus ? (focus.kind === 'card' ? p.card === focus.id : focus.kind === 'execution' ? p.worker === focus.id : focus.kind === 'claim' ? p.id === focus.id : !!p.worker && related(view, focus, target('execution', p.worker))) ? ' hot' : ' dim' : ''}`} /><AskRelationshipHit claimId={p.id} d={p.d} onInspect={() => send({ type: 'focus', target: target('claim', p.id) })} /></g>)}</svg>}
    </div>}
  </section>
}
function Inspector({ view, workers }: { view: View; workers: Worker[] }) {
  const { refreshAfterMutation } = useDeskWorkspace()
  const { scene, state, send, now, readFailed } = view, selection = state.selection
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (selection && !view.restoringSearch) close.current?.focus({ preventScroll: true }) }, [selection])
  const selectedCardId = selection?.kind === 'card' ? selection.id : null
  const [contextRevision, setContextRevision] = useState(0)
  const retainedCard = useRef<SceneCard | null>(null)
  const renderedScene = useRef(scene.generatedAt)
  renderedScene.current = scene.generatedAt
  const confirmedInScene = useRef<string | null>(null)
  const refreshWork = async (result?: StartWorkResult) => {
    if (retainedCard.current && result?.card && retainedCard.current.id === (result.card as SceneCard['source']).id) {
      retainedCard.current = { ...retainedCard.current, source: result.card as SceneCard['source'] }
      confirmedInScene.current = renderedScene.current
    }
    await refreshAfterMutation(); setContextRevision(revision => revision + 1)
  }
  const [context, setContext] = useState<{ outcome?: string; blocks?: Array<{ id: string; text: string }> } | null>(null)
  useEffect(() => {
    setContext(null)
    if (!selectedCardId) return
    const controller = new AbortController()
    void apiFetch(`/api/reconciliation/card-context?id=${encodeURIComponent(selectedCardId)}`, { signal: controller.signal })
      .then(res => res.json()).then(body => { if (!controller.signal.aborted) setContext(body.ok ? body.data : { outcome: 'unavailable' }) })
      .catch(() => { if (!controller.signal.aborted) setContext({ outcome: 'unavailable' }) })
    return () => controller.abort()
  }, [selectedCardId, contextRevision, scene.generatedAt])
  if (!selection) return null
  const claim = [...scene.claims, ...scene.claimHistory].find(c => selection.kind === 'claim' && c.id === selection.id)
  const execution = scene.executions.find(e => e.id === (claim?.executionId ?? (selection.kind === 'execution' ? selection.id : '')))
  const currentCard = scene.cards.find(c => c.id === (claim?.cardId ?? (selection.kind === 'card' ? selection.id : '')))
  if (currentCard && (retainedCard.current?.id !== currentCard.id || confirmedInScene.current !== scene.generatedAt)) { retainedCard.current = currentCard; confirmedInScene.current = null }
  const card = (currentCard && confirmedInScene.current !== scene.generatedAt ? currentCard : undefined) ?? (selection.kind === 'card' && retainedCard.current?.id === selection.id ? retainedCard.current : undefined)
  const home = scene.coverage.homes.find(h => h.source.home === (selection.kind === 'manager' ? selection.id : execution?.home))
  const group = selection.kind === 'group' ? resolveFloorGroup(scene, state, selection.id, now) : undefined
  const groupHomes = group ? relevantWorkerHomes(scene, state.organizer, group) : scene.coverage.homes
  const matches = workers.filter(w => w.home === execution?.home && w.id === execution?.identity.task_id)
  const worker = matches.length === 1 ? matches[0] : null
  const route = worker ? { worker: worker.id, home: homeName(worker.home), key: null, q: '' } : null
  const terminal = worker?.terminalAvailable && route && findLinkedWorker(workers, route)?.key === worker.key ? `?${new URLSearchParams({ worker: route.worker, home: route.home })}` : null
  const claims = [...scene.claims, ...scene.claimHistory].filter(c => card ? c.cardId === card.id : execution ? c.executionId === execution.id : c.id === claim?.id)
  const backlog = scene.backlog.filter(entry => card && entry.source.cardReferences.some(ref => ref.pageId === card.id))
  const findings = scene.findings.filter(f => card ? f.cardIds.includes(card.id) : execution ? f.executionIds.includes(execution.id) : home ? f.homeIds.includes(home.source.home) : false)
  const notionUrl = card ? safeUrl(card.source.url) : null
  const selectedPattern = currentCard ? view.patternResults?.get(currentCard.id) : undefined
  const content = <>
    <header><h2>Inspector</h2><button type="button" className="ov-back" ref={close} onClick={() => send({ type: 'clear-selection' })}>Close Inspector</button></header>
    <small className="ov-eyebrow">{card ? 'Notion card' : execution ? 'Worker' : home ? 'Manager' : 'Overview'}</small>
    <h3 {...(card || execution ? askElement('title') : {})}>{card ? cardTitle(card) : execution ? workerTitle(execution) : home ? managerName(scene, home.source.home) : group?.label ?? (selection.kind === 'firstMate' ? 'First Mate' : 'Selected record unavailable')}</h3>
    {execution && <><p><span {...askElement('machine', 'Machine')}>{execution.placement.machine ?? 'Unknown machine'}</span> · <span {...askElement('status', 'Worker status')}>{recordedWorkerFact(execution, now, scene.coverage.homes.find(home => home.source.home === execution.home)?.observation, readFailed)}</span></p><p>Manager: <span {...askElement('worker', 'Manager')}>{managerName(scene, execution.home)}</span> · <span {...askElement('last_edited', 'Last activity')}>Last activity {ageLabel(activityTimestamp(execution), now)}{(readFailed || stale(execution.observation, now)) && ' · Last known observation'}</span></p><h4>Latest activity</h4><p {...askElement('description', 'Latest activity')}>{String(execution.source.last_event.note ?? execution.source.lastEventText ?? 'No report published')}</p>{terminal && <a href={terminal} target="_blank" rel="noreferrer">Open worker terminal ↗</a>}</>}
    {card && <>{waitingForIssue(card, scene.cards) && <p role="status">{waitingForIssue(card, scene.cards)}</p>}{!currentCard && <p role="status">Outside the current view. Last confirmed card retained for history and any remaining save steps.</p>}<AskCardAction cardId={card.id} /><WorkActions key={`actions-${card.id}`} card={card} sources={context?.blocks} onSaved={refreshWork} /><StartWork key={card.id} cardId={card.id} scene={scene} onSaved={refreshWork} /><p {...askElement('relationship', 'Work hierarchy')} className="ov-breadcrumb">{workBreadcrumb(scene, card)}</p><dl className="ov-detail-fields">{taskFields(card, now).map(([label, value]) => <div key={label}><dt>{label}</dt><dd {...askElement(({ 'Next check-in': 'next_check_in', 'Last edited': 'last_edited', 'Due Date': 'due_date', 'Waiting For': 'waiting_for', 'Will action': 'will_action' } as Record<string, string>)[label] ?? label.toLowerCase().replaceAll(' ', '_'), label, value, label === 'Next check-in' && checkIn(card, now).state === 'overdue' ? 'overdue' : undefined)}>{value}</dd></div>)}</dl><p {...askElement('waiting_for', 'Next action')}>{card.nextAction ?? (backlog.some(entry => entry.source.hold_reason) ? 'Waiting For a prerequisite' : card.expectationReason)}</p>{backlog.map(entry => <p {...askElement('waiting_for', 'Prerequisite')} key={entry.id}>{[entry.source.hold_reason, entry.source.blocked_by && `Blocked by ${entry.source.blocked_by}`, entry.source.hold_until && `Until ${entry.source.hold_until}`].filter(Boolean).join(' · ')}</p>)}{notionUrl && <span className="ov-source-actions"><a href={notionUrl} target="_blank" rel="noreferrer">Open Notion card ↗</a><CopyNotionLink url={notionUrl} /></span>}{externalWorkers(card.source.properties['Delegated To']?.value, now).map(run => <p key={JSON.stringify([run.system, run.run_id, run.observed_at, run.reported_by])}><a href={run.reference} target="_blank" rel="noreferrer">{run.system} · {run.run_id} ↗</a> · {run.freshness === 'current-report' ? 'Reported running' : 'Execution unknown'} · reported by {run.reported_by} at {run.observed_at}</p>)}<h4>Full card</h4>{['available', 'partial'].includes(context?.outcome ?? '') ? <>{context?.blocks?.map(block => <p {...askElement('description', 'Card text')} key={block.id}>{block.text.split('\n').filter(line => !/^Tin Star (?:operation|section|request|answer|answer data|decision intent):/.test(line)).join('\n')}</p>)}{context?.outcome === 'partial' && <p>Some content omitted. Use the Notion source link for the full card.</p>}</> : <p>{context ? 'Card body unavailable. Use the Notion source link.' : 'Reading card…'}</p>}
      {card.parentIds.map(id => <button {...askElement('relationship', 'Parent')} key={id} type="button" disabled={!scene.cards.some(c => c.id === id)} onClick={() => send({ type: 'focus', target: target('card', id) })}>Parent: {scene.cards.find(c => c.id === id) ? cardTitle(scene.cards.find(c => c.id === id)!) : 'Unavailable'}</button>)}</>}
    {home && <><p>{workerSummary(scene.coverage.homes.filter(h => h.source.home === home.source.home), now, readFailed, scene.executions.filter(e => e.kind !== 'secondmate' && !historyRecord(e, now) && e.home === home.source.home).length, state.collapsed.includes(semanticId(target('manager', home.source.home))) ? 0 : undefined)} · {home.source.machine ?? 'Unknown machine'}</p><button type="button" onClick={() => send({ type: 'set-expanded', target: target('manager', home.source.home), expanded: state.collapsed.includes(semanticId(target('manager', home.source.home))) })}>{state.collapsed.includes(semanticId(target('manager', home.source.home))) ? 'Expand' : 'Collapse'} workers</button></>}
    {group && <><p>{workerSummary(groupHomes, now, readFailed, scene.executions.filter(e => e.kind !== 'secondmate' && !historyRecord(e, now) && group.executionIds.includes(e.id)).length)} · {group.cardIds.length} cards</p><details><summary>Epics & parents</summary>{scene.cards.filter(c => group.cardIds.includes(c.id) && (c.parentIds.length || scene.cards.some(child => child.parentIds.includes(c.id)))).map(c => <div key={c.id} className="ov-related"><button type="button" onClick={() => send({ type: 'focus', target: target('card', c.id) })}>{cardTitle(c)}</button>{c.parentIds.length > 0 && <small>Parent: {c.parentIds.map(id => scene.cards.find(parent => parent.id === id)).map(parent => parent ? cardTitle(parent) : 'Unavailable').join(', ')}</small>}</div>)}</details></>}
    {selection.kind === 'firstMate' && <><p>Supervising the configured managers.</p>{scene.coverage.homes.map(h => <div key={h.source.home} className="ov-related"><button type="button" onClick={() => send({ type: 'focus', target: target('manager', h.source.home) })}>{managerName(scene, h.source.home)}</button></div>)}</>}
    {claims.length > 0 && <><h4>Connections & history</h4>{claims.map(c => <AskSurface as="div" enabled={scene.claims.some(claim => claim.id === c.id)} className="ov-related" key={c.id} data-claim-id={c.id} subject={{ target: { kind: 'claim', id: c.id } }} onInspect={() => send({ type: 'focus', target: target('claim', c.id) })}>{scene.claims.some(claim => claim.id === c.id) && <AskCardAction subject={{ target: { kind: 'claim', id: c.id } }} icon />}<small {...askElement('status', 'Connection status')}>{c.state === 'historical' ? 'History' : c.verification === 'confirmed' && c.state === 'current' ? 'Linked' : 'Unverified'}</small><button {...askElement('relationship')} type="button" disabled={!scene.executions.some(e => e.id === c.executionId)} onClick={() => send({ type: 'focus', target: target('execution', c.executionId) })}>{scene.executions.find(e => e.id === c.executionId) ? workerTitle(scene.executions.find(e => e.id === c.executionId)!) : 'Worker history'}</button><button {...askElement('relationship')} type="button" disabled={!scene.cards.some(card => card.id === c.cardId)} onClick={() => send({ type: 'focus', target: target('card', c.cardId) })}>{scene.cards.find(card => card.id === c.cardId) ? cardTitle(scene.cards.find(card => card.id === c.cardId)!) : 'Card unavailable'}</button></AskSurface>)}</>}
    <h4>Activity history</h4>{execution && <p {...askElement('description', 'Activity history')}>{execution.source.last_event.note ?? 'No activity report published'} · {ageLabel(reportTimestamp(execution), now)}</p>}{card && <p {...askElement('last_edited')}>Edited {ageLabel(Date.parse(card.source.last_edited_time), now)}</p>}{claims.map(c => <p {...askElement('relationship', 'Connection history')} key={c.id}>{c.state === 'historical' ? 'Connection ended' : 'Connection observed'} · {c.endedAt ?? c.observedAt ?? 'Time unknown'}</p>)}
    <details><summary>Evidence & diagnostics</summary>{selectedPattern && <p>Selected pattern: {selectedPattern.outcome === 'unavailable' ? 'unable to evaluate' : selectedPattern.outcome === 'match' ? 'match' : 'no match'} · {selectedPattern.reason}</p>}<pre>{JSON.stringify({ selectedPattern, selection, execution, card, home, group, findings, backlog, claims, historyScope: scene.historyScope }, null, 2)}</pre></details>
  </>
  const composerSubject = claim && scene.claims.some(item => item.id === claim.id) ? { target: { kind: 'claim' as const, id: claim.id } } : card ? { cardId: card.id } : execution ? { target: { kind: 'execution' as const, id: execution.id } } : null
  const composerView = { scene: 'overview' as const, organizer: state.organizer, statusFilter: state.statusFilter }
  return card || execution ? <AskSurface as="section" subject={card ? { cardId: card.id } : { target: { kind: 'execution', id: execution!.id } }} className={`ov-inspector${flashRelated(view, selection) ? ' flashed' : ''}`} data-semantic-id={semanticId(selection)} tabIndex={-1} aria-label="Inspector">{content}{composerSubject && <AskContextComposer subject={{ ...composerSubject, view: composerView }} />}</AskSurface>
    : <section className={`ov-inspector${flashRelated(view, selection) ? ' flashed' : ''}`} data-semantic-id={semanticId(selection)} tabIndex={-1} aria-label="Inspector">{content}</section>
}
export function Overview({ workers, initialCardId }: { initialCardId?: string; workers: Worker[] }) {
  const { scene, error, now, queue, queueError, state, send, connection, bridgeError, overviewSearch, refresh, refreshing, lastSuccessfulSyncAt } = useDeskWorkspace()
  const navigatedCard = useRef<string | null>(null)
  useEffect(() => {
    if (!initialCardId || !scene?.cards.some(card => card.id === initialCardId) || navigatedCard.current === initialCardId) return
    navigatedCard.current = initialCardId
    send({ type: 'navigate-card', cardId: initialCardId })
  }, [initialCardId, scene, send])
  const [hovered, setHovered] = useState<Target | null>(null), [diagnosticsRevision, setDiagnosticsRevision] = useState<number | null>(null)
  const diagnostics = diagnosticsRevision === state.revision
  const setDiagnostics = (open: boolean) => setDiagnosticsRevision(open ? state.revision : null)
  const { density, setDensity, openRelationships, setOpenRelationships, detailedCollapsed, setDetailedCollapsed, canvas, root, search } = overviewSearch
  const expanded = useMemo(() => scene ? expandedRelationships(scene, openRelationships) : new Set<string>(), [scene, openRelationships])
  const previousSelection = useRef<string | null>(null)
  const selectedId = state.selection ? semanticId(state.selection) : null
  useEffect(() => { setHovered(null) }, [state.revision])
  // The existing search can explicitly reveal a card outside its status scope.
  // Preserve that temporary native result, then restore Waiting For on search exit.
  const focusedContext = scene && state.searchFocus?.length ? directNeighbors(scene, state.searchFocus) : null
  const flashContext = scene && state.flash?.revealTargets && state.flash.until > now ? directNeighbors(scene, state.flash.ids.map(id => {
    const separator = id.indexOf(':')
    return { kind: id.slice(0, separator) as Target['kind'], id: id.slice(separator + 1) }
  })) : null
  const outsideWaitingFor = scene?.cards.some(card => (focusedContext?.has(`card:${card.id}`) || flashContext?.has(`card:${card.id}`)) && cardStatus(card) !== 'Waiting For')
  const waitingScope = waitingForActive(state)
  const waiting = waitingScope && !outsideWaitingFor
  const [waitingType, setWaitingType] = useState<'All' | WaitingForType>('All')
  const [waitingOpen, setWaitingOpen] = useState<ReadonlySet<string> | null>(readWaitingForExpansion)
  const waitingReveal = useRef('')
  const groups = useMemo(() => scene ? overviewGroups(scene, state, now, !!error, !waiting && density === 'compact' ? expanded : undefined) : [], [scene, state, now, error, density, expanded, waiting])
  const waitingProjection = useMemo(() => waitingForGroups(groups.flatMap(group => group.cards), scene?.cards ?? []), [groups, scene])
  useEffect(() => { if (waitingScope) setWaitingType('All') }, [waitingScope])
  useEffect(() => { if (waitingOpen) saveWaitingForExpansion(waitingOpen) }, [waitingOpen])
  useEffect(() => { if (waiting && scene && waitingOpen === null) setWaitingOpen(new Set(waitingProjection.initial)) }, [waiting, scene, waitingOpen, waitingProjection])
  // Waiting For changes the Work presentation only. Keep the worker organizer,
  // status choices and relationship roots in the existing presentation state.
  const waitingWorkerScope = useMemo(() => waiting ? { ...state, donutFilter: { ...state.donutFilter, cards: [], workers: state.donutFilter?.workers ?? [] },
    ...(state.statusFilter?.preset === 'custom' && state.statusFilter.statuses.length === 1 && state.statusFilter.statuses[0] === 'Waiting For' ? { statusFilter: { preset: 'operational' as const, statuses: [] } } : {}) } : undefined, [waiting, state])
  const waitingWorkers = useMemo(() => scene && waitingWorkerScope
    ? canonicalOverviewGroups(overviewGroups(scene, waitingWorkerScope, now, !!error, expanded)).filter(group => group.workers.length > 0) : [], [scene, waitingWorkerScope, now, error, expanded])
  useEffect(() => {
    if (!waiting) { waitingReveal.current = ''; return }
    if (hasSearch(state.search) || state.searchFocus?.length) return
    const selected = state.selection?.kind === 'card' ? state.selection.id : null
    const keys = waitingProjection.categories.flatMap(category => category.groups).filter(group => group.cards.some(card => expanded.has(`card:${card.id}`) || card.id === selected)).map(group => group.key)
    const signature = JSON.stringify([openRelationships, selected, keys])
    if (waitingReveal.current === signature) return
    waitingReveal.current = signature
    if (keys.length) setWaitingOpen(previous => new Set([...(previous ?? waitingProjection.initial), ...keys]))
  }, [waiting, waitingProjection, expanded, openRelationships, state.selection, state.search, state.searchFocus])
  const searchMatches = useMemo(() => scene && state.searchFocus?.length ? new Set(state.searchFocus.map(targetKey)) : scene && hasSearch(state.search) ? new Set(searchSeeds(scene, state.search!, now).map(targetKey)) : undefined, [scene, state.search, state.searchFocus, now])
  const patternResults = useMemo(() => scene && state.search?.patterns.length ? new Map(sceneWorkHealth(scene, now).map(health => [health.cardId, combinedPatternResult(health, state.search!.patterns)])) : undefined, [scene, state.search, now])
  const displayGroups = useMemo(() => density === 'compact' ? canonicalOverviewGroups(groups) : groups, [groups, density])
  useEffect(() => {
    if (search.isRestoring()) return
    const id = selectedId ?? previousSelection.current
    previousSelection.current = selectedId
    if (!id) return
    const element = [...root.current?.querySelectorAll<HTMLElement>('[data-semantic-id]') ?? []].find(el => el.dataset.semanticId === id)
    element?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    if (!selectedId) element?.focus({ preventScroll: true })
  }, [selectedId, state.selection, state.arrangement, state.collapsed, state.queueOpen, state.queueItemId])
  useEffect(() => {
    const revealedClaim = state.searchReveal?.kind === 'claim' ? scene?.claims.find(claim => claim.id === state.searchReveal!.id) : null
    const destination = revealedClaim ? { kind: 'card', id: revealedClaim.cardId } : state.navigation ? { kind: 'card', id: state.navigation.cardId } : state.searchReveal?.kind === 'execution' ? state.searchReveal : null
    if (!destination || search.isRestoring()) return
    const element = [...root.current?.querySelectorAll<HTMLElement>('.ov-item') ?? []].find(el => el.dataset.entityId === destination.id)
    if (!element) return
    // Expand and reveal have committed. Land immediately so a second input or
    // Desk focus restoration cannot interrupt an in-flight native scroll.
    element.scrollIntoView({ block: 'center', behavior: 'instant' })
    element.focus({ preventScroll: true })
  }, [state.navigation, state.searchReveal])
  if (!scene) return <section className="ov-loading" aria-label="Overview"><p role="status">{error ? 'Sources unavailable · Retrying' : 'Reading workers and Notion cards…'}</p></section>
  const toggleRelationship = (item: Target) => {
    setDiagnostics(false)
    const removing = openRelationships.some(root => same(root, item))
    const roots = removing ? openRelationships.filter(root => !same(root, item)) : [...openRelationships, item]
    setOpenRelationships(roots)
    if (!removing) {
      const revealed = expandedRelationships(scene, [item])
      for (const group of overviewGroups(scene, state, now, !!error, revealed)) {
        if (!group.workers.some(w => revealed.has(`execution:${w.id}`)) && !group.cards.some(c => revealed.has(`card:${c.id}`))) continue
        for (const id of [group.outerId, group.id]) if (state.collapsed.includes(semanticId(target('group', id)))) send({ type: 'set-expanded', target: target('group', id), expanded: true })
      }
    }
  }
  const view: View = { restoringSearch: search.isRestoring(), scene, state, send, now, readFailed: !!error, searchMatches, patternResults, detailed: { collapsed: detailedCollapsed, toggle: item => setDetailedCollapsed(values => values.includes(semanticId(item)) ? values.filter(value => value !== semanticId(item)) : [...values, semanticId(item)]) }, compact: density === 'compact' ? { expanded, toggle: toggleRelationship, roots: openRelationships } : undefined, actionableCardIds: new Set(queue && !queueError ? decisionItems(queue, now).flatMap(item => item.cardIds) : []) }
  const gaps = gapTargets(scene, now, !!error)
  const notionUnavailable = !!error || stale(scene.coverage.intentions, now)
  const fleetCoverage = workerSourceCoverage(scene.coverage.homes, now, !!error)
  const fleetDelayed = fleetCoverage === 'unavailable'
  const checksSuspended = notionUnavailable || fleetCoverage !== 'available' || scene.coverage.absenceConclusions === 'suppressed'
  const coverageNotice = workerCoverageNotice(fleetCoverage)
  const unreadHomes = unreadableWorkerHomes(scene.coverage.homes, now)
  const visibleWorkers = new Set((waiting ? waitingWorkers : groups).flatMap(g => g.workers.map(w => w.id))).size
  const visibleCardIds = new Set(groups.flatMap(g => g.cards.map(c => c.id)))
  const visibleCards = visibleCardIds.size
  const linkHealth = workerLinkSourceHealth(scene, visibleCardIds, now, !!error)
  const patternCoverage = patternResults ? patternCheckSummary(groups.flatMap(group => group.cards.filter(card => state.roadmapExpanded || !isPlanned(scene, card)).map(card => card.id)), patternResults) : null
  const workerCountNote = fleetCoverage === 'unavailable' ? visibleWorkers ? 'last known' : 'unavailable' : fleetCoverage === 'partial' ? visibleWorkers ? 'partial' : 'unknown' : undefined
  const history = scene.executions.filter(e => e.kind !== 'secondmate' && historyRecord(e, now))
  return <div ref={root} role="region" aria-label="Overview" className={`ov ov-density-${density}`} data-density={density} data-arrangement={state.arrangement} data-outer={state.organizer?.outer} data-inner={state.organizer?.inner} data-order={state.organizer?.order} data-direction={state.organizer?.direction} data-preset={state.statusFilter?.preset} data-revision={state.revision} data-scene-id={connection?.scene_id} onKeyDown={e => { if (e.key === 'Escape' && search.active) { e.preventDefault(); e.stopPropagation(); if (search.open) search.dismiss(); else search.restore(); return } if (e.key === 'Escape') { send({ type: 'clear-selection' }); send({ type: 'close-queue' }); send({ type: 'clear-transient' }); setDiagnostics(false) } }}>
    <div className="ov-columns"><div className="ov-main">
      <FloorToolbar workerScope={waitingWorkerScope} sessionControl={<SessionConnection />} patternCoverage={patternCoverage} onInspectPatternCoverage={() => {
        const targets = patternCoverage?.unavailableCardIds.map(id => target('card', id)) ?? []
        if (targets.length) { search.choose(targets[0]!, targets); setOpenRelationships([]) }
      }} sync={{ refresh, refreshing, lastSuccessfulSyncAt, error }} searchControl={<SmartSearch scene={scene} state={state} now={now} open={search.open} focused={search.focused} onOpen={search.begin} onDismiss={search.dismiss} onRestore={search.restore} onChoose={search.choose} />} now={now} visibleWorkers={visibleWorkers} visibleCards={visibleCards} countNotes={{ workers: workerCountNote, cards: notionUnavailable ? 'last known' : undefined }} sourceLabel={notionUnavailable ? 'Notion unavailable' : fleetDelayed ? 'Workers need a refresh' : checksSuspended ? 'Coverage incomplete' : 'Sources connected'} onSourceDetails={() => setDiagnostics(!diagnostics)} scene={scene} state={state} send={send} gaps={gaps} density={density} onDensityChange={value => {
        setDensity(value); saveOverviewDensity(value)
        if (value === 'compact' && state.selection) {
          const selected = state.selection
          if (selected.kind === 'card' || selected.kind === 'execution') setOpenRelationships(roots => roots.some(root => same(root, selected)) ? roots : [...roots, selected])
          send({ type: 'clear-selection' })
        }
      }} />
      {state.assistantChangedView && <div className="ov-cue" role="status">Assistant changed this view <button type="button" onClick={() => send({ type: 'clear-transient' })}>×</button></div>}
      <div className="ov-workspace"><div ref={canvas} className={`ov-canvas${waiting ? ' ov-waiting-canvas' : ''}`}>{waiting ? <div className="ov-waiting-columns">
          <section className="ov-waiting-workers" aria-label="Workers"><header className="ov-waiting-worker-head">WORKERS · {workerCountNote === 'unknown' || workerCountNote === 'unavailable' ? workerCountNote : `${visibleWorkers}${workerCountNote ? ` ${workerCountNote}` : ''}`}</header>{[...new Set(waitingWorkers.map(group => group.outerId))].map(outerId => {
            const children = waitingWorkers.filter(group => group.outerId === outerId), first = children[0]!
            const workerView = view
            const render = (group: typeof first) => <Group key={group.id} workersOnly view={workerView} group={group} allGroups={waitingWorkers} hover={setHovered} focus={hovered ?? state.selection} />
            if (!state.organizer || state.organizer.inner === 'none') return render(first)
            const collapsed = state.collapsed.includes(semanticId(target('group', outerId)))
            return <section className="ov-outer" key={outerId} data-outer={first.outerLabel}><header className="ov-group-head"><button type="button" aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${first.outerLabel}`} onClick={() => send({ type: 'set-expanded', target: target('group', outerId), expanded: collapsed })}>{collapsed ? '+' : '−'}</button><strong>{first.outerLabel}</strong><small className="ov-group-field">{floorFields.find(field => field.id === state.organizer?.outer)?.label}</small></header>{!collapsed && <div className="ov-inner">{children.map(render)}</div>}</section>
          })}</section>
          <div className="ov-gutter" />
          <WaitingForWork projection={waitingProjection} type={waitingType} onType={setWaitingType} open={waitingOpen ?? new Set(waitingProjection.initial)} onToggle={key => setWaitingOpen(previous => { const next = new Set(previous ?? waitingProjection.initial); if (next.has(key)) next.delete(key); else next.add(key); return next })} searchKey={hasSearch(state.search) || state.searchFocus?.length ? JSON.stringify([state.search, state.searchFocus]) : undefined} selected={state.selection?.kind === 'card' ? state.selection.id : undefined} revealed={expanded} flashed={id => flashRelated(view, target('card', id))} onSelect={id => {
            const item = target('card', id)
            setOpenRelationships(roots => roots.some(root => same(root, item)) ? roots : [...roots, item])
            send({ type: 'navigate-card', cardId: id })
            send({ type: 'focus', target: item })
          }} onHover={card => setHovered(card ? target('card', card.id) : null)} partial={scene.coverage.intentions.coverage !== 'complete'} failed={notionUnavailable} observedAt={scene.coverage.intentions.observedAt} />
        </div> : <><div className="ov-headings"><span>WORKERS · {workerCountNote === 'unknown' || workerCountNote === 'unavailable' ? workerCountNote : `${visibleWorkers}${workerCountNote ? ` ${workerCountNote}` : ''}`}</span><small>RELATIONSHIPS</small><span>NOTION TASKS · {visibleCards}{notionUnavailable ? ' last known' : ''}</span></div>
        {[...new Set(displayGroups.map(g => g.outerId))].map(outerId => {
          const children = displayGroups.filter(g => g.outerId === outerId), first = children[0]!
          const nested = state.organizer?.inner !== 'none' && !!state.organizer
          if (!nested) return <Group key={first.id} view={view} group={first} allGroups={groups} hover={setHovered} focus={hovered ?? state.selection} />
          const collapsed = state.collapsed.includes(semanticId(target('group', outerId)))
          return <section className="ov-outer" key={outerId} data-outer={first.outerLabel}><header className="ov-group-head"><button type="button" aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${first.outerLabel}`} onClick={() => send({ type: 'set-expanded', target: target('group', outerId), expanded: collapsed })}>{collapsed ? '+' : '−'}</button><strong>{first.outerLabel === 'Unassigned / Unknown' && ['initiative', 'epic'].includes(state.organizer?.outer ?? '') ? 'Unassigned' : first.outerLabel}</strong><small className="ov-group-field">{floorFields.find(f => f.id === state.organizer?.outer)?.label}</small><span>{workerSummary(relevantWorkerHomes(scene, state.organizer, { label: first.outerLabel }), now, !!error, new Map(groups.filter(g => g.outerId === outerId).flatMap(g => g.workers.map(w => [w.id, w] as const))).size)} · {new Set(groups.filter(g => g.outerId === outerId).flatMap(g => g.cards.map(c => c.id))).size} tasks</span></header>
            {!collapsed && <div className="ov-inner">{children.map(group => <Group key={group.id} view={view} group={group} allGroups={groups} hover={setHovered} focus={hovered ?? state.selection} />)}</div>}
          </section>
        })}
        </>}
        {(waiting || density === 'compact') && state.linksVisible !== false && <CompactConnections canvas={canvas} scene={scene} layout={waiting ? [waitingProjection, waitingWorkers, waitingType, waitingOpen] : displayGroups} expanded={expanded} collapsed={state.collapsed} now={now} readFailed={!!error} flash={state.flash} focus={hovered ?? state.selection ?? (state.searchFocus?.length === 1 ? state.searchFocus[0]! : null)} onInspect={id => send({ type: 'focus', target: target('claim', id) })} />}
        {!waiting && !groups.length && <p className="ov-empty">{hasSearch(state.search) ? state.search?.patterns.length ? patternEmptyText[state.search.patterns[0]!] : 'No relationship clusters match these filters in this scope.' : state.exceptionsOnly ? checksSuspended ? 'Gap checks suspended until observations are complete.' : 'No confirmed gaps in this scope.' : hasDonutFilter(state.donutFilter) ? checksSuspended ? 'No matches in available records · source coverage incomplete.' : 'No linked records match these status selections.' : emptyWorkerScopeLabel(fleetCoverage)}</p>}
        {!waiting && !hasSearch(state.search) && !hasDonutFilter(state.donutFilter) && history.length > 0 && <details className="ov-history"><summary>Worker history · {history.length}</summary>{history.map(e => <button type="button" key={e.id} onClick={() => send({ type: 'focus', target: target('execution', e.id) })}>{workerTitle(e)} · {workerState(e)}</button>)}</details>}
      </div></div>
    </div></div>{state.selection && <Inspector view={view} workers={workers} />}
    {diagnostics && <section className="ov-inspector" aria-label="Source health"><header><h2>Source health</h2><button type="button" onClick={() => setDiagnostics(false)}>Close source health</button></header><p>{notionUnavailable ? 'Notion unavailable. Last known cards remain visible; absence checks are suspended.' : 'Notion connected.'}</p>{coverageNotice && <p>{coverageNotice}{unreadHomes.length ? ` ${unreadHomes.map(home => `${managerName(scene, home.source.home)} · ${homeFreshness(home.observation, now)}`).join('; ')}` : ''}</p>}{checksSuspended && <><p>Gap checks are suspended until the required observations can be verified.</p><p>Worker links in this view: {linkHealth.unknown} cards with unknown workers; {linkHealth.unverified} cards with unverified links. Incomplete coverage does not establish missing workers or work exceptions.</p></>}{linkHealth.conflicting > 0 && <p>{linkHealth.conflicting} {linkHealth.conflicting === 1 ? 'card has' : 'cards have'} conflicting worker evidence. First Mate investigation is still required; select a card and open Evidence &amp; diagnostics.</p>}<p>{bridgeError ? 'Assistant connection unavailable.' : 'Assistant connected.'}</p><pre>{JSON.stringify({ coverage: scene.coverage, warnings: scene.warnings, error }, null, 2)}</pre></section>}
  </div>
}
