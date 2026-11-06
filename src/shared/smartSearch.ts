import Fuse from 'fuse.js'
import type { FloorScene, Target } from './reconciliationPresentation'
import { sceneSearchDocuments, type SearchDocument, type SearchField } from './searchDocuments'
import { verifiedLink, workHealth, type Pattern } from './workHealth'
import { homeLabel as homeLabelForSearch } from './reconciliationLabels'

export interface SearchFilter {
  query: string
  patterns: Pattern[]
  facets: Array<{ field: 'initiative' | 'machine' | 'manager' | 'entity'; value: string }>
}
export const emptySearch = (): SearchFilter => ({ query: '', patterns: [], facets: [] })
export const hasSearch = (search?: SearchFilter) => !!search && !!(search.query.trim() || search.patterns.length || search.facets.length)
export interface SearchHit { document: SearchDocument; rank: number; field: SearchField; ranges: Array<[number, number]> }
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\bpr\s*#?\s*(\d+)\b/g, 'pr $1').trim()
const tokens = (query: string) => [...normalized(query).matchAll(/"([^"]+)"|(\S+)/g)].map(match => ({ text: (match[1] ?? match[2]!).replace(/^#(?=\d+$)/, ''), exact: match[1] !== undefined }))

/** Mutable disposable index: changed documents alone are removed/upserted.
 * Rebuild is just construction from a current authorized scene. */
export class SmartSearchIndex {
  private records = new Map<string, { document: SearchDocument; fingerprint: string }>()
  private results = new Map<string, SearchHit[]>()
  private fuse = new Fuse<SearchDocument>([], { keys: ['title', 'fields.text'], threshold: 0.35, ignoreLocation: true, includeMatches: true, includeScore: true })
  update(documents: SearchDocument[]) {
    const incoming = new Set(documents.map(document => document.key))
    for (const key of this.records.keys()) if (!incoming.has(key)) { this.fuse.remove(document => document.key === key); this.records.delete(key); this.results.clear() }
    for (const document of documents) {
      const fingerprint = JSON.stringify(document)
      if (this.records.get(document.key)?.fingerprint === fingerprint) continue
      this.results.clear()
      this.fuse.remove(item => item.key === document.key)
      this.fuse.add(document); this.records.set(document.key, { document, fingerprint })
    }
  }
  search(query: string): SearchHit[] {
    const cached = this.results.get(query)
    if (cached) return cached
    const parts = tokens(query), q = normalized(query.replaceAll('"', '')).replace(/^#(?=\d+$)/, '')
    if (!parts.length) return [...this.records.values()].map(({ document }) => ({ document, rank: 0, field: document.fields[0] ?? { name: 'Name', source: 'Scene', text: document.title }, ranges: [] }))
    const fuzzy = new Map<string, Map<string, { score: number; field: SearchField; ranges: Array<[number, number]> }>>()
    for (const part of parts) {
      // Short words and numeric/technical identifiers must never drift to a
      // nearby ID. Prefix and exact matching still operate below.
      if (part.exact || part.text.length < 4 || /\d|[\/_#]/.test(part.text)) continue
      for (const hit of this.fuse.search(part.text)) {
        const match = hit.matches?.find(value => value.key === 'fields.text') ?? hit.matches?.[0]
        const field = match?.key === 'fields.text' ? hit.item.fields[match.refIndex ?? 0] : { name: 'Name', source: 'Scene', text: hit.item.title }
        if (!field) continue
        const entries = fuzzy.get(hit.item.key) ?? new Map()
        entries.set(part.text, { score: hit.score ?? 1, field, ranges: match ? match.indices.map(([a, b]) => [a, b] as [number, number]) : [] }); fuzzy.set(hit.item.key, entries)
      }
    }
    const hits: SearchHit[] = []
    for (const { document } of this.records.values()) {
      const fields: SearchField[] = [{ name: 'Identifier', source: 'Canonical source ID', text: document.identifiers.join(' · ') }, { name: 'Name', source: document.target.kind === 'card' ? 'Notion property' : 'First Mate snapshot', text: document.title }, ...document.fields]
      let field = fields[1]!, ranges: Array<[number, number]> = [], usedFuzzy = false, relevance = 0, found = true
      for (const part of parts) {
        const candidate = fields.find(value => {
          const text = normalized(value.text)
          if (/^\d+$/.test(part.text)) return text.split(/[^\p{L}\p{N}]+/u).includes(part.text)
          return text.includes(part.text)
        })
        if (candidate) {
          if (!ranges.length) { field = candidate; const at = normalized(candidate.text).indexOf(part.text); ranges = at < 0 ? [] : [[at, at + part.text.length - 1]] }
          else if (candidate === field) { const at = normalized(candidate.text).indexOf(part.text); if (at >= 0) ranges.push([at, at + part.text.length - 1]) }
          relevance += candidate.name === 'Name' ? 0 : 0.1
        } else {
          const approximate = fuzzy.get(document.key)?.get(part.text)
          if (!approximate) { found = false; break }
          usedFuzzy = true; relevance += approximate.score
          if (!ranges.length) { field = approximate.field; ranges = approximate.ranges }
        }
      }
      if (!found) continue
      const title = normalized(document.title)
      const rank = document.identifiers.some(id => normalized(id) === q) ? 0 : title === q ? 1 : !usedFuzzy && title.startsWith(q) ? 2 : usedFuzzy ? 4 + relevance / parts.length : 3 + relevance / parts.length
      hits.push({ document, rank, field, ranges })
    }
    hits.sort((a, b) => a.rank - b.rank || a.document.title.localeCompare(b.document.title) || a.document.key.localeCompare(b.document.key))
    this.results.set(query, hits)
    if (this.results.size > 32) this.results.delete(this.results.keys().next().value!)
    return hits
  }
}

// Each immutable scene has one disposable index, rather than rebuilding on the
// presentation's one-second clock or when the donuts request candidate counts.
const indexes = new WeakMap<FloorScene, SmartSearchIndex>()
export function updateSearchIndex(scene: FloorScene, index: SmartSearchIndex) {
  index.update(scene.searchIndex?.documents ?? sceneSearchDocuments(scene)); indexes.set(scene, index)
}
export function searchIndex(scene: FloorScene) {
  let index = indexes.get(scene)
  if (!index) { index = new SmartSearchIndex(); index.update(scene.searchIndex?.documents ?? sceneSearchDocuments(scene)); indexes.set(scene, index) }
  return index
}
export const targetKey = (target: Target) => `${target.kind}:${target.id}`
export function directNeighbors(scene: FloorScene, roots: readonly Target[]) {
  const keys = new Set(roots.map(targetKey))
  for (const root of roots) for (const claim of scene.claims) {
    if (!verifiedLink(claim)) continue
    if (root.kind === 'card' && root.id === claim.cardId) keys.add(`execution:${claim.executionId}`)
    if (root.kind === 'execution' && root.id === claim.executionId) keys.add(`card:${claim.cardId}`)
  }
  return keys
}

/** Return seeds satisfying predicates on the same canonical Work/Worker pair.
 * One-hop context is added only after every dimension has matched. */
const seedCache = new WeakMap<FloorScene, Map<string, { until: number; seeds: Target[] }>>()
export function searchSeeds(scene: FloorScene, search: SearchFilter, now: number): Target[] {
  const cache = seedCache.get(scene) ?? new Map<string, { until: number; seeds: Target[] }>()
  const key = JSON.stringify(search), cached = cache.get(key)
  if (cached && now < cached.until) return cached.seeds
  const hits = searchIndex(scene).search(search.query), hitKeys = new Set(hits.map(hit => hit.document.key))
  const seeds = new Map<string, Target>()
  const health = new Map(scene.cards.map(card => [card.id, workHealth(scene, card.id, now)]))
  const add = (target: Target) => seeds.set(targetKey(target), target)
  const pairs: Array<{ cardId?: string; workerId?: string }> = scene.claims.filter(verifiedLink).map(link => ({ cardId: link.cardId, workerId: link.executionId }))
  for (const card of scene.cards) pairs.push({ cardId: card.id })
  for (const worker of scene.executions) pairs.push({ workerId: worker.id })
  for (const pair of pairs) {
    const card = scene.cards.find(item => item.id === pair.cardId), worker = scene.executions.find(item => item.id === pair.workerId)
    if (search.patterns.length && (!card || !search.patterns.every(pattern => health.get(card.id)?.patterns[pattern].outcome === 'match'))) continue
    const matches = search.facets.every(facet => {
      switch (facet.field) {
        case 'machine': return worker?.placement.machine === facet.value
        case 'manager': { const source = scene.coverage.homes.find(home => home.source.home === worker?.home)?.source; return !!source && homeLabelForSearch(source) === facet.value }
        case 'entity': return card?.id === facet.value || worker?.identity.task_id === facet.value || worker?.id === facet.value
        case 'initiative': {
          const value = card?.source.properties.Initiative?.value
          return Array.isArray(value) ? value.includes(facet.value) : value === facet.value || !!card?.ancestry.includes(facet.value)
        }
      }
    })
    if (!matches) continue
    const cardHit = !!card && hitKeys.has(`card:${card.id}`), workerHit = !!worker && hitKeys.has(`execution:${worker.id}`)
    if (!cardHit && !workerHit) continue
    if (search.patterns.length && card) add({ kind: 'card', id: card.id })
    else {
      if (cardHit && card) add({ kind: 'card', id: card.id })
      if (workerHit && worker) add({ kind: 'execution', id: worker.id })
    }
  }
  const result = [...seeds.values()]
  // Classifications change only when a new scene arrives, a read fails, or an
  // observation expires. Do not rerun the same predicates for every donut/clock.
  const deadlines = [scene.coverage.intentions, ...scene.coverage.homes.map(home => home.observation)].map(observation => Date.parse(observation.expiresAt ?? '')).filter(at => at > now)
  cache.set(key, { until: Math.min(Infinity, ...deadlines), seeds: result })
  if (cache.size > 32) cache.delete(cache.keys().next().value!)
  seedCache.set(scene, cache)
  return result
}
