import type { FloorScene, Target } from './reconciliationPresentation'
import { homeLabel } from './reconciliationLabels'

export interface SearchField { name: string; source: string; text: string }
export interface SearchDocument {
  key: string
  entity?: 'machine' | 'manager' | 'initiative'
  focusTargets?: Target[]
  target: Target
  title: string
  identifiers: string[]
  fields: SearchField[]
  observedAt: string | null
  expiresAt: string | null
  coverage: string
}
export interface SearchIndexRead {
  documents: SearchDocument[]
  notes: string[]
}
export const searchTextLimit = 8192
export const searchTotalLimit = 2 * 1024 * 1024
/** Redact likely credential literals before either snippets or the browser index.
 * This only handles published prose/allowlisted fields, never raw source objects. */
export function redactSourceText(input: unknown): string {
  return (typeof input === 'string' ? input : '')
    .replace(/\b(?:secret_|ntn_|sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}\b/g, '[credential omitted]')
    .replace(/\b(?:bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '[credential omitted]')
    .replace(/\b(password|passwd|token|api[_-]?key|secret)\s*[:=]\s*["']?[^\s"',;]{6,}/gi, '$1=[credential omitted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[credential omitted]@')

}
export function searchText(input: unknown): string { return redactSourceText(input).slice(0, searchTextLimit) }
const scalar = (value: unknown): string => Array.isArray(value) ? value.filter(v => typeof v === 'string').join(' · ') : typeof value === 'string' ? value : ''
const technicalIds = (values: string[]) => [...new Set(values.flatMap(value => [value, ...[...value.matchAll(/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/gi)].flatMap(match => [`PR #${match[1]}`, match[1]!])]).filter(Boolean))]

/** Projection of already authorized scene data. No raw logs, home files or briefs. */
export function sceneSearchDocuments(scene: FloorScene): SearchDocument[] {
  const cards: SearchDocument[] = scene.cards.filter(card => !card.source.in_trash).map(card => {
    const fields: SearchField[] = []
    for (const name of ['Name', 'Status', 'Owner', 'Priority', 'Waiting For', 'Initiative', 'Epic', 'Next action', 'Next Action', 'Evidence', 'Link', 'Area', 'Sub-area']) {
      const property = card.source.properties[name]
      if (!property) continue
      const text = property.type === 'relation' && Array.isArray(property.value)
        ? property.value.map(id => scalar(scene.cards.find(parent => parent.id === id)?.source.properties.Name?.value) || String(id)).join(' · ')
        : scalar(property.value)
      if (text) fields.push({ name, source: 'Notion property', text: searchText(text) })
    }
    return { key: `card:${card.id}`, target: { kind: 'card', id: card.id }, title: searchText(scalar(card.source.properties.Name?.value)) || 'Untitled card',
      identifiers: technicalIds([card.id, card.source.url ?? '', scalar(card.source.properties.Link?.value)]).map(searchText),
      fields, observedAt: scene.coverage.intentions.observedAt, expiresAt: scene.coverage.intentions.expiresAt,
      coverage: `${scene.coverage.intentions.status}/${scene.coverage.intentions.coverage}` }
  })
  const workers: SearchDocument[] = scene.executions.filter(worker => worker.kind !== 'secondmate').map(worker => {
    const manager = scene.coverage.homes.find(home => home.source.home === worker.home)?.source
    const fields: SearchField[] = [
      ['Name', worker.source.backlog.title], ['Worker ID', worker.identity.task_id], ['Attempt ID', worker.identity.spawn_gen],
      ['Manager', manager ? homeLabel(manager) : null], ['Machine', worker.placement.machine], ['Branch', worker.source.branch],
      ['Status', worker.source.current_state.state], ['Status explanation', worker.source.current_state.detail],
      ['Activity summary', worker.source.last_event.note], ['Waiting For', worker.source.backlog.hold_reason], ['Blocker', worker.source.backlog.blocked_by],
      ['PR', worker.source.pr.url],
    ].flatMap(([name, value]) => typeof value === 'string' && value ? [{ name: String(name), source: 'First Mate snapshot', text: searchText(value) }] : [])
    return { key: `execution:${worker.id}`, target: { kind: 'execution', id: worker.id }, title: searchText(scalar(worker.source.backlog.title) || worker.identity.task_id || 'Unknown worker'),
      identifiers: technicalIds([worker.identity.task_id ?? '', worker.identity.spawn_gen ?? '', scalar(worker.source.pr.url)]).map(searchText),
      fields, observedAt: worker.observation.observedAt, expiresAt: worker.observation.expiresAt, coverage: `${worker.observation.status}/${worker.observation.coverage}` }
  })
  return [...cards, ...workers]
}

export function boundSearchDocuments(documents: SearchDocument[]): SearchIndexRead {
  let remaining = searchTotalLimit, omitted = false
  const bounded = documents.map(document => {
    let budget = Math.min(searchTextLimit, remaining)
    const fields = document.fields.flatMap(field => {
      const text = searchText(field.text).slice(0, budget)
      if (text.length < field.text.length) omitted = true
      budget -= text.length; remaining -= text.length
      return text ? [{ ...field, text }] : []
    })
    return { ...document, fields }
  })
  return { documents: bounded, notes: omitted ? ['Some excerpt text omitted by index size limits; identity metadata remains searchable.'] : [] }
}

/** Small named entities point at canonical seeds; only verified links add context. */
export function searchEntityDocuments(scene: FloorScene): SearchDocument[] {
  const entities = new Map<string, { title: string; entity: NonNullable<SearchDocument['entity']>; targets: Target[] }>()
  const add = (entity: NonNullable<SearchDocument['entity']>, id: string, title: string, target: Target) => {
    const key = `${entity}:${id}`, item = entities.get(key) ?? { title: searchText(title), entity, targets: [] }
    if (!item.targets.some(value => value.kind === target.kind && value.id === target.id)) item.targets.push(target)
    entities.set(key, item)
  }
  for (const worker of scene.executions.filter(worker => worker.kind !== 'secondmate')) {
    const target: Target = { kind: 'execution', id: worker.id }
    if (worker.placement.machine) add('machine', worker.placement.machine, worker.placement.machine, target)
    const home = scene.coverage.homes.find(home => home.source.home === worker.home)
    if (home) add('manager', worker.home, homeLabel(home.source), target)
  }
  for (const card of scene.cards.filter(card => !card.source.in_trash)) {
    const property = card.source.properties.Initiative
    if (!property || !['relation', 'select', 'rich_text'].includes(property.type ?? '')) continue
    for (const value of Array.isArray(property.value) ? property.value : [property.value]) {
      if (typeof value !== 'string' || !value.trim()) continue
      const id = value.trim(), title = scalar(scene.cards.find(card => card.id === id)?.source.properties.Name?.value) || id
      add('initiative', id, title, { kind: 'card', id: card.id })
    }
  }
  return [...entities].map(([key, item]) => ({ key, title: item.title, entity: item.entity, focusTargets: item.targets,
    target: item.targets[0]!, identifiers: [item.title], fields: [], observedAt: scene.generatedAt,
    expiresAt: scene.coverage.intentions.expiresAt, coverage: 'Scene metadata' }))
}
