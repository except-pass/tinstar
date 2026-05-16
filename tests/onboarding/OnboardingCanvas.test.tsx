// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OnboardingCanvas } from '../../src/components/OnboardingCanvas'

vi.mock('../../src/hooks/useOnboardingState', () => ({
  useOnboardingState: () => ({
    active: 'workspace',
    steps: [
      { id: 'connect', status: 'completed' },
      { id: 'workspace', status: 'active' },
      { id: 'project', status: 'pending' },
      { id: 'first_session', status: 'pending' },
    ],
  }),
}))

vi.mock('../../src/hooks/useBackendState', () => ({
  useBackendState: () => ({ spaces: [] }),
}))

describe('OnboardingCanvas', () => {
  it('renders the four step cards in order', () => {
    render(<OnboardingCanvas />)
    const cards = screen.getAllByTestId(/onboarding-step-/)
    expect(cards.map(c => c.dataset.testid)).toEqual([
      'onboarding-step-connect',
      'onboarding-step-workspace',
      'onboarding-step-project',
      'onboarding-step-first_session',
    ])
  })

  it('marks the active step as expanded and others collapsed', () => {
    render(<OnboardingCanvas />)
    expect(screen.getByTestId('onboarding-step-workspace').dataset.status).toBe('active')
    expect(screen.getByTestId('onboarding-step-connect').dataset.status).toBe('completed')
  })
})
