import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useDeskWorkspace } from '../ask/DeskWorkspace'
import { AskSurface } from '../ask/AskSurface'
import { AskContextComposer } from '../ask/Ask'
import { askElement } from '../ask/element'
import { useViewSnapshot } from '../ask/workspaceHistory'
import type { AskReturn } from '../shared/ask'
import { SmartSearch } from '../reconciliation/SmartSearch'
import { initialPresentation, type Target } from '../shared/reconciliationPresentation'
import type { ReleasesRead } from '../shared/releases'
import { eligibleReleaseNote, type ReleaseChange, type ReleaseObject } from '../shared/releaseObjects'
import { releaseDocuments } from './model'
import { releaseChanges } from './releaseChanges'
import './releases.css'

type Tab = 'changes' | 'acceptance' | 'notes'
type Mode = 'plan' | 'verify'
interface ReleaseView { mode: Mode; id: string | null; tab: Tab; audience: 'internal' | 'customer'; drawer: string | null }
const defaultTab = (mode: Mode): Tab => mode === 'plan' ? 'changes' : 'acceptance'
const tone = (state: string) => ['Passed', 'Deployed', 'Ready', 'Accepted'].includes(state) ? 'good' : state === 'Failed' ? 'bad' : state === 'Running' ? 'active' : ['Blocked', 'Human review', 'Partial rollout', 'Needs review', 'Superseded'].includes(state) ? 'warn' : 'neutral'
const kind = (release: ReleaseObject) => release.kind === 'candidate' ? 'RC' : release.kind === 'draft' ? 'DRAFT' : 'PROD'
const releaseTitle = (release: ReleaseObject) => `${release.kind === 'candidate' ? 'RC ' : release.kind === 'draft' ? 'Draft ' : ''}${release.version}`
const short = (value: string | null) => value?.replace(/^sha256:/, '').slice(0, 10) ?? 'Unknown'
const external = (url: string | null) => url?.startsWith('https://') ? url : undefined
function tabKeys(event: KeyboardEvent<HTMLElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length
  event.preventDefault(); tabs[index]?.focus(); tabs[index]?.click()
}
const Dot = ({ state }: { state: string }) => <span className={tone(state)}><i className="status-dot" aria-hidden="true" /> {state}</span>
const Pair = ({ label, children }: { label: string; children: ReactNode }) => <div className="detail-pair"><span className="key">{label}</span><span className="value">{children}</span></div>
const Break = ({ label }: { label: string }) => <><div className="detail-hr" /><div className="detail-label">{label}</div></>

export function ReleaseDetail({ release, change, close, origin }: { release: ReleaseObject; change?: ReleaseChange; close: () => void; origin?: AskReturn }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const opener = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close(); if (opener.current?.isConnected) opener.current.focus() }
  }, [])
  useEffect(() => {
    if (origin?.section !== 'releases') return
    const element = dialog.current?.querySelector<HTMLElement>('.ask-origin')
    element?.scrollIntoView({ block: 'nearest' }); element?.focus({ preventScroll: true })
  }, [origin])
  const next = !change ? release.kind === 'production' ? 'Review exact component receipts and outstanding source gaps. Production acceptance is separate from delivery.' : 'Review the frozen scope and build/DEV readiness. A candidate does not prove deployment.'
    : !change.successCondition ? 'No acceptance contract defined. Define the feature-specific success condition, safe method and check reference before claiming acceptance.'
    : change.delivery !== 'Deployed' ? 'The required components are not proven in this production record. Await exact target deployment evidence.'
    : change.acceptance === 'Failed' ? 'Production acceptance failed. Route remediation to the work owner; this work remains open.'
    : change.acceptance === 'Human review' ? 'The named reviewer must record the result and specific production evidence.'
    : change.acceptance === 'Running' ? 'The feature-specific check is running. No passing result is claimed yet.' : 'Review all required PRs, targets and checks before completing linked work.'
  return <dialog ref={dialog} className="drawer" aria-labelledby="release-detail-title" onCancel={close} onKeyDown={event => {
    if (event.key !== 'Tab') return
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],summary,input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(element => !element.closest('details:not([open])') || element.matches('details:not([open])>summary'))
    const first = focusable[0], last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }} onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close() } }}>
    <header className="drawer-head"><div><div className="overline">{releaseTitle(release)} / {change ? 'CHANGE' : 'SOURCE EVIDENCE'}</div><h2 className="d-title" id="release-detail-title">{change?.title ?? 'Release evidence'}</h2></div><button autoFocus type="button" className="drawer-close" aria-label="Close details" onClick={close}>×</button></header>
    <div className="drawer-body"><div className="detail-outcome">{change ? `${change.delivery} · ${change.acceptance === 'Unknown' ? 'Acceptance unknown' : change.acceptance}` : release.state}</div><div className="detail-explain">{next}</div>
      <Break label="Release identity" /><Pair label="Release">{releaseTitle(release)} · {release.repository}</Pair><Pair label="Freshness">{release.provenance.historical ? 'Snapshot as of' : 'Observed as of'} {release.provenance.asOf}</Pair>
      {change && <><Break label="Included work" /><Pair label="Product">{change.product}</Pair><Pair label="Notion work">{change.cardId ? <a href={`?card=${encodeURIComponent(change.cardId)}`}>Open linked card ↗</a> : 'Unlinked PR · no explicit Notion association'}</Pair>{change.pulls.map(pull => <AskSurface as="div" key={pull.id} subject={{ target: { kind: 'pull', id: pull.id, ...(pull.head ? { head: pull.head } : {}) }, label: pull.id, view: { scene: 'releases', release_id: release.id } }} tabIndex={-1} data-ask-origin={pull.id} className={origin?.section === 'releases' && origin.target.kind === 'pull' && origin.target.id === pull.id ? 'ask-origin' : undefined}><Pair label="GitHub PR"><a {...askElement('title', 'GitHub PR')} href={pull.url} target="_blank" rel="noreferrer">{pull.id} ↗</a></Pair><details><summary>Ask First Mate about this PR</summary><AskContextComposer subject={{ target: { kind: 'pull', id: pull.id, ...(pull.head ? { head: pull.head } : {}) }, label: pull.title ?? pull.id, view: { scene: 'releases', release_id: release.id } }} /></details></AskSurface>)}<Pair label="Required PRs">{change.requiredPulls.length}; {change.requiredPulls.filter(url => !release.pulls.some(pull => pull.url === url)).length} outside this release range</Pair><Pair label="Component target">{change.targets.map(target => target.component).join(', ') || 'Mapping unknown'}</Pair>
        <Break label="Production success condition" /><div className="detail-explain">{change.successCondition ?? 'No acceptance contract defined'}</div><Pair label="Method / reference">{change.method ?? 'Not defined'} · {change.checkRef ?? 'No check reference'}</Pair></>}
      <Break label="Evidence" />{change && <div className="detail-explain">{change.acceptanceEvidence ?? 'No feature-specific production result recorded'}</div>}
      {(change ? change.targets : release.targets).length ? (change ? change.targets : release.targets).map(target => {
        const receipt = target.receipt
        const content = <Pair label={target.component}>{receipt ? <><span {...askElement('receipt')}>{receipt.outcome} · {receipt.deployedAt}</span><br /><a href={external(receipt.receiptUrl)} target="_blank" rel="noreferrer">Read component receipt ↗</a> · <a href={external(receipt.workflowUrl)} target="_blank" rel="noreferrer">GitHub Actions evidence ↗</a></> : 'No production receipt for this target'}</Pair>
        const matchingPulls = (change?.pulls ?? [...release.pulls, ...(release.supportingPulls ?? [])]).filter(pull => pull.deployment?.targets.some(item => item.component === target.component && item.target === target.target && item.receipt?.id === receipt?.id))
        // A target receipt can prove several PRs; retain the PR captured by Discuss.
        const pull = matchingPulls.find(pull => origin?.section === 'releases' && origin.target.id === pull.id) ?? matchingPulls[0]
        const selected = origin?.section === 'releases' && origin.target.id === pull?.id && (origin.target.kind === 'receipt' && origin.target.receipt_id === receipt?.id || origin.target.kind === 'release') && origin.target.component === target.component && origin.target.target === target.target
        return receipt && pull ? <AskSurface as="div" key={`${target.component}:${target.target}`} subject={{ target: { kind: 'receipt', id: pull.id, component: target.component, target: target.target, receipt_id: receipt.id }, label: `${pull.id} · receipt ${receipt.id}`, view: { scene: 'releases', release_id: release.id } }} data-receipt-id={receipt.id} data-component={target.component} data-target={target.target} tabIndex={-1} className={selected ? 'ask-origin' : undefined}>{content}<details><summary>Ask First Mate about this receipt</summary><AskContextComposer subject={{ target: { kind: 'receipt', id: pull.id, component: target.component, target: target.target, receipt_id: receipt.id }, view: { scene: 'releases', release_id: release.id } }} /></details></AskSurface> : <Fragment key={`${target.component}:${target.target}`}>{content}</Fragment>
      }) : <div className="detail-explain">Required component/target mapping is missing. Git membership does not establish component delivery.</div>}
      {change && <><Break label="Release-note eligibility" /><div className="detail-explain">{release.kind !== 'production' ? 'Planning preview only. No deployment or acceptance claim.' : eligibleReleaseNote(release, change) ? 'Eligible — required deployment and feature acceptance are evidenced.' : 'Not eligible until membership, linked work, required deployment and feature acceptance are evidenced.'}</div></>}
      <details className="source-gaps"><summary>Exact coordinator identities</summary><Pair label="Source">{release.provenance.source}</Pair><Pair label="Source SHA">{release.sourceSha ?? 'Unknown'}</Pair><Pair label="Candidate">{release.candidateId ?? 'Not frozen'}</Pair><Pair label="Frozen plan">{release.planId ?? 'Not frozen'}</Pair><Pair label="Execution / receipt">{release.executionId ?? 'Not deployed by this candidate'}</Pair><Pair label="Git change range">{release.membership.baseline ?? 'Previous source unknown'} → {release.version} · {release.membership.status}</Pair>{(change ? change.targets : release.targets).map(target => <Fragment key={`${target.component}:${target.target}`}><Pair label="Exact target">{target.component} · {target.target}</Pair><Pair label="Build/DEV readiness">{target.readiness}; not production acceptance</Pair>{target.readinessEvidence.map((check, index) => <Pair key={index} label={check.name}>{check.status} {external(check.url) && <a href={check.url!} target="_blank" rel="noreferrer">Build/DEV evidence ↗</a>}</Pair>)}</Fragment>)}</details>
      <Break label="Source gaps" /><ul className="evidence-list">{release.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul><div className="detail-explain">{release.membership.reason ?? 'Git membership read complete.'} A published GitHub Release or tag is not production deployment evidence.</div>
    </div>
  </dialog>
}

export function ReleaseNotes({ release, changes, audience, setAudience }: { release: ReleaseObject; changes: ReleaseChange[]; audience: 'internal' | 'customer'; setAudience: (value: 'internal' | 'customer') => void }) {
  const [copied, setCopied] = useState('')
  const plan = release.kind !== 'production'
  const eligible = changes.filter(change => plan ? !!change.note : eligibleReleaseNote(release, change))
  const included = eligible.filter(change => audience === 'internal' || change.audience === 'customer')
  const groups = [...new Set(included.map(change => change.product))]
  const text = [releaseTitle(release), plan ? 'Planning preview (not published)' : 'Draft release notes (not published)', `${release.repository} · ${audience}`, '', ...groups.flatMap(product => [product, ...included.filter(change => change.product === product).map(change => `- ${change.note}`), '']), ...(!included.length ? ['No changes are currently eligible for this audience.'] : [])].join('\n')
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied('Release notes copied') }
    catch { setCopied('Copy unavailable. Select the draft text to copy it.') }
  }
  return <><header className="section-head"><div><h3>Release notes</h3><p>{plan ? 'Planning preview only. No deployment or acceptance claim.' : 'Draft from accepted changes only; publication remains separate.'}</p></div><span className="small-side">{plan ? 'Not publishable' : 'Draft · not published'}</span></header>
    <div className="notes-tools"><div className="note-switch" role="group" aria-label="Release note audience">{(['internal', 'customer'] as const).map(value => <button key={value} type="button" className={`switch-btn ${audience === value ? 'active' : ''}`} aria-pressed={audience === value} onClick={() => { setCopied(''); setAudience(value) }}>{value === 'internal' ? 'Internal' : 'Customer'}</button>)}</div><button type="button" className="text-action" onClick={() => { void copy() }}>Copy draft</button></div>
    {copied && <p role="status" className="copy-feedback">{copied}</p>}<article className="notes-paper"><div className="notes-kicker">{plan ? 'PREVIEW' : 'DRAFT'} · NOT PUBLISHED</div><h4>{release.version}</h4><div className="notes-desc">{release.repository} · {audience === 'internal' ? 'Internal engineering notes' : 'Customer-facing notes'} · {included.length} included changes</div>{groups.map(product => <Fragment key={product}><h5>{product}</h5><ul>{included.filter(change => change.product === product).map(change => <li key={change.id}>{change.note}</li>)}</ul></Fragment>)}{!included.length && <p className="note-omitted">No changes are currently eligible for this audience.</p>}</article>
    <div className="note-omitted">{plan ? 'Proposed copy only. Editorial wording is not recorded for these changes.' : `${changes.length - eligible.length} changes excluded because linked work, deployment or feature acceptance is not evidenced.`}{audience === 'customer' && eligible.length > included.length && ` ${eligible.length - included.length} internal-only changes excluded.`}</div><div className="footnote">Source: selected release + explicit linked work + exact component receipts + accepted checks. Publication is a separate authorized step.</div></>
}

export function ReleaseCanvas({ release, changes, tab, setTab, audience, setAudience, open }: { release: ReleaseObject; changes: ReleaseChange[]; tab: Tab; setTab: (tab: Tab) => void; audience: 'internal' | 'customer'; setAudience: (value: 'internal' | 'customer') => void; open: (id: string) => void }) {
  const plan = release.kind !== 'production', complete = release.membership.status === 'complete'
  const deployed = release.targets.filter(target => target.receipt?.outcome === 'succeeded' && !target.receipt.exceptions.length && (target.receipt.deployedSha || target.receipt.artifactDigest)).length
  const blocker = release.membership.reason ?? (changes.some(change => !change.successCondition) ? 'No acceptance contract defined for these changes. Feature-specific production acceptance remains unknown.' : release.gaps[0])
  const groups: Array<[string, ReleaseChange[]]> = plan ? [['ACCEPTANCE CONTRACTS', changes]] : [
    ['NEEDS ATTENTION', changes.filter(change => ['Failed', 'Human review', 'Unknown'].includes(change.acceptance) && change.delivery !== 'Not deployed' && change.delivery !== 'Awaiting delivery')],
    ['IN PROGRESS', changes.filter(change => change.acceptance === 'Running' && change.delivery === 'Deployed')],
    ['PASSED', changes.filter(change => change.acceptance === 'Passed' && change.delivery === 'Deployed')],
    ['NOT YET DEPLOYED', changes.filter(change => ['Not deployed', 'Awaiting delivery'].includes(change.delivery))]]
  return <section className="release-page" aria-label={releaseTitle(release)}><div className="overline">{plan ? release.kind === 'draft' ? 'DRAFT RELEASE PLAN' : 'FROZEN RELEASE CANDIDATE' : 'OBSERVED PRODUCTION RELEASE'} · {release.repository.split('/').at(-1)}</div><div className="hero-line"><div className="hero-title"><h2>{releaseTitle(release)}</h2><span className={`hero-state ${tone(release.state)}`}><Dot state={release.state} /></span></div><button type="button" className="hero-cta" onClick={() => open('evidence')}>{plan ? release.kind === 'draft' ? 'Draft source' : 'Frozen candidate' : 'Deployment evidence'} ↗</button></div>
    <div className="hero-sub">{plan ? `Commit ${short(release.sourceSha)}` : `Receipt ${short(release.executionId)}`} · {release.provenance.historical ? 'Snapshot as of' : 'Observed as of'} {release.provenance.asOf} · <span className="mono">Coordinator records</span></div>
    <div className="facts"><span>{plan ? `${release.targets.length} intended targets` : `${deployed} of ${release.targets.length} targets verified in snapshot`}</span><span className="quiet-divider">·</span><span>{complete ? changes.length : `${changes.length} known`} work items</span><span className="quiet-divider">·</span><span>{plan ? 'Build/DEV readiness only' : `${changes.filter(change => eligibleReleaseNote(release, change)).length} accepted changes`}</span></div>
    {blocker && <div className="alert" role="status"><div className="alert-badge">NEEDS REVIEW</div><div className="alert-text">{blocker}</div><button type="button" className="alert-action" onClick={() => open('evidence')}>Evidence →</button></div>}
    <div className="subtabs" role="tablist" aria-label="Within selected release" onKeyDown={tabKeys}>{([['changes', 'Changes'], ['acceptance', 'Acceptance'], ['notes', 'Release notes']] as const).map(([value, label]) => <button type="button" key={value} role="tab" id={`release-tab-${value}`} aria-controls="release-tab-content" aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} className={`subtab ${tab === value ? 'active' : ''}`} onClick={() => setTab(value)}>{label}{value !== 'notes' && <span className="num">{complete ? String(changes.length).padStart(2, '0') : `${changes.length}+`}</span>}</button>)}</div>
    <div role="tabpanel" id="release-tab-content" aria-labelledby={`release-tab-${tab}`}>
      {tab === 'notes' ? <ReleaseNotes key={release.id} release={release} changes={changes} audience={audience} setAudience={setAudience} /> : <><header className="section-head"><div><h3>{tab === 'changes' ? 'Changes in this release' : plan ? 'Production acceptance plan' : 'Production acceptance'}</h3><p>{tab === 'changes' ? `Git changes since ${release.membership.baseline ?? 'the previous release source'}. PRs support explicit linked work.` : plan ? 'Success criteria and methods must exist before feature acceptance.' : 'Feature-specific checks. Build/DEV readiness is not production acceptance.'}</p></div><span className="small-side">{changes.length}{!complete && '+'} work items</span></header>
        {tab === 'changes' ? <><div className="list-head"><div>Change / linked PR</div><div>{plan ? 'Release readiness' : 'Production'}</div><div /></div>{changes.map(change => <button key={change.id} type="button" className="data-row" onClick={() => open(change.id)}><span style={{ minWidth: 0 }}><span className="row-title">{change.title}</span><span className="row-detail" style={{ display: 'block' }}>{change.product} · {change.pulls.map(pull => `#${pull.number}`).join(', ')} · {change.targets.map(target => target.component).join(', ') || 'Target mapping unknown'}</span></span><span className="row-end"><Dot state={plan ? 'Needs review' : change.delivery} /></span><span className="chev" aria-hidden="true">›</span></button>)}</> : groups.filter(([, changes]) => changes.length).map(([name, grouped]) => <Fragment key={name}><div className="group-label">{name} · {grouped.length}</div>{grouped.map(change => <button type="button" className="data-row check-row" key={change.id} onClick={() => open(change.id)}><span className={`bar ${tone(change.acceptance)}`} /><span style={{ minWidth: 0 }}><span className="row-title">{change.title}</span><span className="method" style={{ display: 'block' }}>{change.successCondition ?? 'No acceptance contract defined'}</span></span><span className="check-end"><span className={`status ${tone(change.acceptance)}`}>{change.delivery === 'Not deployed' || change.delivery === 'Awaiting delivery' ? 'Awaiting delivery' : change.acceptance}</span><span className="sub">{change.method ?? 'Not defined'} · {change.pulls.map(pull => `#${pull.number}`).join(', ')}</span></span><span className="chev" aria-hidden="true">›</span></button>)}</Fragment>)}
        {!changes.length && <p className="empty-state">{complete ? 'No merged PR changes found in this exact release range.' : 'Changes are not yet fully known. The selected coordinator identity and component evidence remain available.'}</p>}<div className="list-foot"><span>{tab === 'changes' ? `Only changes associated with ${release.version}.` : 'Missing checks never become a pass.'}</span><button type="button" onClick={() => open('evidence')}>View source evidence ↗</button></div></>}
    </div><details className="source-gaps"><summary>Source provenance and gaps</summary><p>{release.provenance.source} · {release.provenance.asOf}</p><p>Git range: {release.membership.baseline ?? 'Unknown'} ({short(release.membership.baselineSha)}) → {short(release.sourceSha)} · {release.membership.status}</p>{release.evidenceUrl && <a href={external(release.evidenceUrl)} target="_blank" rel="noreferrer">Authoritative source evidence ↗</a>}<ul>{release.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></details>
  </section>
}

export function Releases({ data, error, refresh }: { data: ReleasesRead | null; error: string | null; refresh: () => void }) {
  const { scene, error: sceneError, now, origin, clearOrigin, views } = useDeskWorkspace()
  const [view, setView] = useState<ReleaseView>({ mode: 'plan', id: null, tab: 'changes', audience: 'internal', drawer: null })
  useViewSnapshot(views, 'releases', () => ({ filter: view }), saved => setView(saved.filter), !!data && !!scene)
  const [searchOpen, setSearchOpen] = useState(false)
  const handledOrigin = useRef<string | null>(null)
  const [originGap, setOriginGap] = useState<string | null>(null)
  const releases = data?.releases ?? [], selectable = releases.filter(release => view.mode === 'plan' ? release.kind !== 'production' : release.kind === 'production')
  const selected = selectable.find(release => release.id === view.id) ?? selectable[0]
  const changes = useMemo(() => selected && data && scene ? releaseChanges(selected, data, scene) : [], [selected, data, scene])
  const documents = useMemo(() => scene && selected ? releaseDocuments(scene, selected.pulls) : [], [scene, selected])
  const choose = (id: string) => { clearOrigin?.(); setView(value => ({ ...value, id, tab: defaultTab(value.mode), audience: 'internal', drawer: null })) }
  const openSearchHit = (target: Target) => { const change = changes.find(change => target.kind === 'pull' ? change.pulls.some(pull => pull.id === target.id) : change.cardId === target.id); if (change) setView(value => ({ ...value, drawer: change.id })); setSearchOpen(false) }
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true) } }
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler)
  }, [])
  useEffect(() => {
    if (origin?.section !== 'releases') { handledOrigin.current = null; setOriginGap(null); return }
    const key = JSON.stringify(origin)
    if (handledOrigin.current === key) return
    const target = origin.target
    const release = releases.find(release => (!origin.view?.release_id || release.id === origin.view.release_id) && [...release.pulls, ...(release.supportingPulls ?? [])].some(pull => pull.id === target.id && (target.kind === 'pull' || (target.kind === 'release' || target.kind === 'receipt') && pull.deployment?.targets.some(item => item.component === target.component && item.target === target.target && (target.kind !== 'receipt' || item.receipt?.id === target.receipt_id)))))
    if (!release || !data || !scene) { setOriginGap('Originating PR, target or receipt is unavailable in the recorded release sources.'); return }
    handledOrigin.current = key
    const originalPull = [...release.pulls, ...(release.supportingPulls ?? [])].find(pull => pull.id === target.id)
    setOriginGap(target.kind === 'pull' && target.head && originalPull?.head && target.head !== originalPull.head ? 'The PR head changed since this question. Showing the current release observation.' : null)
    const change = releaseChanges(release, data, scene).find(change => change.pulls.some(pull => pull.id === target.id))
    const mode = release.kind === 'production' ? 'verify' : 'plan'
    setView({ mode, id: release.id, tab: defaultTab(mode), audience: 'internal', drawer: change?.id ?? 'evidence' })
  }, [origin, data, scene])
  const drawerChange = changes.find(change => change.id === view.drawer)
  return <section className="rel-v3" aria-label="Releases"><header className="main-top"><h1>Releases</h1>{scene && <SmartSearch scene={scene} state={initialPresentation()} now={now} scope="releases" documents={documents} open={searchOpen} focused={false} onOpen={() => setSearchOpen(true)} onDismiss={() => setSearchOpen(false)} onRestore={() => {}} onChoose={openSearchHit} />}</header>
    <nav className="lane-tabs" role="tablist" aria-label="Release lifecycle" onKeyDown={tabKeys}>{(['plan', 'verify'] as const).map(mode => <button key={mode} type="button" role="tab" aria-selected={view.mode === mode} tabIndex={view.mode === mode ? 0 : -1} className={`lane-tab ${view.mode === mode ? 'active' : ''}`} onClick={() => { clearOrigin?.(); setView({ mode, id: null, tab: defaultTab(mode), audience: 'internal', drawer: null }) }}>{mode === 'plan' ? 'Plan' : 'Verify'}{releases.length > 0 && <span className="tab-count" aria-hidden="true">{String(releases.filter(release => mode === 'plan' ? release.kind !== 'production' : release.kind === 'production').length).padStart(2, '0')}</span>}</button>)}</nav>
    {(error || sceneError) && <p className="source-gaps" role="status">{error ?? sceneError} Retained records are last known. <button type="button" className="hero-cta" onClick={refresh}>Read sources again</button></p>}
    {originGap && <p className="source-gaps" role="status">{originGap}</p>}
    <div className="body-layout"><aside className="releases-rail" aria-label="Releases to select"><p className="rail-head">{view.mode === 'plan' ? 'Release candidates' : 'Production releases'}</p><div className="release-picker">{selectable.map(release => <button key={release.id} className={`pick ${selected?.id === release.id ? 'active' : ''}`} type="button" aria-pressed={selected?.id === release.id} aria-label={`${release.version} ${kind(release)} ${short(release.planId)} ${short(release.executionId)}`} onClick={() => choose(release.id)}><span className="pick-title"><span className="pick-version">{release.version}</span><span className="pick-type">{kind(release)}</span></span><span className="pick-detail">{release.state} · {short(release.kind === 'production' ? release.executionId : release.planId)}</span><span className="pick-meta">{release.repository}</span></button>)}</div><div className="rail-note">{view.mode === 'plan' ? 'Exact targets come from a frozen coordinator plan.' : 'Actual deployments come from committed production receipts.'}</div></aside>
      {selected ? <ReleaseCanvas release={selected} changes={changes} tab={view.tab} setTab={tab => setView(value => ({ ...value, tab }))} audience={view.audience} setAudience={audience => setView(value => ({ ...value, audience }))} open={drawer => setView(value => ({ ...value, drawer }))} /> : <section className="release-page"><h2>{!data ? 'Reading release sources…' : view.mode === 'plan' ? 'No release candidates' : 'No recorded production releases'}</h2><p className="empty-state">{!data ? 'Waiting for authoritative coordinator identities. No counts or deployment claims are available yet.' : 'No authoritative coordinator objects are available for this view. Configure a coordinator export in releases/reconciliation.json; GitHub tags alone do not create releases.'}</p>{data?.reconciliation?.warnings.map(warning => <p key={warning} className="source-gaps">{warning}</p>)}</section>}
    </div>{selected && view.drawer && (view.drawer === 'evidence' || drawerChange) && <ReleaseDetail key={`${selected.id}:${view.drawer}`} release={selected} change={drawerChange} origin={origin} close={() => setView(value => ({ ...value, drawer: null }))} />}
  </section>
}
