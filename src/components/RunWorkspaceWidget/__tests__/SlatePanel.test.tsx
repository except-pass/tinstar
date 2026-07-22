// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { A2uiContent, SlateSurface } from '../../../types'
import { MALFORMED_SIGNAL } from '../../../a2ui/A2uiRenderer'
import { SlatePanel } from '../SlatePanel'

/** Build an A2UI content envelope from a flat component list. */
function content(components: A2uiContent['components'], root?: string): A2uiContent {
  return { root: root ?? (components[0]?.id as string), components }
}

/** A minimal, valid surface carrying a single Text body. */
function surface(id: string, text: string, extra: Partial<SlateSurface> = {}): SlateSurface {
  return {
    id,
    author: 'agent',
    kind: 'diagram',
    body: content([{ id: 'root', component: 'Text', text, variant: 'body' }]),
    createdAt: 1,
    amendedAt: 1,
    ...extra,
  }
}

describe('SlatePanel (U5)', () => {
  it('renders nothing when the slate is empty or absent', () => {
    const { container: empty } = render(<SlatePanel runId="run-1" surfaces={[]} />)
    expect(empty.firstChild).toBeNull()

    const { container: absent } = render(<SlatePanel runId="run-1" />)
    expect(absent.firstChild).toBeNull()
  })

  it('renders a valid surface A2UI body', () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'Open point: pick a name')]} />)
    expect(screen.getByText('Open point: pick a name')).toBeTruthy()
    // The scroll body carries data-scrollable so the canvas wheel handler yields.
    expect(document.querySelector('[data-scrollable]')).not.toBeNull()
  })

  it('degrades a malformed surface WITHOUT affecting a sibling (per-surface boundary)', () => {
    // A body whose `root` references a non-existent component → the renderer
    // degrades this surface to the readable fallback.
    const malformed: SlateSurface = {
      id: 'bad',
      author: 'agent',
      kind: 'diagram',
      body: { root: 'missing', components: [] },
      createdAt: 1,
      amendedAt: 1,
    }
    const healthy = surface('good', 'I still render', { createdAt: 2 })

    render(<SlatePanel runId="run-1" surfaces={[malformed, healthy]} />)

    // The malformed surface shows the degrade signal...
    expect(screen.getByText(new RegExp(MALFORMED_SIGNAL))).toBeTruthy()
    // ...and its sibling is entirely unaffected.
    expect(screen.getByText('I still render')).toBeTruthy()
  })

  it('sorts surfaces by order then createdAt', () => {
    render(
      <SlatePanel
        runId="run-1"
        surfaces={[
          surface('c', 'gamma', { order: 2, createdAt: 1 }),
          surface('a', 'alpha', { order: 1, createdAt: 5 }),
          surface('b', 'beta', { order: 1, createdAt: 1 }),
        ]}
      />,
    )
    const rendered = screen.getByText('alpha').closest('[data-testid^="slate-surface-"]')
    const scroll = document.querySelector('[data-scrollable]')!
    const ids = Array.from(scroll.querySelectorAll('[data-testid^="slate-surface-"]')).map(
      (el) => el.getAttribute('data-testid'),
    )
    // order 1 (createdAt 1 before 5) then order 2.
    expect(ids).toEqual(['slate-surface-b', 'slate-surface-a', 'slate-surface-c'])
    expect(rendered).not.toBeNull()
  })
})
