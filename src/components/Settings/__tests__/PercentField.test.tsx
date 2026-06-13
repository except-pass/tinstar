import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PercentField } from '../PercentField'

afterEach(() => cleanup())

describe('PercentField', () => {
  it('keeps the typed draft (does not snap mid-type) and commits clamped value on blur', () => {
    const onCommit = vi.fn()
    render(<PercentField value={60} onCommit={onCommit} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    fireEvent.change(input, { target: { value: '1' } })
    expect(input.value).toBe('1')            // not snapped to 5 while typing
    expect(onCommit).not.toHaveBeenCalled()  // no save mid-type
    fireEvent.change(input, { target: { value: '10' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith(10)
    expect(input.value).toBe('10')
  })

  it('clamps a below-min value to the minimum on commit', () => {
    const onCommit = vi.fn()
    render(<PercentField value={60} min={5} onCommit={onCommit} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith(5)
    expect(input.value).toBe('5')
  })

  it('restores the prop value when the field is blurred while empty', () => {
    const onCommit = vi.fn()
    render(<PercentField value={60} onCommit={onCommit} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
    expect(input.value).toBe('60')
  })

  it('re-seeds when the value prop changes', () => {
    const onCommit = vi.fn()
    const { rerender } = render(<PercentField value={60} onCommit={onCommit} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    rerender(<PercentField value={85} onCommit={onCommit} />)
    expect(input.value).toBe('85')
  })
})
