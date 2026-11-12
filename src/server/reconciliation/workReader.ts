import type { ReconciliationConfig } from './config'
import { notionObservation, readNotionCard, type WorkScope } from './notion'
import { NotionApi } from './notionApi'
import { checkInTime } from '../../shared/checkIn'
import { isJiraCard } from '../../shared/workIdentity'
import { JiraAdapter } from './jira'
import { CachedObservation, retainMissing } from './observation'
export type WorkCard = Awaited<ReturnType<typeof readNotionCard>> & { source?: { provider: 'jira'; instanceId: string; collectionId: string; itemId: string; displayKey: string; synthetic: true } }
export type WorkData = Omit<NonNullable<Awaited<ReturnType<ReturnType<typeof notionObservation>['get']>>['data']>, 'cards'> & { cards: WorkCard[] }
export const scopeMatches = (card: WorkCard, scope: WorkScope) => {
  const value = (name: string) => card.properties[name]?.value
  const has = (name: string, expected?: string) => !expected || (Array.isArray(value(name)) ? (value(name) as unknown[]).includes(expected) : value(name) === expected)
  const date = value('Next check-in') as { start?: string; time_zone?: string } | null
  const classifications = ([['Initiative', scope.initiative], ['Epic', scope.epic]] as const).map(([name, expected]) =>
    has(name, expected) ? true : card.properties[name]?.type === 'relation' && card.properties[name]?.hasMore ? undefined : false)
  const matches = !card.archived && !card.in_trash && has('Owner', scope.owner) &&
    (scope.statuses ? scope.statuses.includes(String(value('Status'))) : scope.history || !['Done', 'Archived'].includes(String(value('Status')))) &&
    (!scope.checkpoint_before || !!date?.start && checkInTime(date.start, date.time_zone) <= Date.parse(scope.checkpoint_before))
  return !matches || classifications.includes(false) ? false : classifications.includes(undefined) ? undefined : true
}
export class WorkReader {
  private queries = new Map<string, { scope: WorkScope; observation: CachedObservation<WorkData> }>()
  private cards = new Map<string, { until: number; value: Promise<WorkCard> }>()
  private known = new Map<string, { card: WorkCard; observedAt: string }>()
  lastKnown(id: string) { return this.known.get(id) }
  readonly jira?: JiraAdapter
  constructor(readonly config: ReconciliationConfig['notion'], readonly api: NotionApi, jira?: ReconciliationConfig['jira']) { if (jira) this.jira = new JiraAdapter(jira, api.fetch) }
  query(scope: WorkScope = {}, force = false) {
    const key = JSON.stringify([scope.owner, scope.statuses?.slice().sort(), scope.initiative, scope.epic, scope.checkpoint_before, !!scope.history])
    let entry = this.queries.get(key)
    if (!entry) {
      if (this.queries.size >= 100) this.queries.delete(this.queries.keys().next().value!)
      const notion = notionObservation(this.config, this.api.fetch, scope), jira = this.jira?.observation(scope)
      const observation = !jira ? notion : !this.config ? jira : new CachedObservation<WorkData>(async () => {
        const reads = await Promise.all([notion.get(true), jira.get(true)])
        const available = reads.flatMap(read => read.data ? [read.data] : [])
        if (!available.length) throw new Error('Work sources unavailable')
        const complete = reads.every(read => read.status === 'fresh' && read.coverage === 'complete')
        return { observedAt: new Date().toISOString(), coverage: complete ? 'complete' : 'partial', data: { ...available[0]!,
          cards: available.flatMap(data => data.cards), hasMore: !complete, scope: 'Independent Notion and synthetic Jira sources; no sync or dual writes' } }
      }, 60_000, 120_000, 'Work source coverage incomplete', Date.now, (previous, current) => ({ ...current, cards: retainMissing(previous.cards, current.cards, card => card.id) }))
      entry = { scope, observation }
      this.queries.set(key, entry)
    } else if (!force && entry.observation.isCached()) this.api.diagnostics.cacheHits++
    return entry.observation.get(force)
  }
  declarations() {
    const key = JSON.stringify([undefined, undefined, undefined, undefined, undefined, false])
    return this.queries.get(key)?.observation.peek() ?? {
      status: 'unknown' as const, coverage: 'unknown' as const, data: null,
      observedAt: null, attemptedAt: new Date().toISOString(), expiresAt: null, error: 'Broader declaration coverage is unavailable',
    }
  }
  card(id: string, force = false) {
    const cached = this.cards.get(id)
    if (!force && cached && cached.until > Date.now()) { this.api.diagnostics.cacheHits++; return cached.value }
    const read = isJiraCard(id) ? this.jira ? this.jira.read(id) : Promise.reject(new Error('Jira is not configured')) : readNotionCard(this.config, id, this.api.fetch)
    const value: Promise<WorkCard> = read.then(card => {
      if (this.known.size >= 200) this.known.delete(this.known.keys().next().value!)
      this.known.set(id, { card, observedAt: new Date().toISOString() }); return card
    }).catch(error => { this.cards.delete(id); throw error })
    if (this.cards.size >= 200) this.cards.delete(this.cards.keys().next().value!)
    this.cards.set(id, { until: Date.now() + 60_000, value })
    return value
  }
  confirm(card: WorkCard) {
    this.known.set(card.id, { card, observedAt: new Date().toISOString() })
    this.cards.set(card.id, { until: Date.now() + 60_000, value: Promise.resolve(card) })
    for (const [key, { scope, observation }] of this.queries) observation.updateData(data => {
      const matches = scopeMatches(card, scope)
      const present = data.cards.some(item => item.id === card.id)
      if (matches === undefined && !present && this.queries.get(key)?.observation === observation) this.queries.delete(key)
      const retain = matches === true || matches === undefined && present
      return { ...data, cards: [...data.cards.filter(item => item.id !== card.id), ...(retain ? [card] : [])] }
    })
  }
}
