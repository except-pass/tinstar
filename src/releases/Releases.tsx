import { askElement } from '../ask/element'
import { ActionControls } from '../actions/ActionControls'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, apiUrl } from '../apiClient'
import { AskSurface } from '../ask/AskSurface'
import { useViewSnapshot } from '../ask/workspaceHistory'
import { useOriginFocus } from '../ask/useOriginFocus'
import type { AskReturn, AskView, ArtifactAskTarget } from '../shared/ask'
import { AskCardAction } from '../ask/Ask'
import { useDeskWorkspace } from '../ask/DeskWorkspace'
import { SmartSearch } from '../reconciliation/SmartSearch'
import { initialPresentation, type Target, type FloorScene } from '../shared/reconciliationPresentation'
import { activeReleaseLinks, type ReleasePull, type ReleasesRead } from '../shared/releases'
import { productionSyncLabel, filterReleases, releaseQueueCount, releaseDocuments, releaseFilters, releaseGroups, releaseState, type ReleaseFilter } from './model'
import '../reconciliation/overview.css'
import './releases.css'
import { CardReleaseProposal, ReleaseAutomationSummary } from './ReleaseAutomation'

const cardHref = (id: string) => `?card=${encodeURIComponent(id)}`
const title = (scene: FloorScene, id: string) => String(scene.cards.find(card => card.id === id)?.source.properties.Name?.value ?? id)

function AssociationForm({ scene, data, pull, refresh }: { scene: FloorScene; data: ReleasesRead; pull?: ReleasePull; refresh: () => void }) {
  const [url, setUrl] = useState(pull?.url ?? ''), [cardId, setCard] = useState(''), [reason, setReason] = useState('')
  const [action, setAction] = useState<'link' | 'unlink'>('link'), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const attempt = useRef<{ body: string; id: string } | null>(null)
  return <form className="rel-association" onSubmit={event => {
    event.preventDefault()
    if (busy) return
    const body = JSON.stringify({ pull: url, cardId, action, reason })
    if (attempt.current?.body !== body) attempt.current = { body, id: crypto.randomUUID() }
    setBusy(true); setError(null); setSaved(false)
    void apiFetch('/api/releases/associations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' }, body: JSON.stringify({ ...JSON.parse(body), id: attempt.current.id }) })
      .then(async response => { const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error?.message ?? 'Association save failed'); attempt.current = null; setReason(''); setSaved(true); refresh() })
      .catch(error => setError(error.message)).finally(() => setBusy(false))
  }}>
    <h3>{pull ? 'Update association' : 'Link a PR'}</h3>
    <label>GitHub PR URL<input required type="url" value={url} onChange={event => setUrl(event.target.value)} readOnly={!!pull} /></label>
    <label>Notion card<select required value={cardId} onChange={event => setCard(event.target.value)}><option value="">Choose a card</option>{scene.cards.filter(card => !card.source.in_trash && !card.source.archived).map(card => <option key={card.id} value={card.id}>{title(scene, card.id)}</option>)}{pull?.links.filter(link => !scene.cards.some(card => card.id === link.cardId)).map(link => <option key={link.cardId} value={link.cardId}>{link.cardId} · unavailable</option>)}</select></label>
    <label>Association<select value={action} onChange={event => setAction(event.target.value as 'link' | 'unlink')}><option value="link">Link</option><option value="unlink">Unlink locally</option></select></label>
    <label>Reason<input required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
    <button type="submit" disabled={busy || !data.associationsWritable}>{busy ? 'Saving…' : 'Save local association'}</button>
    {saved && <p role="status">Association saved to local audit.</p>}{!data.associationsWritable && <p>Association editing requires an authorized owner session.</p>}{error && <p role="alert">{error}</p>}
    <small>Local audit only. Notion properties stay unchanged.</small>
  </form>
}
function CardDryRun({ data, cardId }: { data: ReleasesRead; cardId: string }) {
  const card = data.reconciliation?.cards.find(card => card.cardId === cardId)
  if (!card) return null
  const decision = { 'would-complete': 'Would mark Done', 'would-verify': 'Requires production verification', waiting: 'Waiting for required production changes', exception: 'Release evidence unresolved', unrelated: 'Card status is outside release automation' }[card.decision]
  return <div className="rel-dry-run"><strong {...askElement('deployment', 'Dry run')}>Dry run: {decision}</strong><p {...askElement('status', 'Card release status')}>Owner: {card.owner} · {card.status} · {card.requiredPulls.length} required PRs</p>{card.reasons.length > 0 && <ul>{card.reasons.map(reason => <li {...askElement('deployment', 'Release reason')} key={reason}>{reason}</li>)}</ul>}<CardReleaseProposal plan={data.automation} cardId={cardId} /><small>No Notion or Desk transition is performed.</small></div>
}
function matchesReleaseOrigin(pull: ReleasePull, target: AskReturn['target']) {
  if (pull.id !== target.id) return false
  if (target.kind === 'pull') return true
  return (target.kind === 'release' || target.kind === 'receipt') && !!pull.deployment?.targets.some(item =>
    item.target === target.target && item.component === target.component && (target.kind !== 'receipt' || item.receipt?.id === target.receipt_id))
}
function ProductionTargets({ pull, askView }: { pull: ReleasePull; askView: AskView }) {
  const { origin } = useDeskWorkspace()
  const targetOrigin = origin?.section === 'releases' && origin.target.id === pull.id && (origin.target.kind === 'release' || origin.target.kind === 'receipt') ? origin.target : undefined
  return <>
      <h3>Production targets</h3>{pull.deployment?.targets.length ? pull.deployment.targets.map(target => {
        const deployment: ArtifactAskTarget = { kind: 'release', id: pull.id, target: target.target, component: target.component }
        const receipt: ArtifactAskTarget | null = target.receipt ? { ...deployment, kind: 'receipt', receipt_id: target.receipt.id } : null
        const selected = targetOrigin && matchesReleaseOrigin({ ...pull, deployment: { ...pull.deployment!, targets: [target] } }, targetOrigin)
        return <section key={`${target.target}:${target.component}`}>
          <AskSurface as="section" className={selected && targetOrigin?.kind === 'release' ? 'ask-origin' : undefined} data-origin-pull={pull.id} data-deployment-target={JSON.stringify([target.component, target.target])} subject={{ target: deployment, label: `${pull.id} · ${target.component} / ${target.target}`, view: askView }} {...askElement('deployment')}><strong {...askElement('deployment', 'Deployment target')}>{target.component} · {target.target}</strong><AskCardAction subject={{ target: deployment, label: `${pull.id} · ${target.component} / ${target.target}`, view: askView }} icon /><p><span {...askElement('deployment', 'Release state')}>{target.state}</span> · <span {...askElement('deployment', 'Release evidence')}>{target.reason}</span></p><p {...askElement('deployment', 'Ancestry')}>Ancestry: {target.ancestry}</p></AskSurface>
          {target.receipt && receipt && <AskSurface as="section" className={selected && targetOrigin?.kind === 'receipt' ? 'ask-origin' : undefined} data-origin-pull={pull.id} data-receipt-id={target.receipt.id} data-component={target.component} data-target={target.target} {...askElement('receipt')} subject={{ target: receipt, label: `${pull.id} · receipt ${target.receipt.id}`, view: askView }}><AskCardAction subject={{ target: receipt, label: `${pull.id} · receipt ${target.receipt.id}`, view: askView }} icon /><p>{target.receipt.version ?? 'Version unknown'} · {target.receipt.deployedSha ?? target.receipt.artifactDigest ?? 'Identity unknown'}<br />{target.receipt.deployedAt}</p><a href={target.receipt.receiptUrl} target="_blank" rel="noreferrer">Read deployment receipt ↗</a> · <a href={target.receipt.workflowUrl} target="_blank" rel="noreferrer">Release workflow ↗</a></AskSurface>}
        </section>
      }) : <p>No required production component mapping.</p>}
  </>
}
function PullDrawer({ pull, scene, data, refresh, close, askView }: { pull: ReleasePull | null; scene: FloorScene; data: ReleasesRead; refresh: () => void; close: () => void; askView: AskView }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="rel-drawer" aria-label={pull ? `Inspect ${pull.id}` : 'Link a PR'} onCancel={close}>
    <header><h2>{pull ? `${pull.repository} #${pull.number}` : 'Link a PR'}</h2><button autoFocus type="button" onClick={close} aria-label="Close release details">×</button></header>
    {pull && <AskSurface as="section" subject={{ target: { kind: 'pull', id: pull.id, ...(pull.head ? { head: pull.head } : {}) }, label: pull.title ?? pull.id, view: askView }}><h3 {...askElement('title', 'PR title')}>{pull.title ?? 'PR details pending'}</h3><a href={pull.url} target="_blank" rel="noreferrer">Open PR in GitHub ↗</a>
      <dl><dt>GitHub state</dt><dd {...askElement('status', 'GitHub state')}>{pull.state} · {pull.freshness}</dd><dt>Merged</dt><dd {...askElement('updated', 'Merged')}>{pull.mergedAt ?? 'Unknown / not merged'}</dd><dt>Merge commit</dt><dd {...askElement('merge_commit', 'Merge commit')}>{pull.mergeSha ?? 'Unknown'}</dd><dt>Observed</dt><dd {...askElement('last_edited', 'Observed')}>{pull.observedAt ?? 'Pending'}</dd><dt>Production</dt><dd {...askElement('deployment', 'Production')}>{releaseState(pull)} · dry run</dd></dl>
      {pull.exceptions.length > 0 && <ul>{pull.exceptions.map(message => <li {...askElement('deployment', 'Release exception')} key={message}>{message}</li>)}</ul>}
      <ActionControls targets={[pull]} view={askView} compact />
      <ProductionTargets pull={pull} askView={askView} />
      <h3>Card associations</h3>{pull.links.map(link => <section key={link.cardId}><a {...askElement('relationship', 'Linked card')} href={cardHref(link.cardId)}>{title(scene, link.cardId)}</a> · <span {...askElement('relationship', 'Association state')}>{link.active ? 'Linked' : 'Unlinked locally'}</span><p {...askElement('relationship', 'Association sources')}>{link.sources.join(' · ')}</p>{link.events.map(event => <p {...askElement('relationship', 'Association event')} key={event.id}>{event.action} · {event.actor} · {event.at}<br />{event.reason}</p>)}{link.active && <><CardDryRun data={data} cardId={link.cardId} /><AskCardAction cardId={link.cardId} /></>}</section>)}
    </AskSurface>}
    <AssociationForm key={pull?.id ?? 'new'} scene={scene} data={data} pull={pull ?? undefined} refresh={refresh} />
  </dialog>
}
export function Releases({ data, error, refresh }: { data: ReleasesRead | null; error: string | null; refresh: () => void }) {
  const { scene, error: sceneError, now, origin, clearOrigin, views } = useDeskWorkspace()
  const [filter, setFilter] = useState<ReleaseFilter>(() => releaseFilters.includes(origin?.view?.filter as ReleaseFilter) ? origin!.view!.filter as ReleaseFilter : 'In Queue'), [preset, setPreset] = useState<'initiative' | 'repository'>(origin?.view?.preset ?? 'initiative')
  const [selection, setSelection] = useState<string[]>([]), [drawer, setDrawer] = useState<string | null | undefined>(undefined)
  const [collapsed, setCollapsed] = useState<string[]>(origin?.view?.collapsed ?? []), [searchOpen, setSearchOpen] = useState(false), [focus, setFocus] = useState<Target | null>(null)
  const [beforeFocus, setBeforeFocus] = useState<ReleaseFilter | null>(null)
  const destination = origin?.section === 'releases' ? origin : undefined
  const focusRef = useOriginFocus(destination)
  useViewSnapshot(views, 'releases', () => ({ filter, group: preset }), saved => {
    setFilter(saved.filter); setPreset(saved.group)
  }, !!data && !!scene)

  const askView: AskView = { scene: 'releases', filter, preset, collapsed }
  const restoreFocus = () => { setFocus(null); if (beforeFocus) setFilter(beforeFocus); setBeforeFocus(null) }
  const state = useMemo(initialPresentation, [])
  const documents = useMemo(() => scene && data ? releaseDocuments(scene, data.pulls, data.unassociatedCards.map(card => card.id)) : [], [scene, data])
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(value => !value) }
      else if (event.key === 'Escape' && drawer === undefined && !searchOpen) restoreFocus()
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [drawer, searchOpen, beforeFocus])
  if (!scene || !data) return <section ref={focusRef} className="ov-root rel-root" aria-label="Releases"><p role="status">{error ?? sceneError ?? 'Reading release associations…'}</p></section>
  const originPull = destination && data.pulls.find(pull => pull.id === destination.target.id)
  const originMatches = !!(destination && originPull && matchesReleaseOrigin(originPull, destination.target))
  const originMessage = !originPull ? `The originating release ${destination?.target.id} is missing or outside the current authorized source.`
    : !originMatches ? destination?.target.kind === 'receipt' ? 'The original receipt is missing or has been superseded. The answer retains its captured source link.' : 'The original deployment target is missing or outside the current authorized source. The answer retains its captured source link.'
    : `Showing originating release ${destination?.target.id}.${destination?.target.kind === 'pull' && destination.target.head && originPull.head !== destination.target.head ? ' The PR head changed since this question.' : ''}`
  const focused = destination ? data.pulls.filter(pull => pull.id === destination.target.id) : focus ? data.pulls.filter(pull => focus.kind === 'pull' ? pull.id === focus.id : activeReleaseLinks(pull).some(link => link.cardId === focus.id)) : null
  const visible = focused ?? filterReleases(data.pulls, filter), groups = releaseGroups(scene, visible, preset)
  const selected = new Set(selection), drawerPull = data.pulls.find(pull => pull.id === drawer) ?? null, warning = error ?? sceneError
  const choose = (target: Target) => { clearOrigin?.(); if (!focus) setBeforeFocus(filter); setFocus(target); if (target.kind === 'card') setFilter('Exceptions'); setSearchOpen(false) }
  return <section ref={focusRef} className="ov-root rel-root" aria-label="Releases">
    <header className="ov-toolbar rel-toolbar"><strong>Releases <small>{releaseQueueCount(data, warning) ?? '?'}</small></strong>
      <div className="ov-preset-buttons"><button type="button" aria-pressed={preset === 'initiative'} onClick={() => setPreset('initiative')}>Initiative → Epic</button><button type="button" aria-pressed={preset === 'repository'} onClick={() => setPreset('repository')}>Repository</button></div>
      <SmartSearch scope="releases" scene={scene} state={state} now={now} documents={documents} open={searchOpen} focused={!!focus} onOpen={() => setSearchOpen(true)} onDismiss={() => setSearchOpen(false)} onRestore={restoreFocus} onChoose={choose} />
      <div className="rel-filters">{releaseFilters.map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setFocus(null); clearOrigin?.() }}>{value}{value === 'Exceptions' ? ` (${data.pulls.filter(pull => pull.exceptions.length).length + data.unassociatedCards.length})` : ''}</button>)}</div>
      <button type="button" onClick={() => setDrawer(null)}>Link PR</button>
    </header>
    {destination && <p role="status">{originMessage} <button type="button" onClick={clearOrigin}>Show all releases in this view</button></p>}
    <details className="rel-sync"><summary>{productionSyncLabel(data, warning)} · {new Set(data.pulls.map(pull => pull.repository)).size} repositories{data.automation && ' · transitions OFF'}</summary>
      {warning && <p role="alert">{warning}</p>}{data.githubSync?.errors.map(message => <p role="alert" key={message}>{message}</p>)}{[...data.warnings, ...(data.reconciliation?.warnings ?? [])].map(message => <p key={message}>{message}</p>)}
      {data.reconciliation?.targets.map(target => <p key={`${target.repository}:${target.target}:${target.component}`}>{target.repository} · {target.component} / {target.target} · {target.version ?? 'Version unknown'} · {target.deployedSha ?? target.artifactDigest ?? 'Identity unknown'} · observed {target.observedAt} · <a href={target.receiptUrl} target="_blank" rel="noreferrer">Receipt ↗</a></p>)}{!data.reconciliation?.targets.length && <p>Deployed component identities are unknown; no matching current receipt.</p>}
      <p>Read-only reconciliation. No Notion or Desk transitions are performed.</p><a href={apiUrl('/api/releases/reconciliation')} target="_blank" rel="noreferrer">Open dry-run JSON report ↗</a><ReleaseAutomationSummary plan={data.automation} />
    </details>
    {selection.length > 0 && <div className="rel-selection">{selection.length} unique PRs selected <button type="button" onClick={() => setSelection([])}>Clear selection</button></div>}
    <ActionControls targets={data.pulls.filter(pull => selection.includes(pull.id))} view={askView} />
    <div className="rel-scroll"><table className="rel-table"><caption className="sr-only">Release queue · one row per GitHub PR; repeated group references share identity</caption><thead><tr><th><input type="checkbox" aria-label="Select visible PRs" checked={visible.length > 0 && visible.every(pull => selected.has(pull.id))} onChange={event => setSelection(event.target.checked ? [...new Set([...selection, ...visible.map(pull => pull.id)])] : selection.filter(id => !visible.some(pull => pull.id === id)))} /></th><th>GitHub PR</th><th>Change</th><th>Linked Notion cards</th><th>Merged</th><th>Release state</th><th>Inspect</th></tr></thead>
      {groups.map(group => <tbody key={group.id} data-view-group={group.id}><tr className="rel-group"><th colSpan={7}><button type="button" aria-expanded={!collapsed.includes(group.id)} onClick={() => setCollapsed(values => values.includes(group.id) ? values.filter(id => id !== group.id) : [...values, group.id])}>{collapsed.includes(group.id) ? '▸' : '▾'} {group.label} <small>{group.pulls.length}</small></button></th></tr>
        {(!collapsed.includes(group.id) || !!destination) && group.pulls.map(pull => <Fragment key={pull.id}><AskSurface subject={{ target: { kind: 'pull', id: pull.id, ...(pull.head ? { head: pull.head } : {}) }, label: `${pull.id} · ${pull.title ?? 'PR'}`, view: askView }} data-pull-id={pull.id} data-ask-origin={pull.id} tabIndex={-1} className={`${selected.has(pull.id) ? 'rel-selected' : ''}${destination?.target.kind === 'pull' && originMatches && destination.target.id === pull.id ? ' ask-origin' : ''}`}>
          <td><input type="checkbox" aria-label={`Select ${pull.id}`} checked={selected.has(pull.id)} onChange={event => setSelection(values => event.target.checked ? [...new Set([...values, pull.id])] : values.filter(id => id !== pull.id))} /></td>
          <td><a {...askElement('repository')} href={pull.url} target="_blank" rel="noreferrer">{pull.repository}#{pull.number} ↗</a></td><td title={pull.title ?? (pull.readError ? 'GitHub read failed' : 'GitHub details pending')}><button type="button" className="rel-title" {...askElement('title', 'PR title')} onClick={() => setDrawer(pull.id)}>{pull.title ?? (pull.readError ? 'GitHub read failed' : 'GitHub details pending')}</button></td>
          <td><span {...askElement('relationship', 'Linked cards')} className="rel-cards">{activeReleaseLinks(pull).length ? activeReleaseLinks(pull).map(link => <a {...askElement('relationship', 'Linked card')} key={link.cardId} href={cardHref(link.cardId)} title={title(scene, link.cardId)}>{title(scene, link.cardId)}</a>) : <span>No linked card</span>}</span></td>
          <td><time {...askElement('updated', 'Merged at')} dateTime={pull.mergedAt ?? undefined} title={pull.mergedAt ?? undefined}>{pull.mergedAt ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(Date.parse(pull.mergedAt)) : pull.state === 'open' ? 'Open' : 'Unknown'}</time></td>
          <td {...askElement('deployment')}><span title={pull.exceptions.join('; ')}>{releaseState(pull)}</span></td><td><span className="rel-inspect"><AskCardAction subject={{ target: { kind: 'pull', id: pull.id, ...(pull.head ? { head: pull.head } : {}) }, label: `${pull.id} · ${pull.title ?? 'PR'}`, view: askView }} icon /><button type="button" aria-label={`Inspect ${pull.id}`} onClick={() => setDrawer(pull.id)}>ⓘ</button></span></td>
        </AskSurface>{destination?.target.kind === 'pull' && destination.target.action_receipt_id && destination.target.id === pull.id && <tr><td colSpan={7}><ActionControls targets={[pull]} view={askView} compact focusReceipt={destination.target.action_receipt_id} /></td></tr>}{destination && ['release', 'receipt'].includes(destination.target.kind) && <tr><td colSpan={7}><ProductionTargets pull={pull} askView={askView} /></td></tr>}</Fragment>)}
      </tbody>)}
    </table></div>
    {!visible.length && <p className="rel-empty">{filter === 'Shipped' || filter === 'Verify in Prod' ? 'No verified production evidence available yet.' : 'No PRs in this view.'}</p>}
    {filter === 'Exceptions' && data.unassociatedCards.length > 0 && <details className="rel-missing" open><summary>{data.unassociatedCards.length} waiting cards need PR associations</summary>{data.unassociatedCards.filter(card => !focus || focus.kind !== 'card' || focus.id === card.id).map(card => <p key={card.id}><a href={cardHref(card.id)}>{card.title}</a> · {card.reason}</p>)}</details>}
    {drawer !== undefined && <PullDrawer key={drawer ?? 'new'} pull={drawerPull} scene={scene} data={data} refresh={refresh} askView={askView} close={() => setDrawer(undefined)} />}
  </section>
}
