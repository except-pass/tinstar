// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { captureTarget, cssSelectorFor } from '../capture'

function fakePoint(el: Element | null) {
  ;(document as Document & { elementFromPoint: (x: number, y: number) => Element | null })
    .elementFromPoint = () => el
}
const rect = (el: Element, r: { left: number; top: number; width: number; height: number }) => {
  el.getBoundingClientRect = () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => '' }) as DOMRect
}

describe('cssSelectorFor', () => {
  it('uses #id when present', () => {
    document.body.innerHTML = `<div id="hero"></div>`
    expect(cssSelectorFor(document.getElementById('hero')!)).toBe('#hero')
  })
  it('builds a short class/nth-child path otherwise', () => {
    document.body.innerHTML = `<section class="pricing"><h2 class="title big">Pro</h2></section>`
    expect(cssSelectorFor(document.querySelector('h2')!)).toBe('section.pricing:nth-child(1) > h2.title.big:nth-child(1)')
  })
})

describe('captureTarget', () => {
  it('captures tag, selector, and trimmed text for an element', () => {
    document.body.innerHTML = `<section class="pricing"><h2>  Pro plan —\n $29/mo  </h2></section>`
    const h2 = document.querySelector('h2')!
    rect(h2, { left: 100, top: 100, width: 200, height: 50 })
    fakePoint(h2)
    const t = captureTarget(document, 150, 120, 'n1', 'http://localhost:3000/')!
    expect(t.tag).toBe('h2')
    expect(t.text).toBe('Pro plan — $29/mo')
    expect(t.selector).toContain('h2')
    expect(t.imageSrc).toBeUndefined()
    expect(t.within!.x).toBeCloseTo(0.25)
    expect(t.within!.y).toBeCloseTo(0.4)
  })

  it('captures un-proxied src + alt + within for an image', () => {
    document.body.innerHTML = `<img alt="Acme logo">`
    const img = document.querySelector('img')!
    img.setAttribute('src', 'http://tinstar.local/api/proxy/n1/img/logo.png')
    rect(img, { left: 0, top: 0, width: 100, height: 100 })
    fakePoint(img)
    const t = captureTarget(document, 10, 90, 'n1', 'http://localhost:3000/pricing')!
    expect(t.tag).toBe('img')
    expect(t.imageSrc).toBe('http://localhost:3000/img/logo.png')
    expect(t.imageAlt).toBe('Acme logo')
    expect(t.within!.x).toBeCloseTo(0.1)
    expect(t.within!.y).toBeCloseTo(0.9)
  })

  it('leaves a non-proxied absolute src untouched', () => {
    document.body.innerHTML = `<img>`
    const img = document.querySelector('img')!
    img.setAttribute('src', 'https://cdn.example.com/logo.png')
    rect(img, { left: 0, top: 0, width: 10, height: 10 })
    fakePoint(img)
    expect(captureTarget(document, 1, 1, 'n1', 'http://localhost:3000/')!.imageSrc).toBe('https://cdn.example.com/logo.png')
  })

  it('returns undefined for body/html hits and when elementFromPoint is missing', () => {
    fakePoint(document.body)
    expect(captureTarget(document, 1, 1, 'n1', 'http://x/')).toBeUndefined()
    // simulate a document without the API (jsdom default) — must not throw
    const bare = { } as unknown as Document
    expect(captureTarget(bare, 1, 1, 'n1', 'http://x/')).toBeUndefined()
  })

  it('omits within when the element has zero size', () => {
    document.body.innerHTML = `<span>x</span>`
    const el = document.querySelector('span')!
    fakePoint(el) // jsdom rect: all zeros
    expect(captureTarget(document, 1, 1, 'n1', 'http://x/')!.within).toBeUndefined()
  })
})
