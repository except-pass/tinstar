// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FocusCycleHint } from '../FocusCycleHint'

afterEach(cleanup)

describe('FocusCycleHint', () => {
  it('announces the matching cycle shortcut', () => {
    render(<FocusCycleHint direction="previous" modifier="Ctrl" />)
    expect(screen.getByRole('status')).toHaveTextContent('Ctrl + [')
    expect(screen.getByRole('status')).toHaveTextContent('Ctrl + Shift + [')
  })

  it('uses closing brackets for the next direction', () => {
    render(<FocusCycleHint direction="next" modifier="Ctrl" />)
    expect(screen.getByRole('status')).toHaveTextContent('Ctrl + ]')
    expect(screen.getByRole('status')).toHaveTextContent('Ctrl + Shift + ]')
  })

  it('renders nothing without a boundary direction', () => {
    const { container } = render(<FocusCycleHint direction={null} modifier="Ctrl" />)
    expect(container).toBeEmptyDOMElement()
  })
})
