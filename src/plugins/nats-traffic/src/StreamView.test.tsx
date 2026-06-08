// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { StreamView } from './StreamView'
import type { TrafficEvent } from './types'

const ev = (subject: string, data: string): TrafficEvent => ({
  timestamp: '2026-05-29T00:00:00Z', subject, data, direction: 'inbound', sender: 'agent',
})

describe('StreamView', () => {
  it('shows truncated raw data inline and opens the detail modal on row click', () => {
    render(<StreamView events={[ev('tinstar.a.b', '{"hello":1}')]} filter="" />)
    expect(screen.getByText('tinstar.a.b')).toBeInTheDocument()
    // Raw data is visible inline (scannable), not hidden behind a click.
    expect(screen.getByText('{"hello":1}')).toBeInTheDocument()
    fireEvent.click(screen.getByText('tinstar.a.b'))
    // Modal shows the pretty-printed payload.
    const modal = screen.getByTestId('saloon-msg-modal')
    expect(within(modal).getByText(/"hello": 1/)).toBeInTheDocument()
  })

  it('applies the subject/content filter', () => {
    render(<StreamView events={[ev('tinstar.a.b', 'x'), ev('tinstar.c.d', 'y')]} filter="c.d" />)
    expect(screen.getByText('tinstar.c.d')).toBeInTheDocument()
    expect(screen.queryByText('tinstar.a.b')).not.toBeInTheDocument()
  })
})
