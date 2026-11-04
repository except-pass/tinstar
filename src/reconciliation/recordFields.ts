import type { SceneCard } from '../server/reconciliation/scene'
import type { FloorScene } from './presentation'
import { cardStatus, cardTitle } from './overviewModel'
import { dateTimestamp } from '../shared/floorOrganization'

export function propertyText(card: SceneCard, name: string): string {
  const value = card.source.properties[name]?.value
  return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string').join(', ')
}
export function propertyDate(card: SceneCard, name: string): string | null {
  const value = card.source.properties[name]?.value
  return value && typeof value === 'object' && 'start' in value && typeof value.start === 'string' ? value.start : null
}
export function workBreadcrumb(scene: FloorScene, card: SceneCard): string {
  return ['Initiative', 'Epic'].map(name => {
    const property = card.source.properties[name]
    if (!property) return ''
    if (property.type !== 'relation') return propertyText(card, name)
    const ids = Array.isArray(property.value) ? property.value : []
    return ids.map(id => scene.cards.find(c => c.id === id)).map(c => c ? cardTitle(c) : 'Unassigned').join(', ')
  }).filter(Boolean).join(' / ') || 'Unassigned'
}
export function ageLabel(time: number, now: number): string {
  if (!Number.isFinite(time) || time <= 0) return 'Unknown'
  const seconds = Math.max(0, Math.floor((now - time) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
export function dateLabel(value: string | null): string {
  if (!value) return 'Not set'
  const time = dateTimestamp(value)
  if (!Number.isFinite(time)) return 'Unknown'
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', ...(value.length > 10 ? { hour: 'numeric', minute: '2-digit' } as const : {}) }).format(time)
}
export function checkIn(card: SceneCard, now: number): { state: string; label: string } {
  const status = cardStatus(card).toLowerCase()
  if (['done', 'archived', 'backlog', 'todo', 'not started', 'planned', 'spare tokens'].includes(status)) return { state: 'not-applicable', label: 'Not applicable' }
  const at = propertyDate(card, 'Next check-in')
  if (!at) return { state: 'missing', label: 'Not scheduled' }
  const time = dateTimestamp(at)
  return { state: Number.isFinite(time) ? time < now ? 'overdue' : 'upcoming' : 'unknown', label: `${time < now ? 'Overdue · ' : ''}${dateLabel(at)}` }
}
/** Stable order for compact cards and complete Inspector metadata. */
export function taskFields(card: SceneCard, now: number, actionable = true) {
  const complete = ['done', 'archived'].includes(cardStatus(card).toLowerCase())
  const fields: Array<[string, string]> = [
    ['Status', cardStatus(card)], ['Owner', propertyText(card, 'Owner') || 'Unassigned'],
    ['Next check-in', checkIn(card, now).label],
    ['Last edited', ageLabel(Date.parse(card.source.last_edited_time), now)],
    ['Last touched by', propertyText(card, 'Last touched by') || 'Unknown'],
    ['Priority', propertyText(card, 'Priority')],
    ['Due Date', !complete && propertyDate(card, 'Due Date') ? dateLabel(propertyDate(card, 'Due Date')) : ''],
    ['Waiting For', !complete ? propertyText(card, 'Waiting For') : ''],
    ['Will action', !complete && actionable ? propertyText(card, 'Will action') : ''],
  ]
  return fields.filter(([, value]) => value)
}
