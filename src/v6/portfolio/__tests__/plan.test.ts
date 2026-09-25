import { describe, expect, it } from 'vitest'
import { isClickablePlanHref, mergePlanTasks, planPageHref } from '../plan'

const fixture = {
  fixture: true,
  tasks: [
    { id: 'alpha', label: 'Alpha', bucket: 'build', start: 0, end: 1 },
  ],
  _state: {
    _addedTasks: [
      { id: 'beta', label: 'Beta', bucket: 'build', start: 1, end: 2 },
      { id: 'alpha', label: 'duplicate', bucket: 'build', start: 0, end: 0 },
    ],
    alpha: { progress: 0, note: 'set to zero' },
    beta: { note: 'from the browser' },
  },
}

describe('Stretch Plan merge', () => {
  it('labels a fixture and unions browser-added tasks without inventing progress', () => {
    const merged = mergePlanTasks(fixture)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(merged.value.fixture).toBe(true)
    expect(merged.value.tasks.map(task => task.id)).toEqual(['alpha', 'beta'])
    expect(merged.value.tasks[0]).toMatchObject({ source: 'tasks', progress: 0, note: 'set to zero' })
    expect(merged.value.tasks[1]).toMatchObject({ source: 'added', progress: null, note: 'from the browser' })
  })

  it('leaves fixture false when the payload is a live plan', () => {
    const { fixture: _fixture, ...live } = fixture
    const merged = mergePlanTasks(live)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(merged.value.fixture).toBe(false)
    expect(merged.value.tasks.map(task => task.id)).toEqual(['alpha', 'beta'])
  })

  it('builds a local plan link and refuses non-http targets', () => {
    expect(planPageHref('http://127.0.0.1:9', 'pm-demo')).toBe('http://127.0.0.1:9/p/pm-demo')
    expect(planPageHref('http://127.0.0.1:9', '../etc')).toBeNull()
    expect(isClickablePlanHref('http://127.0.0.1:9/p/pm-demo')).toBe(true)
    expect(isClickablePlanHref('https://plans.example/p/pm-demo')).toBe(true)
    expect(isClickablePlanHref('http://plans.example/p/pm-demo')).toBe(false)
    expect(isClickablePlanHref('javascript:alert(1)')).toBe(false)
  })
})
