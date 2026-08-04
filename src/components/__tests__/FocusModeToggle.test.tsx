// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FocusModeToggle } from '../FocusModeToggle'

afterEach(cleanup)

describe('FocusModeToggle', () => {
  it('announces and toggles the current view', () => {
    const onChange = vi.fn()
    const { rerender } = render(<FocusModeToggle focusMode={false} onChange={onChange} />)

    const button = screen.getByRole('button', { name: 'Switch to Focus view' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(onChange).toHaveBeenCalledWith(true)

    rerender(<FocusModeToggle focusMode onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Return to Canvas view' })).toHaveAttribute('aria-pressed', 'true')
  })
})
