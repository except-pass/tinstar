// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { SnapZoneOverlay } from '../SnapZoneOverlay'

const W = (id: string, x: number, y: number) =>
  ({ id, x, y, width: 100, height: 100 })

describe('SnapZoneOverlay', () => {
  it('renders nothing when not dragging', () => {
    const { container } = render(
      <SnapZoneOverlay
        dragging={null}
        widgets={[W('a', 0, 0), W('b', 200, 0)]}
        slotByNode={new Map([['a', '3']])}
        occupiedSlots={new Set(['3'])}
        snapDistance={60}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a halo around a constellation member while dragging nearby', () => {
    const { container } = render(
      <SnapZoneOverlay
        dragging={{ id: 'd', rect: { x: 0, y: 0, width: 100, height: 100 } }}
        widgets={[W('d', 0, 0), W('m', 30, 30)]}
        slotByNode={new Map([['m', '5']])}
        occupiedSlots={new Set(['5'])}
        snapDistance={60}
      />,
    )
    expect(container.querySelector('[data-testid="snap-halo-m"]')).not.toBeNull()
  })

  it('renders a red halo on an ungrouped neighbor when all slots are taken', () => {
    const { container } = render(
      <SnapZoneOverlay
        dragging={{ id: 'd', rect: { x: 0, y: 0, width: 100, height: 100 } }}
        widgets={[W('d', 0, 0), W('u', 30, 30)]}
        slotByNode={new Map()}
        occupiedSlots={new Set(['1','2','3','4','5','6','7','8','9'])}
        snapDistance={60}
      />,
    )
    const halo = container.querySelector('[data-testid="snap-halo-u"]')
    expect(halo).not.toBeNull()
    expect(halo?.className).toMatch(/red/)
  })
})
