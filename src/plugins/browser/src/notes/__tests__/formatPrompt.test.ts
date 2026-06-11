import { describe, it, expect } from 'vitest'
import { formatNotesPrompt, regionWord } from '../formatPrompt'
import type { BrowserNote } from '../../../../../domain/types'

const base = (over: Partial<BrowserNote>): BrowserNote => ({
  id: 'n1', url: 'http://localhost:3000/pricing', comment: 'make this bigger',
  x: 420.4, y: 180.2, nx: 0.42, ny: 0.15, createdAt: 1, ...over,
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
    // x === 1/3 is NOT < 1/3, so col = 'center'; y < 1/3, so row = 'upper'
    expect(regionWord({ x: 1 / 3, y: 0.1 })).toBe('upper-center')
    // x === 2/3 is NOT < 2/3, so col = 'right'; y === 2/3 is NOT < 2/3, so row = 'lower'
    expect(regionWord({ x: 2 / 3, y: 2 / 3 })).toBe('lower-right')
  })
})

describe('formatNotesPrompt', () => {
  it('formats an element target with text, selector, and rounded coords', () => {
    const p = formatNotesPrompt([base({
      target: { tag: 'h2', selector: '.pricing > h2:nth-child(1)', text: 'Pro plan — $29/mo' },
    })])!
    expect(p).toContain('marked up the page http://localhost:3000/pricing with 1 note')
    expect(p).toContain('[1] on <h2> "Pro plan — $29/mo" (.pricing > h2:nth-child(1)), at (420, 180)')
    expect(p).toContain('→ make this bigger')
  })

  it('formats an image target with filename, alt, and region word', () => {
    const p = formatNotesPrompt([base({
      comment: 'wrong logo',
      target: { tag: 'img', imageSrc: 'http://localhost:3000/img/logo.png', imageAlt: 'Acme logo', within: { x: 0.1, y: 0.9 } },
    })])!
    expect(p).toContain('on <img> logo.png (alt: "Acme logo"), lower-left, at (420, 180)')
  })

  it('falls back to coordinates + percentages without a target', () => {
    const p = formatNotesPrompt([base({})])!
    expect(p).toContain('[1] at (420, 180) / (42%, 15%) on the page')
  })

  it('skips sent notes and returns null when nothing is unsent', () => {
    expect(formatNotesPrompt([base({ sentAt: 5 })])).toBeNull()
    const p = formatNotesPrompt([base({ sentAt: 5 }), base({ id: 'n2', comment: 'second' })])!
    expect(p).not.toContain('make this bigger')
    expect(p).toContain('[1]')          // numbering counts unsent only
    expect(p).toContain('second')
  })

  it('groups notes by URL with continuous numbering', () => {
    const p = formatNotesPrompt([base({}), base({ id: 'n2', url: 'http://localhost:3000/about', comment: 'fix typo' })])!
    expect(p).toContain('http://localhost:3000/pricing with 1 note')
    expect(p).toContain('http://localhost:3000/about with 1 note')
    expect(p).toContain('[1]')
    expect(p).toContain('[2]')
  })

  it('renders an empty comment as (no comment)', () => {
    expect(formatNotesPrompt([base({ comment: '' })])).toContain('(no comment)')
  })
})
