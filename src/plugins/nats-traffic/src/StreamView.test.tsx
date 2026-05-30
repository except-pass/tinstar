// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StreamView } from './StreamView'
import type { TrafficEvent } from './types'

const ev = (subject: string, data: string): TrafficEvent => ({
  timestamp: '2026-05-29T00:00:00Z', subject, data, direction: 'inbound', sender: 'agent',
})

describe('StreamView', () => {
  it('renders rows and opens the detail modal on row click', () => {
    render(<StreamView events={[ev('tinstar.a.b', '{"hello":1}')]} filter="" />)
    expect(screen.getByText('tinstar.a.b')).toBeInTheDocument()
    fireEvent.click(screen.getByText('tinstar.a.b'))
    expect(screen.getByText(/hello/)).toBeInTheDocument()
  })

  it('applies the subject/content filter', () => {
    render(<StreamView events={[ev('tinstar.a.b', 'x'), ev('tinstar.c.d', 'y')]} filter="c.d" />)
    expect(screen.getByText('tinstar.c.d')).toBeInTheDocument()
    expect(screen.queryByText('tinstar.a.b')).not.toBeInTheDocument()
  })
})
