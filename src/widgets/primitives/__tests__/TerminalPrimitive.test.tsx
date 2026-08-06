import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TerminalPrimitive } from '../TerminalPrimitive'

describe('TerminalPrimitive', () => {
  it('points the iframe at the terminal wrapper for the session', () => {
    const { container } = render(<TerminalPrimitive sessionId="S-1" />)
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe('/terminal-wrapper.html?session=S-1')
  })
  it('never emits a port parameter, so the wrapper cannot build a bare-port URL', () => {
    const { container } = render(<TerminalPrimitive sessionId="" />)
    const src = container.querySelector('iframe')!.getAttribute('src')!
    expect(src).toBe('/terminal-wrapper.html?')
    expect(src).not.toContain('port=')
  })
})
