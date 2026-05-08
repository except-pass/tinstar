import { describe, it, expect } from 'vitest'
import { computeOnboardingState } from '../../src/hooks/useOnboardingState'

describe('computeOnboardingState', () => {
  it('returns connect when backend unreachable', () => {
    const s = computeOnboardingState({ reachable: false, spaces: [], projects: [], runCount: 0 })
    expect(s.active).toBe('connect')
  })

  it('returns workspace when no spaces exist', () => {
    const s = computeOnboardingState({ reachable: true, spaces: [], projects: [], runCount: 0 })
    expect(s.active).toBe('workspace')
  })

  it('returns project when spaces exist but no projects', () => {
    const s = computeOnboardingState({ reachable: true, spaces: ['s1'], projects: [], runCount: 0 })
    expect(s.active).toBe('project')
  })

  it('returns first_session when spaces and projects exist but no runs', () => {
    const s = computeOnboardingState({ reachable: true, spaces: ['s1'], projects: ['p1'], runCount: 0 })
    expect(s.active).toBe('first_session')
  })

  it('returns null when all essentials present', () => {
    const s = computeOnboardingState({ reachable: true, spaces: ['s1'], projects: ['p1'], runCount: 1 })
    expect(s.active).toBeNull()
  })

  it('marks earlier steps completed and later steps pending', () => {
    const s = computeOnboardingState({ reachable: true, spaces: ['s1'], projects: [], runCount: 0 })
    expect(s.steps.find(x => x.id === 'connect')?.status).toBe('completed')
    expect(s.steps.find(x => x.id === 'workspace')?.status).toBe('completed')
    expect(s.steps.find(x => x.id === 'project')?.status).toBe('active')
    expect(s.steps.find(x => x.id === 'first_session')?.status).toBe('pending')
  })
})
