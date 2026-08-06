// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { A2uiComponent } from '../../domain/types'
import { DecisionControl, NoticeFormProvider, type NoticeFormState } from '../controlComponents'

function form(overrides: Partial<NoticeFormState> = {}): NoticeFormState {
  return {
    interactive: true,
    answered: false,
    submitting: false,
    selectedFor: () => new Set<string>(),
    text: '',
    toggleOption: vi.fn(),
    setText: vi.fn(),
    submit: vi.fn(),
    ...overrides,
  }
}

function renderDecision(node: A2uiComponent, state: NoticeFormState = form()): NoticeFormState {
  render(<NoticeFormProvider value={state}><DecisionControl node={node} /></NoticeFormProvider>)
  return state
}

const FULL: A2uiComponent = {
  component: 'Decision',
  id: 'd',
  options: [
    { id: 'worktree', label: 'Isolated worktree', gain: 'No stomping.', cost: '~400ms each.', wrongIf: 'Hands mostly read.' },
    { id: 'locks', label: 'Advisory locks', gain: 'Zero setup.', cost: 'Stale locks.', wrongIf: 'Two hands write one file.' },
  ],
  risks: [{ label: 'Stale lock wedges the fleet', severity: 'severe', likelihood: 'possible', discoverability: 'silent', note: 'Nothing alerts.' }],
  reversal: { action: 'costly', damage: 'days', note: 'Backfill must re-run.' },
  horizon: { span: 'permanent', until: 'The migration writes rows we cannot un-write.' },
}

describe('DecisionControl', () => {
  it('renders one radio per option with its gain, cost, and wrong-if', () => {
    renderDecision(FULL)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect(screen.getByText('Isolated worktree')).toBeTruthy()
    expect(screen.getByText('No stomping.')).toBeTruthy()
    expect(screen.getByText('~400ms each.')).toBeTruthy()
    expect(screen.getByText('Hands mostly read.')).toBeTruthy()
  })

  it('selects through the form context keyed by the Decision node id', () => {
    const state = renderDecision(FULL)
    fireEvent.click(screen.getAllByRole('radio')[1]!)
    expect(state.toggleOption).toHaveBeenCalledWith('d', 'locks', 'single')
  })

  it('renders every rating chip with its scale label', () => {
    renderDecision(FULL)
    for (const id of ['severity', 'likelihood', 'discoverability', 'action', 'damage', 'span']) {
      expect(screen.getByTestId(`decision-rating-${id}`)).toBeTruthy()
    }
    expect(screen.getByTestId('decision-rating-severity').textContent).toContain('severe')
    expect(screen.getByTestId('decision-rating-discoverability').textContent).toContain('silent')
  })

  it('carries heat as a data attribute so the ramp is assertable', () => {
    renderDecision(FULL)
    expect(screen.getByTestId('decision-rating-severity').getAttribute('data-heat')).toBe('3')
    expect(screen.getByTestId('decision-rating-likelihood').getAttribute('data-heat')).toBe('2')
    expect(screen.getByTestId('decision-rating-action').getAttribute('data-heat')).toBe('2')
  })

  it('renders an unrecognised rating verbatim and uncolored (R8)', () => {
    renderDecision({ ...FULL, risks: [{ label: 'r', severity: 'catastrophic' }] })
    const chip = screen.getByTestId('decision-rating-severity')
    expect(chip.textContent).toContain('catastrophic')
    expect(chip.getAttribute('data-heat')).toBe('unknown')
  })

  it('renders no element for an omitted risk dimension, distinct from an unrecognised one', () => {
    renderDecision({ ...FULL, risks: [{ label: 'r', severity: 'severe' }] })
    expect(screen.getByTestId('decision-rating-severity')).toBeTruthy()
    expect(screen.queryByTestId('decision-rating-likelihood')).toBeNull()
    expect(screen.queryByTestId('decision-rating-discoverability')).toBeNull()
  })

  it('renders no element for an omitted reversal dimension', () => {
    renderDecision({ ...FULL, reversal: { action: 'costly', note: 'x' } })
    expect(screen.getByTestId('decision-rating-action')).toBeTruthy()
    expect(screen.queryByTestId('decision-rating-damage')).toBeNull()
  })

  it('states the horizon `until` line', () => {
    renderDecision(FULL)
    expect(screen.getByTestId('decision-until').textContent).toContain('The migration writes rows we cannot un-write.')
  })

  it('always renders a comment box bound to the shared text field (R7)', () => {
    const state = renderDecision({ ...FULL, comment: undefined })
    const box = screen.getByTestId('decision-comment')
    expect(screen.getByText('Anything else?')).toBeTruthy()
    fireEvent.change(box, { target: { value: 'one more thing' } })
    expect(state.setText).toHaveBeenCalledWith('one more thing')
  })

  it('honors an author-supplied comment label and placeholder', () => {
    renderDecision({ ...FULL, comment: { label: 'Constraints?', placeholder: 'e.g. deadline' } })
    expect(screen.getByText('Constraints?')).toBeTruthy()
    expect(screen.getByTestId('decision-comment').getAttribute('placeholder')).toBe('e.g. deadline')
  })

  it('degrades a malformed block alone, leaving the options standing (R9)', () => {
    renderDecision({ ...FULL, risks: 'garbage', reversal: 42, horizon: { span: 'permanent' } })
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.getByTestId('decision-risks-fallback')).toBeTruthy()
    expect(screen.getByTestId('decision-reversal-fallback')).toBeTruthy()
    expect(screen.getByTestId('decision-horizon-fallback')).toBeTruthy()
  })

  it('degrades whole below the two-option floor', () => {
    renderDecision({ component: 'Decision', id: 'd', options: [{ id: 'a', label: 'A' }] })
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.getByText(/needs at least two options/i)).toBeTruthy()
  })

  it('locks every control once answered', () => {
    renderDecision(FULL, form({ answered: true }))
    expect(screen.getAllByRole('radio').every(r => (r as HTMLInputElement).disabled)).toBe(true)
    expect((screen.getByTestId('decision-comment') as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('renders inert with no form provider (read-only context)', () => {
    render(<DecisionControl node={FULL} />)
    expect(screen.getAllByRole('radio').every(r => (r as HTMLInputElement).disabled)).toBe(true)
  })
})
