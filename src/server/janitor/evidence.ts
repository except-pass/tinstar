import { createHash } from 'node:crypto'
import type { SourceSnapshot } from '../reconciliation'
import { notionPageId } from '../reconciliation/notion'

export type AuditCard = NonNullable<SourceSnapshot['intentions']['data']>['cards'][number]
export const prop = (card: AuditCard, name: string): unknown => card.properties[name]?.value ?? null
export const word = (card: AuditCard, name: string): string => typeof prop(card, name) === 'string' ? (prop(card, name) as string).trim() : ''
export const ids = (card: AuditCard, name: string): string[] => Array.isArray(prop(card, name))
  ? (prop(card, name) as unknown[]).flatMap(value => notionPageId(value) ?? []) : []
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export const sorted = (values: string[]) => [...new Set(values)].sort(compare)

/** Canonical serialization, so collection/property ordering never changes identity. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => compare(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export const fingerprint = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')
export const clean = (value: string) => value.replace(/\b(?:secret_|ntn_|sk-)[A-Za-z0-9_-]{16,}\b/g, '[credential omitted]')
export const title = (card: AuditCard) => clean(word(card, 'Name')) || '(Untitled)'
export const pageUrl = (card: AuditCard) => {
  try {
    const url = new URL(card.url ?? '')
    if (url.protocol === 'https:' && /^(?:(?:www|app)\.)?notion\.(?:com|so)$/.test(url.hostname) && !url.username && !url.password) return url.href
  } catch { /* Canonical ID remains a usable source link. */ }
  return `https://www.notion.so/${card.id}`
}
export const normalizeTitle = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const stop = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'from', 'on', 'by', 'tin', 'star', 'task', 'tasks'])
export const titleTokens = (value: string) => sorted(normalizeTitle(value).split(' ').filter(t => t.length > 2 && !stop.has(t))
  .map(t => /^(?:workers|links|scopes|cards)$/.test(t) ? t.slice(0, -1) : t))

/** Only stable work identifiers, not arbitrary same-domain links or title guesses. */
export function workKeys(value: string): string[] {
  return sorted([...value.matchAll(/https:\/\/[^\s<>"()[\]]+/g)].flatMap(match => {
    try {
      const url = new URL(match[0].replace(/[.,;]+$/, ''))
      if (url.username || url.password) return []
      const pull = url.hostname === 'github.com' && url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?(?:\/.*)?$/)
      if (pull) return [`https://github.com/${pull[1]!.toLowerCase()}/${pull[2]!.toLowerCase()}/pull/${pull[3]}`]
      const jira = url.pathname.match(/^\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/)
      return jira ? [`https://${url.hostname}/browse/${jira[1]}`] : []
    } catch { return [] }
  }))
}
export interface Features {
  normalizedTitle: string
  tokens: string[]
  identifiers: string[]
}
export type FeatureCache = Map<string, Features>
export function features(card: AuditCard, cache: FeatureCache, metrics: { cacheHits: number; cacheMisses: number }): Features {
  const key = fingerprint({ id: card.id, properties: card.properties, edited: card.last_edited_time })
  const cached = cache.get(key)
  if (cached) { metrics.cacheHits++; return cached }
  metrics.cacheMisses++
  const value = { normalizedTitle: normalizeTitle(word(card, 'Name')), tokens: titleTokens(word(card, 'Name')),
    identifiers: workKeys(['Link', 'Evidence'].map(name => word(card, name)).join('\n')) }
  // Bounded process-local cache; no source state or review decisions are persisted here.
  if (cache.size >= 2048) cache.delete(cache.keys().next().value!)
  cache.set(key, value)
  return value
}

/** Bounded, stable neighbors. Shared parent/initiative alone is never a finding. */
export function neighbors(cards: AuditCard[], derived: Map<string, Features>, limit = 8) {
  const index = new Map<string, string[]>()
  const keys = (card: AuditCard) => {
    const f = derived.get(card.id)!
    return [...f.tokens.map(t => `token:${t}`), ...f.identifiers.map(t => `identifier:${t}`),
      ...(f.normalizedTitle ? [`title:${f.normalizedTitle}`] : []), ...ids(card, 'Parent item').map(t => `parent:${t}`)]
  }
  for (const card of cards) for (const key of keys(card)) index.set(key, [...(index.get(key) ?? []), card.id])
  const pairs = new Map<string, [string, string]>()
  for (const card of cards) {
    const scores = new Map<string, number>()
    for (const key of keys(card)) {
      // Stop huge common-word buckets from degenerating into an all-pairs pass.
      const bucket = index.get(key) ?? []
      const position = bucket.indexOf(card.id)
      const entries = bucket.length > limit * 2 + 1 ? bucket.slice(Math.max(0, position - limit), position + limit + 1) : bucket
      for (const id of entries) if (id !== card.id) scores.set(id, (scores.get(id) ?? 0) + (key.startsWith('token:') ? 1 : 10))
    }
    const ranked = [...scores].sort(([a, sa], [b, sb]) => sb - sa || compare(a, b)).slice(0, limit)
    for (const [id] of ranked) {
      const pair = [card.id, id].sort(compare) as [string, string]
      pairs.set(stable(pair), pair)
    }
  }
  return [...pairs.values()].sort((a, b) => compare(stable(a), stable(b)))
}
