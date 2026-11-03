import { decisionItems, hasQueue, type QueueRead } from './reconciliationQueue'
import type { SceneReconciler, Finding, SceneGroup, SceneCard } from '../server/reconciliation/scene'

export type FloorScene = ReturnType<SceneReconciler['reconcile']>
export type Arrangement = keyof FloorScene['arrangements']
export type TargetKind = 'card' | 'execution' | 'claim' | 'manager' | 'group' | 'you' | 'firstMate'
export interface Target { kind: TargetKind; id: string }
export const semanticId = (target: Target) => `${target.kind}:${target.id}`
export const isException = (finding: Finding) => !['confirmed-link', 'legitimate-wait-planned', 'outside-coverage'].includes(finding.kind)
export const isPlanned = (scene: FloorScene, card: SceneCard) => card.expectation === 'wait-planned' || scene.findings.some(f => f.kind === 'legitimate-wait-planned' && f.cardIds.includes(card.id))
export const arrangements: Record<Arrangement, string> = { initiative: 'Initiative', secondMate: 'Manager', machine: 'Machine' }
export const findingLabels: Record<Finding['kind'], string> = {
  'confirmed-link': 'Confirmed link', 'task-execution-gap': '△ Execution gap', 'untracked-worker': '◇ Untracked execution',
  'unverified-conflicting': '◈ Unverified / conflicting', 'unknown-stale-source': '? Unknown / stale',
  'legitimate-wait-planned': '◷ Wait / planned', 'outside-coverage': '↗ Outside coverage',
}
export interface PresentationState {
  revision: number
  sort?: 'activity' | 'priority'
  linksVisible?: boolean
  arrangement: Arrangement
  selection: Target | null
  collapsed: string[]
  exceptionsOnly: boolean
  roadmapExpanded: boolean
  flash: { ids: string[]; until: number } | null
  assistantChangedView: boolean
  queueOpen?: boolean
  queueCardId?: string | null
  queueItemId?: string | null
}
export const initialPresentation = (): PresentationState => ({
  revision: 0, sort: 'priority', linksVisible: true, arrangement: 'initiative', selection: null, collapsed: [], exceptionsOnly: false, roadmapExpanded: true, flash: null, assistantChangedView: false,
})
type Change =
  | { type: 'set-arrangement'; arrangement: Arrangement }
  | { type: 'set-sort'; sort: 'activity' | 'priority' }
  | { type: 'set-links'; visible: boolean }
  | { type: 'set-expanded'; target: Target; expanded: boolean }
  | { type: 'focus'; target: Target }
  | { type: 'set-exceptions'; enabled: boolean }
  | { type: 'set-roadmap'; expanded: boolean }
  | { type: 'flash'; targets: Target[]; durationMs?: number }
  | { type: 'clear-transient' }
  | { type: 'clear-selection' }
  | { type: 'open-queue'; cardId?: string; itemId?: string }
  | { type: 'navigate-queue'; direction: 'next' | 'previous' }
  | { type: 'close-queue' }
export type PresentationAction = Change & { origin?: 'manual' | 'assistant'; expectedRevision?: number }

export function targetExists(scene: FloorScene, target: Target): boolean {
  switch (target.kind) {
    case 'card': return scene.cards.some(card => card.id === target.id)
    case 'execution': return scene.executions.some(execution => execution.id === target.id)
    case 'claim': return [...scene.claims, ...scene.claimHistory].some(claim => claim.id === target.id)
    case 'manager': return scene.coverage.homes.some(home => home.source.home === target.id)
    case 'group': return Object.values(scene.arrangements).some(groups => groups.some(group => group.id === target.id))
    case 'you': case 'firstMate': return target.id === 'root'
  }
}
export function targetInGroup(scene: FloorScene, group: SceneGroup, target: Target): boolean {
  switch (target.kind) {
    case 'card': return group.cardIds.includes(target.id)
    case 'execution': return group.executionIds.includes(target.id)
    case 'claim': {
      const claim = [...scene.claims, ...scene.claimHistory].find(claim => claim.id === target.id)
      return group.claimIds.includes(target.id) || !!claim && (group.cardIds.includes(claim.cardId) || group.executionIds.includes(claim.executionId))
    }
    case 'manager': return group.homeIds.includes(target.id) || scene.executions.some(e => e.home === target.id && group.executionIds.includes(e.id))
    case 'group': return group.id === target.id
    default: return false
  }
}
/** Home parent relationships are configured source facts, never inferred from labels. */
export function ancestorHomes(scene: FloorScene, home: string): string[] {
  const ancestors = new Set<string>()
  let current: string | undefined = home
  while (current && !ancestors.has(current)) {
    ancestors.add(current)
    current = scene.coverage.homes.find(h => h.source.home === current)?.source.parentHome
  }
  return [...ancestors]
}
export function managerCollapsed(scene: FloorScene, state: PresentationState, home: string) {
  return ancestorHomes(scene, home).some(id => state.collapsed.includes(semanticId({ kind: 'manager', id })))
}

/** Shared click/MCP transition boundary. No effects or domain writes. */
export function applyPresentationAction(state: PresentationState, action: PresentationAction, scene: FloorScene, now = Date.now(), queue?: QueueRead | null): {
  state: PresentationState; outcome: 'applied' | 'unknown-id' | 'stale-revision' | 'queue-source-unavailable'
} {
  if (action.expectedRevision !== undefined && action.expectedRevision !== state.revision) return { state, outcome: 'stale-revision' }
  const needsQueue = action.type === 'navigate-queue' || action.type === 'open-queue' && !action.cardId
  if (needsQueue && !hasQueue(queue)) return { state, outcome: 'queue-source-unavailable' }
  if (action.type === 'open-queue' && action.itemId && hasQueue(queue) && !queue.items.some(item => item.id === action.itemId)) return { state, outcome: 'unknown-id' }
  if (action.type === 'open-queue' && action.cardId && !scene.cards.some(c => c.id === action.cardId)) return { state, outcome: 'unknown-id' }
  const targets = action.type === 'focus' || action.type === 'set-expanded' ? [action.target] : action.type === 'flash' ? action.targets : []
  if (targets.some(target => !targetExists(scene, target))) return { state, outcome: 'unknown-id' }
  let next = { ...state, queueItemId: state.queueItemId ?? (hasQueue(queue) ? decisionItems(queue, now)[0]?.id : null) ?? null }
  switch (action.type) {
    case 'set-arrangement': next.arrangement = action.arrangement; break
    case 'set-sort': next.sort = action.sort; break
    case 'set-links': next.linksVisible = action.visible; break
    case 'set-expanded': {
      const id = semanticId(action.target)
      next.collapsed = action.expanded ? state.collapsed.filter(value => value !== id) : [...new Set([...state.collapsed, id])]
      break
    }
    case 'focus': next.selection = action.target; next.exceptionsOnly = false; break
    case 'set-exceptions': next.exceptionsOnly = action.enabled; break
    case 'set-roadmap': next.roadmapExpanded = action.expanded; break
    case 'flash': next.exceptionsOnly = false; next.flash = { ids: [...new Set(action.targets.map(semanticId))], until: now + Math.max(0, Math.min(action.durationMs ?? 2400, 4000)) }; break
    case 'clear-transient': next.flash = null; next.assistantChangedView = false; break
    case 'close-queue': next.queueOpen = false; next.queueCardId = null; break
    case 'open-queue':
      next.selection = null
      next.queueOpen = true; next.queueCardId = action.cardId ?? null
      next.queueItemId = action.cardId ? state.queueItemId ?? null : action.itemId ?? (hasQueue(queue) && queue.items.some(item => item.id === state.queueItemId) ? state.queueItemId : null) ?? (hasQueue(queue) ? decisionItems(queue, now)[0]?.id : null) ?? null
      break
    case 'navigate-queue': {
      const items = hasQueue(queue) ? decisionItems(queue, now) : []
      const index = items.findIndex(item => item.id === next.queueItemId)
      if (state.queueItemId && index < 0 && hasQueue(queue) && !queue.items.some(item => item.id === state.queueItemId)) return { state, outcome: 'unknown-id' }
      next.queueOpen = true; next.selection = null; next.queueCardId = null
      next.queueItemId = items.length ? items[Math.max(0, Math.min(items.length - 1, index + (action.direction === 'next' ? 1 : -1)))]!.id : null
      break
    }
    case 'clear-selection': next.selection = null; break
  }
  // Regrouping/focus reveal the selected item without changing its identity.
  const revealTargets = action.type === 'flash' ? action.targets : next.selection && (action.type === 'focus' || action.type === 'set-arrangement') ? [next.selection] : []
  for (const target of revealTargets) {
    const selectedCardIds = target.kind === 'card' ? [target.id] : [...scene.claims, ...scene.claimHistory].filter(c => target.kind === 'claim' ? c.id === target.id : target.kind === 'execution' && c.executionId === target.id).map(c => c.cardId)
    if (scene.cards.some(c => selectedCardIds.includes(c.id) && isPlanned(scene, c))) next.roadmapExpanded = true
    const reveal = scene.arrangements[next.arrangement].filter(group => targetInGroup(scene, group, target)).map(group => semanticId({ kind: 'group', id: group.id }))
    const claims = [...scene.claims, ...scene.claimHistory].filter(c => target.kind === 'card' ? c.cardId === target.id : target.kind === 'claim' && c.id === target.id)
    const executions = scene.executions.filter(e => target.kind === 'execution' ? e.id === target.id : claims.some(c => c.executionId === e.id))
    reveal.push(...executions.flatMap(e => ancestorHomes(scene, e.home).map(id => semanticId({ kind: 'manager', id }))))
    if (target.kind === 'manager') reveal.push(...ancestorHomes(scene, target.id).map(id => semanticId({ kind: 'manager', id })))
    next.collapsed = next.collapsed.filter(id => !reveal.includes(id))
  }
  next = { ...next, revision: state.revision + 1, assistantChangedView: action.type === 'clear-transient' ? false : action.origin === 'assistant' || state.assistantChangedView }
  return { state: next, outcome: 'applied' }
}
