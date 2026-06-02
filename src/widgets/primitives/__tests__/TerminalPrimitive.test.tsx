import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TerminalPrimitive } from '../TerminalPrimitive'

describe('TerminalPrimitive', () => {
  it('points the iframe at the terminal wrapper for the session', () => {
    const { container } = render(<TerminalPrimitive sessionId="S-1" />)
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe('/terminal-wrapper.html?session=S-1')
  })
  it('falls back to port when no session id', () => {
    const { container } = render(<TerminalPrimitive sessionId="" port={7681} />)
    expect(container.querySelector('iframe')!.getAttribute('src')).toBe('/terminal-wrapper.html?port=7681')
  })
})
