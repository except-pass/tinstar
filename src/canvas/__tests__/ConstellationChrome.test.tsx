// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ConstellationChrome } from '../ConstellationChrome'

describe('ConstellationChrome', () => {
  it('renders nothing when no widgets in the slot', () => {
    const { container } = render(
      <ConstellationChrome slot="3" layouts={[]} active={true} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a bounding-box outline when active and has widgets', () => {
    const { container } = render(
      <ConstellationChrome
        slot="3"
        layouts={[{ id: 'a', x: 0, y: 0, width: 100, height: 100 }]}
        active={true}
      />,
    )
    const outline = container.querySelector('[data-testid="constellation-outline-3"]')
    expect(outline).not.toBeNull()
  })

  it('does NOT render bounding-box outline when inactive', () => {
    const { container } = render(
      <ConstellationChrome
        slot="3"
        layouts={[{ id: 'a', x: 0, y: 0, width: 100, height: 100 }]}
        active={false}
      />,
    )
    expect(container.querySelector('[data-testid="constellation-outline-3"]')).toBeNull()
  })
})
