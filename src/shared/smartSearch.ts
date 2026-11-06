import Fuse from 'fuse.js'
import type { FloorScene, Target } from './reconciliationPresentation'
import { sceneSearchDocuments, type SearchDocument, type SearchField } from './searchDocuments'
import { verifiedLink, sceneWorkHealth, type Pattern } from './workHealth'
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
function mappedText(value: string) {
  let text = ''
  let offsets: Array<[number, number]> = []
  for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
    const part = segment.normalize('NFKC')
    text += part
    offsets.push(...Array.from({ length: part.length }, () => [index, index + segment.length - 1] as [number, number]))
  }
  const lower = text.toLowerCase()
  const lowerOffsets: Array<[number, number]> = []
  for (let index = 0; index < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(index)!)
    lowerOffsets.push(...Array.from({ length: character.toLowerCase().length }, () => [offsets[index]![0], offsets[index + character.length - 1]![1]] as [number, number]))
    index += character.length
  }
  text = lower; offsets = lowerOffsets
  for (const match of [...text.matchAll(/\bpr\s*#?\s*(\d+)\b/g)].reverse()) {
    const start = match.index!, digits = start + match[0].length - match[1]!.length
    text = text.slice(0, start) + `pr ${match[1]}` + text.slice(start + match[0].length)
    offsets.splice(start, match[0].length, offsets[start]!, offsets[start + 1]!, offsets[start + 2] ?? offsets[digits]!, ...offsets.slice(digits, start + match[0].length))
  }
  const start = text.length - text.trimStart().length
  return { text: text.trim(), offsets: offsets.slice(start, start + text.trim().length) }
}
const tokens = (query: string) => [...normalized(query).matchAll(/"([^"]+)"|(\S+)/g)].map(match => ({ text: (match[1] ?? match[2]!).replace(/^#(?=\d+$)/, ''), exact: match[1] !== undefined }))

function literalOccurrence(text: string, term: string) {
  const numbers = [...term.matchAll(/[\p{L}\p{N}]+/gu)].filter(match => /^\d+$/.test(match[0]))
  for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) {
    if (numbers.every(match => {
      const start = at + match.index!, end = start + match[0].length
      return !/[\p{L}\p{N}]$/u.test(text.slice(0, start)) && !/^[\p{L}\p{N}]/u.test(text.slice(end))
    })) return at
  }
  return -1
}

/** Mutable disposable index: changed documents alone are removed/upserted.
 * Rebuild is just construction from a current authorized scene. */
export class SmartSearchIndex {
  private records = new Map<string, { document: SearchDocument; fingerprint: string; terms: Set<string>; fields: Array<{ field: SearchField; text: string; offsets: Array<[number, number]> }> }>()
  private vocabulary = new Map<string, Map<string, { field: SearchField; offsets: Array<[number, number]> }>>()
  private results = new Map<string, SearchHit[]>()
  // Match a deduplicated vocabulary, then follow postings to original fields.
  // Scanning every multi-kilobyte excerpt with Bitap on every keystroke caused
  // 225–489ms queries at the documented text budgets.
  private fuse = new Fuse<string>([], { threshold: 0.35, ignoreLocation: true, includeMatches: true, includeScore: true })
  update(documents: SearchDocument[]) {
    let vocabularyChanged = false
    const remove = (key: string) => {
      for (const word of this.records.get(key)?.terms ?? []) {
        const postings = this.vocabulary.get(word)!
        postings.delete(key)
        if (!postings.size) { this.vocabulary.delete(word); vocabularyChanged = true }
      }
      this.records.delete(key); this.results.clear()
    }
    const incoming = new Set(documents.map(document => document.key))
    for (const key of this.records.keys()) if (!incoming.has(key)) remove(key)
    for (const document of documents) {
      const fingerprint = JSON.stringify([document.title, document.identifiers, document.fields])
      const previous = this.records.get(document.key)
      if (previous?.fingerprint === fingerprint) {
        if (previous.document !== document) { previous.document = document; this.results.clear() }
        continue
      }
      remove(document.key)
      const terms = new Set<string>()
      const fields = [{ name: 'Identifier', source: 'Canonical source ID', text: document.identifiers.join(' · ') },
        { name: 'Name', source: document.target.kind === 'card' ? 'Notion property' : 'First Mate snapshot', text: document.title }, ...document.fields]
        .map(field => { const { text, offsets } = mappedText(field.text); return { field, text, offsets } })
      for (const { field } of fields.slice(1)) for (const match of field.text.matchAll(/[\p{L}\p{N}]+/gu)) {
        const { text: word, offsets } = mappedText(match[0])
        if (word.length < 4 || terms.has(word)) continue
        let postings = this.vocabulary.get(word)
        if (!postings) { postings = new Map(); this.vocabulary.set(word, postings); vocabularyChanged = true }
        postings.set(document.key, { field, offsets: offsets.map(([a, b]) => [a + match.index!, b + match.index!]) }); terms.add(word)
      }
      this.records.set(document.key, { document, fingerprint, terms, fields })
      this.results.clear()
    }
    if (vocabularyChanged) this.fuse.setCollection([...this.vocabulary.keys()])
  }
  search(query: string, now = Date.now()): SearchHit[] {
    // A retained scene can outlive a failed network read. Drop body prose at
    // the source expiry even then, rather than searching old sensitive prose
    // indefinitely. Published scene metadata remains a labeled fallback.
    const records = [...this.records.values()]
    const expired = (document: SearchDocument) => document.target.kind === 'card' &&
      (!document.expiresAt || Date.parse(document.expiresAt) <= now) && document.fields.some(field => field.source.startsWith('Notion blocks'))
    if (records.some(record => expired(record.document))) this.update(records.map(({ document }) => expired(document)
      ? { ...document, fields: document.fields.filter(field => !field.source.startsWith('Notion blocks')) } : document))
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
        for (const [key, posting] of this.vocabulary.get(hit.item) ?? []) {
          const entries = fuzzy.get(key) ?? new Map(), score = hit.score ?? 1
          if (score >= (entries.get(part.text)?.score ?? Infinity)) continue
          const ranges = hit.matches?.[0]?.indices.map(([a, b]) => [posting.offsets[a]![0], posting.offsets[b]![1]] as [number, number]) ?? []
          entries.set(part.text, { score, field: posting.field, ranges }); fuzzy.set(key, entries)
        }
      }
    }
    const hits: SearchHit[] = []
    for (const { document, fields } of this.records.values()) {
      let field = fields[1]!.field, ranges: Array<[number, number]> = [], usedFuzzy = false, relevance = 0, found = true
      for (const part of parts) {
        const occurrence = fields.map(candidate => ({ candidate, at: literalOccurrence(candidate.text, part.text) })).find(match => match.at >= 0)
        if (occurrence) {
          const { candidate, at } = occurrence
          if (!ranges.length) field = candidate.field
          if (candidate.field === field) ranges.push([candidate.offsets[at]![0], candidate.offsets[at + part.text.length - 1]![1]])
          relevance += candidate.field.name === 'Name' ? 0 : 0.1
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
  const hits = searchIndex(scene).search(search.query, now), hitKeys = new Set(hits.map(hit => hit.document.key))
  const seeds = new Map<string, Target>()
  const health = new Map(search.patterns.length ? sceneWorkHealth(scene, now).map(item => [item.cardId, item]) : [])
  const cards = new Map(scene.cards.map(card => [card.id, card])), workers = new Map(scene.executions.map(worker => [worker.id, worker]))
  const add = (target: Target) => seeds.set(targetKey(target), target)
  const pairs: Array<{ cardId?: string; workerId?: string }> = scene.claims.filter(verifiedLink).map(link => ({ cardId: link.cardId, workerId: link.executionId }))
  for (const card of scene.cards) pairs.push({ cardId: card.id })
  for (const worker of scene.executions) pairs.push({ workerId: worker.id })
  for (const pair of pairs) {
    const card = pair.cardId ? cards.get(pair.cardId) : undefined, worker = pair.workerId ? workers.get(pair.workerId) : undefined
    if (search.patterns.length && (!card || !search.patterns.every(pattern => health.get(card.id)?.patterns[pattern].outcome === 'match'))) continue
    const matches = search.facets.every(facet => {
      switch (facet.field) {
        case 'machine': return worker?.placement.machine === facet.value
        case 'manager': { const source = scene.coverage.homes.find(home => home.source.home === worker?.home)?.source; return !!source && homeLabelForSearch(source) === facet.value }
        case 'entity': return card?.id === facet.value || worker?.identity.task_id === facet.value || worker?.id === facet.value
        case 'initiative': {
          const property = card?.source.properties.Initiative
          const value = property && ['relation', 'select', 'rich_text'].includes(property.type ?? '') ? property.value : null
          return (Array.isArray(value) ? value : [value]).some(id => typeof id === 'string' && !!id.trim() && id.trim() === facet.value)
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
