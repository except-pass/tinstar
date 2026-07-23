import { describe, it, expect } from 'vitest'
import type { SlateSurface } from '../../../types'
import { bodyText, surfaceHaystack } from '../slateSearch'

function surface(extra: Partial<SlateSurface> = {}): SlateSurface {
  return { id: 'sid', author: 'agent', kind: 'diagram', createdAt: 1, amendedAt: 1, ...extra }
}

describe('slateSearch', () => {
  it('flattens the readable strings out of an A2UI body', () => {
    expect(bodyText({
      root: 'r',
      components: [
        { id: 'r', component: 'Column' },
        { id: 't', component: 'Text', text: 'The rollback plan', variant: 'h2' },
        { id: 'l', component: 'List', items: ['drain the queue', 'flip the flag'] },
        { id: 's', component: 'Stepper', steps: [{ label: 'build', status: 'done', detail: 'ok' }] },
      ],
    })).toEqual([
      'The rollback plan', 'drain the queue', 'flip the flag', 'build', 'ok',
    ])
  })

  it('ignores structural props, so a body cannot match on its own markup', () => {
    // Matching a surface because its body happens to contain "column" or an href
    // would be worse than not matching at all.
    const text = bodyText({
      root: 'r',
      components: [{ id: 'r', component: 'Column', variant: 'h1', href: 'https://example.com' }],
    })
    expect(text).toEqual([])
  })

  it('is inert on a missing or malformed body', () => {
    expect(bodyText(undefined)).toEqual([])
    expect(bodyText({ root: 'r' } as never)).toEqual([])
  })

  it('searches the rendered body, not only the fields the card never shows', () => {
    // An expanded card never renders `headline` — its visible title is whatever the
    // agent put in the body. A haystack of headline/id/kind alone means a word the
    // user can plainly read matches nothing.
    const s = surface({
      headline: 'never-rendered',
      body: { root: 'r', components: [{ id: 'r', component: 'Text', text: 'Rollback Plan' }] },
    })
    const hay = surfaceHaystack(s)
    expect(hay).toContain('rollback plan')
    expect(hay).toContain('never-rendered')
    expect(hay).toContain('sid')
    expect(hay).toContain('diagram')
  })
})
