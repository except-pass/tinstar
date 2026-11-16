import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import { useDecisionDesk, requestKey, type DecisionDeskState } from './useDecisionDesk'
import { deskCall, type DeskPacket, type DeskPolicy } from './decisionDeskClient'
import { useDeskWorkspace } from '../ask/DeskWorkspace'
import { AskContextComposer, useAskControls } from '../ask/Ask'
import { AskSurface } from '../ask/AskSurface'
import { DecisionCardContext } from './Decisions'
import { WorkerNotes } from '../cockpit/shell/present'
import { findLinkedWorker, homeName } from '../cockpit/overviewQuery'
import './decision-desk.css'

const metric = (value: number | null | undefined) => value == null ? '— / unavailable' : String(value)
const safeLink = (url: string) => { try { const value = new URL(url); return value.protocol === 'https:' && !value.username && !value.password ? url : undefined } catch { return undefined } }
function Prose({ children }: { children: string }) {
  return <ReactMarkdown skipHtml components={{ a: ({ href, children }) => safeLink(href ?? '') ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>, img: ({ alt }) => <span>{alt}</span> }}>{children}</ReactMarkdown>
}
function Section({ label, children }: { label: string; children: ReactNode }) { return <section className="dd-section"><h3 className="dd-eyebrow">{label}</h3>{children}</section> }
export function DecisionDesk() {
  const workspace = useDeskWorkspace()
  const [consumedTarget, setConsumedTarget] = useState<string | null>(null)
  const entries = workspace.queue?.needsWill ?? workspace.queue?.items ?? []
  const originKey = workspace.origin?.section === 'decisions' && workspace.origin.target.kind === 'decision' ? workspace.origin.target.id : null
  const target = originKey ?? workspace.state?.queueItemId
  const navigation = workspace.state?.navigation
  const targetIdentity = JSON.stringify([originKey, workspace.state?.queueItemId, workspace.state?.queueCardId, workspace.state?.selection?.kind === 'card' ? workspace.state.selection.id : null, navigation?.revision])
  const ignoreTarget = consumedTarget === targetIdentity
  const newestNavigation = navigation?.revision === workspace.state?.revision ? navigation?.cardId : undefined
  const requested = ignoreTarget ? undefined : originKey ? entries.find(item => item.id === originKey)?.cardIds[0]
    : newestNavigation ?? workspace.state?.queueCardId ?? entries.find(item => item.id === target)?.cardIds[0] ?? (workspace.state?.selection?.kind === 'card' ? workspace.state.selection.id : undefined) ?? navigation?.cardId
  const requestedKey = ignoreTarget ? undefined : originKey ?? (!newestNavigation && !workspace.state?.queueCardId ? workspace.state?.queueItemId ?? undefined : undefined)
  const pendingTarget = !ignoreTarget && !!originKey && !requested
  const desk = useDecisionDesk(requested, pendingTarget, requestedKey, () => setConsumedTarget(targetIdentity))
  const handledTarget = useRef<string | null>(null)
  const [tab, setTab] = useState<'review' | 'preparation'>('review'), [sourceOpen, setSourceOpen] = useState(false)
  const packet = desk.claim?.packet
  useEffect(() => {
    if (desk.busy || !desk.currentSession || !requested) return
    const key = `${targetIdentity}:${requested}:${requestedKey ?? ''}`
    if (handledTarget.current === key) return
    const initialRefusal = handledTarget.current === null && desk.claim?.outcome === 'requested-unavailable'
    handledTarget.current = key
    if (initialRefusal) return
    if (requested === packet?.packet.binding.card_id && (!requestedKey || requestedKey === packet.packet.binding.request_key)) return
    void desk.claimCard(requested, requestedKey)
  }, [desk.busy, desk.currentSession, requested, requestedKey, targetIdentity, packet?.packet.binding.card_id, packet?.packet.binding.request_key])
  const openSource = () => setSourceOpen(value => !value)
  const nextWithoutTarget = () => { setConsumedTarget(targetIdentity); workspace.clearOrigin?.(); if (desk.currentSession) void desk.claimAvailable() }
  const counts = desk.snapshot?.counts
  return <section className="decision-desk" aria-label="Decisions" data-presentation-scene data-scene-id={workspace.connection?.scene_id} data-revision={workspace.state?.revision}>
    <header className="dd-top"><div className="dd-brand"><span aria-hidden="true">✦</span> Tin Star <span className="dd-slash">/</span> <strong>Decision Desk</strong></div><nav aria-label="Decision Desk views">{(['review', 'preparation'] as const).map(view => <button key={view} type="button" aria-current={tab === view ? 'page' : undefined} onClick={() => setTab(view)}>{view === 'review' ? 'Review' : 'Preparation'}</button>)}</nav></header>
    <div className="dd-status" aria-label="Queue status" title={desk.snapshot ? `Scope ${desk.snapshot.scope}; cached-source projection at ${new Date(desk.snapshot.observed_at).toLocaleString()}` : 'Queue scope and observation time unavailable'}><span>Ready <b>{counts?.ready == null ? '— / unavailable' : `${counts.ready} / ${desk.policy?.values.target_ready ?? '—'}`}</b></span>{counts?.ready != null && <meter aria-label="Ready buffer" min={0} max={desk.policy?.values.target_ready ?? 30} value={counts?.ready ?? 0} title={counts?.ready == null ? 'Ready count unavailable' : `${counts.ready} validated unleased cards`} />}<span>Preparing <b>{metric(counts?.preparing)}</b></span><span>Leased <b>{metric(counts?.leased)}</b></span><ReviewedCount refreshKey={desk.submissionRevision} /></div>
    {(!desk.snapshot || desk.snapshot.omissions.length > 0) && <p className="dd-coverage">{desk.snapshot?.omissions.join(' ') ?? 'Queue metrics unavailable: the backend or source coverage could not be verified.'}</p>}
    <div className="dd-sr" role="status" aria-live="polite">{desk.busy ? 'Decision Desk operation in progress.' : desk.notice || desk.result?.message || (packet ? 'Prepared decision loaded.' : desk.claim?.outcome)}</div>
    {tab === 'preparation' ? <Preparation desk={desk} /> : <div className="dd-layout">
      <aside className="dd-rail"><Section label="REVIEW SESSIONS">{desk.sessions.length ? desk.sessions.map(session => <div className={`dd-session ${desk.currentSession === session.id ? 'dd-current' : ''}`} key={session.id}><strong><span aria-hidden="true">{session.device === 'phone' ? '▯' : '▣'}</span> {session.label}{desk.currentSession === session.id ? ' · this session' : ''}</strong><p>{session.held?.title ?? 'No held decision'}</p></div>) : <p>Session list unavailable.</p>}<p className="dd-caption">Sessions are independent reviewing contexts. Open the original browser context to resume another session.</p><button type="button" className="dd-secondary" disabled={desk.busy || !!desk.claim?.lease} onClick={() => void desk.newSession()}>+ New review session</button></Section><Section label="PREPARED · UNLEASED">{desk.snapshot?.ready.length ? desk.snapshot.ready.slice(0, 5).map(item => <button className="dd-ready-row" key={item.id} type="button" disabled={desk.busy || !!desk.claim?.lease} onClick={() => void desk.claimCard(item.card_id, undefined, item.id)}><strong>{item.title}</strong><small>{item.risk} risk · {item.card_id}</small></button>) : <p>{desk.snapshot ? 'No validated, unleased packets in the covered source scope.' : 'Prepared inventory unavailable.'}</p>}</Section></aside>
      <main className="dd-main">{desk.notice && <p className="dd-notice" role="status">{desk.notice}</p>}{packet ? <Review key={packet.packet.binding.card_id} desk={desk} onSource={openSource} sourceOpen={sourceOpen} onNextAvailable={nextWithoutTarget} /> : <Empty desk={desk} requestedUnavailable={pendingTarget} nextWithoutTarget={nextWithoutTarget} />}</main>
      <aside className="dd-inspector" aria-label="Decision evidence inspector">{packet ? <Inspector packet={packet} count={desk.parts.length} onSource={openSource} /> : <Section label="PREPARATION SUMMARY"><p>{desk.snapshot?.runner.explanation ?? 'Preparation status unavailable.'}</p></Section>}</aside>
    </div>}
  </section>
}
function ReviewedCount({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<{ reviewed_today_utc: number; recording_started_at: string | null; scope: string } | null>(null)
  useEffect(() => { let active = true; void deskCall<NonNullable<typeof data>>('metrics').then(value => { if (active) setData(value) }).catch(() => {}); return () => { active = false } }, [refreshKey])
  return <span title={data ? `Confirmed source requests today, UTC, in ${data.scope}; recording since ${data.recording_started_at ?? 'unavailable'}. Worker acknowledgment is separate.` : 'Reviewed metrics could not be verified'}>Reviewed today (UTC) <b>{metric(data?.reviewed_today_utc)}</b></span>
}
function Empty({ desk, requestedUnavailable = false, nextWithoutTarget }: { desk: DecisionDeskState; requestedUnavailable?: boolean; nextWithoutTarget: () => void }) {
  const outcome = desk.claim?.outcome
  requestedUnavailable ||= outcome === 'requested-unavailable'
  const conflict = desk.claim?.code === 'card-held'
  const title = requestedUnavailable ? 'Requested source request is not ready for review.' : conflict ? 'This decision is held by another review session.' : desk.error || outcome === 'source-unavailable' || outcome === 'next-unavailable' ? 'Decision Desk unavailable.' : outcome === 'no-decision-requests' ? 'No decision requests in the verified source scope.' : !desk.claim ? 'Opening your review session…' : 'No prepared decisions ready.'
  return <div className="dd-empty"><span className="dd-eyebrow">REVIEW</span><h1>{title}</h1><p>{requestedUnavailable ? desk.error ?? desk.claim?.message ?? 'The exact source request and canonical card binding are not available in the current source observation. No substitute decision was claimed.' : conflict ? `Held by ${desk.claim?.lease?.holder ?? 'another reviewer'} until ${desk.claim?.lease?.expires_at ?? 'unavailable'}. Claim the next prepared decision to continue.` : desk.error ?? (outcome === 'no-decision-requests' ? 'There are no unanswered source requests in the verified scope.' : desk.snapshot?.runner.explanation ?? 'Source coverage and preparation status could not be verified. Outstanding decisions may still exist.')}</p>{desk.snapshot && outcome !== 'no-decision-requests' && <p>{metric(desk.snapshot.counts.preparing)} preparing · {desk.snapshot.coverage === 'complete' ? 'Source coverage complete at the last observation.' : 'Source coverage incomplete or unavailable.'}</p>}<button type="button" className="dd-secondary" disabled={desk.busy} onClick={() => requestedUnavailable ? nextWithoutTarget() : void desk.retryClaim()}>{requestedUnavailable ? 'Claim next prepared decision' : 'Refresh prepared decisions'}</button></div>
}
const failureCopy: Record<string, string> = {
  'not-saved': 'Answer was not saved. Your selection is retained. Retry without advancing.',
  'save-unconfirmed': 'Save status unconfirmed — confirming result. Your selection is retained. Retry the same operation ID.',
  'saving': 'Save status unconfirmed — confirming result. Your selection is retained.',
  'selected': 'Retained selection recovered. Retry without advancing.',
  'packet-invalidated': 'Packet invalidated — source revision changed. Refresh research before deciding.',
  'lease-lost': 'Lease expired or lost. Re-claim and revalidate before writing. Your selection is retained.',
  'source-unavailable': 'Source verification unavailable. Refresh evidence before deciding. Your selection is retained.',
  'recorded-releasing': 'Decision recorded. Releasing the previous lease is pending. Retry the same operation ID.',
}
function Review({ desk, onSource, sourceOpen, onNextAvailable }: { desk: DecisionDeskState; onSource: () => void; sourceOpen: boolean; onNextAvailable: () => void }) {
  const held = desk.claim!, stored = held.packet!, packet = stored.packet
  const actions = useRef<HTMLElement>(null)
  useEffect(() => {
    const strip = actions.current, root = strip?.closest<HTMLElement>('.decision-desk')
    if (!strip || !root) return
    // Reserve the rendered height, including wrapped actions, so the last choice
    // and evidence can scroll above the sticky strip at zoom and narrow widths.
    const measure = () => root.style.setProperty('--dd-action-height', `${strip.getBoundingClientRect().height}px`)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(strip); window.addEventListener('resize', measure); measure()
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); root.style.removeProperty('--dd-action-height') }
  }, [])
  const [confirm, setConfirm] = useState(false), [research, setResearch] = useState(false), [reason, setReason] = useState('')
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const pendingWrite = held.code === 'source-write-pending'
  const expired = !held.lease || Date.parse(held.lease.expires_at) <= now || held.code === 'claim-lost' || held.code === 'card-held' || held.outcome === 'lease-lost' || desk.result?.outcome === 'lease-lost'
  const stale = held.outcome === 'packet-invalidated' || desk.result?.outcome === 'packet-invalidated' || !stored.validation.valid || !stored.validation.valid_until || Date.parse(stored.validation.valid_until) <= now || Date.parse(stored.expires_at) <= now
  const parts = desk.parts.length ? desk.parts : [stored]
  const blockedResult = ['packet-invalidated', 'source-unavailable', 'lease-lost', 'answer-conflict', 'blocked-recovery'].includes(desk.result?.outcome ?? '')
  const retry = parts.some(part => !!desk.attempts[requestKey(part)])
  const reconcileRetained = retry && (!desk.result || ['save-unconfirmed', 'saving', 'blocked-recovery', 'lease-lost', 'recorded-releasing', 'selected'].includes(desk.result.outcome))
  const chosen = parts.every(part => !!desk.selections[requestKey(part)])
  const high = parts.some(part => part.packet.risk.rating === 'High' || part.packet.reversibility.rating === 'Difficult')
  const retainedUnconfirmed = retry && ((!desk.busy && !desk.result) || ['save-unconfirmed', 'saving', 'blocked-recovery', 'recorded-releasing'].includes(desk.result?.outcome ?? ''))
  const blocked = expired || stale || blockedResult || pendingWrite
  useEffect(() => { if (blocked) setConfirm(false) }, [blocked])
  useEffect(() => { if (desk.result?.outcome === 'confirmation-required') setConfirm(true) }, [desk.result])
  const message = pendingWrite ? failureCopy['save-unconfirmed'] : expired ? failureCopy['lease-lost'] : retainedUnconfirmed ? failureCopy[desk.result?.outcome === 'recorded-releasing' ? 'recorded-releasing' : 'save-unconfirmed'] : stale ? failureCopy['packet-invalidated'] : desk.result && !desk.result.outcome.startsWith('recorded') ? failureCopy[desk.result.outcome] ?? desk.result.message : desk.result?.outcome === 'recorded-releasing' ? failureCopy['recorded-releasing'] : null
  const submitLabel = retry ? (desk.result?.outcome === 'save-unconfirmed' ? 'Confirm save status' : 'Retry without advancing') : 'Submit decision & next →'
  return <>
    <div className="dd-review-content">
    {message && <div className={`dd-banner ${expired || desk.result?.outcome === 'not-saved' ? 'dd-danger' : ''}`} role="alert"><strong>{message}</strong>{desk.result?.progress?.length ? <p>Independent source requests already recorded: {desk.result.progress.map(item => item.request_id).join(', ')}. This request remains unresolved.</p> : null}{desk.result?.reasons?.length ? <details><summary>View details</summary>{desk.result.reasons.map(text => <p key={text}>{text}</p>)}</details> : null}{blocked && held.code === 'card-held' && !retry && <button className="dd-secondary" type="button" disabled={desk.busy} onClick={onNextAvailable}>Claim next prepared decision</button>}{blocked && reconcileRetained && <button className="dd-secondary" type="button" disabled={desk.busy} onClick={() => void desk.submit()}>Confirm retained save status</button>}{blocked && !pendingWrite && !retainedUnconfirmed && <button className="dd-secondary" type="button" disabled={desk.busy} onClick={() => void (stale && !expired ? desk.release('research', 'Packet stale; refresh required') : desk.retryClaim())}>{stale && !expired ? 'Refresh packet & next' : 'Re-claim & revalidate'}</button>}</div>}
    {desk.error && <p className="dd-banner dd-danger" role="alert">{desk.error}</p>}
    <div className="dd-identifiers" data-semantic-id={`card:${packet.binding.card_id}`} data-decision-id={packet.binding.request_key} tabIndex={-1}><span className="dd-eyebrow">DECISION · {packet.binding.card_id}</span><small>Request {packet.binding.request_id}</small>{!expired && <span className="dd-lease">Leased to this session</span>}</div>
    <h1>{packet.title}</h1><div className="dd-question"><Prose>{packet.question}</Prose></div>
    <Section label="BACKGROUND"><div className="dd-background"><Prose>{packet.background}</Prose></div>{packet.background.length > 400 && <details><summary>Read full background</summary><Prose>{packet.background}</Prose></details>}</Section>
    <div className="dd-recommendation"><h3 className="dd-eyebrow">PREPARATION AGENT RECOMMENDS</h3><strong>{packet.binding.options.find(option => option.id === packet.recommended_option_id)?.label}</strong><Prose>{packet.rationale}</Prose><p className="dd-caption">{packet.confidence} confidence · Advisory recommendation; choose your answer below.</p>{packet.uncertainty.length === 1 ? <p className="dd-caption">Uncertainty: {packet.uncertainty[0]}</p> : packet.uncertainty.length > 1 && <details open={packet.confidence === 'Low'}><summary>Uncertainty{packet.confidence === 'Low' ? ' · low confidence' : ''}</summary><ul>{packet.uncertainty.map(text => <li key={text}>{text}</li>)}</ul></details>}</div>
    {packet.confidence === 'Low' && <div className="dd-banner"><strong>Low confidence</strong><p>Review these unknowns before deciding. Request more research if they affect your authorization.</p>{packet.material_unknowns.map(text => <p key={text}>{text}</p>)}</div>}
    <Assessments packet={stored} />
    <Section label="YOUR DECISION">{desk.snapshot?.recorded_requests.filter(item => item.card_id === packet.binding.card_id).map(item => <p className="dd-caption" key={`${item.request_id}:${item.confirmed_at}`}>Independent request {item.request_id} durably recorded at {new Date(item.confirmed_at).toLocaleString()}. Each request is reviewed separately.</p>)}{parts.map(part => <fieldset key={requestKey(part)} className="dd-choices" disabled={desk.busy || blocked || !!desk.attempts[requestKey(part)]}><legend>Choose one source option</legend><p className="dd-caption">Request {part.packet.binding.request_id}</p>{part.packet.binding.options.map(option => <label key={option.id} className={`dd-option ${desk.selections[requestKey(part)] === option.id ? 'dd-selected' : ''}`}><input type="radio" name={requestKey(part)} value={option.id} checked={desk.selections[requestKey(part)] === option.id} onChange={() => desk.select(part, option.id)} /><span>{option.label}{option.id === part.packet.recommended_option_id && <small>Recommended</small>}</span></label>)}</fieldset>)}</Section>
    <details className="dd-inline-evidence"><summary>Evidence, confidence & execution boundaries</summary><Inspector packet={stored} count={parts.length} onSource={onSource} /></details>
    {sourceOpen && <details className="dd-source-context" open><summary>Source request & discussion</summary><SourceDiscussion packet={stored} /></details>}
    </div>
    <footer ref={actions} className="dd-actions"><button type="button" className="dd-primary" disabled={desk.busy || blocked || !chosen} onClick={() => high && !retry ? setConfirm(true) : void desk.submit()}>{desk.busy ? 'Saving / verifying…' : submitLabel}</button><button type="button" className="dd-secondary" disabled={desk.busy || retry} onClick={() => void desk.release('skip')}>Skip</button><button type="button" className="dd-text" disabled={desk.busy || retry} onClick={() => setResearch(value => !value)}>Need more research</button></footer>
    {research && <div className="dd-research"><label>Research needed (optional)<textarea value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} /></label><button type="button" className="dd-secondary" disabled={desk.busy} onClick={() => { setResearch(false); void desk.release('research', reason) }}>Request research & next</button><button className="dd-text" type="button" onClick={() => setResearch(false)}>Cancel</button></div>}
    {confirm && <Confirmation parts={parts} selections={desk.selections} onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void desk.submit(true) }} />}
  </>
}
function Assessments({ packet: { packet } }: { packet: DeskPacket }) {
  return <div className="dd-assessments"><section><h3>Decision risk</h3><strong className={`dd-rating dd-${packet.risk.rating.toLowerCase()}`}>{packet.risk.rating}</strong><Prose>{packet.risk.explanation}</Prose><p className="dd-caption">Blast radius: {packet.risk.blast_radius}</p></section><section><h3>Reversibility</h3><strong className="dd-rating">{packet.reversibility.rating}</strong><Prose>{packet.reversibility.explanation}</Prose><p className="dd-caption">Rollback: {packet.reversibility.rollback}</p></section></div>
}
function Inspector({ packet: stored, count, onSource }: { packet: DeskPacket; count: number; onSource: () => void }) {
  const packet = stored.packet
  return <><Section label="PREPARATION SUMMARY"><p>{stored.validation.valid ? 'Source binding validated' : 'Source verification required'}</p><dl><dt>Confidence</dt><dd>{packet.confidence}</dd><dt>Packet</dt><dd>Version {stored.version}</dd><dt>Published</dt><dd>{new Date(stored.published_at).toLocaleString()}</dd><dt>Fresh through</dt><dd>{stored.validation.valid_until ? new Date(stored.validation.valid_until).toLocaleString() : 'Unavailable'}</dd><dt>Answer parts</dt><dd>{count || 1} independent source request{count === 1 ? '' : 's'}</dd></dl><details><summary>Source revision & preparation</summary><p>Source record: {packet.binding.source_id}</p><p>{stored.validation.valid ? 'Exact semantic source revision matched this immutable packet at validation.' : 'Source revision is not verified; refresh is required.'}</p><p>Packet version {stored.version} · content digest {stored.content_hash}</p><p>Prepared by {stored.prepared_by}</p><p>Source generation: {packet.binding.source_spawn_gen ?? 'Unavailable'}</p></details></Section><Section label="AFTER YOU APPROVE"><details><summary>Impact, likelihood & rollback</summary><p>{packet.risk.likelihood}</p><p>{packet.risk.blast_radius}</p><p>{packet.reversibility.rollback}</p><p>{packet.reversibility.residual_exposure}</p></details><Prose>{packet.authorization.scope}</Prose><p>{packet.authorization.next_owner} · {packet.authorization.next_status}</p><Prose>{packet.authorization.permitted_follow_up}</Prose><ul>{packet.authorization.remaining_gates.map(text => <li key={text}>{text}</li>)}</ul></Section><Section label="EVIDENCE & PROVENANCE">{packet.references.map(reference => safeLink(reference.url) ? <a className="dd-reference" key={reference.url} href={reference.url} target="_blank" rel="noreferrer">{reference.label} ↗</a> : <p key={reference.url}>{reference.label} · Link unavailable</p>)}<details><summary>Full background, consequences & unknowns</summary><Prose>{packet.background}</Prose>{[...packet.consequences, ...packet.impacted, ...packet.prerequisites, ...packet.uncertainty, ...packet.material_unknowns].map((text, i) => <p key={i}>{text}</p>)}</details><details><summary>Freshness & invalidation</summary>{packet.invalidation_conditions.map(text => <p key={text}>{text}</p>)}{stored.validation.reasons.map(text => <p key={text}>{text}</p>)}</details><button className="dd-text" type="button" onClick={onSource}>Source request & discussion</button></Section></>
}
function SourceDiscussion({ packet: { packet } }: { packet: DeskPacket }) {
  const controls = useAskControls(), workspace = useDeskWorkspace()
  const source = packet.binding.source_request
  const matches = (workspace.workers ?? []).filter(worker => worker.home === source.home && worker.id === source.taskId)
  const worker = matches.length === 1 ? matches[0] : null
  const route = worker ? { worker: worker.id, home: homeName(worker.home), key: null, q: '' } : null
  const linked = route ? findLinkedWorker(workspace.workers, route) : null
  const href = worker && linked?.home === worker.home && linked.id === worker.id && route ? `?${new URLSearchParams({ worker: route.worker, home: route.home })}` : null
  const latest = controls?.items.filter(item => item.context.target?.kind === 'decision' && item.context.target.id === packet.binding.request_key).at(-1)
  const subject = { target: { kind: 'decision' as const, id: packet.binding.request_key }, view: { scene: 'decisions' as const, request_key: packet.binding.request_key, query: '' }, label: packet.title }
  return <AskSurface as="section" subject={subject}><DecisionCardContext readOnly id={packet.binding.card_id} /><p>Discussion is bound to source request {packet.binding.request_id}. Sending a question does not answer this decision.</p>{href && <a className="dd-reference" href={href} target="_blank" rel="noreferrer">Open source terminal ↗</a>}{workspace.scene?.cards.some(card => card.id === packet.binding.card_id) && <button type="button" className="dd-text" onClick={() => workspace.send({ type: 'navigate-card', cardId: packet.binding.card_id })}>Open related work</button>}{latest ? <button type="button" className="dd-secondary" onClick={() => { controls!.setDeskVisible(true); controls!.showThread(latest); workspace.openDesk() }}>Open source conversation in Discuss</button> : <p className="dd-caption">No First Mate exchange is published for this request yet.</p>}{controls?.deskVisible && controls.expanded ? <p className="dd-caption">Continue in the open Discuss conversation.</p> : <AskContextComposer compact subject={subject} />}</AskSurface>
}
function Confirmation({ parts, selections, onCancel, onConfirm }: { parts: DeskPacket[]; selections: Record<string, string>; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), [checked, setChecked] = useState(false)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { dialog.current?.close(); previous?.focus() }
  }, [])
  return <dialog className="dd-modal" ref={dialog} aria-labelledby="dd-confirm-title" onCancel={event => { event.preventDefault(); onCancel() }} onKeyDown={event => {
    if (event.key !== 'Tab') return
    // Native dialog can hand Tab focus to browser chrome. Keep the review
    // confirmation within its currently enabled confirmation controls.
    const controls = [...dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]') ?? []].filter(control => control.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}><h2 id="dd-confirm-title">Confirm this bounded decision</h2><p>Review the exact choices, adverse impact and what this answer permits.</p>{parts.map(part => <section key={requestKey(part)}><h3>{part.packet.binding.options.find(option => option.id === selections[requestKey(part)])?.label}</h3><p><b>Authorized scope:</b> {part.packet.authorization.scope}</p><p><b>Adverse impact:</b> {part.packet.risk.explanation} {part.packet.risk.blast_radius}</p><p><b>Reversibility · {part.packet.reversibility.rating}:</b> {part.packet.reversibility.rollback} {part.packet.reversibility.residual_exposure}</p><p><b>Next:</b> {part.packet.authorization.next_owner} · {part.packet.authorization.next_status}. {part.packet.authorization.permitted_follow_up}</p><ul>{part.packet.authorization.remaining_gates.map(text => <li key={text}>{text}</li>)}</ul></section>)}<label className="dd-check"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />I confirm these selected options within the stated scope.</label><div className="dd-modal-actions"><button type="button" className="dd-secondary" autoFocus onClick={onCancel}>Cancel</button><button type="button" className="dd-primary" disabled={!checked} onClick={onConfirm}>Confirm & submit decision</button></div></dialog>
}
function Preparation({ desk }: { desk: DecisionDeskState }) {
  const workspace = useDeskWorkspace()
  const retained = (workspace.messages ?? []).filter(message => message.kind === 'message' && !(workspace.workers ?? []).some(worker => worker.home === message.home && worker.id === message.taskId))
  const [values, setValues] = useState<DeskPolicy['values'] | null>(desk.policy?.values ?? null)
  const [saving, setSaving] = useState(false), [message, setMessage] = useState('')
  const observedPolicy = useRef(desk.policy)
  useEffect(() => {
    // A cached-source refresh must not erase settings the reviewer is editing.
    if (observedPolicy.current?.scope !== desk.policy?.scope || observedPolicy.current?.version !== desk.policy?.version) {
      observedPolicy.current = desk.policy; setValues(desk.policy?.values ?? null)
    }
  }, [desk.policy])
  const counts = desk.snapshot?.counts
  return <main className="dd-preparation"><span className="dd-eyebrow">DECISION PREPARATION / CONFIGURATION</span><h1>Keep decisions ready before I ask.</h1><p>Set the buffer of validated, unleased decision packets for rapid review.</p><div className="dd-stats">{[['Ready · unleased', counts?.ready], ['Preparing now', counts?.preparing], ['Leased to sessions', counts?.leased], ['Needs re-preparation', counts?.needs_repreparation]].map(([label, value]) => <div key={label as string}><span>{label}</span><strong>{metric(value as number | null | undefined)}</strong></div>)}</div><p className="dd-banner">{desk.snapshot?.runner.explanation ?? 'Preparation runner status unavailable.'}</p><div className="dd-prep-panels"><section className="dd-panel"><h2 className="dd-eyebrow">QUEUE POLICY</h2>{values ? <><label className="dd-range"><span>Target ready depth <output>{values.target_ready}</output></span><input aria-label="Target ready depth" type="range" min="1" max="30" value={values.target_ready} onChange={event => setValues({ ...values, target_ready: Number(event.target.value) })} /><small>Keep this many validated, unleased decisions available</small></label><label className="dd-range"><span>Maximum parallel preparers <output>{values.max_preparers}</output></span><input aria-label="Maximum parallel preparers" type="range" min="1" max="8" value={values.max_preparers} onChange={event => setValues({ ...values, max_preparers: Number(event.target.value) })} /><small>Worker cap, 1–8. No runner is currently configured.</small></label><label className="dd-check dd-policy-toggle"><span><strong>Automatic replenishment</strong><small>When a runner is configured, start eligible work after claims, answers and invalidation.</small></span><input type="checkbox" role="switch" checked={values.automatic_replenishment} onChange={event => setValues({ ...values, automatic_replenishment: event.target.checked })} /></label><div className="dd-order"><strong>Review ordering</strong><p>Existing Tin Star readiness, next checkpoint, then canonical ID. Source requests are not silently reordered.</p></div><button className="dd-primary" type="button" disabled={saving} onClick={async () => { setSaving(true); setMessage(''); try { await desk.savePolicy(values); setMessage('Queue policy saved. No preparation runner is configured.') } catch (error) { setMessage(`Settings were not confirmed saved. ${error instanceof Error ? error.message : 'Backend unavailable'}`) } finally { setSaving(false) } }}>{saving ? 'Saving policy…' : 'Save queue policy'}</button><p className="dd-caption">Effective saved policy: {desk.policy?.values.target_ready} ready · {desk.policy?.values.max_preparers} preparers · automatic {desk.policy?.values.automatic_replenishment ? 'on' : 'off'}. Version {desk.policy?.version}.</p></> : <p>Effective settings unavailable. Retry after backend access is restored.</p>}{message && <p role="status">{message}</p>}</section><section className="dd-panel"><h2 className="dd-eyebrow">PREPARATION PIPELINE</h2><div className="dd-pipeline">{[['To prepare', counts?.to_prepare], ['Working', counts?.preparing], ['Ready', counts?.ready], ['Leased', counts?.leased]].map(([label, value]) => <div key={label as string}><strong>{metric(value as number | null | undefined)}</strong><span>{label}</span></div>)}</div><h3 className="dd-eyebrow">UP NEXT FOR PREPARATION</h3>{desk.snapshot?.pending.some(row => row.state !== 'Ready' && row.state !== 'Leased') ? desk.snapshot.pending.filter(row => row.state !== 'Ready' && row.state !== 'Leased').slice(0, 5).map((row, index) => <article className="dd-pending" key={`${row.card_id}:${row.request_id}:${index}`}><strong>{row.title}</strong><small>{row.card_id} · {row.request_id ?? 'Unverified request identity'}</small><span>{row.state} · no runner configured</span>{row.reasons.length > 0 && <details><summary>Evidence & next action</summary>{row.reasons.map(text => <p key={text}>{text}</p>)}<p>Refresh authoritative source evidence before preparation. No automatic retry is scheduled.</p></details>}</article>) : <p>{desk.snapshot?.counts.requests === 0 ? 'No decision requests in the verified scope.' : desk.snapshot?.coverage === 'complete' ? 'No pending preparation rows in the verified scope.' : 'Pending source work unavailable or not yet verified.'}</p>}</section></div>{!!desk.snapshot?.source_failures?.length && <details className="dd-rules"><summary>Source verification unavailable</summary>{desk.snapshot.source_failures.map(failure => <section key={failure.card_id}><strong>Card {failure.card_id}</strong>{failure.reasons.map(reason => <p key={reason}>{reason}</p>)}</section>)}</details>}{retained.length > 0 && <details className="dd-rules"><summary>Source delivery details</summary><WorkerNotes messages={retained} submit={workspace.submit} /></details>}<details className="dd-rules"><summary>Processing rules</summary><p>Notion cards and exact source requests remain authoritative. Preparation publishes advisory packets; it cannot answer or authorize work. Review leases last 60 minutes and are separate from preparation locks. Changed requests, expired evidence and lost leases block submission. Answer retries retain the original operation ID; durable source readback precedes the next card. No preparation runner, scheduler or retry process is started by these settings.</p></details></main>
}
