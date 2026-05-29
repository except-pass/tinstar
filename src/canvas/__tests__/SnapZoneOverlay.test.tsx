// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { SnapZoneOverlay } from '../SnapZoneOverlay'

const W = (id: string, x: number, y: number) =>
  ({ id, x, y, width: 100, height: 100 })

describe('SnapZoneOverlay', () => {
  it('renders nothing when there is no snap target', () => {
    const { container } = render(<SnapZoneOverlay target={null} canJoin />)
    expect(container.firstChild).toBeNull()
  })

  it('highlights the single target widget', () => {
    const { container } = render(<SnapZoneOverlay target={W('m', 30, 30)} canJoin />)
    expect(container.querySelector('[data-testid="snap-halo-m"]')).not.toBeNull()
  })

  it('renders a warning (red) tone when the snap cannot join (slots full)', () => {
    const { container } = render(<SnapZoneOverlay target={W('u', 30, 30)} canJoin={false} />)
    const halo = container.querySelector('[data-testid="snap-halo-u"]')
    expect(halo).not.toBeNull()
    expect(halo?.className).toMatch(/red/)
  })
})
