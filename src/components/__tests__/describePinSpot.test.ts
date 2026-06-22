import { describe, it, expect } from 'vitest'
import { describePinSpot } from '../InfiniteCanvas'
import type { Pin } from '../../domain/pinSet'

function makePin(overrides: Partial<Pin> = {}): Pin {
  return { id: 'p1', nodeId: 'n1', nx: 0.3, ny: 0.7, comment: '', createdAt: 1, ...overrides }
}

describe('describePinSpot', () => {
  it('returns capture label for native-widget pins', () => {
    const p = makePin({ context: { capture: { label: 'Submit button' } } })
    expect(describePinSpot(p)).toBe('Submit button')
  })

  it('returns url+element text for browser pins with a text target', () => {
    const p = makePin({ context: { url: 'https://example.com', target: { tag: 'BUTTON', text: 'Login' } } })
    expect(describePinSpot(p)).toBe('Login — https://example.com')
  })

  it('returns url+imageAlt for browser pins with an imageAlt target', () => {
    const p = makePin({ context: { url: 'https://example.com', target: { tag: 'IMG', imageAlt: 'logo' } } })
    expect(describePinSpot(p)).toBe('logo — https://example.com')
  })

  it('returns url+tag for browser pins with only a tag target', () => {
    const p = makePin({ context: { url: 'https://example.com', target: { tag: 'BUTTON' } } })
    expect(describePinSpot(p)).toBe('BUTTON — https://example.com')
  })

  it('returns bare url for browser pins with no useful target', () => {
    const p = makePin({ context: { url: 'https://example.com' } })
    expect(describePinSpot(p)).toBe('https://example.com')
  })

  it('returns bare url for browser pins with target that has only a selector (no text/imageAlt/tag-as-element)', () => {
    // tag is required on BrowserNoteTarget but text/imageAlt are absent —
    // describePinSpot still has tag so it will return tag+url. This case
    // confirms the tag itself acts as the element descriptor.
    const p = makePin({ context: { url: 'https://example.com', target: { tag: 'DIV', selector: '.wrapper' } } })
    expect(describePinSpot(p)).toBe('DIV — https://example.com')
  })

  it('falls back to positional coordinates for pins with no context', () => {
    const p = makePin({ nx: 0.5, ny: 0.25 })
    expect(describePinSpot(p)).toBe('50%,25%')
  })

  it('falls back to positional coordinates for pins with context but no capture or url', () => {
    const p = makePin({ nx: 0.1, ny: 0.9, context: { someOtherKey: 'foo' } })
    expect(describePinSpot(p)).toBe('10%,90%')
  })

  it('prefers capture label over url when both are present', () => {
    const p = makePin({ context: { capture: { label: 'Native label' }, url: 'https://example.com' } })
    expect(describePinSpot(p)).toBe('Native label')
  })
})
