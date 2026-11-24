import type { CardLeases, SourceWriteIntent } from './cardLeases'
import type { ReconciliationConfig } from './config'
import { notionObservation, readNotionCard, type WorkScope } from './notion'
import { NotionApi } from './notionApi'
import { canonicalWorkId, waitingForWorkIds, workBlocker, type WaitState, type WorkBlocker } from '../../shared/waitingForPolicy'
import { checkInTime } from '../../shared/checkIn'
import { isJiraCard } from '../../shared/workIdentity'
import { JiraAdapter } from './jira'
import { CachedObservation, retainMissing, type Observation } from './observation'
import type { JiraWork } from './jiraWork'
export type WorkCard = Awaited<ReturnType<typeof readNotionCard>> & { source?: { provider: 'jira'; instanceId: string; collectionId: string; itemId: string; displayKey: string; synthetic: boolean } }
export type WorkData = Omit<NonNullable<Awaited<ReturnType<ReturnType<typeof notionObservation>['get']>>['data']>, 'cards'> & { cards: WorkCard[] }
export function legacyWorkObservation(value: Observation<WorkData>): Observation<WorkData> {
  if (!value.sources) return value
  const board = value.sources.find(source => source.source !== 'jira')
  if (!board) return { status: 'unknown', coverage: 'unknown', data: null, observedAt: null,
    attemptedAt: value.attemptedAt, expiresAt: null, error: null }
  const { source: _source, ...metadata } = board
  return { ...metadata, data: value.data && board.observedAt
    ? { ...value.data, cards: value.data.cards.filter(card => card.source?.synthetic !== false), hasMore: board.hasMore ?? board.coverage !== 'complete' }
    : null }
}

const sourceCoverage = <T>(source: string, { data: _data, sources: _sources, ...observation }: Observation<T>) => ({ source, ...observation })
const scopeKey = (scope: WorkScope) => JSON.stringify([scope.owner, scope.statuses?.slice().sort(), scope.initiative, scope.epic, scope.checkpoint_before, !!scope.history])
export const scopeMatches = (card: WorkCard, scope: WorkScope) => {
  const value = (name: string) => card.properties[name]?.value
  const has = (name: string, expected?: string) => !expected || (Array.isArray(value(name)) ? (value(name) as unknown[]).includes(expected) : value(name) === expected)
  const date = value('Next check-in') as { start?: string; time_zone?: string } | null
  const classifications = ([['Initiative', scope.initiative], ['Epic', scope.epic]] as const).map(([name, expected]) =>
    has(name, expected) ? true : card.properties[name]?.type === 'relation' && card.properties[name]?.hasMore ? undefined : false)
  const status = String(value('Status'))
  const includeCanceled = card.source?.synthetic === false && status === 'Canceled' && scope.statuses?.includes(status)
  const matches = (!card.archived || includeCanceled) && !card.in_trash && has('Owner', scope.owner) &&
    (scope.statuses ? scope.statuses.includes(status) : scope.history || !['Done', 'Archived'].includes(status)) &&
    (!scope.checkpoint_before || !!date?.start && checkInTime(date.start, date.time_zone) <= Date.parse(scope.checkpoint_before))
  return !matches || classifications.includes(false) ? false : classifications.includes(undefined) ? undefined : true
}
export class WorkReader {
  leases?: CardLeases
  onConfirmed?: (card: WorkCard) => void
  private queries = new Map<string, { scope: WorkScope; includePilot: boolean; observation: CachedObservation<WorkData> }>()
  private cards = new Map<string, { until: number; value: Promise<WorkCard>; background: boolean }>()
  private known = new Map<string, { card: WorkCard; observedAt: string }>()
  mutate<T>(id: string, perform: () => Promise<T>, intent?: SourceWriteIntent, probe?: (intent: SourceWriteIntent) => Promise<'applied' | 'different' | 'unknown'>) { return this.leases ? this.leases.mutate(id, perform, intent, probe) : perform() }
  lastKnown(id: string) { return this.known.get(id) }
  readonly jira?: JiraAdapter
  constructor(readonly config: ReconciliationConfig['notion'], readonly api: NotionApi, jira?: ReconciliationConfig['jira'], private readonly native?: JiraWork) {
    if (jira) this.jira = new JiraAdapter(jira, api.fetch, api.backgroundFetch, api.parallelFetch)
  }
  private board(scope: WorkScope, force: boolean, background: boolean, includePilot = true) {
    const key = !includePilot && this.jira ? `notion:${scopeKey(scope)}` : scopeKey(scope)
    let entry = this.queries.get(key)
    if (!entry) {
      if (this.queries.size >= 100) this.queries.delete(this.queries.keys().next().value!)
      const notion = notionObservation(this.config, this.api.parallelFetch, scope, this.api.backgroundFetch), jira = includePilot ? this.jira?.observation(scope) : undefined
      const observation = !jira ? notion : !this.config ? jira : new CachedObservation<WorkData>(async background => {
        const reads = await Promise.all([notion.get(true, background), jira.get(true, background)])
        const available = reads.flatMap(read => read.data ? [read.data] : [])
        if (!available.length) throw new Error('Work sources unavailable')
        const complete = reads.every(read => read.status === 'fresh' && read.coverage === 'complete')
        return { observedAt: new Date().toISOString(), coverage: complete ? 'complete' : 'partial', data: { ...available[0]!,
          cards: available.flatMap(data => data.cards), hasMore: !complete, scope: 'Independent Notion and synthetic Jira sources; no sync or dual writes' } }
      }, 60_000, 120_000, 'Work source coverage incomplete', Date.now, (previous, current) => ({ ...current, cards: retainMissing(previous.cards, current.cards, card => card.id) }))
      entry = { scope, includePilot: !!jira, observation }
      this.queries.set(key, entry)
    } else if (!force && entry.observation.isCached()) this.api.diagnostics.cacheHits++
    return entry.observation.get(force, background)
  }
  async query(scope: WorkScope = {}, force = false, background = false, includeNative = false): Promise<Observation<WorkData>> {
    if (!includeNative || !this.native) return this.board(scope, force, background)
    const revision = this.native.accessRevision
    const [board, jira] = await Promise.all([
      this.config || this.jira ? this.board(scope, force, background) : null,
      this.native.observationFor(scope).get(force, background),
    ])
    return this.combine(scope, board, revision === this.native.accessRevision ? jira : { ...jira, data: null, status: 'unknown', coverage: 'unknown', observedAt: null, expiresAt: null })
  }
  async workerLinkQuery(keys: readonly string[]): Promise<Observation<WorkData>> {
    if (!keys.length || !this.native) return this.board({}, false, false, false)
    const revision = this.native.accessRevision
    const [board, jira] = await Promise.all([
      this.config ? this.board({}, false, false, false) : null,
      this.native.readTswTargets(keys),
    ])
    return this.combine({}, board, revision === this.native.accessRevision ? jira : { ...jira, data: null, status: 'unknown', coverage: 'unknown', observedAt: null, expiresAt: null })
  }

  private combine(scope: WorkScope, board: Observation<WorkData> | null, jira: Observation<WorkData>): Observation<WorkData> {
    const sources = [...(board ? [{ ...sourceCoverage(this.config ? 'notion' : 'jira-pilot', board), hasMore: board.data?.hasMore }] : []), sourceCoverage('jira', jira)]
    const complete = sources.every(source => source.status === 'fresh' && source.coverage === 'complete')
    const data = board?.data ?? jira.data
    const oldest = (key: 'observedAt' | 'expiresAt') => sources.flatMap(source => source[key] ?? []).sort()[0] ?? null
    return { ...jira, sources, observedAt: oldest('observedAt'), expiresAt: complete ? oldest('expiresAt') : null,
      status: complete ? 'fresh' : data ? 'partial' : 'unknown', coverage: complete ? 'complete' : 'partial',
      error: sources.flatMap(source => source.error ?? []).join('; ') || null,
      data: data && { ...data, cards: [...board?.data?.cards ?? [], ...jira.data?.cards.filter(card => scopeMatches(card, scope)) ?? []],
        hasMore: !complete, scope: 'Configured work sources' } }
  }
  declarations(includeNative = false): Observation<WorkData> {
    const pending = {
      status: 'unknown' as const, coverage: 'unknown' as const, data: null,
      observedAt: null, attemptedAt: new Date().toISOString(), expiresAt: null, error: 'Broader declaration coverage is unavailable',
    }
    const board = this.queries.get(scopeKey({}))?.observation.peek() ?? pending
    return includeNative && this.native
      ? this.combine({}, this.config || this.jira ? board : null, this.native.observation.peek() ?? pending) : board
  }
  card(id: string, force = false, background = false, signal?: AbortSignal) {
    const cached = this.cards.get(id)
    if (!force && cached && cached.until > Date.now() && (background || !cached.background)) { this.api.diagnostics.cacheHits++; return cached.value }
    const read = isJiraCard(id) ? this.jira ? this.jira.read(id, signal, background) : Promise.reject(new Error('Jira is not configured')) : readNotionCard(this.config, id, background ? this.api.backgroundFetch : this.api.fetch, signal)
    const value: Promise<WorkCard> = read.then(card => {
      signal?.throwIfAborted()
      if (this.cards.get(id)?.value !== value) return card
      this.cards.get(id)!.background = false
      if (this.known.size >= 200) this.known.delete(this.known.keys().next().value!)
      this.known.set(id, { card, observedAt: new Date().toISOString() }); return card
    }).catch(error => { if (this.cards.get(id)?.value === value) this.cards.delete(id); throw error })
    if (this.cards.size >= 200) this.cards.delete(this.cards.keys().next().value!)
    this.cards.set(id, { until: Date.now() + 60_000, value, background })
    return value
  }
  async waitingForWork(waits: readonly WaitState[], loaded: readonly WorkCard[] = [], { refresh = false, cachedOnly = false } = {}) {
    const ids = new Set(waits.flatMap(waitingForWorkIds))
    const references = new Map<string, WorkBlocker>()
    for (const card of loaded) {
      const id = canonicalWorkId(card.id)
      if (id && ids.delete(id)) references.set(id, workBlocker(card))
    }
    // Resolve each distinct missing target once through the foreground queue.
    // Cap request latency on large or slow boards; unread targets stay unknown.
    if (!ids.size) return references
    const deadline = cachedOnly ? undefined : AbortSignal.timeout(10_000)
    await Promise.all([...ids].map(async id => {
      // Ordinary UI polls carry forward exact evidence already read. An
      // explicit refresh rechecks it, and a failed check evicts it from cards.
      const read = cachedOnly ? this.cards.get(id)?.value : this.card(id, refresh, false, deadline)
      if (!read) return
      try { references.set(id, workBlocker(await read)) }
      catch { /* failure or limited source access leaves this target unknown */ }
    }))
    return references
  }
  confirm(card: WorkCard) {
    this.onConfirmed?.(card)
    this.known.set(card.id, { card, observedAt: new Date().toISOString() })
    this.cards.set(card.id, { until: Date.now() + 60_000, value: Promise.resolve(card), background: false })
    for (const [key, { scope, includePilot, observation }] of this.queries) {
      if (!includePilot && isJiraCard(card.id)) continue
      observation.updateData(data => {
        const matches = scopeMatches(card, scope)
        const present = data.cards.some(item => item.id === card.id)
        if (matches === undefined && !present && this.queries.get(key)?.observation === observation) this.queries.delete(key)
        const retain = matches === true || matches === undefined && present
        return { ...data, cards: [...data.cards.filter(item => item.id !== card.id), ...(retain ? [card] : [])] }
      })
    }
  }
}
