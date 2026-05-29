// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ConstellationChrome } from '../ConstellationChrome'

// Two flush, side-by-side widgets (B's left edge == A's right edge) form one seam.
const stuckPair = [
  { id: 'a', x: 0, y: 0, width: 100, height: 100 },
  { id: 'b', x: 100, y: 0, width: 100, height: 100 },
]
const single = [{ id: 'a', x: 0, y: 0, width: 100, height: 100 }]

describe('ConstellationChrome', () => {
  it('renders nothing when no widgets in the slot', () => {
    const { container } = render(
      <ConstellationChrome slot="3" members={[]} active={true} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a bounding-box outline when active and has widgets', () => {
    const { container } = render(
      <ConstellationChrome slot="3" members={single} active={true} />,
    )
    const outline = container.querySelector('[data-testid="constellation-outline-3"]')
    expect(outline).not.toBeNull()
  })

  it('does NOT render bounding-box outline when inactive', () => {
    const { container } = render(
      <ConstellationChrome slot="3" members={single} active={false} />,
    )
    expect(container.querySelector('[data-testid="constellation-outline-3"]')).toBeNull()
  })

  it('renders a break-link chip at the seam between two stuck widgets when active', () => {
    const { container } = render(
      <ConstellationChrome slot="3" members={stuckPair} active onBreak={() => {}} />,
    )
    expect(container.querySelector('[data-testid="constellation-break-3-0"]')).not.toBeNull()
  })

  it('does NOT render break chips when inactive', () => {
    const { container } = render(
      <ConstellationChrome slot="3" members={stuckPair} active={false} onBreak={() => {}} />,
    )
    expect(container.querySelector('[data-testid="constellation-break-3-0"]')).toBeNull()
  })

  it('clicking a break chip calls onBreak with the seam pair ids', () => {
    const onBreak = vi.fn()
    const { getByTestId } = render(
      <ConstellationChrome slot="3" members={stuckPair} active onBreak={onBreak} />,
    )
    fireEvent.click(getByTestId('constellation-break-3-0'))
    expect(onBreak).toHaveBeenCalledWith('a', 'b')
  })
})
