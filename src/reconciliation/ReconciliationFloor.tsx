import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { Claim, Execution, Finding, SceneCard, SceneGroup } from '../server/reconciliation/scene'
import type { Worker } from '../cockpit/shell/types'
import { homeName, findLinkedWorker } from '../cockpit/overviewQuery'
import { AgentIcon } from '../components/agentIcon'
import {
  ancestorHomes, managerCollapsed, arrangements, findingLabels, isException, isPlanned, semanticId, targetExists, targetInGroup,
  type FloorScene, type PresentationAction, type PresentationState, type Target,
} from './presentation'
import { useDeskQueue } from './useDeskQueue'
import { usePresentation } from './usePresentation'
import { QueuePanel } from './QueuePanel'
import { useFloorScene } from './useFloorScene'
import './floor.css'

const target = (kind: Target['kind'], id: string): Target => ({ kind, id })
const cardTitle = (card: SceneCard) => String(card.source.properties.Name?.value || card.id)
const status = (card: SceneCard) => String(card.source.properties.Status?.value || 'Unknown status')
const time = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'unknown time'
const unique = <T,>(items: T[]) => [...new Set(items)]
const expired = (observation: { status: string; expiresAt: string | null }, now: number) =>
  observation.status === 'stale' || observation.status === 'unknown' || !!observation.expiresAt && Date.parse(observation.expiresAt) <= now
const safeLink = (value: string | null) => { try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) ? url.href : null } catch { return null } }
function activityAt(execution: Execution) {
  const age = execution.source.last_event.age_seconds
  const observed = Date.parse(execution.observation.observedAt ?? '')
  return typeof age === 'number' && Number.isFinite(observed) ? new Date(observed - age * 1000).toISOString() : null
}
function relatedFindings(scene: FloorScene, cardIds: string[], executionIds: string[], homeIds: string[] = []) {
  return scene.findings.filter(f => f.cardIds.some(id => cardIds.includes(id)) || f.executionIds.some(id => executionIds.includes(id)) || f.homeIds.some(id => homeIds.includes(id)))
}
const tone = (findings: Finding[]) => findings.some(f => f.kind === 'task-execution-gap') ? 'gap' : findings.some(f => f.kind === 'untracked-worker') ? 'untracked' :
  findings.some(isException) ? 'unknown' : 'quiet'

function waitExplanation(scene: FloorScene, card: SceneCard) {
  const waits = scene.findings.filter(f => f.kind === 'legitimate-wait-planned' && f.cardIds.includes(card.id))
  const backlog = waits.length ? scene.backlog.filter(entry =>
    ['fresh', 'partial'].includes(entry.observation.status) &&
    new Set(entry.source.cardReferences.map(ref => ref.pageId)).size === 1 &&
    entry.source.cardReferences.some(ref => ref.pageId === card.id && ref.basis === 'explicit') &&
    (entry.source.state === 'queued' || entry.source.hold_reason || entry.source.blocked_by || entry.source.hold_until)) : []
  return [waits.length ? unique(waits.map(f => f.reason)).join('; ') : card.expectationReason,
    ...backlog.map(({ home, source }) => [
      `First Mate ${home} / ${source.id}: ${source.state}`,
      source.hold_reason && `Hold reason: ${source.hold_reason}`,
      source.blocked_by && `Blocked by: ${source.blocked_by}`,
      source.hold_until && `Hold until: ${source.hold_until}`,
    ].filter(Boolean).join(' · ')),
  ].join(' · ')
}

type Dispatch = (action: PresentationAction) => void
interface Context { scene: FloorScene; state: PresentationState; send: Dispatch; now: number; delayed: boolean; readFailed: boolean }
function FocusButton({ context, item, className = '', children }: { context: Context; item: Target; className?: string; children: ReactNode }) {
  const id = semanticId(item)
  const selected = context.state.selection && semanticId(context.state.selection) === id
  const flashed = context.state.flash && context.state.flash.until > context.now && context.state.flash.ids.includes(id)
  return <button type="button" className={`floor-focus ${className}${selected ? ' is-selected' : ''}${flashed ? ' is-flashed' : ''}`} data-semantic-id={id}
    aria-pressed={!!selected} onClick={() => context.send(item.kind === 'you' ? { type: 'open-queue' } : { type: 'focus', target: item })}>{children}</button>
}
function FindingChips({ findings, delayed = false }: { findings: Finding[]; delayed?: boolean }) {
  return <span className="floor-findings">{unique(findings.map(f => f.kind)).map(kind => <span key={kind} className={`floor-chip floor-${tone(findings.filter(f => f.kind === kind))}`}>
    {delayed && ['task-execution-gap', 'untracked-worker'].includes(kind) ? 'Last-known: ' : ''}{findingLabels[kind]}</span>)}</span>
}
function WorkerNode({ execution, context }: { execution: Execution; context: Context }) {
  const stale = context.readFailed || expired(execution.observation, context.now)
  return <FocusButton context={context} item={target('execution', execution.id)} className="floor-worker">
    <span className="floor-worker-avatar"><AgentIcon seed={execution.identity.task_id ?? execution.id} color="#00f0ff" className="floor-avatar-image" /></span>
    <span><strong>{execution.identity.task_id ?? 'Unknown worker'}</strong><small>{execution.kind === 'secondmate' ? 'Second Mate · ' : ''}{stale ? 'last-known · ' : ''}{String(execution.source.current_state.state ?? execution.activity)} · {execution.placement.machine ?? 'Unknown machine'}</small>
      <small>{execution.placement.basis} placement · {homeName(execution.home)}</small>
      <span className="floor-activity">{String(execution.source.last_event.note ?? execution.source.current_state.detail ?? 'No activity detail published')}</span>
      <time dateTime={execution.source.current_state.observed_at ? String(execution.source.current_state.observed_at) : undefined}>State observed {time(typeof execution.source.current_state.observed_at === 'string' ? execution.source.current_state.observed_at : null)}</time>
    </span>
  </FocusButton>
}
function ClaimNode({ claim, context }: { claim: Claim; context: Context }) {
  return <FocusButton context={context} item={target('claim', claim.id)} className={`floor-claim ${claim.verification === 'confirmed' ? '' : 'floor-unknown'}`}>
    <span aria-hidden="true">↔</span><strong>{claim.verification}</strong><small>{claim.basis} · {claim.state}</small><time dateTime={claim.observedAt ?? undefined}>{time(claim.observedAt)}</time>
  </FocusButton>
}
function TaskNode({ card, context }: { card: SceneCard; context: Context }) {
  const findings = relatedFindings(context.scene, [card.id], [])
  const parent = card.parentIds.map(id => context.scene.cards.find(c => c.id === id)).map(c => c ? cardTitle(c) : 'Unavailable parent')
  return <FocusButton context={context} item={target('card', card.id)} className="floor-task">
    <small>{status(card)}{parent.length > 0 && ` · ${parent.join(' / ')}`}</small><strong>{cardTitle(card)}</strong>
    <FindingChips findings={findings} delayed={context.delayed} />
    {card.nextAction && <span>{card.nextAction}</span>}
    <small>Checkpoint {card.checkpoint.state}{card.checkpoint.at ? ` · ${time(card.checkpoint.at)}` : ''}</small>
  </FocusButton>
}
function CardRow({ card, group, context }: { card: SceneCard; group: SceneGroup; context: Context }) {
  const claims = context.scene.claims.filter(c => c.cardId === card.id && group.claimIds.includes(c.id))
  const executions = context.scene.executions.filter(e => claims.some(c => c.executionId === e.id))
  const shown = executions.filter(e => !managerCollapsed(context.scene, context.state, e.home))
  const findings = relatedFindings(context.scene, [card.id], executions.map(e => e.id))
  return <article className={`floor-row floor-${tone(findings)}${isPlanned(context.scene, card) ? ' floor-planned' : ''}`} data-card-id={card.id}>
    <div className="floor-execution-stack">{shown.length ? shown.map(execution => <div key={execution.id} className="floor-pair">
      <WorkerNode execution={execution} context={context} /><div className="floor-claim-stack">{claims.filter(c => c.executionId === execution.id).map(claim => <ClaimNode key={claim.id} claim={claim} context={context} />)}</div>
    </div>) : <div className={`floor-socket floor-${executions.length || context.delayed ? 'quiet' : tone(findings)}`}>
      <span aria-hidden="true">{executions.length ? '⊞' : isPlanned(context.scene, card) ? '◷' : '○'}</span>
      <strong>{executions.length ? `${executions.length} attempt(s) under collapsed managers` : findings.some(f => f.kind === 'task-execution-gap') ? context.delayed ? 'Last-known execution gap' : 'Execution gap' : isPlanned(context.scene, card) ? 'No worker required now' : card.expectation === 'outside' ? 'Outside First Mate coverage' : 'Execution unverified'}</strong>
      <small>{executions.length ? 'Expand the home above to reveal workers' : context.delayed ? 'Source read delayed; absence conclusions suspended' : waitExplanation(context.scene, card)}</small>
    </div>}</div>
    <TaskNode card={card} context={context} />
  </article>
}
function UnlinkedRow({ execution, context }: { execution: Execution; context: Context }) {
  const claims = context.scene.claims.filter(c => c.executionId === execution.id)
  const findings = relatedFindings(context.scene, [], [execution.id])
  return <article className={`floor-row floor-${tone(findings)}`} data-execution-id={execution.id}>
    <div className="floor-pair"><WorkerNode execution={execution} context={context} /><div className="floor-claim-stack">{claims.length ? claims.map(claim => <ClaimNode key={claim.id} claim={claim} context={context} />) : <span className="floor-unlinked">↔ No recognized claim</span>}</div></div>
    <div className={`floor-socket floor-${context.delayed ? 'unknown' : tone(findings)}`}><span aria-hidden="true">◇</span><strong>{claims.length ? 'Referenced card unavailable' : findings.some(f => f.kind === 'untracked-worker') ? context.delayed ? 'Last-known untracked execution' : 'Untracked execution' : 'Work item unverified'}</strong><FindingChips findings={findings} delayed={context.delayed} /></div>
  </article>
}
function Neighborhood({ group, context }: { group: SceneGroup; context: Context }) {
  const { scene, state, send } = context
  const item = target('group', group.id)
  const open = !state.collapsed.includes(semanticId(item))
  const exceptions = relatedFindings(scene, group.cardIds, group.executionIds, group.homeIds).filter(isException)
  const cards = scene.cards.filter(c => group.cardIds.includes(c.id) && (!state.exceptionsOnly || exceptions.some(f => f.cardIds.includes(c.id))))
  const roadmap = cards.filter(c => isPlanned(scene, c))
  const current = cards.filter(c => !isPlanned(scene, c))
  const unlinked = scene.executions.filter(e => group.executionIds.includes(e.id) &&
    !scene.claims.some(c => c.executionId === e.id && scene.cards.some(card => card.id === c.cardId)) &&
    !managerCollapsed(scene, state, e.home) && (!state.exceptionsOnly || exceptions.some(f => f.executionIds.includes(e.id))))
  if (state.exceptionsOnly && !exceptions.length) return null
  return <section className="floor-neighborhood" data-group-id={group.id}>
    <header className="floor-group-header">
      <button className="floor-expand" type="button" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} group ${group.label}`} onClick={() => send({ type: 'set-expanded', target: item, expanded: !open })}>{open ? '−' : '+'}</button>
      <FocusButton context={context} item={item} className="floor-group-name"><strong>{group.label}</strong><small>{group.counts.cards} cards · {group.counts.workers} unique workers · {group.counts.attempts} attempts · {exceptions.length} findings</small></FocusButton>
    </header>
    {open && <div className="floor-group-body">
      {current.map(card => <CardRow key={card.id} card={card} group={group} context={context} />)}
      {unlinked.map(execution => <UnlinkedRow key={execution.id} execution={execution} context={context} />)}
      {roadmap.length > 0 && <div className="floor-roadmap"><button type="button" aria-expanded={state.roadmapExpanded} onClick={() => send({ type: 'set-roadmap', expanded: !state.roadmapExpanded })}>{state.roadmapExpanded ? '−' : '+'} Roadmap / waits · {roadmap.length} cards · planned or accounted-for waits</button>
        {state.roadmapExpanded && roadmap.map(card => <CardRow key={card.id} card={card} group={group} context={context} />)}</div>}
      {!cards.length && !unlinked.length && <p className="floor-empty">{group.homeIds.length ? 'No visible rows. Home observation coverage is shown above; this does not certify an empty home.' : 'No assigned records in this grouping.'}</p>}
      {exceptions.filter(f => !f.cardIds.length && !f.executionIds.length).map(f => <p key={f.id} className="floor-source-warning">{f.reason}</p>)}
    </div>}
  </section>
}
function Hierarchy({ context }: { context: Context }) {
  const { scene, state, send } = context
  return <section className="floor-hierarchy" aria-label="Accountability hierarchy">
    <div className="floor-command-chain"><FocusButton context={context} item={target('you', 'root')}><span className="floor-avatar">Y</span><strong>You</strong><small>Management</small></FocusButton><span aria-hidden="true">→</span>
      <FocusButton context={context} item={target('firstMate', 'root')}><span className="floor-avatar">FM</span><strong>First Mate</strong><small>Execution authority</small></FocusButton><span className="floor-chain-caption">→ observed homes / Second Mates</span>
      <button type="button" className="floor-desk-slot" data-slot="desk-queue" onClick={() => send({ type: 'open-queue' })}><strong>Your desk</strong><small>Open queue</small></button>
    </div>
    <div className="floor-managers">{scene.coverage.homes.filter(home => !ancestorHomes(scene, home.source.home).slice(1).some(id => state.collapsed.includes(semanticId(target('manager', id))))).map(home => {
      const id = home.source.home
      const descendants = scene.coverage.homes.filter(h => ancestorHomes(scene, h.source.home).includes(id)).map(h => h.source.home)
      const executions = scene.executions.filter(e => descendants.includes(e.home))
      const childHomes = scene.coverage.homes.filter(h => h.source.parentHome === id)
      const workerCount = new Set(executions.filter(e => e.kind !== 'secondmate').map(e => JSON.stringify([e.home, e.identity.task_id]))).size
      const findings = relatedFindings(scene, [], executions.map(e => e.id), descendants).filter(isException)
      const latest = executions.filter(e => e.source.last_event.note).sort((a, b) => (Date.parse(activityAt(b) ?? '') || 0) - (Date.parse(activityAt(a) ?? '') || 0))[0]
      const open = !state.collapsed.includes(semanticId(target('manager', id)))
      return <article className="floor-manager" key={id}>
        <div className="floor-manager-heading"><button className="floor-expand" type="button" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} manager ${id}`} onClick={() => send({ type: 'set-expanded', target: target('manager', id), expanded: !open })}>{open ? '−' : '+'}</button>
          <FocusButton context={context} item={target('manager', id)}><strong>{homeName(id)}</strong><small>{home.source.parentHome ? `Second Mate → ${homeName(home.source.parentHome)}` : 'Root home · parent not configured'} · {home.source.machine ?? 'Unknown machine'} ({home.source.machineBasis})</small></FocusButton></div>
        <span className="floor-manager-count">{workerCount} unique workers in subtree · {executions.length} attempts · {childHomes.length} child homes · {findings.length} findings</span>
        <span className="floor-manager-count">{executions.filter(e => e.activity === 'executing').length} executing · {executions.filter(e => e.activity === 'waiting').length} waiting · {executions.filter(e => e.activity === 'unknown').length} unknown</span>
        <small>{context.readFailed || expired(home.observation, context.now) ? 'Last-known / unknown' : home.observation.status} / {home.observation.coverage} · observed {time(home.observation.observedAt)}</small>
        {latest && <p className="floor-manager-event">{latest.identity.task_id}: {String(latest.source.last_event.note)}<time>{activityAt(latest) ? `Report time (from source age): ${time(activityAt(latest))}` : 'Report timestamp not published'}</time></p>}
        {home.observation.error && <p className="floor-source-warning">{home.observation.error}</p>}
      </article>
    })}</div>
    {!scene.coverage.homes.length && <p className="floor-source-warning">No configured home observations. Whole-farm coverage is unknown.</p>}
  </section>
}
function Inspector({ context, workers }: { context: Context; workers: Worker[] }) {
  const { scene, state, send } = context
  const selection = state.selection
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (selection) close.current?.focus({ preventScroll: true }) }, [selection])
  if (!selection) return null
  const exists = targetExists(scene, selection)
  const claim = selection.kind === 'claim' ? [...scene.claims, ...scene.claimHistory].find(c => c.id === selection.id) : null
  const card = scene.cards.find(c => c.id === (claim?.cardId ?? (selection.kind === 'card' ? selection.id : null)))
  const execution = scene.executions.find(e => e.id === (claim?.executionId ?? (selection.kind === 'execution' ? selection.id : null)))
  const home = scene.coverage.homes.find(h => h.source.home === (execution?.home ?? (selection.kind === 'manager' ? selection.id : null)))
  const related = [...scene.claims, ...scene.claimHistory].filter(c => c.id === claim?.id || !!card && c.cardId === card.id || !!execution && c.executionId === execution.id)
  const group = Object.values(scene.arrangements).flat().find(g => selection.kind === 'group' && g.id === selection.id)
  const findings = relatedFindings(scene, card ? [card.id] : group?.cardIds ?? [], execution ? [execution.id] : group?.executionIds ?? [], home ? [home.source.home] : [])
  const workerMatches = execution ? workers.filter(w => w.home === execution.home && w.id === execution.identity.task_id) : []
  const worker = workerMatches.length === 1 ? workerMatches[0] : null
  // Use the existing cockpit resolver too: its URL uses a home basename. Do not
  // open a same-named worker in a different home when that route is ambiguous.
  const route = worker ? { worker: worker.id, home: homeName(worker.home), key: null, q: '' } : null
  const linkable = route && findLinkedWorker(workers, route)?.key === worker?.key
  const workerHref = route && linkable ? `?${new URLSearchParams({ worker: route.worker, home: route.home })}` : null
  const cardUrl = safeLink(card?.source.url ?? null)
  return <aside className="floor-inspector" aria-label="Scene inspector" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); send({ type: 'clear-selection' }) } }}>
    <header><span className="cockpit-eyebrow">TRACE / {selection.kind}</span><button ref={close} type="button" onClick={() => send({ type: 'clear-selection' })} aria-label="Close inspector">×</button></header>
    <h2>{card ? cardTitle(card) : execution?.identity.task_id ?? group?.label ?? home?.source.home ?? (selection.kind === 'you' ? 'Your desk' : selection.kind === 'firstMate' ? 'First Mate' : 'Last-known selection')}</h2>
    {!exists && <p className="floor-source-warning">This ID is absent from the latest scene. Selection is retained; no replacement was guessed.</p>}
    <dl><dt>Semantic ID</dt><dd>{semanticId(selection)}</dd></dl>
    {selection.kind === 'you' && <p>Reading and navigating your desk do not approve, dismiss or complete work.</p>}
    {selection.kind === 'firstMate' && <p>First Mate owns execution. This floor reads configured homes across machines; whole-farm coverage is not certified.</p>}
    {card && <><p>{waitExplanation(scene, card)}</p><dl><dt>Card ID</dt><dd>{card.id}</dd><dt>Owner</dt><dd>{String(card.source.properties.Owner?.value ?? 'Unknown')}</dd><dt>Status</dt><dd>{status(card)}</dd><dt>Content edited</dt><dd>{time(card.source.last_edited_time)}</dd><dt>Next action / wait</dt><dd>{card.nextAction ?? 'Not collected or published'}</dd><dt>Checkpoint</dt><dd>{card.checkpoint.state} · {time(card.checkpoint.at)}</dd><dt>Progress assessment</dt><dd>Not collected; checkpoints and links do not prove progress</dd></dl>
      {cardUrl && <a href={cardUrl} target="_blank" rel="noopener noreferrer">Read source card ↗</a>}
      {card.parentIds.map(id => <button type="button" key={id} disabled={!scene.cards.some(c => c.id === id)} onClick={() => send({ type: 'focus', target: target('card', id) })}>Parent: {scene.cards.find(c => c.id === id) ? cardTitle(scene.cards.find(c => c.id === id)!) : `${id} (unavailable)`}</button>)}
      <button type="button" onClick={() => send({ type: 'open-queue', cardId: card.id })}>Read card context</button><p>Card prose is read on demand; omissions and source failures remain explicit.</p></>}
    {execution && <><dl><dt>Accountable home</dt><dd>{execution.home}</dd><dt>Parent home</dt><dd>{execution.parentHome ?? 'Not configured'}</dd><dt>Task / attempt</dt><dd>{execution.identity.task_id ?? 'Unknown'} / {execution.identity.spawn_gen ?? 'Unknown'}</dd><dt>Placement</dt><dd>{execution.placement.machine ?? 'Unknown'} · {execution.placement.basis}; configured: {execution.placement.configuredMachine ?? 'unknown'}</dd><dt>State</dt><dd>{String(execution.source.current_state.state ?? 'Unknown')} · activity {execution.activity}</dd><dt>State timestamp</dt><dd>{time(typeof execution.source.current_state.observed_at === 'string' ? execution.source.current_state.observed_at : null)}</dd><dt>Runtime / model</dt><dd>{String(execution.source.harness ?? 'Unknown')} / {String(execution.source.model ?? 'Unknown')}</dd><dt>Branch</dt><dd>{String(execution.source.branch ?? 'Unknown')}</dd></dl>
      <p>{String(execution.source.current_state.detail ?? 'No state detail published')}</p>
      <h3>Latest published report</h3><p>{String(execution.source.last_event.note ?? 'No report published')}</p><time>{activityAt(execution) ? `${time(activityAt(execution))} (derived from source report age)` : 'Report timestamp not published'}</time>
      {workerHref && worker?.terminalAvailable ? <a href={workerHref} target="_blank" rel="noopener noreferrer">Open safe worker / terminal viewer ↗</a> : <p>Terminal route unavailable for this exact observed worker. File-published homes are read-only.</p>}
      <p>Closing the viewer leaves the worker running.</p></>}
    {home && <><h3>Home observation</h3><dl><dt>Home</dt><dd>{home.source.home}</dd><dt>Parent</dt><dd>{home.source.parentHome ?? 'Not configured'}</dd><dt>Coverage</dt><dd>{context.readFailed || expired(home.observation, context.now) ? 'Last-known / unknown' : home.observation.status} / {home.observation.coverage}</dd><dt>Observed</dt><dd>{time(home.observation.observedAt)}</dd><dt>Expires</dt><dd>{time(home.observation.expiresAt)}</dd></dl></>}
    {group && <p>{group.counts.cards} cards · {group.counts.workers} unique workers · {group.counts.attempts} attempts. Membership can overlap other groups; totals use unions.</p>}
    {findings.length > 0 && <section><h3>Reconciliation evidence</h3>{findings.map(f => <div key={f.id} className="floor-evidence"><FindingChips findings={[f]} delayed={context.delayed} /><p>{f.reason}</p></div>)}</section>}
    {related.length > 0 && <section><h3>Relationships & observed history</h3><p>{scene.historyScope}</p>{related.map(c => <div key={c.id} className="floor-evidence">
      <FocusButton context={context} item={target('claim', c.id)}><strong>{c.verification} · {c.basis} · {c.state}</strong></FocusButton>
      <dl><dt>Source fields</dt><dd>{c.sources.join(', ')}</dd><dt>Observed</dt><dd>{time(c.observedAt)}</dd><dt>First observed</dt><dd>{time(c.firstObservedAt)}</dd><dt>Ended</dt><dd>{c.endedAt ? time(c.endedAt) : 'Not observed ended'}</dd><dt>Attempt</dt><dd>{c.identity.fm_home} / {c.identity.task_id} / {c.identity.spawn_gen}</dd></dl>
      <button type="button" disabled={!scene.cards.some(card => card.id === c.cardId)} onClick={() => send({ type: 'focus', target: target('card', c.cardId) })}>Trace card</button>
      <button type="button" disabled={!scene.executions.some(e => e.id === c.executionId)} onClick={() => send({ type: 'focus', target: target('execution', c.executionId) })}>Trace worker</button>
    </div>)}</section>}
    <p className="floor-empty">Snapshot reports and bounded relationship history only. No complete terminal/activity history is claimed.</p>
  </aside>
}

export function ReconciliationFloor({ workers }: { workers: Worker[] }) {
  const { scene, error, now } = useFloorScene()
  const { queue, error: queueError } = useDeskQueue()
  const { state, send, connection, bridgeError } = usePresentation(scene, queue, !!error)
  const root = useRef<HTMLDivElement>(null)
  const selectedId = state.selection ? semanticId(state.selection) : null
  const previousSelection = useRef<string | null>(null)
  useEffect(() => {
    const id = selectedId ?? previousSelection.current
    previousSelection.current = selectedId
    if (!id) return
    // DOM lookup is internal rendering, never part of the semantic command API.
    const elements = root.current?.querySelectorAll<HTMLElement>('[data-semantic-id]')
    const element = [...elements ?? []].find(element => element.dataset.semanticId === id)
    element?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    if (!selectedId) element?.focus({ preventScroll: true })
  }, [selectedId, state.arrangement, state.collapsed])
  const gaps = useMemo(() => scene ? scene.findings.filter(f => ['task-execution-gap', 'untracked-worker'].includes(f.kind)).flatMap(f => [
    ...f.cardIds.filter(id => scene.cards.some(c => c.id === id)).map(id => target('card', id)),
    ...f.executionIds.filter(id => scene.executions.some(e => e.id === id)).map(id => target('execution', id)),
  ]) : [], [scene])
  if (!scene) return <section className="floor"><h1>Reconciliation Floor</h1><p role="status">{error ?? 'Reading configured sources…'}</p><p>Whole-farm coverage is unknown until observations arrive.</p></section>
  const delayed = !!error || expired(scene.coverage.intentions, now) || scene.coverage.homes.some(home => expired(home.observation, now))
  const context: Context = { scene, state, send, now, delayed, readFailed: !!error }
  const exceptions = scene.findings.filter(isException)
  const sourceFindings = exceptions.filter(f => !f.cardIds.length && !f.executionIds.length)
  return <div className="floor" ref={root} data-arrangement={state.arrangement} data-revision={state.revision} data-scene-id={connection?.scene_id} onKeyDown={event => {
    if (event.key === 'Escape') { send({ type: 'clear-selection' }); send({ type: 'clear-transient' }) }
  }}>
    <header className="floor-header"><div><span className="cockpit-eyebrow">TIN STAR / TWO SOURCES · ONE SCENE</span><h1>Reconciliation Floor</h1><p>Intentions ↔ execution across the farm</p></div>
      <span className="floor-assurance">Read + presentation only</span></header>
    <div className="floor-toolbar" aria-label="Floor presentation"><div className="floor-arrangements" role="group" aria-label="Arrangement">{Object.entries(arrangements).map(([id, label]) => <button type="button" key={id} aria-pressed={state.arrangement === id} onClick={() => send({ type: 'set-arrangement', arrangement: id as keyof typeof arrangements })}>{label}</button>)}</div>
      <button type="button" aria-pressed={state.exceptionsOnly} onClick={() => send({ type: 'set-exceptions', enabled: !state.exceptionsOnly })}>Exceptions Only · {exceptions.length} findings</button>
      <button type="button" disabled={!gaps.length || delayed} onClick={() => send({ type: 'flash', targets: gaps })}>Flash gaps · {unique(gaps.map(semanticId)).length} records</button>
      <button type="button" onClick={() => send({ type: 'clear-transient' })}>Clear highlights</button>
    </div>
    <div className="floor-coverage" role="status"><strong>{delayed ? 'Unknown / last-known coverage' : 'Configured-source observations'} · whole farm not certified</strong>
      <span>{scene.counts.cards} cards · {scene.counts.workers} unique workers · {scene.counts.attempts} attempts · {scene.counts.claims} relationships. Counts cover the full configured scene; group memberships can overlap.</span>
      <span>Notion {expired(scene.coverage.intentions, now) ? 'unknown / last-known' : scene.coverage.intentions.status} / {scene.coverage.intentions.coverage} · observed {time(scene.coverage.intentions.observedAt)} · scene {time(scene.generatedAt)}</span>
      {error && <strong>{error}</strong>}{!error && delayed && <strong>Expired or unavailable observations: last-known findings are retained; absence conclusions are suspended.</strong>}
      {scene.warnings.map(warning => <span key={warning}>{warning}</span>)}
      {scene.coverage.intentions.error && <span>{scene.coverage.intentions.error}</span>}
    </div>
    {state.assistantChangedView && <div className="floor-assistant-cue" role="status">Assistant changed this view <button type="button" onClick={() => send({ type: 'clear-transient' })}>Clear cue</button></div>}
    <p className="floor-empty">Conversation view: {connection?.scene_id ?? 'connecting'}{bridgeError ? ' · disconnected; commands await acknowledgment' : ' · private MCP'}</p>
    <QueuePanel state={state} send={send} queue={queue} error={queueError} now={now} />
    <Hierarchy context={context} />
    <div className="floor-layout"><div className="floor-scene">
      <div className="floor-scene-caption"><span>{arrangements[state.arrangement]} neighborhoods</span><span>{state.exceptionsOnly ? `${exceptions.length} exception findings in configured scope` : 'Worker ↔ relationship ↔ intention'}</span></div>
      {sourceFindings.length > 0 && <div className="floor-source-warning">{sourceFindings.map(f => <p key={f.id}>{f.reason}</p>)}</div>}
      {scene.arrangements[state.arrangement].map(group => <Neighborhood key={group.id} group={group} context={context} />)}
      {state.selection && !scene.arrangements[state.arrangement].some(group => targetInGroup(scene, group, state.selection!)) && <p className="floor-empty">Selected identity retained in the inspector; it has no current membership in this arrangement.</p>}
    </div><Inspector context={context} workers={workers} /></div>
  </div>
}
