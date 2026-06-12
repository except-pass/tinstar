import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { captureWidgetContext } from '../captureWidgetContext'

// jsdom has no real hit-testing, so we stub document.elementFromPoint to return
// the node we want to be "under" the pin and assert on the produced label.
function stubElementFromPoint(doc: Document, el: Element | null) {
  doc.elementFromPoint = () => el
}

describe('captureWidgetContext', () => {
  let root: HTMLElement
  beforeEach(() => {
    root = document.createElement('div')
    document.body.appendChild(root)
  })
  afterEach(() => {
    root.remove()
    stubElementFromPoint(document, null)
  })

  it('returns undefined when nothing is under the point', () => {
    stubElementFromPoint(document, null)
    expect(captureWidgetContext(10, 10)).toBeUndefined()
  })

  it('returns undefined when an IFRAME is under the point (cross-document)', () => {
    const iframe = document.createElement('iframe')
    root.appendChild(iframe)
    stubElementFromPoint(document, iframe)
    expect(captureWidgetContext(10, 10)).toBeUndefined()
  })

  it('labels a role=tab with its short text', () => {
    root.innerHTML = `
      <div data-testid="file-tree">
        <div role="tablist">
          <div role="tab"><span>CHANGED</span></div>
        </div>
      </div>`
    const span = root.querySelector('span')!
    stubElementFromPoint(document, span)
    const out = captureWidgetContext(5, 5)!
    expect(out).toBeDefined()
    expect(out.label).toContain('CHANGED')
  })

  it('uses an explicit data-pin-context ancestor as the authoritative region', () => {
    root.innerHTML = `
      <div data-pin-context="telemetry pane">
        <h3>TOKENS</h3>
        <div class="value">1,234</div>
      </div>`
    const value = root.querySelector('.value')!
    stubElementFromPoint(document, value)
    const out = captureWidgetContext(5, 5)!
    expect(out.label).toContain('telemetry pane')
  })

  it('composes immediate label with region when both present', () => {
    root.innerHTML = `
      <section data-pin-context="telemetry pane">
        <button aria-label="Refresh tokens">↻</button>
      </section>`
    const btn = root.querySelector('button')!
    stubElementFromPoint(document, btn)
    const out = captureWidgetContext(5, 5)!
    expect(out.label).toContain('Refresh tokens')
    expect(out.label).toContain('telemetry pane')
    expect(out.label).toContain(' · in ')
  })

  it('uses nearest heading as region label', () => {
    root.innerHTML = `
      <div>
        <h2>TOKENS</h2>
        <a href="#">details</a>
      </div>`
    const a = root.querySelector('a')!
    stubElementFromPoint(document, a)
    const out = captureWidgetContext(5, 5)!
    expect(out.label).toContain('details')
    expect(out.label).toContain('TOKENS')
  })

  it('humanizes a data-testid region (telemetry-pane → telemetry pane)', () => {
    root.innerHTML = `
      <div data-testid="telemetry-pane">
        <div class="leaf">99%</div>
      </div>`
    const leaf = root.querySelector('.leaf')!
    stubElementFromPoint(document, leaf)
    const out = captureWidgetContext(5, 5)!
    // leaf text "99%" is the immediate, region humanized from testid
    expect(out.label).toContain('telemetry pane')
  })

  it('falls back to the start element trimmed text when no label/region', () => {
    root.innerHTML = `<div class="plain">just some text here</div>`
    const plain = root.querySelector('.plain')!
    stubElementFromPoint(document, plain)
    const out = captureWidgetContext(5, 5)!
    expect(out.label).toContain('just some text here')
    expect(out.tag).toBe('div')
  })

  it('returns undefined when start element is empty with no labels', () => {
    root.innerHTML = `<div class="empty"></div>`
    const empty = root.querySelector('.empty')!
    stubElementFromPoint(document, empty)
    expect(captureWidgetContext(5, 5)).toBeUndefined()
  })

  it('skips pin-system elements while climbing (never labels the marker)', () => {
    root.innerHTML = `
      <div data-pin-context="agent pane">
        <div data-testid="pin-marker" aria-label="Pinned note">
          <span>X</span>
        </div>
      </div>`
    const span = root.querySelector('span')!
    stubElementFromPoint(document, span)
    const out = captureWidgetContext(5, 5)!
    // Must not pick up the pin-marker's aria-label "Pinned note"
    expect(out.label).not.toContain('Pinned note')
    expect(out.label).toContain('agent pane')
  })

  it('caps text length to 80 chars', () => {
    const long = 'x'.repeat(200)
    root.innerHTML = `<div class="long">${long}</div>`
    const el = root.querySelector('.long')!
    stubElementFromPoint(document, el)
    const out = captureWidgetContext(5, 5)
    if (out?.text) expect(out.text.length).toBeLessThanOrEqual(80)
  })
})
