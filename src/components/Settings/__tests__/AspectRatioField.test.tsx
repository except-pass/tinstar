import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AspectRatioField } from '../AspectRatioField'

afterEach(() => cleanup())

describe('AspectRatioField', () => {
  it('seeds from the aspect as W:1 and emits W/H on blur', () => {
    const onChange = vi.fn()
    render(<AspectRatioField value={1.5} onChange={onChange} />)
    const inputs = screen.getAllByRole('spinbutton') as HTMLInputElement[]
    const w = inputs[0]!
    const h = inputs[1]!
    expect(Number(w.value)).toBeCloseTo(1.5)
    expect(Number(h.value)).toBe(1)
    fireEvent.change(w, { target: { value: '16' } })
    fireEvent.change(h, { target: { value: '9' } })
    fireEvent.blur(h)
    expect(onChange).toHaveBeenLastCalledWith(16 / 9)
  })

  it('does not emit when an input is zero or empty', () => {
    const onChange = vi.fn()
    render(<AspectRatioField value={1.5} onChange={onChange} />)
    const w = (screen.getAllByRole('spinbutton') as HTMLInputElement[])[0]!
    fireEvent.change(w, { target: { value: '0' } })
    fireEvent.blur(w)
    expect(onChange).not.toHaveBeenCalled()
  })
})
