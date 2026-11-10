import type { SceneCard } from '../server/reconciliation/scene'
import type { PresentationState } from './presentation'
import { propertyDate, propertyText } from './recordFields'
import { checkInTime } from '../shared/checkIn'

export const waitingForTypes = ['Actor', 'Event', 'Work'] as const
export type WaitingForType = typeof waitingForTypes[number]
export interface WaitingForGroup {
  key: string; type: WaitingForType; id: string; label: string; cards: SceneCard[]
  target?: { kind: 'card'; id: string } | { kind: 'url'; url: string }
}
const normalize = (id: string) => id.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
const pageId = (id: string) => /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id) ? id.replaceAll('-', '').toLowerCase() : null
export function waitingForActive(state: PresentationState) {
  const statuses = state.donutFilter?.cards.length ? state.donutFilter.cards : state.statusFilter?.preset === 'custom' ? state.statusFilter.statuses : []
  return statuses.length === 1 && statuses[0] === 'Waiting For'
}
function githubTarget(value: string) {
  try {
    const url = new URL(value)
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|actions\/runs)\/(\d+)\/?$/)
    // Only exact GitHub PR/run URLs are dependency destinations. Other IDs stay text.
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port && match
      ? { url: `https://github.com${url.pathname.replace(/\/$/, '')}`, repo: match[2]!, number: match[4]!, kind: match[3]!, label: `${match[2]} ${match[3] === 'pull' ? 'PR #' : 'run #'}${match[4]}` } : null
  } catch { return null }
}
function eventTarget(id: string, cards: SceneCard[]) {
  const direct = githubTarget(id)
  if (direct) return direct
  const candidates = cards.flatMap(card => [...propertyText(card, 'Waiting For').matchAll(/https:\/\/github\.com\/[^\s<>"()]+/g)].flatMap(match => {
    const parsed = githubTarget(match[0].replace(/[.,;]+$/, ''))
    return parsed && normalize(id).includes(parsed.repo.toLowerCase()) && new RegExp(`(?:#|\\b)${parsed.number}\\b`).test(id) ? [parsed] : []
  }))
  const unique = [...new Map(candidates.map(value => [value.url, value])).values()]
  return unique.length === 1 ? unique[0] : null
}
export function waitingForIssue(card: SceneCard, known: readonly SceneCard[]): string | null {
  if (propertyText(card, 'Status') !== 'Waiting For') return null
  const type = propertyText(card, 'Waiting For Type'), id = propertyText(card, 'Waiting For ID').trim()
  if (!type) return 'Waiting For Type is missing.'
  if (!waitingForTypes.includes(type as WaitingForType)) return `Waiting For Type “${type}” is not Work, Actor or Event.`
  if (!id) return 'Waiting For ID is missing.'
  if (type === 'Work') {
    const canonical = pageId(id)
    if (!canonical) return 'Waiting For ID is not a valid Notion Work card identifier.'
    if (canonical === pageId(card.id)) return 'Waiting For ID references this same Work card.'
    if (!known.some(card => pageId(card.id) === canonical && !card.source.in_trash && !card.source.archived)) return 'Waiting For ID does not resolve to a Work card in the loaded source. The reference needs verification.'
  }
  return null
}
const priority = (card: SceneCard) => {
  const value = propertyText(card, 'Priority').replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase()
  return Number(value.match(/^p?(\d+)$/)?.[1] ?? ({ urgent: 0, critical: 0, high: 1, medium: 2, normal: 2, low: 3 }[value] ?? 100))
}
const title = (card: SceneCard) => propertyText(card, 'Name') || 'Untitled card'
const checkpoint = (card: SceneCard) => {
  const date = card.source.properties['Next check-in']?.value as { time_zone?: string } | undefined
  const time = checkInTime(propertyDate(card, 'Next check-in'), date?.time_zone)
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER
}
const compareCards = (a: SceneCard, b: SceneCard) => priority(a) - priority(b) || checkpoint(a) - checkpoint(b) || title(a).localeCompare(title(b)) || a.id.localeCompare(b.id)
/** A projection of the shared read, never a dependency store or a workflow action. */
export function waitingForGroups(scope: readonly SceneCard[], known: readonly SceneCard[] = scope) {
  const distinct = new Map<string, SceneCard>()
  for (const card of scope) {
    const key = pageId(card.id) ?? card.id, old = distinct.get(key)
    if (!old || card.source.last_edited_time > old.source.last_edited_time) distinct.set(key, card)
  }
  const active = [...distinct.values()].filter(card => propertyText(card, 'Status') === 'Waiting For' && !card.source.archived && !card.source.in_trash)
  const groups = new Map<string, WaitingForGroup>(), unclassified: SceneCard[] = []
  for (const card of active.sort(compareCards)) {
    if (waitingForIssue(card, known)) { unclassified.push(card); continue }
    const type = propertyText(card, 'Waiting For Type') as WaitingForType, id = propertyText(card, 'Waiting For ID').trim()
    const canonical = type === 'Work' ? pageId(id)! : normalize(type === 'Event' ? githubTarget(id)?.url ?? id : id), key = JSON.stringify([type, canonical])
    let group = groups.get(key)
    if (!group) {
      const work = type === 'Work' ? known.find(card => pageId(card.id) === canonical) : null
      group = { key, type, id, label: work ? title(work) : id, cards: [], ...(work ? { target: { kind: 'card' as const, id: work.id } } : {}) }
      groups.set(key, group)
    }
    group.cards.push(card)
  }
  for (const group of groups.values()) if (group.type === 'Event') {
    const link = eventTarget(group.id, group.cards)
    if (link) { group.target = { kind: 'url', url: link.url }; if (githubTarget(group.id)) group.label = link.label }
  }
  const categories = waitingForTypes.map(type => ({ type, groups: [...groups.values()].filter(group => group.type === type).sort((a, b) =>
    (type === 'Actor' ? Number(normalize(b.id) === 'will') - Number(normalize(a.id) === 'will') : 0) || b.cards.length - a.cards.length || a.label.localeCompare(b.label) || a.key.localeCompare(b.key)) }))
  const initial = [...groups.values()].sort((a, b) => Number(b.type === 'Actor' && normalize(b.id) === 'will') - Number(a.type === 'Actor' && normalize(a.id) === 'will') || b.cards.length - a.cards.length || a.label.localeCompare(b.label)).slice(0, 3).map(group => group.key)
  return { categories, unclassified, count: active.length, initial }
}

const expansionKey = 'tinstar.overview.waitingFor.expansion.v1'
export function readWaitingForExpansion(): ReadonlySet<string> | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(expansionKey) ?? 'null')
    return Array.isArray(value) && value.every(key => typeof key === 'string') ? new Set(value) : null
  } catch { return null }
}
export function saveWaitingForExpansion(value: ReadonlySet<string>) {
  try { sessionStorage.setItem(expansionKey, JSON.stringify([...value])) } catch { /* ordinary view state still works when storage is unavailable */ }
}
