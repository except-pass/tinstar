import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { fixtureId, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { organizedGroups } from '../../shared/floorOrganization'
import { initialPresentation } from '../presentation'
import { Group } from '../Overview'
import { tasksByWorkerPosition } from '../overviewModel'

const now = Date.parse('2026-11-04T17:00:00Z')

describe('rendered floor endpoint ordering', () => {
  beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }))
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })
  it.each(['activity', 'checkIn'] as const)('keeps worker %s order and uses it for tasks in both directions', order => {
    const scene = fixtureScene({ now })
    const first = scene.claims.find(c => c.cardId === fixtureId(1))!
    scene.claims.push({ ...first, id: 'additional-task', cardId: fixtureId(6) })
    scene.cards.find(c => c.id === fixtureId(1))!.source.properties['Next check-in'] = { id: 'check', type: 'date', hasMore: false, value: { start: '2026-11-04T12:00:00Z' } }
    scene.cards.find(c => c.id === fixtureId(4))!.source.properties['Next check-in'] = { id: 'check', type: 'date', hasMore: false, value: { start: '2026-11-04T13:00:00Z' } }
    scene.cards.find(c => c.id === fixtureId(6))!.source.properties['Next check-in'] = { id: 'check', type: 'date', hasMore: false, value: { start: '2026-11-04T14:00:00Z' } }
    const unlinked = scene.executions.find(w => w.identity.task_id === 'untracked-worker')!
    unlinked.source.last_event.age_seconds = 0
    for (const direction of ['asc', 'desc'] as const) {
      const state = { ...initialPresentation(), organizer: { outer: 'none' as const, inner: 'none' as const, order, direction } }
      const groups = organizedGroups(scene, state, now), group = groups[0]!
      const { container: host, unmount } = render(<Group view={{ scene, state, send: () => {}, now, readFailed: false, actionableCardIds: new Set() }} group={group} allGroups={groups} hover={() => {}} focus={null} />)
      expect([...host.querySelectorAll<HTMLElement>('.ov-execution')].map(el => el.dataset.entityId)).toEqual(group.workers.map(w => w.id))
      expect([...host.querySelectorAll<HTMLElement>('.ov-card')].map(el => el.dataset.entityId)).toEqual(tasksByWorkerPosition(group.workers, group.cards, scene.claims).map(c => c.id))
      unmount()
    }
  })
})
