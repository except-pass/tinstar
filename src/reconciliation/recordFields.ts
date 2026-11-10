import type { Execution, SceneCard } from '../server/reconciliation/scene'
import type { FloorScene } from './presentation'
import { cardStatus, cardTitle } from './overviewModel'
import { dateBucket, dateTimestamp } from '../shared/floorOrganization'
import { checkInTime } from '../shared/checkIn'

export function propertyText(card: SceneCard, name: string): string {
  const value = card.source.properties[name]?.value
  return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string').join(', ')
}
export function propertyDate(card: SceneCard, name: string): string | null {
  const value = card.source.properties[name]?.value
  return value && typeof value === 'object' && 'start' in value && typeof value.start === 'string' ? value.start : null
}
function checkpointTime(card: SceneCard): number {
  const value = card.source.properties['Next check-in']?.value
  const zone = value && typeof value === 'object' && 'time_zone' in value && typeof value.time_zone === 'string' ? value.time_zone : null
  return checkInTime(propertyDate(card, 'Next check-in'), zone)
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
export function dateLabel(value: string | null, time = value ? dateTimestamp(value) : NaN): string {
  if (!value) return 'Not set'
  if (!Number.isFinite(time)) return 'Unknown'
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', ...(value.length > 10 ? { hour: 'numeric', minute: '2-digit' } as const : {}) }).format(time)
}
export function checkIn(card: SceneCard, now: number): { state: string; label: string } {
  const status = cardStatus(card).toLowerCase()
  if (['done', 'archived', 'backlog', 'todo', 'not started', 'planned', 'spare tokens'].includes(status)) return { state: 'not-applicable', label: 'Not applicable' }
  const at = propertyDate(card, 'Next check-in')
  if (!at) return { state: 'missing', label: 'Not scheduled' }
  const time = checkpointTime(card)
  const overdue = time < now
  return { state: !Number.isFinite(time) ? 'unknown' : overdue ? 'overdue' : 'upcoming', label: `${overdue ? 'Overdue · ' : ''}${dateLabel(at, time)}${at.length === 10 ? ' 9 AM ET' : ''}` }
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

/** Workers borrow Work breadcrumbs only from confirmed explicit relationships. */
export function workerBreadcrumb(scene: FloorScene, worker: Execution): string {
  const cards = scene.claims.filter(c => c.executionId === worker.id && c.basis === 'explicit' && c.verification === 'confirmed' && c.state === 'current')
    .map(c => scene.cards.find(card => card.id === c.cardId)).filter((c): c is SceneCard => !!c)
  return [...new Set(cards.map(c => workBreadcrumb(scene, c)).filter(value => value !== 'Unassigned'))].join(' · ')
}
export function compactCheckIn(card: SceneCard, now: number): string {
  const check = checkIn(card, now)
  if (check.state === 'overdue') {
    const elapsed = now - checkpointTime(card)
    return `Overdue ${elapsed < 3600000 ? `${Math.max(1, Math.floor(elapsed / 60000))}m` : elapsed < 86400000 ? `${Math.floor(elapsed / 3600000)}h` : `${Math.floor(elapsed / 86400000)}d`}`
  }
  if (check.state === 'upcoming') {
    const value = propertyDate(card, 'Next check-in')!
    const time = checkpointTime(card)
    const instant = new Date(time).toISOString()
    const label = value.length > 10 && dateBucket(instant, now, true) === 'Today'
      ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(time).replace(' AM', 'a').replace(' PM', 'p')
      : dateLabel(value, time)
    return `Check-in ${label}`
  }
  if (cardStatus(card) === 'Ready for Review' && check.state === 'missing') return 'Review requested'
  return check.label
}
