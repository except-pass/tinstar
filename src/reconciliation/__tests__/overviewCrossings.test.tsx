import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { organizedGroups } from '../../shared/floorOrganization'
import { Group } from '../Overview'
import { canonicalOverviewGroups, tasksByWorkerPosition } from '../overviewModel'
import { initialPresentation } from '../presentation'

const now = Date.parse('2026-11-04T17:00:00Z')
type Edge = [number, number]
function fixture(edges: Edge[], count: number) {
  const scene = fixtureScene({ now })
  const worker = scene.executions.find(w => w.kind !== 'secondmate')!, card = scene.cards[0]!, claim = scene.claims[0]!
  scene.executions = Array.from({ length: count }, (_, index) => ({ ...structuredClone(worker), id: `worker-${index}` }))
  scene.cards = Array.from({ length: count }, (_, index) => {
    const next = { ...structuredClone(card), id: `task-${index}` }
    next.source.properties.Status!.value = 'In Progress'
    delete next.source.properties['Next check-in']
    return next
  })
  scene.claims = edges.map(([w, c], index) => ({ ...claim, id: `link-${index}`, executionId: `worker-${w}`, cardId: `task-${c}`, basis: 'explicit', verification: 'confirmed', state: 'current' }))
  return scene
}
function crossings(workers: string[], tasks: string[], edges: Edge[]) {
  const points = edges.map(([w, c]): [number, number] => [workers.indexOf(`worker-${w}`), tasks.indexOf(`task-${c}`)])
  return points.reduce((sum, [w, c], index) => sum + points.slice(index + 1).filter(([w2, c2]) => (w - w2) * (c - c2) < 0).length, 0)
}
function permutations<T>(items: T[]): T[][] {
  return items.length ? items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map(rest => [item, ...rest])) : [[]]
}

describe.each(['compact', 'detailed'] as const)('%s task ordering', density => {
  beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }))
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })
  function mount(scene: ReturnType<typeof fixture>, direction: 'asc' | 'desc' = 'asc') {
    const state = { ...initialPresentation(), roadmapExpanded: true, organizer: { outer: 'none' as const, inner: 'none' as const, order: 'checkIn' as const, direction } }
    const groups = organizedGroups(scene, state, now)
    const group = (density === 'compact' ? canonicalOverviewGroups(groups) : groups)[0]!
    const view = { scene, state, now, readFailed: false, send: () => {}, actionableCardIds: new Set<string>(), compact: density === 'compact' ? { expanded: new Set<string>(), roots: [], toggle: () => {} } : undefined }
    const rendered = render(<Group view={view} group={group} allGroups={groups} hover={() => {}} focus={null} />)
    const ids = (kind: string) => [...rendered.container.querySelectorAll<HTMLElement>(`.ov-${kind}`)].map(el => el.dataset.entityId!)
    return { ...rendered, group, workers: ids('execution'), tasks: ids('card') }
  }
  it.each([{ permutation: [2, 0, 1] }, { permutation: [5, 3, 1, 4, 0, 2] }])('uncrosses a 1:1 permutation $permutation', ({ permutation }) => {
    const edges: Edge[] = permutation.map((task, worker) => [worker, task])
    const scene = fixture(edges, permutation.length)
    const result = mount(scene)
    expect(crossings(result.workers, result.group.cards.map(c => c.id), edges)).toBeGreaterThan(0)
    expect(crossings(result.workers, result.tasks, edges)).toBe(0)
    expect(result.workers).toEqual(result.group.workers.map(w => w.id))
    expect(new Set(result.tasks).size).toBe(permutation.length)
  })
  it('puts a fan-out adjacent at its worker with the minimum possible crossings', () => {
    const edges: Edge[] = [[0, 4], [1, 3], [1, 0], [1, 2], [2, 1]]
    const result = mount(fixture(edges, 5))
    const minimum = Math.min(...permutations(result.tasks).map(tasks => crossings(result.workers, tasks, edges)))
    expect(crossings(result.workers, result.tasks, edges)).toBe(minimum)
    expect(minimum).toBe(0)
    expect(result.tasks).toEqual(['task-4', 'task-0', 'task-2', 'task-3', 'task-1'])
  })
  it.each(['asc', 'desc'] as const)('keeps %s Order ties stable and unlinked tasks last', direction => {
    const scene = fixture([[0, 4], [0, 1]], 6)
    scene.cards.forEach((card, index) => { card.source.properties['Next check-in'] = { id: 'date', type: 'date', value: { start: `2026-11-${10 + index}T12:00:00Z` }, hasMore: false } })
    const first = mount(scene, direction)
    const byOrder = first.group.cards.map(c => c.id)
    expect(first.tasks).toEqual([...byOrder.filter(id => ['task-1', 'task-4'].includes(id)), ...byOrder.filter(id => !['task-1', 'task-4'].includes(id))])
    first.unmount()
    scene.cards.reverse(); scene.claims.reverse()
    expect(mount(scene, direction).tasks).toEqual(first.tasks)
  })
})

it('uses the mean of visible worker indices, ignoring duplicate, historical and cross-group links', () => {
  const scene = fixture([[0, 0], [4, 0], [1, 1], [3, 2], [5, 3]], 6)
  const workers = scene.executions.slice(0, 5)
  scene.claims.push({ ...scene.claims[0]!, id: 'duplicate' }, { ...scene.claims[0]!, id: 'historical', cardId: 'task-2', state: 'historical' })
  const before = structuredClone(scene)
  expect(tasksByWorkerPosition(workers, scene.cards, scene.claims).map(c => c.id)).toEqual(['task-1', 'task-0', 'task-2', 'task-3', 'task-4', 'task-5'])
  expect(tasksByWorkerPosition(workers.slice().reverse(), scene.cards, scene.claims).map(c => c.id)).toEqual(['task-2', 'task-0', 'task-1', 'task-3', 'task-4', 'task-5'])
  expect(scene).toEqual(before)
})
