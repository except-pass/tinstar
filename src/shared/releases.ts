import type { FloorScene } from './reconciliationPresentation'
import { operationalStatuses } from './floorOrganization'
import type { PullDeployment, ReleaseDryRun } from './releaseReconciliation'
import type { ReleaseAutomationPlan } from './releaseAutomation'
import type { SceneCard } from '../server/reconciliation/scene'

export interface PullIdentity { id: string; repository: string; number: number; url: string }
/** GitHub identity is repository + number; URLs with query/fragment retain that identity. */
export function releasePull(value: string): PullIdentity | null {
  try {
    const url = new URL(value)
    const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || !match) return null
    const repository = `${match[1]}/${match[2]}`.toLowerCase(), number = Number(match[3])
    if (!Number.isSafeInteger(number)) return null
    return { id: `${repository}#${number}`, repository, number, url: `https://github.com/${repository}/pull/${number}` }
  } catch { return null }
}
/** Existing First Mate registrations, including retained backlog records. No ownership inference. */
export function registeredPulls(scene: FloorScene): PullIdentity[] {
  return [...scene.executions.map(worker => worker.source.pr.url), ...scene.backlog.map(row => row.source.pr_url)]
    .flatMap(value => { const pull = typeof value === 'string' ? releasePull(value) : null; return pull ? [pull] : [] })
}
export interface AssociationEvent {
  id: string; pull: string; cardId: string; action: 'link' | 'unlink'; actor: string; at: string; reason: string
}
export interface ReleaseLink { cardId: string; active: boolean; sources: string[]; events: AssociationEvent[] }
export interface ReleasePull extends PullIdentity {
  links: ReleaseLink[]
  title: string | null
  state: 'open' | 'closed' | 'merged' | 'unknown'
  mergedAt: string | null
  mergeSha: string | null
  observedAt: string | null
  freshness: 'fresh' | 'stale' | 'unknown'
  exceptions: string[]
  readError?: string
  deployment?: PullDeployment
}
export interface ReleasesRead {
  generatedAt: string; pulls: ReleasePull[]
  unassociatedCards: Array<{ id: string; title: string; reason: string }>
  warnings: string[]
  associationsComplete: boolean
  associationsWritable: boolean
  githubSync?: { status: 'pending' | 'ok' | 'error'; errors: string[] }
  reconciliation?: ReleaseDryRun
  automation?: ReleaseAutomationPlan
}
export const activeReleaseLinks = (pull: ReleasePull) => pull.links.filter(link => link.active)

/** Source Link/GitHub properties are explicit declarations. Body/title similarity is never used. */
export function declaredPulls(card: SceneCard): PullIdentity[] {
  const urls = ['Link', 'GitHub', 'GitHub PRs', 'Pull requests'].flatMap(name => {
    const value = card.source.properties[name]?.value
    return (Array.isArray(value) ? value : [value]).flatMap(value => typeof value === 'string' ? value.match(/https:\/\/github\.com\/[^\s<>"\[\]()]+/gi) ?? [] : [])
  })
  return [...new Map(urls.map(releasePull).filter((pull): pull is PullIdentity => !!pull).map(pull => [pull.id, pull])).values()]
}

/** PR/card edges are independent of worker assignment and retain audit history after unlink. */
export function releaseAssociations(scene: FloorScene, events: AssociationEvent[] = []): ReleasesRead {
  const workerAssociationsComplete = scene.coverage.homes.every(home => home.observation.status === 'fresh' && home.observation.coverage === 'complete')
  const associationsComplete = scene.coverage.intentions.status === 'fresh' && scene.coverage.intentions.coverage === 'complete' && workerAssociationsComplete
  const warnings = [...(scene.coverage.intentions.status === 'fresh' && scene.coverage.intentions.coverage === 'complete' ? [] : ['Notion association source is stale, partial or unavailable']), ...(!workerAssociationsComplete ? ['Worker PR association source is stale, partial or unavailable'] : [])]
  const pulls = new Map<string, ReleasePull>()
  const ensure = (identity: PullIdentity) => {
    let pull = pulls.get(identity.id)
    if (!pull) {
      pull = { ...identity, links: [], title: null, state: 'unknown', mergedAt: null, mergeSha: null, observedAt: null, freshness: 'unknown', exceptions: [] }
      pulls.set(identity.id, pull)
    }
    return pull
  }
  const edge = (pull: ReleasePull, cardId: string) => {
    let link = pull.links.find(link => link.cardId === cardId)
    if (!link) { link = { cardId, active: false, sources: [], events: [] }; pull.links.push(link) }
    return link
  }
  for (const card of scene.cards.filter(card => !card.source.in_trash && !card.source.archived && operationalStatuses.includes(String(card.source.properties.Status?.value)))) {
    for (const identity of declaredPulls(card)) {
      const link = edge(ensure(identity), card.id)
      link.active = true; link.sources.push('Notion Link/GitHub property')
    }
  }
  // The same join serves Releases and PR Operations. Only Notion-owned,
  // reconciled exact worker declarations can confirm an additional card edge.
  for (const claim of scene.claims) {
    if (claim.basis !== 'explicit' || claim.verification !== 'confirmed' || claim.state !== 'current') continue
    const worker = scene.executions.find(worker => worker.id === claim.executionId)
    const identity = worker && typeof worker.source.pr.url === 'string' ? releasePull(worker.source.pr.url) : null
    const card = scene.cards.find(card => card.id === claim.cardId)
    if (!identity || !card || card.source.archived || card.source.in_trash || !operationalStatuses.includes(String(card.source.properties.Status?.value))) continue
    const link = edge(ensure(identity), claim.cardId)
    link.active = true
    if (!link.sources.includes('Verified Notion First Mate tasks → registered PR')) link.sources.push('Verified Notion First Mate tasks → registered PR')
  }
  for (const event of events) {
    const identity = releasePull(event.pull)
    if (!identity) continue
    const link = edge(ensure(identity), event.cardId)
    link.events.push(event); link.active = event.action === 'link'
    if (!link.sources.includes('Manual association')) link.sources.push('Manual association')
  }
  for (const pull of pulls.values()) {
    const links = activeReleaseLinks(pull)
    if (!links.length) pull.exceptions.push('No linked Notion card')
    for (const link of links) {
      const card = scene.cards.find(card => card.id === link.cardId && !card.source.in_trash && !card.source.archived)
      if (!card) pull.exceptions.push(`Linked card unavailable: ${link.cardId}`)
      if (link.events.at(-1)?.action === 'link' && !card) pull.exceptions.push('Manual association conflicts with current card coverage')
    }
    pull.exceptions.push(...warnings)
  }
  const associated = new Set([...pulls.values()].flatMap(pull => activeReleaseLinks(pull).map(link => link.cardId)))
  return { generatedAt: scene.generatedAt, pulls: [...pulls.values()].sort((a, b) => a.id.localeCompare(b.id)),
    unassociatedCards: scene.cards.filter(card => !card.source.in_trash && !card.source.archived && card.source.properties.Status?.value === 'Waiting for Prod Release' && !associated.has(card.id))
      .map(card => ({ id: card.id, title: String(card.source.properties.Name?.value ?? card.id), reason: 'Waiting for Prod Release without an explicit PR association' })),
    warnings, associationsComplete, associationsWritable: false }
}
