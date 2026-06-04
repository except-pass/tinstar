import { describe, it, expect } from 'vitest'
import { preserveCohesion, type WidgetLayout } from '../useWidgetLayouts'

const L = (x: number, y: number, width = 100, height = 100): WidgetLayout => ({ x, y, width, height })

describe('preserveCohesion', () => {
  it('keeps a snapped session+browser together after a scattering re-layout', () => {
    // Pre-arrange: browser snapped flush to the right of the session.
    const prev = new Map<string, WidgetLayout>([
      ['session', L(0, 0)],
      ['browser', L(100, 0)],
    ])
    // A fresh default layout scatters the two into far-apart cells.
    const fresh = new Map<string, WidgetLayout>([
      ['session', L(50, 50)],
      ['browser', L(900, 700)],
    ])

    const out = preserveCohesion(fresh, prev, [['session', 'browser']])

    const s = out.get('session')!
    const b = out.get('browser')!
    // The pre-arrange relative offset is preserved → browser stays flush-right.
    expect(b.x).toBe(s.x + s.width)
    expect(b.y).toBe(s.y)
  })

  it('preserves the exact relative offset of every member (rigid block move)', () => {
    const prev = new Map<string, WidgetLayout>([
      ['a', L(10, 10)],
      ['b', L(10, 130)], // 120px below a
      ['c', L(140, 10)], // 130px right of a
    ])
    const fresh = new Map<string, WidgetLayout>([
      ['a', L(0, 0)],
      ['b', L(500, 0)],
      ['c', L(0, 500)],
    ])

    const out = preserveCohesion(fresh, prev, [['a', 'b', 'c']])

    // Whatever anchor is chosen, the inter-member offsets must match `prev`.
    const a = out.get('a')!, b = out.get('b')!, c = out.get('c')!
    expect(b.x - a.x).toBe(0)
    expect(b.y - a.y).toBe(120)
    expect(c.x - a.x).toBe(130)
    expect(c.y - a.y).toBe(0)
  })

  it('leaves layouts untouched when a group has fewer than two live members', () => {
    const prev = new Map<string, WidgetLayout>([['session', L(0, 0)]])
    const fresh = new Map<string, WidgetLayout>([['session', L(50, 50)]])

    const out = preserveCohesion(fresh, prev, [['session', 'missing']])

    expect(out.get('session')).toEqual(L(50, 50))
  })

  it('ignores group members absent from the fresh or prev layouts', () => {
    const prev = new Map<string, WidgetLayout>([
      ['session', L(0, 0)],
      ['browser', L(100, 0)],
    ])
    const fresh = new Map<string, WidgetLayout>([
      ['session', L(50, 50)],
      ['browser', L(900, 700)],
      // 'ghost' has no fresh/prev entry and must not be created.
    ])

    const out = preserveCohesion(fresh, prev, [['session', 'browser', 'ghost']])

    expect(out.has('ghost')).toBe(false)
    const s = out.get('session')!
    const b = out.get('browser')!
    expect(b.x).toBe(s.x + s.width)
    expect(b.y).toBe(s.y)
  })
})
