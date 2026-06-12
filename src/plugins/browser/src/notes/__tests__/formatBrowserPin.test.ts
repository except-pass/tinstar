import { describe, it, expect } from 'vitest'
import { formatBrowserPin, regionWord } from '../formatBrowserPin'
import type { Pin } from '../../../../../domain/pinSet'

const pin = (over: Partial<Pin> = {}): Pin => ({
  id: 'p1', nodeId: 'browser-w1', nx: 0.42, ny: 0.15, comment: 'make this bigger', createdAt: 1, ...over,
})

describe('regionWord', () => {
  it('maps the nine-cell grid', () => {
    expect(regionWord({ x: 0.1, y: 0.1 })).toBe('upper-left')
    expect(regionWord({ x: 0.5, y: 0.5 })).toBe('center')
    expect(regionWord({ x: 0.9, y: 0.9 })).toBe('lower-right')
    expect(regionWord({ x: 0.1, y: 0.5 })).toBe('middle-left')
    expect(regionWord({ x: 0.5, y: 0.9 })).toBe('lower-center')
  })

  it('pins boundary values to the higher cell', () => {
    expect(regionWord({ x: 1 / 3, y: 0.1 })).toBe('upper-center')
    expect(regionWord({ x: 2 / 3, y: 2 / 3 })).toBe('lower-right')
  })
})

describe('formatBrowserPin', () => {
  it('formats an element target with text, selector, page url and document coords', () => {
    const p = formatBrowserPin(pin({
      context: {
        url: 'http://localhost:3000/pricing', docX: 420.4, docY: 180.2,
        target: { tag: 'h2', selector: '.pricing > h2:nth-child(1)', text: 'Pro plan — $29/mo' },
      },
    }))
    expect(p).toContain("marked up the page http://localhost:3000/pricing")
    expect(p).toContain('[1] on <h2> "Pro plan — $29/mo" (.pricing > h2:nth-child(1)), at (420, 180)')
    expect(p).toContain('→ make this bigger')
  })

  it('formats an image target with filename, alt, and region word', () => {
    const p = formatBrowserPin(pin({
      comment: 'wrong logo',
      context: {
        url: 'http://localhost:3000/', docX: 420, docY: 180,
        target: { tag: 'img', imageSrc: 'http://localhost:3000/img/logo.png', imageAlt: 'Acme logo', within: { x: 0.1, y: 0.9 } },
      },
    }))
    expect(p).toContain('on <img> logo.png (alt: "Acme logo"), lower-left, at (420, 180)')
  })

  it('falls back to coords-only when there is no target', () => {
    const p = formatBrowserPin(pin({ context: { url: 'http://localhost:3000/pricing', docX: 420, docY: 180 } }))
    expect(p).toContain('the page http://localhost:3000/pricing')
    expect(p).toContain('[1] at (420, 180) on the page')
  })

  it('uses nx/ny when a fresh pin has no context coords', () => {
    const p = formatBrowserPin(pin({ nx: 11.2, ny: 22.7, context: undefined }))
    // no docX/docY → falls back to nx/ny (rounded)
    expect(p).toContain('at (11, 23)')
    expect(p).toContain("marked up the page:")  // no url
  })

  it('renders an empty comment as (no comment)', () => {
    expect(formatBrowserPin(pin({ comment: '' }))).toContain('(no comment)')
  })
})
