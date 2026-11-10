import type { ReconciliationConfig } from './config'
import { notionObservation, readNotionCard, type WorkScope } from './notion'
import { NotionApi } from './notionApi'
import { checkInTime } from '../../shared/checkIn'
export type WorkCard = Awaited<ReturnType<typeof readNotionCard>>
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
  private queries = new Map<string, { scope: WorkScope; observation: ReturnType<typeof notionObservation> }>()
  private cards = new Map<string, { until: number; value: Promise<WorkCard> }>()
  private known = new Map<string, { card: WorkCard; observedAt: string }>()
  lastKnown(id: string) { return this.known.get(id) }
  constructor(readonly config: ReconciliationConfig['notion'], readonly api: NotionApi) {}
  query(scope: WorkScope = {}, force = false) {
    const key = JSON.stringify([scope.owner, scope.statuses?.slice().sort(), scope.initiative, scope.epic, scope.checkpoint_before, !!scope.history])
    let entry = this.queries.get(key)
    if (!entry) {
      if (this.queries.size >= 100) this.queries.delete(this.queries.keys().next().value!)
      entry = { scope, observation: notionObservation(this.config, this.api.fetch, scope) }
      this.queries.set(key, entry)
    } else if (!force && entry.observation.isCached()) this.api.diagnostics.cacheHits++
    return entry.observation.get(force)
  }
  card(id: string, force = false) {
    const cached = this.cards.get(id)
    if (!force && cached && cached.until > Date.now()) { this.api.diagnostics.cacheHits++; return cached.value }
    const value = readNotionCard(this.config, id, this.api.fetch).then(card => {
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
