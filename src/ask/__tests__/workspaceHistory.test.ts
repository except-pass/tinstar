import { afterEach, expect, it, vi } from 'vitest'
import { captureScroll, restoreScroll } from '../workspaceHistory'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })
it('restores the semantic row and its group after layout changes, with horizontal position and focus', () => {
  const viewport = document.createElement('div')
  viewport.innerHTML = '<section data-view-group="a"><button data-pull-id="repo#1">First copy</button></section><section data-view-group="b"><button data-pull-id="repo#1">Second copy</button></section>'
  document.body.append(viewport)
  const [first, second] = [...viewport.querySelectorAll('button')]
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 10 } as DOMRect)
  vi.spyOn(first!, 'getBoundingClientRect').mockReturnValue({ top: -30, bottom: 0 } as DOMRect)
  const rectangle = vi.spyOn(second!, 'getBoundingClientRect').mockReturnValue({ top: 20, bottom: 50 } as DOMRect)
  viewport.scrollTop = 100; viewport.scrollLeft = 63; second!.focus()
  const saved = captureScroll(viewport, 'data-pull-id')
  viewport.scrollTop = 0; viewport.scrollLeft = 0; first!.focus()
  rectangle.mockReturnValue({ top: 80, bottom: 110 } as DOMRect)
  restoreScroll(viewport, 'data-pull-id', saved)
  expect(viewport.scrollTop).toBe(60)
  expect(viewport.scrollLeft).toBe(63)
  expect(second).toHaveFocus()
})
it('uses the saved scroll position when the original semantic anchor has disappeared', () => {
  const viewport = document.createElement('div')
  viewport.innerHTML = '<button data-pull-id="repo#1">Original</button>'
  document.body.append(viewport)
  vi.spyOn(viewport.querySelector('button')!, 'getBoundingClientRect').mockReturnValue({ top: 20, bottom: 50 } as DOMRect)
  viewport.scrollTop = 170; viewport.scrollLeft = 34
  const saved = captureScroll(viewport, 'data-pull-id')
  viewport.replaceChildren(); viewport.scrollTop = 0; viewport.scrollLeft = 0
  restoreScroll(viewport, 'data-pull-id', saved)
  expect(viewport.scrollTop).toBe(170); expect(viewport.scrollLeft).toBe(34)
})
