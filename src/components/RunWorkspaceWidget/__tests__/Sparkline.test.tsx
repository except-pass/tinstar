// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Sparkline } from '../Sparkline'

describe('<Sparkline>', () => {
  it('renders no <path> when data is empty', () => {
    const { container } = render(<Sparkline data={[]} accent="#58c8ff" />)
    expect(container.querySelectorAll('path')).toHaveLength(0)
  })

  it('renders no <path> when data has < 2 points', () => {
    const { container } = render(<Sparkline data={[1]} accent="#58c8ff" />)
    expect(container.querySelectorAll('path')).toHaveLength(0)
  })

  it('renders area + stroke paths and an endpoint dot for >=2 points', () => {
    const { container } = render(<Sparkline data={[1, 2, 3, 4]} accent="#58c8ff" />)
    expect(container.querySelectorAll('path').length).toBe(2)        // area + stroke
    expect(container.querySelectorAll('circle').length).toBe(1)      // endpoint
  })

  it('handles null gaps without crashing', () => {
    const { container } = render(<Sparkline data={[1, null, 3, null, 5]} accent="#58c8ff" />)
    expect(container.querySelectorAll('path').length).toBe(2)
  })

  it('uses the provided accent color on the stroke', () => {
    const { container } = render(<Sparkline data={[1, 2]} accent="#f6c155" />)
    const stroke = container.querySelectorAll('path')[1]!   // second path is the stroke
    expect(stroke.getAttribute('stroke')).toBe('#f6c155')
  })

  it('skips NaN/Infinity values without producing invalid path strings', () => {
    const { container } = render(<Sparkline data={[1, NaN, 3, Infinity, 5]} accent="#58c8ff" />)
    const paths = container.querySelectorAll('path')
    expect(paths.length).toBe(2)
    for (const p of paths) {
      expect(p.getAttribute('d')).not.toContain('NaN')
      expect(p.getAttribute('d')).not.toContain('Infinity')
    }
  })
})
