// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PinMarker } from '../PinMarker'

const base = { id: 'p1', index: 1, accent: '#0ff', comment: 'c', zoom: 1, onPointerDown: () => {} }

describe('PinMarker reply states', () => {
  it('shows the index when unsent', () => {
    const { getByTestId } = render(<PinMarker {...base} sent={false} />)
    expect(getByTestId('pin-marker-p1').textContent).toBe('1')
  })
  it('renders an unread dot when sent with an unread agent reply', () => {
    const { getByTestId } = render(<PinMarker {...base} sent unread />)
    expect(getByTestId('pin-unread-p1')).toBeTruthy()
  })
  it('does not render the unread dot once opened (unread=false)', () => {
    const { queryByTestId } = render(<PinMarker {...base} sent unread={false} />)
    expect(queryByTestId('pin-unread-p1')).toBeNull()
  })
  it('marks resolved markers with data-resolved', () => {
    const { getByTestId } = render(<PinMarker {...base} sent resolved />)
    expect(getByTestId('pin-marker-p1').getAttribute('data-resolved')).toBe('true')
  })
})
